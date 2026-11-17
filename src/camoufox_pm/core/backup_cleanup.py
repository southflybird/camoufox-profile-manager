"""Explicit, restartable per-file cleanup; never touches live or synced data."""

import asyncio
import json
import shutil
import uuid
import zipfile
from contextlib import nullcontext

from . import profile_archive
from .browser_data_policy import (
    archive_digest,
    archive_origins,
    default_ublock_origins,
    disposable_ublock_path,
)
from .profile_operations import profile_data_path, profile_operation, run_file_operation
from .sync_guard import guard_profile
from .update_permissions import reject_reparse_paths


def compact_archive(source, destination):
    profile_archive.read_archive(source)
    with (
        zipfile.ZipFile(source) as old,
        zipfile.ZipFile(destination, "x", zipfile.ZIP_DEFLATED, compresslevel=6) as new,
    ):
        origins = archive_origins(old)
        if sum(i.file_size for i in old.infolist()) > 2 * 1024**3:
            raise ValueError("Archive exceeds cleanup limit")
        seen = set()
        for entry in old.infolist():
            if entry.filename in seen:
                raise ValueError("Duplicate archive entry")
            seen.add(entry.filename)
            skip = entry.filename.startswith("data/") and disposable_ublock_path(
                entry.filename[5:], origins
            )
            with old.open(entry) as reader:
                if skip:
                    while reader.read(1024 * 1024):
                        pass  # Check the CRC of discarded data too.
                else:
                    with new.open(entry.filename, "w") as writer:
                        shutil.copyfileobj(reader, writer)
    archive_digest(destination)  # Read every retained byte before replacement.


def profile_targets(profile, directory):
    def read(name):
        path = directory / name
        reject_reparse_paths(path)
        if path.stat().st_size > 4 * 1024 * 1024:
            raise ValueError("Oversized extension metadata")
        return path.read_bytes()

    origins = default_ublock_origins(profile.model_dump(mode="json"), read)
    base = directory / "storage" / "default"
    if not origins or not base.exists():
        return []
    reject_reparse_paths(base)
    targets = []
    for path in base.iterdir():
        if disposable_ublock_path(path.relative_to(directory).as_posix(), origins):
            reject_reparse_paths(path)
            for child in path.rglob("*"):
                reject_reparse_paths(child)
            if path.is_dir():
                targets.append(path)
    return targets


def target_size(targets):
    return sum(p.stat().st_size for root in targets for p in root.rglob("*") if p.is_file())


async def run_cleanup(backups, execute):
    report = {
        "state": "running",
        "processed": 0,
        "unchanged": 0,
        "released_bytes": 0,
        "estimated_bytes": 0,
        "candidates": 0,
        "skipped": [],
        "failed": [],
    }
    backups.cleanup_status = report
    try:
        async with backups._exclusive():
            # Atomic replacement is the per-archive commit point. Metadata is
            # recoverable from the ZIP, so interruption needs no bulk rollback.
            for item in backups.list_backups():
                source = backups._archive_path(item["id"])
                temporary = source.with_name(uuid.uuid4().hex + ".compact")
                try:
                    with zipfile.ZipFile(source) as archive:
                        origins = archive_origins(archive)
                        estimate = sum(
                            i.compress_size
                            for i in archive.infolist()
                            if i.filename.startswith("data/")
                            and disposable_ublock_path(i.filename[5:], origins)
                        )
                    report["estimated_bytes"] += estimate
                    report["candidates"] += bool(estimate)
                    if not execute:
                        continue
                    if estimate:
                        await run_file_operation(compact_archive, source, temporary)
                        saved = source.stat().st_size - temporary.stat().st_size
                        if saved > 0:
                            temporary.chmod(0o600)
                            temporary.replace(source)
                            report["released_bytes"] += saved
                            report["processed"] += 1
                        else:
                            report["unchanged"] += 1
                    else:
                        report["unchanged"] += 1
                except (OSError, ValueError, zipfile.BadZipFile, KeyError) as exc:
                    report["failed"].append({"id": item["id"], "reason": str(exc)})
                finally:
                    temporary.unlink(missing_ok=True)
            profiles = await backups.manager.storage.list_profiles({"include_deleted": True})
            for candidate in profiles:
                try:
                    async with profile_operation(
                        backups.manager, candidate.id, include_deleted=True
                    ) as profile:
                        if await guard_profile(backups.manager, profile.id, profile=profile):
                            report["skipped"].append(
                                {"id": profile.id, "reason": "Synchronized profile"}
                            )
                            continue
                        directory = profile_data_path(backups.manager, profile)
                        targets = await run_file_operation(profile_targets, profile, directory)
                        size = await run_file_operation(target_size, targets)
                        report["estimated_bytes"] += size
                        report["candidates"] += bool(targets)
                        if not execute:
                            continue
                        if targets:
                            # The held profile lease protects both snapshot and deletion.
                            await backups._write_locked_profile(profile, "manual", prune=False)
                            for target in targets:
                                reject_reparse_paths(target)
                                await run_file_operation(shutil.rmtree, target)
                            report["released_bytes"] += size
                            report["processed"] += 1
                except (OSError, ValueError) as exc:
                    report["skipped"].append({"id": candidate.id, "reason": str(exc)})
            if execute:
                # Validate/deduplicate old entries before imposing new retention.
                for profile_id in {i["profile_id"] for i in backups.list_backups()}:
                    seen = {}
                    items = [i for i in backups.list_backups() if i["profile_id"] == profile_id]
                    valid = True
                    for item in items:
                        source = backups._archive_path(item["id"])
                        try:
                            digest = await run_file_operation(archive_digest, source)
                            if digest in seen:
                                kept = seen[digest]
                                record = json.loads(kept.with_suffix(".json").read_text())
                                for purpose, at in item["uses"].items():
                                    record["uses"][purpose] = max(
                                        at, record["uses"].get(purpose, "")
                                    )
                                backups._write_json(kept.with_suffix(".json"), record)
                                report["released_bytes"] += source.stat().st_size
                                source.unlink()
                                source.with_suffix(".json").unlink()
                            else:
                                record = json.loads(source.with_suffix(".json").read_text())
                                record.update(digest=digest, uses=item["uses"])
                                backups._write_json(source.with_suffix(".json"), record)
                                seen[digest] = source
                        except (OSError, ValueError, zipfile.BadZipFile) as exc:
                            valid = False
                            report["failed"].append({"id": item["id"], "reason": str(exc)})
                    if valid:
                        before = sum(i["size_bytes"] for i in backups.list_backups())
                        backups._prune(profile_id)
                        report["released_bytes"] += before - sum(
                            i["size_bytes"] for i in backups.list_backups()
                        )
        report["state"] = "complete"
    except Exception as exc:
        report["state"] = "error"
        report["failed"].append({"id": "cleanup", "reason": str(exc)})
    return report


def start_cleanup(backups, execute):
    if backups.cleanup_task and not backups.cleanup_task.done():
        raise ValueError("Cleanup is already running")
    backups.cleanup_status = {"state": "running", "processed": 0}

    async def admitted():
        try:
            gate = getattr(backups, "maintenance_gate", None)
            with gate.operation() if gate else nullcontext():
                await run_cleanup(backups, execute)
        except Exception as exc:
            backups.cleanup_status = {
                "state": "error",
                "failed": [{"id": "cleanup", "reason": str(exc)}],
            }

    backups.cleanup_task = asyncio.create_task(admitted())
    return backups.cleanup_status
