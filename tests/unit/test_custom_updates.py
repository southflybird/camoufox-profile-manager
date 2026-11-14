"""Custom installs must never offer upstream installers or confuse revisions."""

import httpx
import pytest

from camoufox_pm.core import custom_updates as updates


@pytest.fixture
def github(monkeypatch):
    real_client = httpx.AsyncClient
    requests = []

    def serve(payload, status=200):
        def handler(request):
            requests.append(request)
            return httpx.Response(status, json=payload, request=request)

        monkeypatch.setattr(
            updates.httpx,
            "AsyncClient",
            lambda **kwargs: real_client(transport=httpx.MockTransport(handler), **kwargs),
        )
        return requests

    return serve


async def test_custom_revisions_are_ordered_numerically_and_assets_stay_in_the_fork(
    github, monkeypatch
):
    monkeypatch.setattr(updates, "__version__", "0.7.0+southflybird.1")
    tag = "custom-v0.7.0-r10"
    own = f"{updates.RELEASES}/download/{tag}/cpm-custom-setup.exe"
    requests = github(
        [
            {"tag_name": "v999.0.0"},
            {"tag_name": "custom-v0.7.0-r2"},
            {
                "tag_name": tag,
                "assets": [
                    {"name": "own.exe", "browser_download_url": own},
                    {
                        "name": "official.exe",
                        "browser_download_url": "https://github.com/polyackiy/camoufox-profile-manager/releases/download/v999.0.0/app.exe",
                    },
                    {
                        "name": "escape.exe",
                        "browser_download_url": f"{updates.RELEASES}/download/{tag}/%2e%2e/app.exe",
                    },
                ],
            },
        ]
    )
    result = await updates.check_update()
    assert result.available and result.latest_version == "0.7.0+southflybird.10"
    assert result.release_url == f"{updates.RELEASES}/tag/{tag}"
    assert [asset.url for asset in result.assets] == [own]
    assert requests[0].url.host == "api.github.com"
    assert requests[0].url.path.startswith(f"/repos/{updates.REPOSITORY}/")


async def test_preview_is_opt_in_and_drafts_never_appear(github, monkeypatch):
    monkeypatch.setattr(updates, "__version__", "0.7.0+southflybird.1")
    github(
        [
            {"tag_name": "custom-v0.8.0-r1", "prerelease": True},
            {"tag_name": "custom-v9.0.0-r1", "draft": True},
            {"tag_name": "custom-v0.7.0-r1"},
        ]
    )
    assert not (await updates.check_update()).available
    assert (await updates.check_update("preview")).latest_version == "0.8.0+southflybird.1"


@pytest.mark.parametrize(
    "payload",
    [
        [],
        [{"tag_name": "v999.0.0"}],
        [{"tag_name": "custom-v0.7.0-r1/../bad"}],
        None,
        {"message": "bad"},
    ],
)
async def test_missing_or_malformed_custom_release_never_falls_back_to_upstream(github, payload):
    github(payload)
    result = await updates.check_update()
    assert not result.available and result.error
    assert result.release_url == updates.RELEASES
    assert result.assets == []


@pytest.mark.parametrize("status", [403, 404, 429, 503])
async def test_api_failure_retains_only_the_custom_manual_download_page(github, status):
    github({}, status)
    result = await updates.check_update()
    assert result.error and not result.available
    assert result.release_url == updates.RELEASES


async def test_same_or_older_custom_releases_do_not_downgrade(github, monkeypatch):
    monkeypatch.setattr(updates, "__version__", "0.8.0+southflybird.2")
    github([{"tag_name": "custom-v0.8.0-r1"}])
    assert not (await updates.check_update()).available
