"""Revocation-aware SSE invalidations. Data stays behind existing read APIs."""

import asyncio
import json

from fastapi import APIRouter, Request
from starlette.responses import StreamingResponse

from camoufox_pm.api.access import refreshed_principal, visible_profile_ids
from camoufox_pm.api.dependencies import require_auth
from camoufox_pm.core import events

router = APIRouter()


@router.get("/events", operation_id="subscribe_events")
async def subscribe_events(request: Request):
    from camoufox_pm.main import maintenance_gate

    with maintenance_gate.operation():
        principal = await require_auth(request, request.headers.get("x-api-key"))

    async def stream():
        queue = asyncio.Queue(maxsize=128)
        events.subscribers.add(queue)
        known = set()
        loop = asyncio.get_running_loop()
        deadline = loop.time() + 300
        try:
            yield "event: reset\ndata: {}\n\n"
            while (
                not events.stopping
                and loop.time() < deadline
                and not await request.is_disconnected()
            ):
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=1)
                except asyncio.TimeoutError:
                    event = None
                try:
                    with maintenance_gate.operation():
                        await refreshed_principal(principal)
                        allowed = await visible_profile_ids()
                except Exception:
                    yield "event: denied\ndata: {}\n\n"
                    break
                if allowed is not None and allowed != known:
                    known = set(allowed)
                    yield "event: reset\ndata: {}\n\n"
                if event is None:
                    yield ": heartbeat\n\n"
                elif event["profile_id"] is None:
                    yield "event: reset\ndata: {}\n\n"
                elif (
                    allowed is None
                    or event["profile_id"] in allowed
                    or event["profile_id"] in known
                ):
                    yield "event: change\ndata: " + json.dumps(event) + "\n\n"
        finally:
            events.subscribers.discard(queue)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
