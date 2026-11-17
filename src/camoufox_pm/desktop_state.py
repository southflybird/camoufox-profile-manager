"""Local desktop preferences and OS-backed remembered login."""

import hashlib
import json
import os
import threading
from pathlib import Path
from urllib.parse import urlsplit


class DesktopState:
    def __init__(self, directory):
        self._path = Path(directory) / "desktop-state.json"
        self._lock = threading.RLock()
        self._window = None
        self._origin = None
        self._service = (
            "camoufox-pm.login."
            + hashlib.sha256(str(self._path.resolve()).encode()).hexdigest()[:24]
        )
        try:
            value = json.loads(self._path.read_text(encoding="utf-8"))
            self._data = value if isinstance(value, dict) else {}
        except (OSError, ValueError):
            self._data = {}
        if not isinstance(self._data.get("preferences"), dict):
            self._data["preferences"] = {}

    def _check(self):
        if (
            self._window is None
            or urlsplit(self._window.get_current_url() or "")[:2] != self._origin
        ):
            raise RuntimeError("Desktop access unavailable")

    def _write(self):
        with self._lock:
            target = self._path.with_suffix(".tmp")
            target.write_text(json.dumps(self._data), encoding="utf-8")
            os.replace(target, self._path)

    def get_preferences(self, user):
        self._check()
        with self._lock:
            return self._data.get("preferences", {}).get(str(user)[:255], {})

    def set_preferences(self, user, value):
        self._check()
        if not isinstance(value, dict) or len(json.dumps(value)) > 16384:
            raise ValueError("Invalid preferences")
        with self._lock:
            self._data.setdefault("preferences", {})[str(user)[:255]] = value
            self._write()

    def _keyring(self):
        import sys

        import keyring

        if sys.platform == "win32":
            from keyring.backends.Windows import WinVaultKeyring

            return WinVaultKeyring()
        backend = keyring.get_keyring()
        if type(backend).__module__ not in (
            "keyring.backends.macOS",
            "keyring.backends.SecretService",
        ):
            raise RuntimeError("System credential storage unavailable")
        return backend

    def read_login(self):
        self._check()
        raw = self._keyring().get_password(self._service, "last-login")
        return json.loads(raw) if raw else None

    def save_login(self, username, password):
        self._check()
        if (
            not isinstance(username, str)
            or not isinstance(password, str)
            or len(username) > 255
            or len(password) > 4096
        ):
            raise ValueError("Invalid credentials")
        self._keyring().set_password(
            self._service, "last-login", json.dumps({"username": username, "password": password})
        )

    def clear_login(self):
        self._check()
        backend = self._keyring()
        if backend.get_password(self._service, "last-login") is not None:
            backend.delete_password(self._service, "last-login")
