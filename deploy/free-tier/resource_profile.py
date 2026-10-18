"""Optional, functionally reduced ERP pilot; no promise about free-tier RAM.

The default/full installation is unchanged. The free-tier profile keeps all
SQLAlchemy models, schema creation, repairs, authentication and validation,
but mounts only the estimating workflow. It changes neither shipped manifests
nor users' persisted module/process choices. A restart without the profile
restores the full product. Module management is a core router, not a manifest.
"""

from __future__ import annotations

import json
import os
from collections.abc import Iterable, Mapping
from typing import Any


PROFILE_ENV = "OE_RESOURCE_PROFILE"
FREE_TIER_MODULES = frozenset(
    {
        "oe_users", "oe_projects", "oe_boq", "oe_costs", "oe_catalog",
        "oe_assemblies", "oe_fx", "oe_i18n_foundation", "oe_validation",
        "oe_jobs", "oe_onboarding",
    }
)

# All background registry processes belong to omitted capabilities or are
# optional warm-ups. Generic job status/cancellation remains available. In
# particular this locks out encoders even with legacy or persisted "on" rows.
FREE_TIER_PROCESSES = frozenset()


def free_tier_enabled() -> bool:
    value = os.environ.get(PROFILE_ENV, "").strip().lower()
    if value in {"", "default", "full"}:
        return False
    if value != "free-tier":
        raise ValueError(f"Unsupported {PROFILE_ENV}: {value!r}")
    return True


def dependency_closure(seeds: Iterable[str], manifests: Mapping[str, Any]) -> frozenset[str]:
    """Resolve real required dependencies, refusing missing/cyclic manifests."""
    selected: set[str] = set()
    visiting: set[str] = set()

    def visit(name: str) -> None:
        if name in selected:
            return
        if name in visiting:
            raise ValueError(f"Circular resource-profile dependency: {name}")
        if name not in manifests:
            raise ValueError(f"Missing resource-profile module: {name}")
        visiting.add(name)
        for dependency in manifests[name].depends:
            visit(dependency)
        visiting.remove(name)
        selected.add(name)

    for seed in seeds:
        visit(seed)
    return frozenset(selected)


def selected_modules(manifests: Mapping[str, Any]) -> frozenset[str]:
    if not free_tier_enabled():
        return frozenset(manifests)
    return dependency_closure(FREE_TIER_MODULES, manifests)


def module_available(name: str, manifests: Mapping[str, Any]) -> bool:
    return not free_tier_enabled() or name in selected_modules(manifests)


def profile_load_order(order: list[str], manifests: Mapping[str, Any]) -> list[str]:
    if not free_tier_enabled():
        return order
    selected = selected_modules(manifests)
    missing = selected.difference(order)
    if missing:
        raise ValueError(f"Required resource-profile modules are disabled: {sorted(missing)}")
    return [name for name in order if name in selected]


def require_module(name: str, manifests: Mapping[str, Any]) -> None:
    if not module_available(name, manifests):
        raise ValueError(f"Module {name!r} is unavailable in the free-tier resource profile")


def process_profile_override(process_id: str) -> bool | None:
    if free_tier_enabled() and process_id not in FREE_TIER_PROCESSES:
        return False
    return None


def blocked_request(path: str, method: str) -> bool:
    """Guard known heavy operations before request bodies or handlers run.

    Ordinary project/BOQ/cost CRUD, validation and bounded BOQ spreadsheet
    imports remain accessible. Full CWICR/catalogue imports, model operations
    and demo provisioning are outside this small estimating pilot.
    """
    if not free_tier_enabled():
        return False
    parts = path.strip("/").replace("_", "-").split("/")
    write = method.upper() not in {"GET", "HEAD", "OPTIONS"}
    if parts[:3] == ["api", "v1", "costs"] and len(parts) > 3:
        tail = parts[3:]
        if tail[0] in {
            "import", "bulk", "load-cwicr", "base-market", "base-home",
            "vector", "qdrant-search", "semantic-search", "semantic", "catalogues-v3",
        }:
            return True
        if write and (tail[0] == "match-index" or (
            tail[0] == "resource-prices" and tail[-1] in {"seed", "bulk", "reprice"}
        )):
            return True
    if parts[:3] == ["api", "v1", "boq"]:
        if "vector" in parts[3:] or ("import" in parts[3:] and "smart" in parts[3:]):
            return True
    if write and (
        parts[:3] == ["api", "demo", "install"]
        or parts[:4] == ["api", "v1", "onboarding", "provision"]
        or parts[:3] == ["api", "system", "upgrade"]
        or parts[:3] in (["api", "v1", "partner-pack"], ["api", "v1", "packs"])
    ):
        return True
    return False


class ResourceProfileMiddleware:
    """Small ASGI guard; preserves all upstream auth/security middleware."""

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        if scope["type"] == "http" and blocked_request(scope["path"], scope["method"]):
            body = json.dumps({"detail": "This operation is unavailable in the free-tier resource profile."}).encode()
            await send({"type": "http.response.start", "status": 403, "headers": [
                (b"content-type", b"application/json"), (b"content-length", str(len(body)).encode()),
            ]})
            await send({"type": "http.response.body", "body": body})
            return
        await self.app(scope, receive, send)
