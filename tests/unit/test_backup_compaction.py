import json
import zipfile
from pathlib import Path

from camoufox_pm.core import profile_archive
from camoufox_pm.core.backup_cleanup import run_cleanup
from camoufox_pm.core.backups import ProfileBackupManager
from camoufox_pm.core.browser_data_policy import default_ublock_origins, disposable_ublock_path
from tests.unit.test_recovery import seeded

FIXTURE = json.loads((Path(__file__).parents[1] / "fixtures/ublock-policy-v1.json").read_text())


def install_fixture(path):
    (path / "prefs.js").write_bytes(FIXTURE["prefs"].encode())
    (path / "extensions.json").write_text(json.dumps(FIXTURE["installed"]))
    for name in FIXTURE["removed"] + FIXTURE["kept"]:
        target = path / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b"payload")


def test_shared_policy_and_explicit_extensions():
    files = {
        "prefs.js": FIXTURE["prefs"].encode(),
        "extensions.json": json.dumps(FIXTURE["installed"]).encode(),
    }
    origins = default_ublock_origins(FIXTURE["profile"], files.__getitem__)
    assert origins
    assert all(disposable_ublock_path(n, origins) for n in FIXTURE["removed"])
    assert not any(disposable_ublock_path(n, origins) for n in FIXTURE["kept"])
    assert default_ublock_origins({"extensions": [".cpm-addons/explicit"]}, files.__getitem__) == ()
    files["extensions.json"] = b'{"addons":[{"id":"uBlock0@raymondhill.net"}]}'
    assert default_ublock_origins(FIXTURE["profile"], files.__getitem__) == ()
    files["extensions.json"] = b"invalid"
    assert default_ublock_origins(FIXTURE["profile"], files.__getitem__) == ()


async def test_cleanup_preserves_retained_data_and_identity(profile_manager):
    profile, path = await seeded(profile_manager)
    install_fixture(path)
    old = path.parent / "legacy.zip"
    profile_archive.export_profile(profile, path, old, compact_defaults=False)
    backups = ProfileBackupManager(profile_manager)
    backup = (await backups.create_backups())["backups"][0]
    # Simulate a pre-upgrade backup without modifying real runtime data.
    backups._archive_path(backup["id"]).write_bytes(old.read_bytes())
    before = await profile_manager.get_profile(profile.id)
    preview = await run_cleanup(backups, False)
    assert preview["candidates"] == 2 and preview["estimated_bytes"] > 0
    assert all((path / n).exists() for n in FIXTURE["removed"])
    result = await run_cleanup(backups, True)
    assert result["failed"] == [] and result["skipped"] == []
    assert all(not (path / n).exists() for n in FIXTURE["removed"])
    assert all((path / n).read_bytes() == b"payload" for n in FIXTURE["kept"])
    after = await profile_manager.get_profile(profile.id)
    assert after.row_version == before.row_version and after.id == before.id
    kept = backups.list_backups()
    assert len(kept) == 1
    with zipfile.ZipFile(backups._archive_path(kept[0]["id"])) as archive:
        assert all("data/" + n not in archive.namelist() for n in FIXTURE["removed"])
    again = await run_cleanup(backups, True)
    assert again["released_bytes"] == 0


async def test_dedup_rotation_checkpoints_and_file_changes(profile_manager):
    profile, path = await seeded(profile_manager)
    backups = ProfileBackupManager(profile_manager)
    initial = (await backups.create_due_backups())["backups"][0]
    assert not (await backups.create_due_backups())["backups"]
    reused = await backups.create_backups(reason="before_update")
    assert reused["reused"][0]["id"] == initial["id"]
    for i in range(3):
        (path / "cookies.sqlite").write_bytes(f"version-{i}".encode())
        assert len((await backups.create_backups())["backups"]) == 1
    assert len(backups.list_backups()) == 3
    for item in backups.list_backups():
        restored = await backups.restore_backup(item["id"])
        assert Path(restored.storage_path, "cookies.sqlite").exists()
    # A damaged file cannot be reused, even if the metadata digest still matches.
    newest = backups._archive_path(backups.list_backups()[0]["id"])
    newest.write_bytes(b"corrupt")
    assert len((await backups.create_backups([profile.id]))["backups"]) == 1
    newest = backups._archive_path(backups.list_backups()[0]["id"])
    with zipfile.ZipFile(newest, "w") as malformed:
        malformed.writestr("data/cookies.sqlite", b"version-2")
    assert len((await backups.create_backups([profile.id]))["backups"]) == 1


async def test_trash_and_busy_cleanup(profile_manager):
    profile, path = await seeded(profile_manager)
    install_fixture(path)
    backups = ProfileBackupManager(profile_manager)
    await profile_manager.delete_profile(profile.id)
    assert (await backups.create_due_backups())["backups"] == []
    assert (await backups.create_backups(reason="before_update"))["backups"]
    before = await profile_manager.storage.get_profile(profile.id, include_deleted=True)
    assert (await run_cleanup(backups, True))["failed"] == []
    after = await profile_manager.storage.get_profile(profile.id, include_deleted=True)
    assert after.row_version == before.row_version and after.deleted_at == before.deleted_at


async def test_failed_cleanup_preserves_original(profile_manager, monkeypatch):
    profile, path = await seeded(profile_manager)
    install_fixture(path)
    backups = ProfileBackupManager(profile_manager)

    def fail(*args, **kwargs):
        raise OSError("disk full")

    monkeypatch.setattr(profile_archive, "export_profile", fail)
    result = await run_cleanup(backups, True)
    assert result["skipped"]
    assert all((path / n).exists() for n in FIXTURE["removed"])
