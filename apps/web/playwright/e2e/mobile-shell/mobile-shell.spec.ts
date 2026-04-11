/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { devices, type Locator } from "@playwright/test";

import { test, expect } from "../../element-web-test";

const ROOM_NAMES = ["Mobile Alpha", "Mobile Beta", "Mobile Gamma"];
const pixel7 = devices["Pixel 7"];

async function expectNoHorizontalOverflow(locator: Locator): Promise<void> {
    const overflow = await locator.evaluate((element) => element.scrollWidth - element.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
}

test.use({
    viewport: pixel7.viewport,
    userAgent: pixel7.userAgent,
    deviceScaleFactor: pixel7.deviceScaleFactor,
    isMobile: pixel7.isMobile,
    hasTouch: pixel7.hasTouch,
    config: {
        mobile_web_shell_enabled: true,
    },
    labsFlags: ["feature_new_room_list"],
});

test.describe("Mobile shell", () => {
    test.describe.configure({ timeout: 120000 });

    test.beforeEach(async ({ app, page, user }) => {
        void user;
        await page.waitForSelector(".mx_MatrixChat", { timeout: 30000 });
        await page.waitForFunction(() => Boolean(window.mxMatrixClientPeg?.get?.()));

        const dismissUnsupportedBrowser = page.getByRole("button", { name: "Dismiss" });
        if (await dismissUnsupportedBrowser.isVisible().catch(() => false)) {
            await dismissUnsupportedBrowser.click();
        }

        for (const name of ROOM_NAMES) {
            await app.client.createRoom({ name });
        }

        await expect(page.getByTestId("mx_MobileShell")).toBeVisible();

        try {
            await app.closeNotificationToast();
        } catch {
            // The toast is not guaranteed to appear on every run.
        }
    });

    test("renders a phone-first room list on mobile entry", async ({ page }) => {
        await expect(page).not.toHaveURL(/mobile_guide/);
        await expect(page.getByTestId("mx_MobileShell")).toBeVisible();
        await expect(page.getByTestId("mx_MobileChatsScreen")).toBeVisible();
        await expect(page.getByTestId("mx_MobileShell_bottomNav")).toBeVisible();
        await expect(page.locator(".mx_SpacePanel")).toHaveCount(0);

        const roomList = page.getByTestId("room-list");
        await expect(roomList).toBeVisible();
        await expect(roomList.locator(`[title="${ROOM_NAMES[ROOM_NAMES.length - 1]}"]`).first()).toBeVisible();
        await expect(page.getByTestId("room-list-item-content").first()).toBeVisible();

        await expectNoHorizontalOverflow(page.getByTestId("mx_MobileShell"));
        await expectNoHorizontalOverflow(roomList);
    });

    test("uses the full viewport for room timelines on mobile", async ({ page, app }) => {
        await app.viewRoomByName(ROOM_NAMES[0]);

        await expect(page.getByTestId("mx_MobileRoomScreen")).toBeVisible();
        await expect(page.getByTestId("mx_MobileShell_bottomNav")).toHaveCount(0);
        await expect(app.getComposer()).toBeVisible();

        const composer = app.getComposerField();
        await composer.fill("mobile shell smoke test");
        await composer.press("Enter");
        await expect(page.getByText("mobile shell smoke test")).toBeVisible();

        await expectNoHorizontalOverflow(page.getByTestId("mx_MobileRoomScreen"));
    });

    test("renders settings as a single-column mobile screen", async ({ page }) => {
        await page.getByTestId("mx_MobileShell_nav_settings").click();

        const settingsView = page.getByTestId("mx_MobileSettingsView");
        await expect(settingsView).toBeVisible();
        await expect(settingsView.locator(".mx_TabbedView_tabsOnTop")).toBeVisible();
        await expect(settingsView.locator(".mx_TabbedView_tabsOnLeft")).toHaveCount(0);
        await expect(settingsView.getByRole("textbox", { name: "Display Name" })).toBeVisible();

        await expectNoHorizontalOverflow(settingsView);
    });
});
