"""Bounded in-process invalidations, published only after committed writes."""

import asyncio
from functools import wraps

subscribers: set[asyncio.Queue] = set()
stopping = False
sequence = 0


def publish(profile_id=None):
    global sequence
    sequence += 1
    for queue in tuple(subscribers):
        event = {"sequence": sequence, "profile_id": profile_id}
        if queue.full():
            while not queue.empty():
                queue.get_nowait()
            event["profile_id"] = None
        queue.put_nowait(event)


def changed(function):
    @wraps(function)
    async def run(self, *args, **kwargs):
        result = await function(self, *args, **kwargs)
        if result is not False:
            value = args[0] if args else None
            profile_id = (
                getattr(value, "id", value)
                if "group" not in function.__name__
                and "user" not in function.__name__
                and "grant" not in function.__name__
                else None
            )
            publish(profile_id if isinstance(profile_id, str) else None)
        return result

    return run
