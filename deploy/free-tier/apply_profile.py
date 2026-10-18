"""Apply the reviewed optional profile to the exact upstream 18.6.4 sources.

Run at image build time, never against a running installation. Every source
hash and replacement is verified before any file is written. Unknown releases
fail closed so a changed upstream cannot silently bypass the resource policy.
The complete modified application and this patcher remain distributed in the
image/repository alongside the upstream AGPL source and attribution.
"""

from __future__ import annotations

import ast
import hashlib
from pathlib import Path
import sys


EXPECTED_HASHES = {
    "app/main.py": "46ad0ed2679746b2e823f6b992bfdd494b7e7aa14b35128a4c9b0d72e865b58e",
    "app/core/module_loader.py": "4d30dc597a9d678e34c129ca722bf6a50259968262e7d3fb61b5f95077c83e56",
    "app/core/processes/registry.py": "3d7e9aa83d98c49ccf04e19d528ed41ab34b15081ec312318cc02d260ed33b15",
    "app/core/semantic_switch.py": "5e8cb5bb986970084485d44cba2face412808c7cd429a635a4534430d974d28b",
    "app/modules/costs/matcher.py": "27149c4815687c2a3ab39edad2682274a993672b0ab8cec4ffd13e967ab1a3ab",
}


def replace_checked(source: str, old: str, new: str, count: int = 1) -> str:
    found = source.count(old)
    if found != count:
        raise ValueError(f"Patch anchor expected {count} occurrence(s), got {found}: {old[:90]!r}")
    return source.replace(old, new)


def guard_aliases(source: str) -> str:
    aliases = {
        "app.modules.opencde_api.router": "oe_opencde_api",
        "app.modules.changeorders.router": "oe_changeorders",
        "app.modules.costmodel.router": "oe_costmodel",
        "app.modules.tendering.router": "oe_tendering",
        "app.modules.coordination_hub.router": "oe_coordination_hub",
        "app.modules.schedule.router_4d": "oe_schedule",
    }
    replacements: list[tuple[int, int, str]] = []
    seen: set[str] = set()
    lines = source.splitlines(keepends=True)
    for node in ast.walk(ast.parse(source)):
        if not isinstance(node, ast.Try):
            continue
        imports = [item for item in node.body if isinstance(item, ast.ImportFrom) and item.module in aliases]
        if not imports:
            continue
        if len(imports) != 1 or imports[0].module in seen:
            raise ValueError("Upstream alias import shape changed")
        module = imports[0].module
        seen.add(module)
        indent = " " * node.col_offset
        original = "".join(lines[node.lineno - 1:node.end_lineno])
        guarded = f'{indent}if module_available("{aliases[module]}", module_loader._manifests):\n'
        guarded += "".join("    " + line if line.strip() else line for line in original.splitlines(keepends=True))
        replacements.append((node.lineno - 1, node.end_lineno, guarded))
    if seen != set(aliases):
        raise ValueError(f"Missing alias patch targets: {set(aliases).difference(seen)}")
    for start, end, replacement in sorted(replacements, reverse=True):
        lines[start:end] = [replacement]
    return "".join(lines)


def patched_sources(sources: dict[str, str]) -> dict[str, str]:
    """Return all verified modifications without writing partial changes."""
    for name, expected in EXPECTED_HASHES.items():
        actual = hashlib.sha256(sources[name].encode("utf-8")).hexdigest()
        if actual != expected:
            raise ValueError(f"Unsupported upstream source: {name} (expected reviewed 18.6.4)")
    result = dict(sources)
    name = "app/core/module_loader.py"
    text = replace_checked(result[name], "from fastapi import FastAPI\n", "from fastapi import FastAPI\n\nfrom app.core.resource_profile import module_available, profile_load_order, require_module\n")
    text = replace_checked(text, "        order = self.resolve_order()\n", "        order = profile_load_order(self.resolve_order(), self._manifests)\n")
    text = replace_checked(text, '        """Load a single module."""\n', '        """Load a single module."""\n        require_module(module_name, self._manifests)\n')
    text = replace_checked(text, '"enabled": name not in self._disabled,', '"enabled": name not in self._disabled and module_available(name, self._manifests),', 2)
    text = replace_checked(text, '"is_core": manifest.category == "core",', '"is_core": manifest.category == "core" and module_available(name, self._manifests),', 2)
    text = replace_checked(text, "        return module_name not in self._disabled\n", "        return module_name not in self._disabled and module_available(module_name, self._manifests)\n")
    text = replace_checked(text, "        manifest = self._manifests[module_name]\n\n        # Already enabled and loaded", "        require_module(module_name, self._manifests)\n        manifest = self._manifests[module_name]\n\n        # Already enabled and loaded")
    result[name] = text

    name = "app/main.py"
    text = replace_checked(result[name], "from app.core.module_loader import module_loader\n", "from app.core.module_loader import module_loader\nfrom app.core.resource_profile import ResourceProfileMiddleware, module_available\n")
    text = replace_checked(text, "    app.add_middleware(MaxBodySizeMiddleware, max_body_bytes=settings.max_request_body_bytes)\n", "    app.add_middleware(MaxBodySizeMiddleware, max_body_bytes=settings.max_request_body_bytes)\n    app.add_middleware(ResourceProfileMiddleware)\n")
    result[name] = guard_aliases(text)

    name = "app/core/processes/registry.py"
    text = replace_checked(result[name], "from app.core.processes.base import ManagedProcess\n", "from app.core.processes.base import ManagedProcess\nfrom app.core.resource_profile import process_profile_override\n")
    text = replace_checked(text, "    def _env(self, entry: _Entry) -> bool | None:\n", "    def _env(self, entry: _Entry) -> bool | None:\n        profile = process_profile_override(entry.spec.id)\n        if profile is not None:\n            return profile\n")
    result[name] = text

    name = "app/core/semantic_switch.py"
    text = replace_checked(result[name], "import threading\n", "import threading\n\nfrom app.core.resource_profile import free_tier_enabled\n")
    text = replace_checked(text, "    return _env_override() is not None\n", "    return free_tier_enabled() or _env_override() is not None\n")
    text = replace_checked(text, '    """Whether this installation may load the embedding model and vector store."""\n', '    """Whether this installation may load the embedding model and vector store."""\n    if free_tier_enabled():\n        return False\n')
    result[name] = text

    name = "app/modules/costs/matcher.py"
    text = replace_checked(result[name], "from app.modules.costs.models import CostItem\n", "from app.modules.costs.models import CostItem\nfrom app.core.resource_profile import free_tier_enabled\n")
    text = replace_checked(text, "    global _warned_missing_semantic_deps\n", "    global _warned_missing_semantic_deps\n\n    if free_tier_enabled():\n        return False\n")
    result[name] = text
    for filename, content in result.items():
        compile(content, filename, "exec")
    return result


def apply_profile(backend: Path) -> None:
    sources = {name: (backend / name).read_text(encoding="utf-8") for name in EXPECTED_HASHES}
    patched = patched_sources(sources)
    helper = Path(__file__).with_name("resource_profile.py").read_text(encoding="utf-8")
    compile(helper, "app/core/resource_profile.py", "exec")
    for name, source in patched.items():
        (backend / name).write_text(source, encoding="utf-8", newline="\n")
    (backend / "app/core/resource_profile.py").write_text(helper, encoding="utf-8", newline="\n")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python apply_profile.py /app/backend")
    apply_profile(Path(sys.argv[1]))
    print("Applied reviewed optional resource profile to OpenConstructionERP 18.6.4")
