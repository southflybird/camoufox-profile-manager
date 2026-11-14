"""Discover only custom releases; installation remains a manual operation.

Keep this adapter separate from the upstream updater so future upstream merges
do not accidentally re-enable downloads of the official distribution.
"""

import re
from typing import Literal
from urllib.parse import unquote, urlsplit

import httpx
from packaging.version import Version

from camoufox_pm import __version__
from camoufox_pm.core.updates import ReleaseAsset, UpdateStatus
from camoufox_pm.distribution import RELEASES, REPOSITORY


def release_version(tag: str) -> Version:
    match = re.fullmatch(r"custom-v(\d+\.\d+\.\d+)-r([1-9]\d*)", tag)
    if match is None:
        raise ValueError("Not a custom release tag")
    return Version(f"{match[1]}+southflybird.{match[2]}")


def _asset_url(url: str, tag: str) -> bool:
    parsed = urlsplit(url)
    prefix = f"/{REPOSITORY}/releases/download/{tag}/"
    path = unquote(parsed.path)
    name = path.removeprefix(prefix)
    return (
        parsed.scheme == "https"
        and parsed.netloc == "github.com"
        and not parsed.query
        and not parsed.fragment
        and path.startswith(prefix)
        and bool(name)
        and name not in {".", ".."}
        and "/" not in name
        and "\\" not in name
    )


async def check_update(channel: Literal["stable", "preview"] = "stable") -> UpdateStatus:
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.get(
                f"https://api.github.com/repos/{REPOSITORY}/releases?per_page=100",
                headers={"Accept": "application/vnd.github+json"},
            )
            response.raise_for_status()
            releases = response.json()
        if not isinstance(releases, list):
            raise ValueError("Invalid releases response")
        eligible = []
        for release in releases:
            if not isinstance(release, dict) or release.get("draft"):
                continue
            if release.get("prerelease") and channel != "preview":
                continue
            try:
                parsed_version = release_version(release["tag_name"])
            except (KeyError, TypeError, ValueError):
                continue
            eligible.append((parsed_version, release))
        if not eligible:
            return UpdateStatus(
                release_url=RELEASES, error="No custom release has been published yet."
            )
        latest, release = max(eligible, key=lambda item: item[0])
        tag = release["tag_name"]
        assets = [
            ReleaseAsset(name=item["name"], url=item["browser_download_url"])
            for item in release.get("assets", [])
            if _asset_url(item["browser_download_url"], tag)
        ]
        return UpdateStatus(
            current_version=__version__,
            latest_version=str(latest),
            available=latest > Version(__version__),
            release_url=f"{RELEASES}/tag/{tag}",
            assets=assets,
        )
    except (httpx.HTTPError, ValueError, KeyError, TypeError):
        return UpdateStatus(
            release_url=RELEASES,
            error="Could not check for updates. Check your connection and try again.",
        )
