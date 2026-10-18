#!/usr/bin/env python3
"""Measure the real ERP container under hard Linux memory limits, without cloud resources.

Run on a Linux Docker host: python scripts/benchmark_memory.py --limits 256 512
Every limit uses a fresh constrained PostgreSQL 16 database and application volume.
Results describe a short, single-user smoke workload, not production capacity. A failed
limit remains a failed result. Use --allow-failures only for an exploratory matrix.
Credentials exist only in temporary local files/in-memory and are never printed.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
from decimal import Decimal
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import tempfile
import threading
import time
from urllib import error, request


ROOT = Path(__file__).resolve().parents[1]
MIB = 1024 * 1024


class ProbeError(Exception):
    """A failure safe to include in a public benchmark report."""


def docker(*args: str, timeout: int = 60, check: bool = True) -> subprocess.CompletedProcess:
    try:
        result = subprocess.run(
            ["docker", *args], text=True, capture_output=True, timeout=timeout, cwd=ROOT,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ProbeError(f"Docker command {args[0]} unavailable or timed out") from exc
    if check and result.returncode:
        # Docker diagnostics and inspect output may include credentials. Keep them private.
        raise ProbeError(f"Docker command {args[0]} failed (exit {result.returncode})")
    return result


def inspect_state(container: str) -> dict:
    try:
        result = docker("inspect", "--format", "{{json .State}}", container, check=False)
        return json.loads(result.stdout) if result.returncode == 0 else {}
    except (ProbeError, ValueError):
        return {}


def cgroup_directory(pid: int) -> tuple[Path, bool] | None:
    """Resolve the container's host cgroup (v2 preferred, v1 supported)."""
    try:
        lines = Path(f"/proc/{pid}/cgroup").read_text().splitlines()
        for line in lines:
            _, controllers, relative = line.split(":", 2)
            if not controllers:
                return Path("/sys/fs/cgroup") / relative.lstrip("/"), True
            if "memory" in controllers.split(","):
                return Path("/sys/fs/cgroup/memory") / relative.lstrip("/"), False
    except (OSError, ValueError):
        pass
    return None


def read_integer(path: Path) -> int | None:
    try:
        return int(path.read_text().strip())
    except (OSError, ValueError):
        return None


class MemoryMonitor:
    """Read the host cgroup; never inject a measurement process into the container."""

    def __init__(self, container: str):
        self.container = container
        self.samples: list[dict] = []
        self.started = time.monotonic()
        self.stop_event = threading.Event()
        self.thread = threading.Thread(target=self.run, daemon=True)

    def run(self) -> None:
        location = None
        while not self.stop_event.is_set():
            if location is None:
                state = inspect_state(self.container)
                if state.get("Pid", 0):
                    location = cgroup_directory(state["Pid"])
            if location:
                directory, v2 = location
                current = read_integer(directory / ("memory.current" if v2 else "memory.usage_in_bytes"))
                peak = read_integer(directory / ("memory.peak" if v2 else "memory.max_usage_in_bytes"))
                if current is not None:
                    processes = []
                    try:
                        pids = (directory / "cgroup.procs").read_text().split()
                    except OSError:
                        pids = []
                    for pid in set(pids):
                        try:
                            status = Path(f"/proc/{pid}/status").read_text()
                            rss = re.search(r"^VmRSS:\s+(\d+) kB", status, re.M)
                            name = re.search(r"^Name:\s+(.*)$", status, re.M)
                            if rss:
                                processes.append({
                                    "name": name.group(1) if name else "unknown",
                                    "rss_bytes": int(rss.group(1)) * 1024,
                                })
                        except OSError:
                            continue
                    events = {}
                    if v2:
                        try:
                            events = {k: int(v) for k, v in (
                                line.split() for line in (directory / "memory.events").read_text().splitlines()
                            )}
                        except (OSError, ValueError):
                            pass
                    self.samples.append({
                        "elapsed_seconds": round(time.monotonic() - self.started, 2),
                        "current_bytes": current,
                        "peak_bytes": peak,
                        # RSS can count shared pages repeatedly; cgroup memory is authoritative.
                        "sum_process_rss_bytes": sum(p["rss_bytes"] for p in processes),
                        "processes": processes,
                        "memory_events": events,
                    })
            self.stop_event.wait(1)

    def start(self) -> None:
        self.thread.start()

    def finish(self) -> dict:
        self.stop_event.set()
        self.thread.join(timeout=10)
        return {
            "available": bool(self.samples),
            "sample_interval_seconds": 1,
            "max_current_bytes": max((s["current_bytes"] for s in self.samples), default=None),
            "max_peak_bytes": max((s["peak_bytes"] or 0 for s in self.samples), default=None),
            "max_sum_process_rss_bytes": max((s["sum_process_rss_bytes"] for s in self.samples), default=None),
            "observed_oom_kills": max((s["memory_events"].get("oom_kill", 0) for s in self.samples), default=0),
            "samples": self.samples,
        }


def http(base: str, path: str, method: str = "GET", body: dict | None = None,
         token: str | None = None, expected: int = 200, timeout: int = 30):
    headers = {"Accept": "application/json"}
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = request.Request(base + path, data=data, headers=headers, method=method)
    opener = request.build_opener(request.ProxyHandler({}))
    try:
        with opener.open(req, timeout=timeout) as response:
            status, raw = response.status, response.read(4 * MIB)
    except error.HTTPError as exc:
        status, raw = exc.code, b""
        exc.close()
    except (error.URLError, TimeoutError, OSError) as exc:
        raise ProbeError(f"{method} {path}: connection failed or timed out") from exc
    if status != expected:
        raise ProbeError(f"{method} {path}: expected HTTP {expected}, received {status}")
    if raw and raw.lstrip().startswith((b"{", b"[")):
        return json.loads(raw)
    return raw


def exercise(base: str, hold_seconds: int, sensitive_values: set[str]) -> list[str]:
    """One administrator, one project, one BOQ, ten costed lines, repeated reads."""
    checks = []
    frontend = http(base, "/")
    if not isinstance(frontend, bytes) or b"<html" not in frontend.lower():
        raise ProbeError("Frontend did not return an HTML document")
    checks.append("frontend_html")
    credentials = {
        "email": "memory-benchmark@example.test", "password": "Aa1" + secrets.token_hex(24),
        "full_name": "Memory benchmark",
    }
    sensitive_values.add(credentials["password"])
    account = http(base, "/api/v1/users/auth/register", "POST", credentials, expected=201)
    if account.get("role") != "admin" or account.get("is_active") is not True:
        raise ProbeError("Bootstrap did not return an active administrator")
    checks.append("first_administrator")
    other = {**credentials, "email": "second-user@example.test"}
    http(base, "/api/v1/users/auth/register", "POST", other, expected=403)
    checks.append("subsequent_registration_closed")
    login = http(base, "/api/v1/users/auth/login", "POST", {
        "email": credentials["email"], "password": credentials["password"],
    })
    token = login.get("access_token")
    if not isinstance(token, str) or not token:
        raise ProbeError("Login did not return an access token")
    sensitive_values.update(value for key, value in login.items() if "token" in key and isinstance(value, str))
    checks.append("login")
    project = http(base, "/api/v1/projects/", "POST", {
        "name": "Tromso benchmark", "region": "Norway", "currency": "NOK", "locale": "no",
    }, token, 201)
    project_id = project["id"]
    checks.append("create_project")
    boq = http(base, "/api/v1/boq/boqs/", "POST", {
        "name": "Small carpentry estimate", "project_id": project_id,
    }, token, 201)
    boq_path = f"/api/v1/boq/boqs/{boq['id']}/"
    for index in range(10):
        position = http(base, boq_path + "positions/", "POST", {
            "ordinal": f"01.{index + 1:03}", "description": f"Timber installation {index + 1}",
            "unit": "m2", "quantity": 10, "unit_rate": 125,
        }, token, 201)
        if Decimal(str(position.get("total", "-1"))) != Decimal("1250"):
            raise ProbeError("BOQ position total was not the expected 1,250 NOK")
    checks.append("create_boq_and_10_positions_with_totals")
    deadline = time.monotonic() + hold_seconds
    count = 0
    while count == 0 or time.monotonic() < deadline:
        projects = http(base, "/api/v1/projects/", token=token)
        if not any(p.get("id") == project_id for p in projects):
            raise ProbeError("Saved project missing from project list")
        positions = http(base, boq_path + "positions/", token=token)
        if not isinstance(positions, list) or len(positions) != 10:
            raise ProbeError("Saved BOQ positions did not round-trip")
        http(base, "/api/health")
        count += 1
        if time.monotonic() < deadline:
            time.sleep(2)
    checks.append(f"repeated_project_boq_health_reads:{count}")
    return checks


def safe_text_tail(text: str, sensitive_values: set[str], line_count: int = 80) -> list[str]:
    """Redact captured diagnostics before retaining bounded lines."""
    for secret in sorted(sensitive_values, key=len, reverse=True):
        if secret:
            text = text.replace(secret, "[REDACTED]")
    # Extra defence for token/hash values produced by the application itself.
    text = re.sub(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b", "[REDACTED_JWT]", text)
    text = re.sub(r"\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}", "[REDACTED_PASSWORD_HASH]", text)
    text = re.sub(
        r"(?i)(\b[A-Z_]*(?:PASSWORD|SECRET|TOKEN|API_KEY)[A-Z_]*\s*[=:]\s*)[^\s,;]+",
        r"\1[REDACTED]", text,
    )
    # Logging errors/tracebacks remains useful; do not return docker inspect/env.
    return [line[:1000] for line in text.splitlines()[-line_count:]]


def safe_log_tail(container: str, sensitive_values: set[str]) -> list[str]:
    """Capture privately, redact before storing, retain at most 80 bounded lines."""
    try:
        logs = docker("logs", "--tail", "80", container, check=False)
    except ProbeError:
        return ["Container logs unavailable"]
    return safe_text_tail(logs.stdout + logs.stderr, sensitive_values)


def trial(args: argparse.Namespace, limit: int) -> dict:
    identity = "erp-memory-" + secrets.token_hex(5)
    network, app, db = identity + "-net", identity + "-app", identity + "-db"
    volumes = [identity + "-app-data", identity + "-db-data"]
    monitors = []
    sensitive_values: set[str] = set()
    phase = "database_startup"
    result = {"profile": args.profile, "app_limit_mib": limit, "database_limit_mib": 256,
              "status": "failed", "checks": [], "started_utc": datetime.now(timezone.utc).isoformat()}
    started = time.monotonic()
    try:
        with tempfile.TemporaryDirectory(prefix="erp-memory-") as temp:
            password = secrets.token_hex(32)
            sensitive_values.add(password)
            pg_env = Path(temp) / "postgres.env"
            app_env = Path(temp) / "app.env"
            pg_env.write_text(f"POSTGRES_PASSWORD={password}\nPOSTGRES_USER=oe\nPOSTGRES_DB=openestimate\n")
            app_values = {
                "OE_DB_HOST": "postgres", "OE_DB_PORT": "5432", "OE_DB_USER": "oe",
                "OE_DB_NAME": "openestimate", "OE_DB_PASSWORD": password,
                "JWT_SECRET": secrets.token_hex(32), "SEED_DEMO": "false",
                "OE_REGISTRATION_MODE": "closed", "OE_DOWNLOAD_EMBEDDING_MODEL": "0",
                "ALLOWED_ORIGINS": "http://127.0.0.1", "OPENAI_API_KEY": "",
                "ALLOW_RUNTIME_UPGRADE": "false", "REDIS_URL": "",
            }
            sensitive_values.add(app_values["JWT_SECRET"])
            for value in args.env:
                key, val = value.split("=", 1)
                if key in {"SEED_DEMO", "OE_REGISTRATION_MODE", "OE_DOWNLOAD_EMBEDDING_MODEL", "OPENAI_API_KEY"}:
                    raise ProbeError("Benchmark safety settings cannot be overridden")
                app_values[key] = val
                if re.search(r"PASSWORD|SECRET|TOKEN|API_KEY", key, re.I) and val:
                    sensitive_values.add(val)
            app_env.write_text("".join(f"{k}={v}\n" for k, v in app_values.items()))
            os.chmod(pg_env, 0o600)
            os.chmod(app_env, 0o600)
            docker("network", "create", network)
            for volume in volumes:
                docker("volume", "create", volume)
            docker("run", "-d", "--name", db, "--network", network, "--network-alias", "postgres",
                   "--memory", "256m", "--memory-swap", "256m", "--env-file", str(pg_env),
                   "--mount", f"source={volumes[1]},target=/var/lib/postgresql/data",
                   "postgres:16-alpine", "-c", "shared_buffers=16MB", "-c", "max_connections=100",
                   "-c", "work_mem=1MB", "-c", "maintenance_work_mem=16MB", timeout=180)
            result["database_image_id"] = docker(
                "image", "inspect", "--format", "{{.Id}}", "postgres:16-alpine",
            ).stdout.strip()
            db_monitor = MemoryMonitor(db)
            db_monitor.start()
            monitors.append(("database_memory", db_monitor))
            for _ in range(60):
                # The image starts a temporary Unix-socket-only server during
                # initdb. Wait for the final TCP server, as the app uses TCP.
                if docker("exec", db, "pg_isready", "-h", "127.0.0.1", "-U", "oe", "-d", "openestimate", check=False).returncode == 0:
                    break
                if not inspect_state(db).get("Running"):
                    raise ProbeError("PostgreSQL stopped during startup")
                time.sleep(1)
            else:
                raise ProbeError("PostgreSQL readiness timed out")
            # Keep PostgreSQL's normal lock table capacity: ERP creates hundreds
            # of tables/indexes in one transaction. Lowering max_connections also
            # lowers max_locks_per_transaction * max_connections lock slots.
            settings = docker(
                "exec", db, "psql", "-X", "-A", "-t", "-U", "oe", "-d", "openestimate", "-c",
                "SELECT json_build_object("
                "'shared_buffers', current_setting('shared_buffers'),"
                "'max_connections', current_setting('max_connections'),"
                "'max_locks_per_transaction', current_setting('max_locks_per_transaction'),"
                "'work_mem', current_setting('work_mem'),"
                "'maintenance_work_mem', current_setting('maintenance_work_mem'))",
            )
            result["database_settings"] = json.loads(settings.stdout)
            phase = "application_startup"
            run_args = ["run", "-d", "--name", app, "--network", network,
                        "--memory", f"{limit}m", "--memory-swap", f"{limit}m",
                        "--env-file", str(app_env), "--publish", "127.0.0.1::8080",
                        "--mount", f"source={volumes[0]},target=/data"]
            if args.cpus:
                run_args += ["--cpus", str(args.cpus)]
            docker(*run_args, args.image)
            app_monitor = MemoryMonitor(app)
            app_monitor.start()
            monitors.append(("app_memory", app_monitor))
            mapped = docker("port", app, "8080/tcp").stdout.strip().splitlines()[0]
            base = "http://" + mapped
            deadline = time.monotonic() + args.startup_timeout
            while time.monotonic() < deadline:
                if not inspect_state(app).get("Running"):
                    raise ProbeError("Application stopped during startup")
                try:
                    http(base, "/api/health", timeout=5)
                    result["health_ready_seconds"] = round(time.monotonic() - started, 2)
                    break
                except ProbeError:
                    time.sleep(2)
            else:
                raise ProbeError("Application health did not become ready before the startup timeout")
            phase = "application_workload"
            result["checks"] = ["health_ready"] + exercise(base, args.hold_seconds, sensitive_values)
            result["status"] = "passed"
    except (ProbeError, KeyError, ValueError) as exc:
        result["failure"] = str(exc) if isinstance(exc, ProbeError) else "Unexpected API response shape"
        result["failure_kind"] = phase
    finally:
        for name, monitor in monitors:
            result[name] = monitor.finish()
        for name, container in (("app_state", app), ("database_state", db)):
            state = inspect_state(container)
            result[name] = {key: state.get(key) for key in ("Running", "OOMKilled", "ExitCode")}
        if any(result.get(name, {}).get("OOMKilled") for name in ("app_state", "database_state")):
            result["status"] = "failed"
            result["failure"] = "A container was killed for exceeding its memory limit"
            result["failure_kind"] = "out_of_memory"
        elif any(result.get(name, {}).get("observed_oom_kills", 0) for name in ("app_memory", "database_memory")):
            result["status"] = "failed"
            result["failure"] = "The cgroup reported an out-of-memory kill"
            result["failure_kind"] = "out_of_memory"
        if result["status"] == "passed" and not all(
            result.get(name, {}).get("available") for name in ("app_memory", "database_memory")
        ):
            result["status"] = "unverified_memory"
            result["failure"] = "Workload passed, but host cgroup memory measurements were unavailable"
            result["failure_kind"] = "measurement_unavailable"
        if result["status"] != "passed":
            result["redacted_log_tails"] = {
                "application": safe_log_tail(app, sensitive_values),
                "database": safe_log_tail(db, sensitive_values),
            }
        try:
            docker("rm", "-f", app, db, check=False)
            for volume in volumes:
                docker("volume", "rm", volume, check=False)
            docker("network", "rm", network, check=False)
        except ProbeError:
            result["cleanup_warning"] = "Docker cleanup could not finish; remove this run's erp-memory-* resources"
        result["elapsed_seconds"] = round(time.monotonic() - started, 2)
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--limits", type=int, nargs="+", default=[256, 512])
    parser.add_argument("--profile", default="baseline", help="Label recorded in the report; does not change runtime by itself")
    parser.add_argument("--image", default="erp-memory-benchmark:local")
    parser.add_argument("--dockerfile", default="Dockerfile", help="Repo-relative Dockerfile; defaults to the full upstream wrapper")
    parser.add_argument("--skip-build", action="store_true")
    parser.add_argument("--build-arg", action="append", default=[])
    parser.add_argument("--env", action="append", default=[], help="Non-secret runtime KEY=VALUE override")
    parser.add_argument("--cpus", type=float, help="Optional app CPU limit; omit to isolate memory effects")
    parser.add_argument("--startup-timeout", type=int, default=480)
    parser.add_argument("--hold-seconds", type=int, default=60)
    parser.add_argument("--output", type=Path, default=ROOT / "work" / "memory-benchmark.json")
    parser.add_argument("--allow-failures", action="store_true", help="Diagnostic exit status only; results still record failures")
    args = parser.parse_args()
    if sys.platform != "linux":
        parser.error("Run on a Linux Docker host so the host /proc and cgroup memory counters are readable")
    if any(limit < 64 for limit in args.limits) or args.hold_seconds < 0 or args.startup_timeout < 1:
        parser.error("Use memory limits >=64 MiB and non-negative durations")
    if any("=" not in value or "\n" in value or "\r" in value for value in args.env + args.build_arg):
        parser.error("Overrides must be single-line KEY=VALUE pairs")
    report = {
        "schema_version": 1, "profile": args.profile,
        "scope": "Transient local Docker containers on a Linux host; no Northflank resources or credentials",
        "limitations": "Single user, small BOQ, no catalog import, AI, BIM, PDF export or production load; no swap",
        "cpu_limit": args.cpus, "hold_seconds": args.hold_seconds,
        "dockerfile": args.dockerfile,
        "database_image": "postgres:16-alpine", "trials": [],
    }
    try:
        docker("info")
        if not args.skip_build:
            build = ["build", "--file", args.dockerfile, "--tag", args.image]
            for value in args.build_arg:
                build += ["--build-arg", value]
            built = docker(*build, ".", timeout=900, check=False)
            if built.returncode:
                override_values = {value.split("=", 1)[1] for value in args.build_arg + args.env}
                report["setup_diagnostics"] = safe_text_tail(
                    built.stdout + built.stderr, override_values, line_count=20,
                )
                raise ProbeError(f"Docker build failed (exit {built.returncode}); see redacted setup diagnostics")
        report["app_image_id"] = docker("image", "inspect", "--format", "{{.Id}}", args.image).stdout.strip()
        for limit in args.limits:
            print(f"Benchmarking profile={args.profile}, application={limit} MiB, PostgreSQL=256 MiB", flush=True)
            result = trial(args, limit)
            report["trials"].append(result)
            app_peak = result.get("app_memory", {}).get("max_peak_bytes")
            print(f"  {result['status']}; app cgroup peak={round(app_peak / MIB, 1) if app_peak else 'unavailable'} MiB; "
                  f"{result.get('failure', 'single-user workflow passed')}", flush=True)
    except ProbeError as exc:
        report["setup_failure"] = str(exc)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as handle:
            handle.write(f"### ERP memory benchmark: {args.profile}\n\n")
            handle.write("App limit | Result | App cgroup peak | DB cgroup peak | Failure\n---|---|---|---|---\n")
            for result in report["trials"]:
                peaks = [result.get(key, {}).get("max_peak_bytes") for key in ("app_memory", "database_memory")]
                formatted = [f"{value / MIB:.1f} MiB" if value else "unavailable" for value in peaks]
                handle.write(f"{result['app_limit_mib']} MiB | {result['status']} | {formatted[0]} | {formatted[1]} | "
                             f"{result.get('failure', '')}\n")
            if "setup_failure" in report:
                handle.write(f"\nSetup failed: {report['setup_failure']}\n")
            handle.write(f"\n{report['limitations']}. A pass is not a production capacity guarantee.\n")
    failed = "setup_failure" in report or any(item["status"] != "passed" for item in report["trials"])
    return 0 if args.allow_failures or not failed else 1


if __name__ == "__main__":
    raise SystemExit(main())
