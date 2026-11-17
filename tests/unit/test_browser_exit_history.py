"""Successful browser exits outlive proxy edits, checks and failed launches."""

import asyncio
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from camoufox_pm.core import fingerprint_store
from camoufox_pm.core.database import StorageManager
from camoufox_pm.core.models import BrowserExitRecord, Profile, ProxyCheckRecord
from camoufox_pm.core.proxy_inventory import ProxyInventory

PREVIOUS = BrowserExitRecord(
    checked_at=datetime(2026, 11, 14, tzinfo=timezone.utc),
    ip="198.51.100.9",
    country="DE",
    timezone="Europe/Berlin",
)


@pytest.fixture
def fake_browser(profile_manager, monkeypatch):
    monkeypatch.setattr(fingerprint_store, "resolve", lambda *args, **kwargs: {})

    async def launch(*args, **kwargs):
        return SimpleNamespace(process_id=None)

    monkeypatch.setattr(profile_manager.browser_sessions, "launch", launch)


@pytest.mark.asyncio
async def test_only_a_completed_launch_replaces_the_previous_exit(
    profile_manager, fake_browser, monkeypatch
):
    profile = await profile_manager.create_profile("waiting")
    await profile_manager.storage.set_browser_exit(profile.id, PREVIOUS)
    started, release = asyncio.Event(), asyncio.Event()

    async def launch(*args, **kwargs):
        started.set()
        await release.wait()
        return SimpleNamespace(process_id=None)

    monkeypatch.setattr(profile_manager.browser_sessions, "launch", launch)
    task = asyncio.create_task(profile_manager.launch_browser(profile.id))
    try:
        await asyncio.wait_for(started.wait(), 5)
        assert (await profile_manager.get_profile(profile.id)).last_browser_exit == PREVIOUS
    finally:
        release.set()
        await task
    stored = await profile_manager.get_profile(profile.id)
    assert stored.last_browser_exit.ip == "203.0.113.7"
    assert stored.last_browser_exit.checked_at > PREVIOUS.checked_at
    assert stored.last_browser_exit.proxy_changed is False
    assert stored.row_version == profile.row_version


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", [RuntimeError, asyncio.CancelledError])
async def test_browser_failure_after_a_successful_ip_lookup_preserves_history(
    profile_manager, fake_browser, monkeypatch, failure
):
    profile = await profile_manager.create_profile("failure")
    await profile_manager.storage.set_browser_exit(profile.id, PREVIOUS)

    async def fail(*args, **kwargs):
        raise failure("Browser did not start")

    monkeypatch.setattr(profile_manager.browser_sessions, "launch", fail)
    with pytest.raises(failure):
        await profile_manager.launch_browser(profile.id)
    assert (await profile_manager.get_profile(profile.id)).last_browser_exit == PREVIOUS
    assert (await profile_manager.storage.get_lease(profile.id))[0] is None


@pytest.mark.asyncio
@pytest.mark.parametrize("expected_version", [None, 0])
async def test_proxy_edits_keep_the_last_exit_and_mark_it_pending(
    profile_manager, expected_version
):
    profile = await profile_manager.create_profile("edit")
    await profile_manager.storage.set_browser_exit(profile.id, PREVIOUS)
    await profile_manager.update_profile(
        profile.id,
        {"proxy_config": {"type": "http", "server": "new.invalid:8080"}},
        expected_row_version=expected_version,
    )
    stored = await profile_manager.get_profile(profile.id)
    assert stored.last_browser_exit == PREVIOUS.model_copy(update={"proxy_changed": True})


@pytest.mark.asyncio
async def test_an_old_profile_snapshot_cannot_revert_new_launch_history(storage):
    profile = Profile(name="old editor snapshot")
    await storage.save_profile(profile)
    await storage.set_browser_exit(profile.id, PREVIOUS)
    profile.notes = "Edited after launch"
    await storage.update_profile(profile, expected_row_version=profile.row_version)
    stored = await storage.get_profile(profile.id)
    assert stored.last_browser_exit == PREVIOUS
    assert stored.notes == profile.notes


@pytest.mark.asyncio
async def test_proxy_inventory_assignment_preserves_exit_history(profile_manager):
    inventory = ProxyInventory(profile_manager)
    profile = await profile_manager.create_profile("assignment")
    await profile_manager.storage.set_browser_exit(profile.id, PREVIOUS)
    proxy = await inventory.create({"name": "new", "type": "http", "server": "new.invalid:8080"})
    result = await inventory.assign(proxy["id"], [{"id": profile.id, "row_version": 0}], 0)
    assert result["assigned"] == [profile.id]
    stored = await profile_manager.get_profile(profile.id)
    assert stored.last_browser_exit == PREVIOUS.model_copy(update={"proxy_changed": True})


@pytest.mark.asyncio
async def test_cloning_starts_without_inheriting_another_browsers_exit(profile_manager):
    source = await profile_manager.create_profile("source")
    await profile_manager.storage.set_browser_exit(source.id, PREVIOUS)
    clone = await profile_manager.clone_profile(source.id, "copy")
    assert clone.last_browser_exit is None
    assert (await profile_manager.get_profile(clone.id)).last_browser_exit is None
    assert (await profile_manager.get_profile(source.id)).last_browser_exit == PREVIOUS


@pytest.mark.asyncio
async def test_legacy_exit_migration_keeps_old_values_and_only_runs_once(tmp_path):
    database = str(tmp_path / "legacy.db")
    storage = StorageManager(database)
    await storage.initialize()
    check = ProxyCheckRecord(
        checked_at=PREVIOUS.checked_at, reachable=True, ip=PREVIOUS.ip, country=PREVIOUS.country
    )
    await storage.save_profile(
        Profile(id="used", name="used", last_used=datetime.now(), proxy_check=check)
    )
    await storage.save_profile(Profile(id="manual", name="manual", proxy_check=check))
    storage.db._connection.execute("ALTER TABLE profiles DROP COLUMN last_browser_exit")
    storage.db._connection.commit()
    await storage.close()
    await storage.initialize()
    try:
        historical = (await storage.get_profile("used")).last_browser_exit
        assert historical.ip == PREVIOUS.ip
        assert historical.legacy is True
        assert (await storage.get_profile("manual")).last_browser_exit is None
        # A later manual check must not be imported when the app restarts.
        manual = await storage.get_profile("manual")
        manual.last_used = datetime.now()
        await storage.update_profile(manual)
        await storage.close()
        await storage.initialize()
        assert (await storage.get_profile("manual")).last_browser_exit is None
    finally:
        await storage.close()


@pytest.mark.asyncio
async def test_unreadable_exit_history_does_not_break_the_list(storage):
    profile = Profile(name="unreadable")
    await storage.save_profile(profile)
    storage.db._connection.execute(
        "UPDATE profiles SET last_browser_exit = ? WHERE id = ?", ("{invalid json", profile.id)
    )
    storage.db._connection.commit()
    assert (await storage.get_profile(profile.id)).last_browser_exit is None
    assert len(await storage.list_profiles()) == 1


def test_launch_history_does_not_invalidate_sync_journals():
    from camoufox_pm.sync.apply import _profile_digest

    profile = Profile(name="journal")
    original = _profile_digest(profile)
    profile.last_browser_exit = PREVIOUS
    assert _profile_digest(profile) == original
    profile.last_browser_exit = PREVIOUS.model_copy(update={"proxy_changed": True})
    assert _profile_digest(profile) == original
    profile.name = "changed metadata"
    assert _profile_digest(profile) != original
