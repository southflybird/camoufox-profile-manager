"""Real API/UI exit persistence with synthetic network and browser boundaries.

Run after NEXT_EXPORT=1 npm --prefix web run build:static. Uses only temporary data.
"""

import os
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from textwrap import dedent

import httpx
from playwright.sync_api import expect, sync_playwright

SERVER = dedent("""
    import sys
    from types import SimpleNamespace
    import uvicorn
    from camoufox_pm.core import browser_install, fingerprint_store, proxy_check
    from camoufox_pm.core.browser_session import BrowserSessionManager

    async def resolve(proxy, timeout=10):
        if proxy and proxy.server.startswith('updated.'):
            return '203.0.113.22', 17
        return ('203.0.113.11' if proxy else '198.51.100.12'), 17

    async def launch(self, profile_id, options, on_exit=None):
        if 'broken.invalid' in options.get('proxy', {}).get('server', ''):
            raise RuntimeError('Synthetic browser startup failure after IP lookup')
        expected = '203.0.113.11' if options.get('proxy') else '198.51.100.12'
        if 'updated.invalid' in options.get('proxy', {}).get('server', ''):
            expected = '203.0.113.22'
        assert options['geoip'] == expected
        return SimpleNamespace(process_id=None)

    proxy_check.resolve_exit_ip = resolve
    proxy_check.locate = lambda ip: proxy_check.ProxyLocation(
        ip=ip, country='JP', timezone='Asia/Tokyo'
    )
    browser_install.ensure_browser_ready = lambda: None
    fingerprint_store.resolve = lambda *args, **kwargs: {}
    BrowserSessionManager.launch = launch
    uvicorn.run('camoufox_pm.main:app', host='127.0.0.1', port=int(sys.argv[1]),
                timeout_graceful_shutdown=2)
""")


def main():
    root = Path(__file__).resolve().parents[2]
    with tempfile.TemporaryDirectory(
        prefix="cpm-exit-ui-", ignore_cleanup_errors=True
    ) as directory:
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        env = {
            **os.environ,
            "CPM_CUSTOM_DB_PATH": str(Path(directory) / "profiles.db"),
            "CPM_CUSTOM_WEBUI_DIR": str(root / "web/out"),
            "CPM_CUSTOM_API_KEY": "exit-acceptance-key",
        }
        with open(Path(directory) / "server.log", "w", encoding="utf-8") as log:
            process = subprocess.Popen(
                [sys.executable, "-c", SERVER, str(port)],
                cwd=root,
                env=env,
                stdout=log,
                stderr=log,
            )
            try:
                origin = f"http://127.0.0.1:{port}"
                with httpx.Client(
                    base_url=origin, headers={"X-API-Key": "exit-acceptance-key"}
                ) as api:
                    for _ in range(200):
                        try:
                            if api.get("/health").is_success:
                                break
                        except httpx.TransportError:
                            pass
                        if process.poll() is not None:
                            raise RuntimeError(Path(directory, "server.log").read_text())
                        time.sleep(0.1)
                    else:
                        raise RuntimeError("Test server did not start")

                    profiles = []
                    for name in ("manual-saved", "auto-proxy", "auto-direct"):
                        response = api.post(
                            "/api/v1/profiles",
                            json={
                                "name": name,
                                "generate_fingerprint": False,
                                "proxy_config": {
                                    "type": "socks5",
                                    "server": "synthetic.invalid:1080",
                                    "username": "u",
                                    "password": "p",
                                }
                                if name != "auto-direct"
                                else None,
                            },
                        )
                        response.raise_for_status()
                        profiles.append(response.json())

                    with sync_playwright() as playwright:
                        browser = playwright.chromium.launch(
                            channel=os.environ.get("CPM_CUSTOM_TEST_BROWSER")
                        )
                        page = browser.new_page(viewport={"width": 1700, "height": 1100})
                        page.add_init_script(
                            "localStorage.setItem('camoufox-pm.ui-language', 'en')"
                        )
                        checks = []
                        page.on(
                            "request",
                            lambda request: (
                                checks.append(request.url)
                                if request.url.endswith("/proxy/check")
                                else None
                            ),
                        )
                        page.goto(origin)
                        page.get_by_label("API key for this browser").fill("exit-acceptance-key")
                        page.get_by_role("button", name="Continue", exact=True).click()

                        def row(name):
                            return page.locator("tbody tr").filter(has_text=name)

                        manual = row("manual-saved")
                        expect(manual).to_contain_text("Not launched yet")
                        manual.locator("[data-menu-trigger]").click()
                        page.get_by_role("menuitem", name="Edit", exact=True).click()
                        dialog = page.get_by_role("dialog")
                        dialog.get_by_label("Notes", exact=True).fill("unsaved draft")
                        dialog.get_by_role("button", name="Check proxy", exact=True).click()
                        expect(dialog).to_contain_text("203.0.113.11")
                        expect(dialog.get_by_label("Notes", exact=True)).to_have_value(
                            "unsaved draft"
                        )
                        dialog.get_by_role("button", name="Cancel", exact=True).click()
                        expect(manual).to_contain_text("Not launched yet")
                        assert len(checks) == 1
                        assert (
                            api.get(f"/api/v1/profiles/{profiles[0]['id']}").json()["notes"] is None
                        )

                        for name, ip in (
                            ("auto-proxy", "203.0.113.11"),
                            ("auto-direct", "198.51.100.12"),
                        ):
                            target = row(name)
                            target.get_by_role("button", name="Run", exact=True).click()
                            expect(target).to_contain_text(ip)
                            expect(target).to_contain_text("JP")
                        assert len(checks) == 1, "Launching must not request an extra manual check"

                        proxy_id = profiles[1]["id"]
                        previous = api.get(f"/api/v1/profiles/{proxy_id}").json()[
                            "last_browser_exit"
                        ]
                        edited = api.put(
                            f"/api/v1/profiles/{proxy_id}",
                            json={
                                "proxy_config": {
                                    "type": "socks5",
                                    "server": "updated.invalid:1080",
                                    "username": "u",
                                    "password": "p",
                                },
                            },
                        )
                        edited.raise_for_status()
                        target = row("auto-proxy")
                        expect(target).to_contain_text("Proxy changed")
                        expect(target).to_contain_text(previous["ip"])
                        target.locator("[data-menu-trigger]").click()
                        page.get_by_role("menuitem", name="Check proxy", exact=True).click()
                        dialog = page.get_by_role("dialog", name="Proxy check results", exact=True)
                        expect(dialog).to_contain_text("203.0.113.22")
                        dialog.get_by_role("button", name="Close", exact=True).click()
                        expect(target).to_contain_text(previous["ip"])
                        assert (
                            api.get(f"/api/v1/profiles/{proxy_id}").json()["last_browser_exit"][
                                "checked_at"
                            ]
                            == previous["checked_at"]
                        )

                        target.get_by_role("button", name="Run", exact=True).click()
                        expect(target).to_contain_text("203.0.113.22")
                        expect(target).not_to_contain_text("Proxy changed")
                        successful = api.get(f"/api/v1/profiles/{proxy_id}").json()[
                            "last_browser_exit"
                        ]

                        target.locator("[data-menu-trigger]").click()
                        page.get_by_role("menuitem", name="Edit", exact=True).click()
                        dialog = page.get_by_role("dialog", name="Edit profile", exact=True)
                        dialog.get_by_label("Server", exact=True).fill("broken.invalid:1080")
                        dialog.get_by_role("button", name="Save changes", exact=True).click()
                        expect(dialog).to_have_count(0)
                        expect(target).to_contain_text("203.0.113.22")
                        expect(target).to_contain_text("Proxy changed")
                        target.get_by_role("button", name="Run", exact=True).click()
                        expect(
                            page.get_by_text("Could not launch browser", exact=True)
                        ).to_be_visible()
                        expect(target).to_contain_text("203.0.113.22")
                        after_failure = api.get(f"/api/v1/profiles/{proxy_id}").json()[
                            "last_browser_exit"
                        ]
                        assert after_failure["ip"] == successful["ip"]
                        assert after_failure["checked_at"] == successful["checked_at"]
                        page.reload()
                        for profile in profiles:
                            stored = api.get(f"/api/v1/profiles/{profile['id']}").json()
                            expect(row(profile["name"])).to_contain_text(
                                stored["last_browser_exit"]["ip"]
                                if stored["last_browser_exit"]
                                else "Not launched yet"
                            )
                        page.screenshot(
                            path=str(root / "build/profile-exit-acceptance.png"), full_page=True
                        )
                        browser.close()
                        print(
                            "Manual checks, API/form proxy edits and failed launches preserve actual exits; successful launches update them"
                        )
            finally:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)


if __name__ == "__main__":
    main()
