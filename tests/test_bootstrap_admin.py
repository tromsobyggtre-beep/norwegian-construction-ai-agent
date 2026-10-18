"""Bootstrap contract and credential handling, with every HTTP call mocked."""

from __future__ import annotations

import contextlib
import getpass
from http.client import IncompleteRead
import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest import mock
from urllib import error, request


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "bootstrap_admin.py"
SPEC = importlib.util.spec_from_file_location("bootstrap_admin", SCRIPT)
bootstrap = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bootstrap)

PASSWORD = "Private-admin-90210!"
TOKEN = "sensitive-server-token"
EMAIL = "owner@example.com"


class BootstrapAdminTests(unittest.TestCase):
    def run_helper(self, opener, passwords=None):
        output, errors = io.StringIO(), io.StringIO()
        with (
            mock.patch.dict(bootstrap.os.environ, {"OE_REGISTRATION_MODE": "closed"}),
            mock.patch.object(bootstrap.sys.stdin, "isatty", return_value=True),
            mock.patch("builtins.input", side_effect=[EMAIL, "Construction Owner"]),
            mock.patch.object(bootstrap.getpass, "getpass", side_effect=passwords or [PASSWORD, PASSWORD]),
            mock.patch.object(bootstrap.request, "build_opener", return_value=opener),
            contextlib.redirect_stdout(output),
            contextlib.redirect_stderr(errors),
        ):
            result = bootstrap.main([])
        rendered = output.getvalue() + errors.getvalue()
        self.assertNotIn(PASSWORD, rendered)
        self.assertNotIn(TOKEN, rendered)
        return result, rendered

    @staticmethod
    def opener_for(account, status=201):
        response = mock.MagicMock()
        response.status = status
        response.read.return_value = json.dumps(account).encode("utf-8")
        response.__enter__.return_value = response
        opener = mock.Mock()
        opener.open.return_value = response
        return opener

    def test_first_admin_request_matches_release_schema_and_does_not_print_secrets(self):
        opener = self.opener_for(
            {"email": EMAIL, "role": "admin", "is_active": True, "access_token": TOKEN}
        )
        result, output = self.run_helper(opener)
        self.assertEqual(result, 0)
        self.assertIn("Administrator created and confirmed active", output)
        self.assertEqual(opener.open.call_count, 1)
        registration = opener.open.call_args.args[0]
        self.assertEqual(registration.full_url, "http://127.0.0.1:8080/api/v1/users/auth/register")
        self.assertEqual(registration.get_method(), "POST")
        self.assertEqual(
            json.loads(registration.data),
            {"email": EMAIL, "password": PASSWORD, "full_name": "Construction Owner"},
        )
        self.assertGreater(opener.open.call_args.kwargs["timeout"], 0)

    def test_invalid_passwords_never_send_a_request(self):
        cases = [
            [PASSWORD, "Different-secret-123!"],
            ["short1", "short1"],
            ["longpasswordwithoutdigits", "longpasswordwithoutdigits"],
            ["123456789012345", "123456789012345"],
            ["A1" * 65, "A1" * 65],
        ]
        for passwords in cases:
            with self.subTest(case=len(passwords[0])):
                opener = mock.Mock()
                result, output = self.run_helper(opener, passwords)
                self.assertEqual(result, 1)
                self.assertIn("No request was sent", output)
                opener.open.assert_not_called()
                for secret in passwords:
                    self.assertNotIn(secret, output)

    def test_existing_install_or_email_is_rejected_without_retries_or_error_echo(self):
        for status in (403, 409):
            with self.subTest(status=status):
                body = io.BytesIO(f'{PASSWORD} {TOKEN}'.encode())
                opener = mock.Mock()
                opener.open.side_effect = error.HTTPError(
                    bootstrap.REGISTER_URL, status, f"Server echoed {PASSWORD}", {}, body
                )
                result, output = self.run_helper(opener)
                self.assertEqual(result, 1)
                self.assertIn("Bootstrap refused", output)
                self.assertEqual(opener.open.call_count, 1)
                self.assertTrue(body.closed)

    def test_successful_nonadmin_response_is_never_reported_as_bootstrap_success(self):
        for changes in ({"role": "viewer"}, {"is_active": False}, {"email": "other@example.com"}):
            account = {"email": EMAIL, "role": "admin", "is_active": True, "token": TOKEN}
            account.update(changes)
            with self.subTest(changes=changes):
                result, output = self.run_helper(self.opener_for(account))
                self.assertEqual(result, 1)
                self.assertIn("did not confirm an active administrator", output)
                self.assertNotIn("Administrator created", output)

    def test_connection_failure_hides_exception_text_and_warns_about_unknown_result(self):
        failures = (
            error.URLError(f"Internal error containing {PASSWORD} {TOKEN}"),
            IncompleteRead(f"{PASSWORD} {TOKEN}".encode()),
        )
        for failure in failures:
            with self.subTest(failure=type(failure).__name__):
                opener = mock.Mock()
                opener.open.side_effect = failure
                result, output = self.run_helper(opener)
                self.assertEqual(result, 1)
                self.assertIn("Account creation is unconfirmed", output)
                self.assertEqual(opener.open.call_count, 1)

    def test_invalid_or_oversized_server_response_is_not_printed(self):
        for body in (f"invalid json {PASSWORD} {TOKEN}".encode(), b"a" * 16_385):
            opener = self.opener_for({})
            opener.open.return_value.read.return_value = body
            with self.subTest(size=len(body)):
                result, output = self.run_helper(opener)
                self.assertEqual(result, 1)
                self.assertIn("did not confirm an active administrator", output)

    def test_interactive_terminal_and_closed_registration_are_required_before_prompts(self):
        for interactive, mode in ((False, "closed"), (True, "open"), (True, "")):
            with (
                self.subTest(interactive=interactive, mode=mode),
                mock.patch.dict(bootstrap.os.environ, {"OE_REGISTRATION_MODE": mode}),
                mock.patch.object(bootstrap.sys.stdin, "isatty", return_value=interactive),
                mock.patch("builtins.input") as prompt,
                mock.patch.object(bootstrap.request, "build_opener") as build_opener,
                contextlib.redirect_stderr(io.StringIO()),
            ):
                self.assertEqual(bootstrap.main([]), 1)
                prompt.assert_not_called()
                build_opener.assert_not_called()

    def test_password_arguments_are_refused_without_echo(self):
        errors = io.StringIO()
        with contextlib.redirect_stderr(errors), mock.patch("builtins.input") as prompt:
            self.assertEqual(bootstrap.main([PASSWORD]), 1)
        self.assertNotIn(PASSWORD, errors.getvalue())
        prompt.assert_not_called()

    def test_hidden_input_cannot_fall_back_to_echoed_password(self):
        opener = mock.Mock()
        result, output = self.run_helper(opener, [getpass.GetPassWarning("No hidden terminal")])
        self.assertEqual(result, 1)
        self.assertIn("Hidden password input is unavailable", output)
        opener.open.assert_not_called()

    def test_proxy_bypass_and_redirect_refusal_protect_registration_credentials(self):
        # Exercise the helper's real opener construction, intercepting its
        # transport before anything can leave the process.
        built_openers = []
        stdlib_build_opener = request.build_opener
        response = self.opener_for({"email": EMAIL, "role": "admin", "is_active": True}).open.return_value

        def capture_opener(*handlers):
            opener = stdlib_build_opener(*handlers)
            built_openers.append(opener)
            return opener

        with (
            mock.patch.dict(bootstrap.os.environ, {"http_proxy": "http://proxy.example:3128"}),
            mock.patch.object(request, "build_opener", side_effect=capture_opener),
            mock.patch.object(request.OpenerDirector, "open", return_value=response) as transport,
        ):
            bootstrap.register_admin({"email": EMAIL, "password": PASSWORD, "full_name": "Owner"})
        transport.assert_called_once()
        opener = built_openers[0]
        self.assertFalse(any(isinstance(handler, request.ProxyHandler) for handler in opener.handlers))
        redirects = next(handler for handler in opener.handlers if isinstance(handler, bootstrap.RefuseRedirects))
        original = request.Request(bootstrap.REGISTER_URL, data=b"secret", method="POST")
        for target in ("https://external.example/register", "http://127.0.0.1:8080/elsewhere"):
            with self.subTest(target=target):
                self.assertIsNone(redirects.redirect_request(original, None, 307, "Temporary redirect", {}, target))


if __name__ == "__main__":
    unittest.main()
