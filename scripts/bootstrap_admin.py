#!/usr/bin/env python3
"""Create the first administrator from the application's private exec console.

Run ``python /opt/deployment/bootstrap_admin.py`` in an interactive terminal
before making the application port public. Credentials are never accepted as
arguments or environment variables. The upstream API decides whether the
database is fresh; closed registration prevents creating subsequent users.
"""

from __future__ import annotations

import getpass
from http.client import HTTPException
import json
import os
import re
import sys
import warnings
from urllib import error, request


REGISTER_URL = "http://127.0.0.1:8080/api/v1/users/auth/register"
REQUEST_TIMEOUT_SECONDS = 15
MAX_RESPONSE_BYTES = 16_384


class BootstrapError(Exception):
    """An operator-facing error whose message contains no server/user secrets."""


class RefuseRedirects(request.HTTPRedirectHandler):
    """Never forward a registration body, including to another local path."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def validate_password(password: str, confirmation: str) -> None:
    """Apply a stronger minimum than the upstream public registration form."""
    if password != confirmation:
        raise BootstrapError("Passwords do not match. No request was sent.")
    if not 12 <= len(password) <= 128:
        raise BootstrapError("Use a password with 12 to 128 characters. No request was sent.")
    if not any(char.isalpha() for char in password) or not any(char.isdigit() for char in password):
        raise BootstrapError("The password must contain a letter and a digit. No request was sent.")


def collect_credentials() -> dict[str, str]:
    email = input("Administrator email: ").strip()
    if len(email) > 254 or not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
        raise BootstrapError("Enter a valid administrator email. No request was sent.")

    full_name = input("Administrator full name: ").strip()
    if not 1 <= len(full_name) <= 255 or any(
        ord(char) < 32 or char in "<>" for char in full_name
    ):
        raise BootstrapError("Enter a plain-text name with 1 to 255 characters. No request was sent.")

    # getpass normally falls back to echoed stdin when a terminal is missing.
    # Turning that warning into an exception keeps the password hidden.
    with warnings.catch_warnings():
        warnings.simplefilter("error", getpass.GetPassWarning)
        try:
            password = getpass.getpass("Administrator password (12+ characters, letter and digit): ")
            confirmation = getpass.getpass("Confirm administrator password: ")
        except getpass.GetPassWarning:
            raise BootstrapError("Hidden password input is unavailable. Use an interactive exec terminal.") from None

    validate_password(password, confirmation)
    # Do not send a role: the server alone selects the first user's admin role.
    return {"email": email, "password": password, "full_name": full_name}


def register_admin(credentials: dict[str, str]) -> None:
    """Send one local request, without retries or disclosure of response data."""
    opener = request.build_opener(request.ProxyHandler({}), RefuseRedirects())
    registration = request.Request(
        REGISTER_URL,
        data=json.dumps(credentials).encode("utf-8"),
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    try:
        with opener.open(registration, timeout=REQUEST_TIMEOUT_SECONDS) as response:
            if response.status != 201:
                raise BootstrapError("The server did not confirm account creation. Keep the service private.")
            body = response.read(MAX_RESPONSE_BYTES + 1)
    except error.HTTPError as exc:
        status = exc.code
        exc.close()
        if status == 403:
            raise BootstrapError(
                "Bootstrap refused: registration is closed and an account already exists. "
                "Use the existing administrator or the documented recovery procedure."
            ) from None
        if status == 409:
            raise BootstrapError("Bootstrap refused: that email is already registered. No account was changed.") from None
        if status == 422:
            raise BootstrapError("The server rejected the account details. Check the email, name and password policy.") from None
        if status == 429:
            raise BootstrapError("Registration is rate-limited. Wait before checking the account and retrying.") from None
        if 300 <= status < 400:
            raise BootstrapError("The local endpoint redirected the request. No redirect was followed.") from None
        raise BootstrapError(
            f"Registration failed (HTTP {status}). Keep the service private and inspect the application status."
        ) from None
    except (error.URLError, OSError, HTTPException):
        raise BootstrapError(
            "The local request failed or timed out. Account creation is unconfirmed; "
            "check the application before retrying."
        ) from None

    try:
        if len(body) > MAX_RESPONSE_BYTES:
            raise ValueError
        account = json.loads(body)
        confirmed = (
            isinstance(account, dict)
            and account.get("role") == "admin"
            and account.get("is_active") is True
            and isinstance(account.get("email"), str)
            and account["email"].casefold() == credentials["email"].casefold()
        )
    except (ValueError, UnicodeDecodeError):
        confirmed = False
    if not confirmed:
        raise BootstrapError(
            "The response did not confirm an active administrator. "
            "Keep the service private and inspect existing accounts before retrying."
        )


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    try:
        if args:
            raise BootstrapError("This helper takes no arguments. Enter credentials only at its interactive prompts.")
        if not sys.stdin.isatty():
            raise BootstrapError("Use an interactive Northflank exec terminal; piped input is refused.")
        if os.environ.get("OE_REGISTRATION_MODE", "").strip().lower() != "closed":
            raise BootstrapError("Set OE_REGISTRATION_MODE=closed on the service and restart it before bootstrap.")
        print("Create the first administrator. Keep the application port private until this succeeds.")
        credentials = collect_credentials()
        register_admin(credentials)
    except BootstrapError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    except (EOFError, KeyboardInterrupt):
        print("\nCancelled. Account creation is unconfirmed if a request was already sent.", file=sys.stderr)
        return 1
    print("Administrator created and confirmed active. Sign in with the credentials you entered.")
    print("You can now enable the application's public HTTPS port; keep registration closed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
