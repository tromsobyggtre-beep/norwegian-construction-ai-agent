"""Resource policy and the exact upstream patch, without database dependencies."""

from __future__ import annotations

import asyncio
import ast
import importlib.util
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
DEPLOY = ROOT / "deploy" / "free-tier"
UPSTREAM = ROOT / "openconstructionerp" / "backend"


def load_script(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


profile = load_script("erp_resource_profile", DEPLOY / "resource_profile.py")
patcher = load_script("erp_profile_patcher", DEPLOY / "apply_profile.py")


def manifests():
    result = {
        name: SimpleNamespace(
            name=name, depends=[], optional_depends=[], enabled=True,
            category="core", version="1", display_name=name,
            display_name_i18n={}, description="", author="", auto_install=True,
        )
        for name in profile.FREE_TIER_MODULES | {"oe_clash", "oe_dashboards"}
    }
    result["oe_projects"].depends = ["oe_users"]
    result["oe_boq"].depends = ["oe_projects"]
    result["oe_assemblies"].depends = ["oe_costs", "oe_fx"]
    return result


class ProfilePolicyTests(unittest.TestCase):
    def test_absent_default_full_do_not_change_selection_or_http(self):
        for value in ("", "default", "full"):
            with self.subTest(value=value), mock.patch.dict(profile.os.environ, {profile.PROFILE_ENV: value}):
                items = manifests()
                order = list(items)
                self.assertIs(profile.profile_load_order(order, items), order)
                self.assertTrue(profile.module_available("oe_clash", items))
                self.assertIsNone(profile.process_profile_override("cwicr_ranker"))
                self.assertFalse(profile.blocked_request("/api/v1/costs/load-cwicr/DE", "POST"))

    def test_unknown_profile_fails_closed(self):
        with mock.patch.dict(profile.os.environ, {profile.PROFILE_ENV: "free-typo"}):
            with self.assertRaisesRegex(ValueError, "Unsupported"):
                profile.free_tier_enabled()

    def test_dependency_closure_validates_and_does_not_mutate_manifests(self):
        items = manifests()
        self.assertEqual(
            profile.dependency_closure(["oe_boq"], items),
            {"oe_users", "oe_projects", "oe_boq"},
        )
        self.assertTrue(all(item.enabled for item in items.values()))
        with self.assertRaisesRegex(ValueError, "Missing"):
            profile.dependency_closure(["oe_unknown"], items)
        items["oe_users"].depends = ["oe_boq"]
        with self.assertRaisesRegex(ValueError, "Circular"):
            profile.dependency_closure(["oe_boq"], items)

    def test_profile_preserves_required_modules_and_blocks_legacy_models(self):
        with mock.patch.dict(profile.os.environ, {profile.PROFILE_ENV: "free-tier"}):
            items = manifests()
            chosen = profile.profile_load_order(list(items), items)
            self.assertEqual(set(chosen), profile.FREE_TIER_MODULES)
            self.assertTrue(profile.module_available("oe_validation", items))
            with self.assertRaisesRegex(ValueError, "unavailable"):
                profile.require_module("oe_clash", items)
            for process in ("cwicr_ranker", "bge_reranker", "embedding_model", "openapi_prime"):
                self.assertIs(profile.process_profile_override(process), False)
            with self.assertRaisesRegex(ValueError, "disabled"):
                profile.profile_load_order([n for n in items if n != "oe_boq"], items)

    def test_heavy_routes_denied_but_auth_crud_validation_and_small_boq_import_remain(self):
        denied = [
            ("/api/v1/costs/load-cwicr/DE/", "POST"),
            ("/api/v1/costs/import/pricelist/uploads/", "POST"),
            ("/api/v1/costs/bulk/", "POST"),
            ("/api/v1/costs/catalogues-v3/DE/install", "POST"),
            ("/api/v1/costs/vector/load-github/DE", "POST"),
            ("/api/v1/onboarding/provision", "POST"),
            ("/api/demo/install/sample", "POST"),
            ("/api/v1/boq/boqs/abc/import/smart/", "POST"),
        ]
        allowed = [
            ("/api/v1/users/login/", "POST"),
            ("/api/v1/projects/", "POST"),
            ("/api/v1/boq/positions/", "POST"),
            ("/api/v1/costs/", "POST"),
            ("/api/v1/costs/match/", "POST"),
            ("/api/v1/validation/validate/", "POST"),
            ("/api/v1/boq/boqs/abc/import/excel/", "POST"),
            ("/api/v1/modules/oe_clash/enable", "POST"),
        ]
        with mock.patch.dict(profile.os.environ, {profile.PROFILE_ENV: "free-tier"}):
            for path, method in denied:
                with self.subTest(path=path):
                    self.assertTrue(profile.blocked_request(path, method))
            for path, method in allowed:
                with self.subTest(path=path):
                    self.assertFalse(profile.blocked_request(path, method))

    def test_http_guard_rejects_without_reading_upload_or_calling_app(self):
        async def check():
            receive, app, send = mock.AsyncMock(), mock.AsyncMock(), mock.AsyncMock()
            middleware = profile.ResourceProfileMiddleware(app)
            await middleware({"type": "http", "path": "/api/v1/costs/bulk/", "method": "POST"}, receive, send)
            receive.assert_not_awaited()
            app.assert_not_awaited()
            self.assertEqual(send.await_args_list[0].args[0]["status"], 403)
        with mock.patch.dict(profile.os.environ, {profile.PROFILE_ENV: "free-tier"}):
            asyncio.run(check())


@unittest.skipUnless((UPSTREAM / "app/main.py").is_file(), "Upstream submodule not initialized")
class UpstreamPatchTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.original = {name: (UPSTREAM / name).read_text(encoding="utf-8") for name in patcher.EXPECTED_HASHES}
        cls.patched = patcher.patched_sources(cls.original)

    def test_unknown_upstream_refused_before_writes(self):
        changed = dict(self.original)
        changed["app/main.py"] += "\n# new release\n"
        with self.assertRaisesRegex(ValueError, "Unsupported upstream source"):
            patcher.patched_sources(changed)

    def test_schema_model_discovery_is_byte_for_byte_retained_and_all_aliases_guarded(self):
        original = self.original["app/main.py"]
        start = original.index("            for _m in pkgutil.iter_modules(_modules_pkg.__path__):")
        end = original.index("            # Add missing columns", start)
        self.assertIn(original[start:end], self.patched["app/main.py"])
        self.assertEqual(self.patched["app/main.py"].count('if module_available("oe_'), 6)
        # Compile the real source, rather than a fixture copying the anchors.
        for name, source in self.patched.items():
            compile(source, name, "exec")

    def test_real_upstream_manifest_dependency_closure_is_valid(self):
        items = {}
        for path in (UPSTREAM / "app/modules").glob("*/manifest.py"):
            tree = ast.parse(path.read_text(encoding="utf-8"))
            for node in ast.walk(tree):
                if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "ModuleManifest":
                    fields = {keyword.arg: keyword.value for keyword in node.keywords}
                    name = ast.literal_eval(fields["name"])
                    dependencies = ast.literal_eval(fields["depends"]) if "depends" in fields else []
                    items[name] = SimpleNamespace(depends=dependencies)
        closure = profile.dependency_closure(profile.FREE_TIER_MODULES, items)
        self.assertEqual(closure, profile.FREE_TIER_MODULES)

    def loader(self):
        fastapi = ModuleType("fastapi")
        fastapi.FastAPI = object
        state = ModuleType("app.core.module_state")
        state.load_module_states = lambda: {}
        state.set_module_enabled = mock.Mock()
        overrides = {
            "fastapi": fastapi, "app.core.resource_profile": profile,
            "app.core.module_state": state,
        }
        module = ModuleType("resource_profile_test_loader")
        module.__file__ = str(UPSTREAM / "app/core/module_loader.py")
        # Dataclasses consult sys.modules while resolving annotations.
        overrides[module.__name__] = module
        context = mock.patch.dict(sys.modules, overrides)
        context.start()
        self.addCleanup(context.stop)
        exec(compile(self.patched["app/core/module_loader.py"], "module_loader.py", "exec"), module.__dict__)
        loader = module.ModuleLoader()
        loader._manifests = manifests()
        loader.discover = mock.Mock()
        return loader, state

    def test_native_loader_skips_heavy_imports_lists_exclusions_and_refuses_enable(self):
        async def check():
            loader, state = self.loader()
            loader._load_module = mock.AsyncMock()
            await loader.load_all(object())
            loaded = {call.args[0] for call in loader._load_module.await_args_list}
            self.assertEqual(loaded, profile.FREE_TIER_MODULES)
            rows = {row["name"]: row for row in loader.list_modules()}
            self.assertFalse(rows["oe_clash"]["enabled"])
            self.assertFalse(rows["oe_clash"]["is_core"])
            self.assertFalse(loader.is_enabled("oe_clash"))
            self.assertTrue(rows["oe_validation"]["is_core"])
            with self.assertRaisesRegex(ValueError, "unavailable"):
                await loader.enable_module("oe_clash", object())
            state.set_module_enabled.assert_not_called()
            self.assertTrue(all(m.enabled for m in loader._manifests.values()))
        with mock.patch.dict(profile.os.environ, {profile.PROFILE_ENV: "free-tier"}):
            asyncio.run(check())

    def test_native_loader_full_mode_keeps_all_core_modules(self):
        async def check():
            loader, _ = self.loader()
            loader._load_module = mock.AsyncMock()
            await loader.load_all(object())
            self.assertEqual(loader._load_module.await_count, len(loader._manifests))
            self.assertTrue(loader.is_enabled("oe_clash"))
            row = next(item for item in loader.list_modules() if item["name"] == "oe_clash")
            self.assertTrue(row["enabled"])
            self.assertTrue(row["is_core"])
        with mock.patch.dict(profile.os.environ, {profile.PROFILE_ENV: ""}):
            asyncio.run(check())


if __name__ == "__main__":
    unittest.main()
