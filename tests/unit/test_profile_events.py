"""Committed invalidations, slow consumers, authorization and desktop persistence."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock
from urllib.parse import urlsplit

import pytest

from camoufox_pm.core import events
from camoufox_pm.core.database import StaleWriteError
from camoufox_pm.core.models import Profile
from camoufox_pm.desktop_state import DesktopState


@pytest.mark.asyncio
async def test_only_committed_profile_writes_notify(storage):
    queue = asyncio.Queue(maxsize=4)
    events.subscribers.add(queue)
    try:
        profile = Profile(name="original")
        await storage.save_profile(profile)
        assert (await queue.get())["profile_id"] == profile.id
        await storage.update_profile(profile, expected_row_version=profile.row_version)
        await queue.get()
        with pytest.raises(StaleWriteError):
            await storage.update_profile(profile, expected_row_version=profile.row_version - 1)
        assert queue.empty()
    finally:
        events.subscribers.discard(queue)


def test_overflow_replaces_backlog_with_reset():
    queue = asyncio.Queue(maxsize=2)
    events.subscribers.add(queue)
    try:
        events.publish("one")
        events.publish("two")
        events.publish("three")
        assert queue.qsize() == 1
        assert queue.get_nowait()["profile_id"] is None
    finally:
        events.subscribers.discard(queue)


def test_preferences_survive_port_change_without_plaintext_credentials(tmp_path):
    first = DesktopState(tmp_path)
    first._origin = urlsplit("http://127.0.0.1:1234/")[:2]
    first._window = SimpleNamespace(get_current_url=lambda: "http://127.0.0.1:1234/")
    first.set_preferences("alice", {"sort": "created_at", "hidden": ["group"]})
    second = DesktopState(tmp_path)
    second._origin = urlsplit("http://127.0.0.1:5678/")[:2]
    second._window = SimpleNamespace(get_current_url=lambda: "http://127.0.0.1:5678/")
    assert second.get_preferences("alice")["sort"] == "created_at"
    assert second.get_preferences("bob") == {}
    assert first._service == second._service
    second._window = SimpleNamespace(get_current_url=lambda: "https://example.com/")
    with pytest.raises(RuntimeError):
        second.read_login()


@pytest.mark.asyncio
async def test_stream_filters_hidden_ids_and_closes_after_revocation(monkeypatch):
    from camoufox_pm.api.routes import events as route

    monkeypatch.setattr(route, "require_auth", AsyncMock(return_value=object()))
    monkeypatch.setattr(route, "refreshed_principal", AsyncMock())
    monkeypatch.setattr(route, "visible_profile_ids", AsyncMock(return_value={"visible"}))
    monkeypatch.setattr(events, "stopping", False)
    response = await route.subscribe_events(
        SimpleNamespace(headers={}, is_disconnected=AsyncMock(return_value=False))
    )
    stream = response.body_iterator
    assert "reset" in await anext(stream)
    events.publish("secret")
    assert "reset" in await anext(stream)  # Initial visibility snapshot.
    # Hidden profile IDs never appear; the next frame is a heartbeat.
    assert "secret" not in await anext(stream)
    events.publish("visible")
    assert '"profile_id": "visible"' in await anext(stream)
    route.refreshed_principal.side_effect = RuntimeError("revoked")
    events.publish("visible")
    assert "denied" in await anext(stream)
    with pytest.raises(StopAsyncIteration):
        await anext(stream)
    assert not events.subscribers


def test_remembered_login_uses_only_system_vault_and_can_be_cleared(tmp_path, monkeypatch):
    state = DesktopState(tmp_path)
    state._origin = urlsplit("http://127.0.0.1:1234/")[:2]
    state._window = SimpleNamespace(get_current_url=lambda: "http://127.0.0.1:1234/")
    values = {}
    backend = SimpleNamespace(
        get_password=lambda service, slot: values.get((service, slot)),
        set_password=lambda service, slot, value: values.__setitem__((service, slot), value),
        delete_password=lambda service, slot: values.pop((service, slot)),
    )
    monkeypatch.setattr(state, "_keyring", lambda: backend)
    state.save_login("alice", "secret")
    assert state.read_login() == {"username": "alice", "password": "secret"}
    assert not state._path.exists()
    state.clear_login()
    assert state.read_login() is None
    state.clear_login()  # Idempotent.
