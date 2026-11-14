"""Exercise the bundled custom UI against a disposable local API and database."""

import argparse
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import httpx
import psutil
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]


def run(
    require_api_key: bool = False, blocked_storage: bool = False, packaged: Path | None = None
) -> None:
    synthetic_key = "cpm-custom-synthetic-auth-smoke"
    report_name = "custom-ui-api-key" if require_api_key else "custom-ui"
    if packaged:
        report_name += "-packaged"
    with tempfile.TemporaryDirectory(prefix="cpm-custom-ui-") as temporary:
        work = Path(temporary)
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        base = f"http://127.0.0.1:{port}"
        environment = {
            key: value for key, value in os.environ.items() if not key.startswith("CPM_CUSTOM_")
        }
        environment["CPM_CUSTOM_DB_PATH"] = str(work / "profiles.db")
        if require_api_key:
            environment["CPM_CUSTOM_API_KEY"] = synthetic_key
        with (work / "server.log").open("w", encoding="utf-8") as log:
            startup = None
            if packaged and os.name == "nt":
                startup = subprocess.STARTUPINFO()
                startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
                startup.wShowWindow = 0
            server = subprocess.Popen(
                [str(packaged.resolve())]
                if packaged
                else [
                    sys.executable,
                    "-m",
                    "uvicorn",
                    "camoufox_pm.main:app",
                    "--host",
                    "127.0.0.1",
                    "--port",
                    str(port),
                    "--log-level",
                    "warning",
                ],
                cwd=ROOT,
                env=environment,
                stdout=log,
                stderr=log,
                startupinfo=startup,
            )
            try:
                if packaged:
                    for _ in range(600):
                        connections = psutil.Process(server.pid).net_connections(kind="inet")
                        listening = next(
                            (item for item in connections if item.status == psutil.CONN_LISTEN),
                            None,
                        )
                        if listening:
                            base = f"http://127.0.0.1:{listening.laddr.port}"
                            break
                        if server.poll() is not None:
                            raise RuntimeError("Packaged desktop exited before starting its API")
                        time.sleep(0.1)
                    else:
                        raise RuntimeError("Packaged API did not start")
                with httpx.Client(
                    base_url=base,
                    timeout=15,
                    headers={"X-API-Key": synthetic_key} if require_api_key else {},
                ) as api:
                    for _ in range(600):
                        try:
                            if api.get("/health").is_success:
                                break
                        except httpx.HTTPError:
                            pass
                        if server.poll() is not None:
                            raise RuntimeError((work / "server.log").read_text(encoding="utf-8"))
                        time.sleep(0.1)
                    else:
                        raise RuntimeError("Disposable API did not start")

                    def create(name: str) -> dict:
                        response = api.post(
                            "/api/v1/profiles", json={"name": name, "generate_fingerprint": False}
                        )
                        response.raise_for_status()
                        return response.json()

                    profiles = [create(f"Keep {index:02}") for index in range(28)]
                    with sync_playwright() as playwright:
                        browser = playwright.chromium.launch(
                            channel=os.environ.get("CPM_CUSTOM_TEST_BROWSER")
                            or ("msedge" if sys.platform == "win32" else None),
                            headless=True,
                        )
                        try:
                            page = browser.new_page(
                                locale="en-US", viewport={"width": 1440, "height": 1000}
                            )
                            page_errors = []
                            page.on("pageerror", lambda error: page_errors.append(str(error)))
                            probes = []
                            protected_reads = []
                            page.on(
                                "request",
                                lambda request: (
                                    probes.append(request.url)
                                    if "/auth/session" in request.url
                                    else None
                                ),
                            )
                            page.on(
                                "request",
                                lambda request: (
                                    protected_reads.append(request.url)
                                    if "/profiles?" in request.url
                                    else None
                                ),
                            )
                            if blocked_storage:
                                page.add_init_script(
                                    "Object.defineProperty(window, 'localStorage', {get() {throw new Error('Storage blocked')}})"
                                )
                            page.goto(base, wait_until="networkidle")
                            expect(page).to_have_title("CPM Custom")
                            if require_api_key:
                                expect(
                                    page.get_by_role("heading", name="API key required")
                                ).to_be_visible()
                                page.wait_for_timeout(1500)
                                assert len(probes) == 1 and not protected_reads, (
                                    "Unauthenticated startup mounted the protected app or looped"
                                )
                                field = page.get_by_label("API key for this browser", exact=True)
                                field.fill("wrong-synthetic-key")
                                page.get_by_role("button", name="Continue", exact=True).click()
                                expect(page.locator("form").get_by_role("alert")).to_contain_text(
                                    "The API key is not valid"
                                )
                                assert not protected_reads
                                field.fill(synthetic_key)
                                page.get_by_role("button", name="Continue", exact=True).click()
                                expect(
                                    page.get_by_role("link", name="Settings", exact=True)
                                ).to_be_visible()
                            search = page.get_by_role("textbox", name="Search profiles")
                            search.fill("Keep")
                            page.get_by_role("button", name="Next page", exact=True).click()
                            selected = page.get_by_role(
                                "checkbox", name="Select Keep 26", exact=True
                            )
                            selected.check()
                            original_url = page.url
                            create("Keep 28")
                            expect(page.get_by_text("Keep 28", exact=True)).to_be_visible(
                                timeout=15_000
                            )
                            expect(search).to_have_value("Keep")
                            expect(selected).to_be_checked()
                            assert page.url == original_url

                            def denied_group(route):
                                route.fulfill(
                                    status=403, json={"detail": "Synthetic resource denial"}
                                )

                            page.route("**/api/v1/groups", denied_group)
                            page.evaluate("window.dispatchEvent(new Event('focus'))")
                            page.wait_for_timeout(1000)
                            expect(search).to_have_value("Keep")
                            expect(selected).to_be_checked()
                            assert page.url == original_url, (
                                "A resource-level denial remounted the page"
                            )
                            page.unroute("**/api/v1/groups", denied_group)

                            page.get_by_role(
                                "button", name="Actions for Keep 26", exact=True
                            ).click()
                            page.get_by_role("menuitem", name="Edit", exact=True).click()
                            name = page.locator("#pf-name")
                            name.fill("Unfinished edit")

                            def fail_list(route):
                                route.fulfill(
                                    status=503, json={"detail": "Synthetic temporary failure"}
                                )

                            page.route("**/api/v1/profiles?*", fail_list)
                            page.evaluate("window.dispatchEvent(new Event('focus'))")
                            page.wait_for_timeout(500)
                            expect(name).to_have_value("Unfinished edit")
                            expect(selected).to_be_checked()
                            page.unroute("**/api/v1/profiles?*", fail_list)
                            create("Keep 29")
                            page.evaluate("window.dispatchEvent(new Event('focus'))")
                            expect(page.get_by_text("Keep 29", exact=True)).to_be_visible(
                                timeout=5000
                            )
                            expect(name).to_have_value("Unfinished edit")
                            page.get_by_role("dialog").get_by_role(
                                "button", name="Cancel", exact=True
                            ).click()

                            api.delete(f"/api/v1/profiles/{profiles[26]['id']}").raise_for_status()
                            page.evaluate("window.dispatchEvent(new Event('focus'))")
                            expect(
                                page.get_by_role("checkbox", name="Select Keep 26", exact=True)
                            ).to_have_count(0)
                            expect(page.get_by_text("1 selected", exact=True)).to_have_count(0)

                            reads = []
                            page.on(
                                "request",
                                lambda request: (
                                    reads.append(request.url)
                                    if "/api/v1/profiles?" in request.url
                                    else None
                                ),
                            )
                            page.evaluate(
                                "Object.defineProperty(document, 'visibilityState', {configurable: true, value: 'hidden'}); document.dispatchEvent(new Event('visibilitychange'))"
                            )
                            before = len(reads)
                            page.wait_for_timeout(11_000)
                            assert len(reads) == before, (
                                "A hidden page kept polling the profile list"
                            )
                            page.evaluate(
                                "Object.defineProperty(document, 'visibilityState', {configurable: true, value: 'visible'}); document.dispatchEvent(new Event('visibilitychange'))"
                            )
                            page.wait_for_timeout(500)
                            assert len(reads) > before, "Returning to the page did not refresh"
                            expect(search).to_have_value("Keep")
                            assert page.url == original_url
                            (ROOT / "build").mkdir(exist_ok=True)
                            page.screenshot(path=str(ROOT / f"build/{report_name}.png"))
                            page.get_by_role("link", name="Settings", exact=True).click()
                            expect(
                                page.get_by_role(
                                    "link", name="Custom release downloads", exact=True
                                )
                            ).to_have_attribute(
                                "href",
                                "https://github.com/southflybird/camoufox-profile-manager/releases",
                            )
                            if require_api_key:
                                page.get_by_role("link", name="Access and activity", exact=True).click()
                                page.get_by_label("Username", exact=True).fill("custom-admin")
                                page.get_by_label("Password", exact=True).fill("synthetic-admin-password")
                                page.get_by_role("button", name="Add user", exact=True).click()
                                expect(page.get_by_role("heading", name="Sign in", exact=True)).to_be_visible()
                                page.get_by_label("Username", exact=True).fill("custom-admin")
                                page.get_by_label("Password", exact=True).fill("wrong-password")
                                page.get_by_role("button", name="Sign in", exact=True).click()
                                expect(page.get_by_text("Invalid username or password", exact=True)).to_be_visible()
                                page.get_by_label("Password", exact=True).fill("synthetic-admin-password")
                                page.get_by_role("button", name="Sign in", exact=True).click()
                                expect(page.get_by_role("button", name="Log out", exact=True)).to_be_visible()
                                page.reload(wait_until="networkidle")
                                expect(page.get_by_role("button", name="Log out", exact=True)).to_be_visible()
                                # Machine clients remain independent of the UI session.
                                api.get("/api/v1/system/config").raise_for_status()
                                page.get_by_role("button", name="Log out", exact=True).click()
                                expect(page.get_by_role("heading", name="Sign in", exact=True)).to_be_visible()
                                page.reload(wait_until="networkidle")
                                expect(page.get_by_role("heading", name="Sign in", exact=True)).to_be_visible()
                                api.get("/api/v1/system/config").raise_for_status()
                            if require_api_key:
                                page.route(
                                    "**/api/v1/auth/session",
                                    lambda route: route.fulfill(
                                        json={
                                            "user_auth_enabled": False,
                                            "authenticated": False,
                                            "username": None,
                                        }
                                    ),
                                )
                                page.route(
                                    "**/api/v1/profiles?*",
                                    lambda route: route.fulfill(
                                        status=401, json={"detail": "Synthetic revoked key"}
                                    ),
                                )
                                page.goto(base)
                                expect(
                                    page.get_by_role("heading", name="API key required")
                                ).to_be_visible()
                                count = len(protected_reads)
                                page.wait_for_timeout(1500)
                                assert len(protected_reads) == count, (
                                    "Access loss restarted protected polling"
                                )
                            assert not page_errors, page_errors
                        finally:
                            browser.close()
                report = {
                    "passed": True,
                    "scope": "bundled UI with a disposable database",
                    "api_key_required": require_api_key,
                    "blocked_storage": blocked_storage,
                    "packaged": packaged is not None,
                    "checks": [
                        "username initialization, login, session reuse, logout and independent machine key",
                        "scheduled refresh",
                        "search/page/selection retention",
                        "unfinished edit retention",
                        "temporary read failure",
                        "focus recovery",
                        "deleted selection cleanup",
                        "hidden-page pause",
                        "custom release link",
                        "no browser script errors",
                        "resource denial preserves a valid session and local state",
                    ],
                }
                (ROOT / f"build/{report_name}.json").write_text(
                    json.dumps(report, indent=2) + "\n", encoding="utf-8"
                )
                print(json.dumps(report))
            finally:
                server.terminate()
                try:
                    server.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait(timeout=5)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api-key", action="store_true")
    parser.add_argument("--blocked-storage", action="store_true")
    parser.add_argument("--packaged", type=Path)
    args = parser.parse_args()
    run(args.api_key, args.blocked_storage, args.packaged)
