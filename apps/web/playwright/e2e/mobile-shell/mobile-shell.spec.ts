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
        await expect(page.locator(".mx_MobileShell_appBar")).toHaveCount(0);
        await expect(page.getByRole("button", { name: "People" })).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Other rooms" })).toHaveCount(0);

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
        await expect(page.getByTestId("mx_MobileShell_roomBackBar")).toContainText(ROOM_NAMES[0]);
        await expect(page.getByTestId("mx_MobileRoomHeaderActions")).toBeVisible();
        await expect(page.getByTestId("mx_MobileRoomHeaderInfoButton")).toBeVisible();
        await expect(page.getByTestId("mx_MobileShell_bottomNav")).toHaveCount(0);
        await expect(app.getComposer()).toBeVisible();

        const composer = app.getComposerField();
        await composer.fill("mobile shell smoke test");
        await composer.press("Enter");
        await expect(page.getByText("mobile shell smoke test")).toBeVisible();

        await page.getByText("mobile shell smoke test").click();
        const actionBar = page.locator(".mx_MessageActionBar:visible").first();
        await expect(actionBar).toBeVisible();
        const actionBarBox = await actionBar.boundingBox();
        expect(actionBarBox).not.toBeNull();
        expect(actionBarBox!.x + actionBarBox!.width).toBeLessThanOrEqual(pixel7.viewport.width - 4);

        const actionWidths = await page
            .locator(".mx_MessageComposer_actions")
            .first()
            .evaluate((element) => {
                const parentWidth = element.parentElement?.getBoundingClientRect().width ?? 0;
                const width = element.getBoundingClientRect().width;
                return { width, parentWidth };
            });
        expect(actionWidths.width).toBeLessThan(actionWidths.parentWidth * 0.4);

        await expectNoHorizontalOverflow(page.getByTestId("mx_MobileRoomScreen"));
    });

    test("navigates between the mobile room timeline, room details, and the chats list", async ({ page, app }) => {
        await app.viewRoomByName(ROOM_NAMES[1]);

        await expect(page.getByTestId("mx_MobileRoomScreen")).toBeVisible();
        await page.getByTestId("mx_MobileRoomHeaderInfoButton").click();

        const roomInfoOverlay = page.getByTestId("mx_MobileRoomInfoOverlay");
        const rightPanel = roomInfoOverlay.getByTestId("right-panel");
        await expect(page.getByTestId("mx_MobileRoomScreen")).toBeVisible();
        await expect(roomInfoOverlay).toBeVisible();
        await expect(rightPanel).toBeVisible();
        await expect(rightPanel).toContainText(ROOM_NAMES[1]);
        await expect(rightPanel).toContainText("People");

        await page.getByTestId("mx_MobileShell_backButton").click();
        await expect(page.getByTestId("mx_MobileRoomScreen")).toBeVisible();
        await expect(page.getByTestId("right-panel")).toHaveCount(0);

        await page.getByTestId("mx_MobileShell_backButton").click();
        await expect(page.getByTestId("mx_MobileChatsScreen")).toBeVisible();
        await expect(page.getByTestId("mx_MobileShell_bottomNav")).toBeVisible();
    });

    test("renders settings as a single-column mobile screen", async ({ page }) => {
        await page.getByTestId("mx_MobileShell_nav_settings").click();

        const settingsView = page.getByTestId("mx_MobileSettingsView");
        await expect(settingsView).toBeVisible();
        await expect(settingsView.locator(".mx_TabbedView_tabsOnTop")).toBeVisible();
        await expect(settingsView.locator(".mx_TabbedView_tabsOnLeft")).toHaveCount(0);
        await expect(settingsView.getByRole("textbox", { name: "Display Name" })).toBeVisible();
        const settingsPanel = settingsView.locator(".mx_TabbedView_tabPanelContent");
        await expect(settingsPanel).toBeVisible();
        const scrollTop = await settingsPanel.evaluate((element) => {
            element.scrollTop = 400;
            return element.scrollTop;
        });
        expect(scrollTop).toBeGreaterThan(0);

        await expectNoHorizontalOverflow(settingsView);
    });
});
