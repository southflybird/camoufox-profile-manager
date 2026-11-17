"""Versioned, conservative policy for the formerly bundled uBlock storage.

Only a mapped uBlock origin with no installed/managed uBlock is disposable.
The same policy is implemented by MyDrive; ambiguous input always retains data.
"""

import hashlib
import json
import re
import zipfile

UBLOCK_ID = "uBlock0@raymondhill.net"
POLICY_VERSION = 1
VOLATILE_FIELDS = {
    "id",
    "storage_path",
    "row_version",
    "updated_at",
    "last_used",
    "proxy_check",
    "last_browser_exit",
    "deleted_at",
}


def default_ublock_origins(record: dict, read) -> tuple[str, ...]:
    try:
        # Managed extensions are explicit user intent. Never guess their identity.
        if record.get("extensions") != []:
            return ()
        installed = json.loads(read("extensions.json"))
        if not isinstance(installed["addons"], list) or any(
            not isinstance(addon, dict)
            or not isinstance(addon.get("id"), str)
            or addon.get("id") == UBLOCK_ID
            for addon in installed["addons"]
        ):
            return ()
        prefs = read("prefs.js").decode("utf-8")
        matches = re.findall(
            r'^user_pref\("extensions\.webextensions\.uuids", ("(?:[^"\\]|\\.)*")\);\r?$',
            prefs,
            re.MULTILINE,
        )
        if len(matches) != 1:
            return ()
        mapping = json.loads(json.loads(matches[0]))
        if not isinstance(mapping, dict) or not all(isinstance(v, str) for v in mapping.values()):
            return ()
        uid = mapping[UBLOCK_ID]
        if not isinstance(uid, str) or not re.fullmatch(
            r"[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}", uid
        ):
            return ()
        return ("storage/default/moz-extension+++" + uid,)
    except (OSError, ValueError, KeyError, TypeError, AttributeError, UnicodeError):
        return ()


def disposable_ublock_path(name: str, origins: tuple[str, ...]) -> bool:
    origin = name.split("/", 3)
    if len(origin) < 3:
        return False
    root = "/".join(origin[:3])
    return any(
        root == base or re.fullmatch(re.escape(base) + r"\^userContextId=[0-9]+", root)
        for base in origins
    )


def archive_origins(archive: zipfile.ZipFile) -> tuple[str, ...]:
    def read(name):
        entry = archive.getinfo("data/" + name)
        if entry.file_size > 4 * 1024 * 1024:
            raise ValueError("Oversized extension metadata")
        return archive.read(entry)

    if archive.getinfo("profile.json").file_size > 4 * 1024 * 1024:
        raise ValueError("Oversized profile metadata")
    record = json.loads(archive.read("profile.json"))
    return default_ublock_origins(record, read)


def archive_digest(source) -> str:
    """Hash actual retained content, independent of ZIP order or timestamps."""
    digest = hashlib.sha256(b"cpm-backup-content-v1\0")
    with zipfile.ZipFile(source) as archive:
        try:
            for name in ("profile.json", "manifest.json"):
                if archive.getinfo(name).file_size > 4 * 1024 * 1024:
                    raise ValueError("Oversized profile metadata")
            manifest = json.loads(archive.read("manifest.json"))
            record = json.loads(archive.read("profile.json"))
        except KeyError as exc:
            raise ValueError("Missing profile archive metadata") from exc
        if (
            not isinstance(manifest, dict)
            or manifest.get("format_version") != 1
            or not isinstance(record, dict)
        ):
            raise ValueError("Invalid profile archive metadata")
        if sum(i.file_size for i in archive.infolist()) > 2 * 1024**3:
            raise ValueError("Archive exceeds backup limit")
        record = {k: v for k, v in record.items() if k not in VOLATILE_FIELDS}
        digest.update(json.dumps(record, sort_keys=True, separators=(",", ":")).encode())
        seen = set()
        for entry in sorted(archive.infolist(), key=lambda i: i.filename):
            if entry.filename in seen:
                raise ValueError("Duplicate archive entry")
            seen.add(entry.filename)
            if not entry.filename.startswith("data/") or entry.is_dir():
                continue
            digest.update(entry.filename.encode() + b"\0")
            digest.update(str(entry.file_size).encode() + b"\0")
            with archive.open(entry) as member:
                while chunk := member.read(1024 * 1024):
                    digest.update(chunk)
    return digest.hexdigest()
