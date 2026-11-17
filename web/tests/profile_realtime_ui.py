"""Real API + SSE + static UI acceptance. Run after npm --prefix web run build."""

import os
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import httpx
from playwright.sync_api import expect, sync_playwright


def check_action_menu_layout(page, api, root):
    """Two rows must not scroll vertically when an action menu opens."""
    second_name = "Menu layout " + "x" * 65
    response = api.post(
        "/api/v1/profiles",
        json={
            "name": second_name,
            "generate_fingerprint": False,
            "browser_settings": {"os": "macos"},
        },
    )
    response.raise_for_status()
    expect(page.get_by_text(second_name, exact=False)).to_be_visible()
    page.get_by_text("Visible columns", exact=True).click()  # Close the column picker.
    dismiss = page.get_by_role("button", name="Dismiss setup banner", exact=True)
    if dismiss.is_visible():
        dismiss.click()
    page.set_viewport_size({"width": 1900, "height": 1100})
    scroller = page.locator("[data-profile-table-scroll]")
    rows = scroller.locator("tbody tr")
    expect(rows).to_have_count(2)
    expect(scroller.get_by_role("columnheader", name="ID", exact=True)).to_be_visible()
    for index, os_name in enumerate(["macOS", "Windows"]):
        cells = rows.nth(index).locator("td")
        expect(cells.nth(1).get_by_role("img", name=os_name, exact=True)).to_be_visible()
        expect(cells.nth(2).get_by_role("button", name="Copy ID", exact=True)).to_be_visible()
        assert cells.nth(2).inner_text().strip() not in cells.nth(1).inner_text()
    page.get_by_text("Visible columns", exact=True).click()
    page.get_by_role("checkbox", name="ID", exact=True).uncheck()
    expect(scroller.get_by_role("columnheader", name="ID", exact=True)).to_be_hidden()
    page.get_by_role("checkbox", name="ID", exact=True).check()
    page.get_by_text("Visible columns", exact=True).click()
    page.get_by_role("heading", name="Profiles", exact=True).hover()

    def no_vertical_overflow():
        assert scroller.evaluate("element => element.scrollHeight <= element.clientHeight + 1")

    def matching_backgrounds():
        assert rows.evaluate_all(
            "rows => rows.every(row => getComputedStyle(row).backgroundColor === getComputedStyle(row.lastElementChild).backgroundColor)"
        )

    def complete_menu():
        menu = page.get_by_role("menu")
        expect(menu).to_be_visible()
        last = menu.get_by_role("menuitem", name="Move to Trash", exact=True)
        expect(last).to_be_visible()
        assert menu.evaluate(
            "element => { const r = element.getBoundingClientRect(); return element.parentElement === document.body && r.top >= 0 && r.bottom <= innerHeight }"
        )
        assert last.evaluate(
            "element => { const r = element.getBoundingClientRect(); return element.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) }"
        )
        no_vertical_overflow()

    no_vertical_overflow()
    matching_backgrounds()
    for index in range(2):
        row = rows.nth(index)
        row.locator("td").nth(1).hover()
        matching_backgrounds()
        trigger = row.locator("[data-menu-trigger]")
        trigger.click()
        complete_menu()
        expect(page.get_by_role("menuitem", name="Edit", exact=True)).to_be_focused()
        page.keyboard.press("ArrowDown")
        expect(page.get_by_role("menuitem", name="Duplicate", exact=True)).to_be_focused()
        page.keyboard.press("Escape")
        expect(page.get_by_role("menu")).to_have_count(0)
        expect(trigger).to_be_focused()
        no_vertical_overflow()

    rows.last.locator("[data-menu-trigger]").click()
    complete_menu()
    page.screenshot(path=str(root / "build/profile-menu-layout-acceptance.png"), full_page=True)
    page.get_by_role("heading", name="Profiles", exact=True).click()
    expect(page.get_by_role("menu")).to_have_count(0)

    rows.last.locator("[data-menu-trigger]").click()
    page.get_by_role("menuitem", name="Edit", exact=True).click()
    expect(page.get_by_role("menu")).to_have_count(0)
    expect(page.get_by_role("dialog")).to_be_visible()
    page.get_by_role("dialog").get_by_role("button", name="Cancel", exact=True).click()

    page.set_viewport_size({"width": 900, "height": 550})
    assert scroller.evaluate("element => element.scrollWidth > element.clientWidth")
    scroller.evaluate("element => { element.scrollLeft = element.scrollWidth }")
    rows.last.locator("[data-menu-trigger]").click()
    complete_menu()
    # Reposition an already open menu when the viewport changes.
    page.set_viewport_size({"width": 1000, "height": 600})
    complete_menu()
    page.keyboard.press("Escape")
    no_vertical_overflow()
    page.set_viewport_size({"width": 1500, "height": 950})
    print(
        "Two-row action backgrounds, unclipped menus, no vertical overflow, narrow viewport and keyboard navigation passed"
    )


def main():
    with tempfile.TemporaryDirectory(
        prefix="cpm-realtime-", ignore_cleanup_errors=True
    ) as directory:
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        root = Path(__file__).resolve().parents[2]
        env = {
            **os.environ,
            "CPM_CUSTOM_DB_PATH": str(Path(directory) / "profiles.db"),
            "CPM_CUSTOM_PROFILES_DIR": str(Path(directory) / "profiles"),
            "CPM_CUSTOM_WEBUI_DIR": str(root / "web/out"),
            "CPM_CUSTOM_API_KEY": "acceptance-key",
        }
        with open(Path(directory) / "server.log", "w", encoding="utf-8") as log:
            process = subprocess.Popen(
                [
                    sys.executable,
                    "-m",
                    "uvicorn",
                    "camoufox_pm.main:app",
                    "--host",
                    "127.0.0.1",
                    "--port",
                    str(port),
                    "--timeout-graceful-shutdown",
                    "3",
                ],
                cwd=root,
                env=env,
                stdout=log,
                stderr=log,
            )
            origin = f"http://127.0.0.1:{port}"
            try:
                with httpx.Client(base_url=origin, headers={"X-API-Key": "acceptance-key"}) as api:
                    for _ in range(200):
                        try:
                            if api.get("/health").status_code == 200:
                                break
                        except httpx.TransportError:
                            pass
                        if process.poll() is not None:
                            raise RuntimeError(Path(directory, "server.log").read_text())
                        time.sleep(0.1)
                    with sync_playwright() as playwright:
                        browser = playwright.chromium.launch(
                            channel=os.environ.get("CPM_CUSTOM_TEST_BROWSER")
                        )
                        page = browser.new_page(viewport={"width": 1500, "height": 950})
                        page.add_init_script(
                            "localStorage.setItem('camoufox-pm.ui-language', 'en')"
                        )
                        page.goto(origin)
                        page.get_by_label("API key for this browser").fill("acceptance-key")
                        page.get_by_role("button", name="Continue", exact=True).click()
                        expect(
                            page.get_by_role("button", name="Refresh", exact=True)
                        ).to_be_visible()
                        response = api.post(
                            "/api/v1/profiles",
                            json={"name": "SSE-created", "generate_fingerprint": False},
                        )
                        response.raise_for_status()
                        profile = response.json()
                        start = time.monotonic()
                        expect(page.get_by_text("SSE-created", exact=False)).to_be_visible(
                            timeout=1500
                        )
                        print(f"API create visible in {time.monotonic() - start:.3f}s")
                        page.get_by_role("button", name="Quick edit name", exact=True).click()
                        page.get_by_role("textbox", name="Name", exact=True).fill("Quick-renamed")
                        page.get_by_role("button", name="Save", exact=True).click()
                        expect(page.get_by_text("Quick-renamed", exact=False)).to_be_visible()
                        page.get_by_role("button", name="Quick edit notes", exact=True).click()
                        page.get_by_role("textbox", name="Notes", exact=True).fill("local draft")
                        updated = api.put(
                            f"/api/v1/profiles/{profile['id']}", json={"notes": "API note"}
                        )
                        updated.raise_for_status()
                        expect(page.get_by_role("textbox", name="Notes", exact=True)).to_have_value(
                            "local draft"
                        )
                        page.get_by_role("button", name="Save", exact=True).click()
                        expect(page.get_by_text("Latest content:", exact=False)).to_be_visible()
                        page.get_by_role("button", name="Save my changes again", exact=True).click()
                        expect(page.get_by_role("dialog")).to_have_count(0)
                        expect(page.get_by_text("local draft", exact=True)).to_be_visible()
                        assert (
                            api.get(f"/api/v1/profiles/{profile['id']}").json()["notes"]
                            == "local draft"
                        )
                        page.get_by_text("Visible columns", exact=True).click()
                        page.get_by_role("checkbox", name="Group", exact=True).uncheck()
                        page.wait_for_timeout(500)
                        page.reload()
                        page.get_by_text("Visible columns", exact=True).click()
                        expect(
                            page.get_by_role("checkbox", name="Group", exact=True)
                        ).not_to_be_checked()
                        assert "sort=created_at" in page.url
                        page.screenshot(
                            path=str(root / "build/profile-realtime-acceptance.png"), full_page=True
                        )
                        check_action_menu_layout(page, api, root)
                        response = api.delete(f"/api/v1/profiles/{profile['id']}")
                        response.raise_for_status()
                        expect(page.get_by_text("Quick-renamed", exact=False)).to_have_count(0)
                        browser.close()
                        print(
                            "API create/update/delete, quick edits, conflict draft preservation and preferences passed"
                        )
            finally:
                import psutil

                for child in psutil.Process(process.pid).children(recursive=True):
                    child.terminate()
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)


if __name__ == "__main__":
    main()
