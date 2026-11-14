"""Exercise the bundled custom UI against a disposable local API and database."""

import json
import os
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import httpx
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]


def run() -> None:
    with tempfile.TemporaryDirectory(prefix="cpm-custom-ui-") as temporary:
        work = Path(temporary)
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        base = f"http://127.0.0.1:{port}"
        environment = {
            key: value for key, value in os.environ.items() if not key.startswith("CPM_")
        }
        environment["CPM_DB_PATH"] = str(work / "profiles.db")
        with (work / "server.log").open("w", encoding="utf-8") as log:
            server = subprocess.Popen(
                [
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
            )
            try:
                with httpx.Client(base_url=base, timeout=15) as api:
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
                            channel=os.environ.get("CPM_TEST_BROWSER")
                            or ("msedge" if sys.platform == "win32" else None),
                            headless=True,
                        )
                        try:
                            page = browser.new_page(
                                locale="en-US", viewport={"width": 1440, "height": 1000}
                            )
                            page_errors = []
                            page.on("pageerror", lambda error: page_errors.append(str(error)))
                            page.goto(base, wait_until="networkidle")
                            expect(page).to_have_title("CPM Custom")
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
                            page.screenshot(path=str(ROOT / "build/custom-ui.png"))
                            page.get_by_role("link", name="Settings", exact=True).click()
                            expect(
                                page.get_by_role(
                                    "link", name="Custom release downloads", exact=True
                                )
                            ).to_have_attribute(
                                "href",
                                "https://github.com/southflybird/camoufox-profile-manager/releases",
                            )
                            assert not page_errors, page_errors
                        finally:
                            browser.close()
                report = {
                    "passed": True,
                    "scope": "bundled UI with a disposable database",
                    "checks": [
                        "scheduled refresh",
                        "search/page/selection retention",
                        "unfinished edit retention",
                        "temporary read failure",
                        "focus recovery",
                        "deleted selection cleanup",
                        "hidden-page pause",
                        "custom release link",
                        "no browser script errors",
                    ],
                }
                (ROOT / "build/custom-ui.json").write_text(
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
    run()
