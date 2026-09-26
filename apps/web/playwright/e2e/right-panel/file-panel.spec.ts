/*
Copyright 2024 New Vector Ltd.
Copyright 2023 Suguru Hirahara

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/
import { test, expect } from "../../element-web-test";
import type { Locator, Page, TestInfo } from "@playwright/test";
import type { EventType, MsgType } from "matrix-js-sdk/src/matrix";
import { viewRoomSummaryByName } from "./utils";
import { isDendrite } from "../../plugins/homeserver/dendrite";
import { getSampleFilePath } from "../../sample-files";
import { readFile } from "node:fs/promises";
import type { ElementAppPage } from "../../pages/ElementAppPage";

const ROOM_NAME = "Test room";
const NAME = "Alice";

async function uploadFile(app: ElementAppPage, sampleFile: string) {
    // Upload a file from the message composer
    await app.composerUploadFiles("room", getSampleFilePath(sampleFile));
    // Wait until the file is sent
    await expect(app.page.locator(".mx_RoomView_statusArea_expanded")).not.toBeVisible();
    await expect(app.page.locator(".mx_RoomView_body .mx_EventTile").last().getByRole("status")).toHaveAccessibleName(
        "Your message was sent",
    );
}

async function verifyZoomedDownload(
    page: Page,
    panel: Locator,
    link: Locator,
    testInfo: TestInfo,
    label: string,
): Promise<void> {
    await expect(link).toBeVisible();
    await page.keyboard.press("ControlOrMeta+0");
    const baselineWidth = await page.evaluate(() => document.documentElement.clientWidth);
    let previousZoomWidth = baselineWidth;
    try {
        for (const [percent, presses] of [
            [100, 0],
            [150, 3],
            [200, 5],
        ] as const) {
            await page.keyboard.press("ControlOrMeta+0");
            for (let i = 0; i < presses; i++) await page.keyboard.press("ControlOrMeta+Shift+Equal");
            // Browser zoom changes the layout viewport; do not assume Chrome's platform-specific step size.
            await expect
                .poll(() => page.evaluate(() => document.documentElement.clientWidth), { timeout: 2_000 })
                .toBeLessThanOrEqual(percent === 100 ? baselineWidth + 1 : previousZoomWidth - 1);
            const zoomWidth = await page.evaluate(() => document.documentElement.clientWidth);
            if (percent === 100) expect(zoomWidth).toBe(baselineWidth);
            previousZoomWidth = zoomWidth;
            await link.scrollIntoViewIfNeeded();
            const panelBounds = await panel.boundingBox();
            const bounds = await link.boundingBox();
            expect(panelBounds).not.toBeNull();
            expect(bounds).not.toBeNull();
            expect(bounds!.x).toBeGreaterThanOrEqual(panelBounds!.x);
            expect(bounds!.y).toBeGreaterThanOrEqual(panelBounds!.y);
            expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(panelBounds!.x + panelBounds!.width + 1);
            expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(panelBounds!.y + panelBounds!.height + 1);
            const downloadPromise = page.waitForEvent("download");
            await link.click();
            const download = await downloadPromise;
            expect(await download.failure()).toBeNull();
            const downloadPath = await download.path();
            expect(downloadPath).not.toBeNull();
            expect((await readFile(downloadPath!)).byteLength).toBeGreaterThan(0);
            const screenshot = await panel.screenshot();
            await testInfo.attach(`real-media-panel-${label}-zoom-${percent}`, {
                body: screenshot,
                contentType: "image/png",
            });
            await panel.screenshot({ path: `/tmp/element-search-panel-${label}-zoom-${percent}.png` });
        }
    } finally {
        if (!page.isClosed()) await page.keyboard.press("ControlOrMeta+0");
    }
}

test.describe("FilePanel", () => {
    test.use({
        displayName: NAME,
    });

    test.beforeEach(async ({ page, user, app }) => {
        await app.client.createRoom({ name: ROOM_NAME });

        // Open the file panel
        await viewRoomSummaryByName(page, app, ROOM_NAME);
        await page.getByRole("menuitem", { name: "Files" }).click();
        await expect(page.locator(".mx_FilePanel")).toBeVisible();
    });

    test.describe("render", { tag: ["@no-firefox", "@no-webkit"] }, () => {
        test("should render empty state", { tag: "@screenshot" }, async ({ page }) => {
            // Wait until the information about the empty state is rendered
            await expect(page.locator(".mx_EmptyState")).toBeVisible();

            // Take a snapshot of RightPanel - fix https://github.com/vector-im/element-web/issues/25332
            await expect(page.locator(".mx_RightPanel")).toMatchScreenshot("empty.png");
        });

        test("should list tiles on the panel", { tag: "@screenshot" }, async ({ page, app }) => {
            // Upload multiple files
            await uploadFile(app, "riot.png"); // Image
            await uploadFile(app, "1sec.ogg"); // Audio
            await uploadFile(app, "matrix-org-client-versions.json"); // JSON

            const roomViewBody = page.locator(".mx_RoomView_body");
            // Assert that all of the file were uploaded and rendered
            await expect(roomViewBody.locator(".mx_EventTile")).toHaveCount(3);

            // Assert that the image exists and has the alt string
            await expect(
                roomViewBody.locator(".mx_EventTile").filter({ has: page.locator("img[alt='riot.png']") }),
            ).toBeVisible();

            // Assert that the audio player is rendered
            await expect(roomViewBody.getByRole("region", { name: "Audio player" })).toBeVisible();

            // Assert that the file is rendered as a preview tile with its name and a download button
            const fileTile = roomViewBody.locator(".mx_EventTile").last();
            await expect(fileTile.getByText(/matrix.*?\.json/)).toBeVisible();
            await expect(fileTile.getByRole("button", { name: "Download" })).toBeVisible();

            const filePanel = page.locator(".mx_FilePanel");
            // Assert that the file panel is opened inside mx_RightPanel and visible
            await expect(filePanel).toBeVisible();

            const filePanelMessageList = filePanel.locator(".mx_RoomView_MessageList");

            // The panel renders EventTileView file tiles without legacy layout attributes.
            await expect(filePanelMessageList.locator(".mx_EventTile").first()).not.toHaveAttribute("data-layout");

            // Assert that all of the file tiles are rendered
            await expect(filePanelMessageList.locator(".mx_EventTile")).toHaveCount(3);

            // Assert that the download links are rendered for the image and the audio file, which embed
            // the classic file body as their download-only fallback
            await expect(filePanelMessageList.locator(".mx_MFileBody")).toHaveCount(2);

            // Assert that the sender of the files is rendered on all of the tiles
            await expect(filePanelMessageList.getByText(NAME)).toHaveCount(3);

            // Detect the image file
            const image = filePanelMessageList
                .locator(".mx_EventTile")
                .filter({ has: page.locator("img[alt='riot.png']") })
                .getByTestId("event-tile-slot-body");
            // Assert that the image is specified as thumbnail and has the alt string
            await expect(image.locator("img.mx_ImageBody_image")).toBeVisible();
            await expect(image.locator("img[alt='riot.png']")).toBeVisible();

            // Detect the audio file
            const audio = filePanelMessageList.getByRole("region", { name: "Audio player" });
            // Assert that the play button is rendered
            await expect(audio.getByRole("button", { name: "Play" })).toBeVisible();

            // Detect the JSON file
            // Assert that the file is rendered as a preview tile with its name and a download button
            const file = filePanelMessageList.locator(".mx_EventTile").last();
            await expect(file.getByText(/matrix.*?\.json/)).toBeVisible();
            await expect(file.getByRole("button", { name: "Download" })).toBeVisible();

            // Make the viewport tall enough to display all of the file tiles on FilePanel
            await page.setViewportSize({ width: 800, height: 1000 });

            // In case the panel is scrollable on the resized viewport
            // Assert that the value for flexbox is applied
            await expect(filePanel.locator(".mx_ScrollPanel .mx_RoomView_MessageList")).toHaveCSS(
                "justify-content",
                "flex-end",
            );
            // Assert that all of the file tiles are visible before taking a snapshot
            await expect(filePanelMessageList.locator(".mx_ImageBody")).toBeVisible(); // top
            await expect(filePanelMessageList.locator(".mx_MAudioBody")).toBeVisible(); // middle
            const timestampedTile = filePanelMessageList
                .locator(".mx_EventTile")
                .filter({ has: page.getByTestId("event-tile-slot-timestamp") })
                .last();
            const senderDetails = timestampedTile.getByTestId("event-tile-slot-sender");
            await expect(senderDetails.locator(".mx_DisambiguatedProfile")).toBeVisible();
            await expect(
                timestampedTile.getByTestId("event-tile-slot-timestamp").locator(".mx_MessageTimestamp"),
            ).toBeVisible();

            // Take a snapshot of file tiles list on FilePanel
            await expect(filePanelMessageList).toMatchScreenshot("file-tiles-list.png", {
                // Exclude timestamps & flaky seek bar from snapshot
                mask: [page.getByTestId("audio-player-seek")],
                css: `
                    .mx_MessageTimestamp {
                        visibility: hidden;
                    }
                `,
            });
        });

        test("should render the audio player and play the audio file on the panel", async ({ page, app }) => {
            // Upload an image file
            await uploadFile(app, "1sec.ogg");

            const audioBody = page.getByTestId("right-panel").getByRole("region", { name: "Audio player" });

            // Assert that the audio player is rendered
            // Assert that the audio file information is rendered;
            await expect(audioBody.getByText("1sec.ogg")).toBeVisible(); // extension
            await expect(audioBody.getByRole("time")).toHaveText("00:01"); // duration
            await expect(audioBody.getByText("(3.56 KB)")).toBeVisible(); // actual size;

            // Assert that the duration counter is 00:01 before clicking the play button
            await expect(audioBody.getByRole("time")).toHaveText("00:01");

            // Assert that the counter is zero before clicking the play button
            await expect(audioBody.getByRole("timer")).toHaveText("00:00");

            // Click the play button
            await audioBody.getByRole("button", { name: "Play" }).click();

            // Assert that the pause button is rendered
            await expect(audioBody.getByRole("button", { name: "Pause" })).toBeVisible();

            // Assert that the timer is reset when the audio file finished playing
            await expect(audioBody.getByRole("timer")).toHaveText("00:00");

            // Assert that the play button is rendered
            await expect(audioBody.getByRole("button", { name: "Play" })).toBeVisible();
        });

        test("should render file size in kibibytes on a file tile", async ({ page, app }) => {
            const size = "1.12 KB"; // actual file size in kibibytes (1024 bytes)

            // Upload a file
            await uploadFile(app, "matrix-org-client-versions.json");

            const tile = page.locator(".mx_FilePanel .mx_EventTile");
            // Assert that the file size is displayed in kibibytes, not kilobytes (1000 bytes)
            // See: https://github.com/vector-im/element-web/issues/24866
            // The panel renders files as a preview tile, which shows the size as the tile body.
            await expect(tile.getByText(size)).toBeVisible();
        });
    });

    test("finds a file after four empty history pages without clicking continue", async ({ page, app, user }) => {
        await page.locator(".mx_FilePanel").getByRole("button", { name: "Close" }).click();
        const roomId = await app.client.createRoom({ name: "Sparse files fixture" });
        await app.viewRoomById(roomId);
        let pages = 0;
        await page.route("**/_matrix/client/**/rooms/**/messages?*", async (route) => {
            if (!route.request().url().includes(encodeURIComponent(roomId))) return route.continue();
            pages++;
            const attachment = pages === 5;
            await route.fulfill({
                contentType: "application/json",
                body: JSON.stringify({
                    start: new URL(route.request().url()).searchParams.get("from"),
                    end: `sparse-${pages}`,
                    chunk:
                        pages <= 5
                            ? [
                                  {
                                      event_id: `$sparse-${pages}`,
                                      room_id: roomId,
                                      sender: user.userId,
                                      origin_server_ts: Date.now() - pages * 1000,
                                      type: "m.room.message",
                                      content: attachment
                                          ? {
                                                msgtype: "m.file",
                                                body: "found-fifth.txt",
                                                url: "mxc://localhost/sparse-fixture",
                                            }
                                          : { msgtype: "m.text", body: `ordinary message ${pages}` },
                                  },
                              ]
                            : [],
                }),
            });
        });
        await viewRoomSummaryByName(page, app, "Sparse files fixture");
        await page.getByRole("menuitem", { name: "Files" }).click();
        await expect(page.locator(".mx_FilePanel").getByText("found-fifth.txt")).toBeVisible({ timeout: 20_000 });
        expect(pages).toBeGreaterThanOrEqual(5);
    });

    test("finds a real room message and jumps to it in development StrictMode", async ({ page, app }) => {
        const message = "Search lifecycle check in room";
        const composer = app.getComposerField();
        await composer.fill(message);
        await composer.press("Enter");
        await expect(page.getByText(message, { exact: true })).toBeVisible();
        await page.locator(".mx_FilePanel").getByRole("button", { name: "Close" }).click();
        await app.toggleRoomInfoPanel();
        const input = page.locator(".mx_RoomSummaryCard_search").getByRole("searchbox");
        await input.fill("lifecycle check");
        await input.press("Enter");
        const result = page.locator(".mx_RoomView_searchResultsPanel").getByText(message, { exact: true });
        await expect(result).toBeVisible();
        await page.locator(".mx_RoomView_searchResultsPanel").getByRole("button", { name: "View in room" }).click();
        await expect(page.getByTestId("event-tile-slot-body").getByText(message, { exact: true })).toBeVisible();
    });

    test("downloads an encrypted image from the real media panel", async ({ page, app }) => {
        await page.locator(".mx_FilePanel").getByRole("button", { name: "Close" }).click();
        const roomId = await app.client.createRoom({
            name: "Encrypted media fixture",
            initial_state: [
                {
                    type: "m.room.encryption",
                    state_key: "",
                    content: { algorithm: "m.megolm.v1.aes-sha2" },
                },
            ],
        });
        await app.viewRoomById(roomId);
        await expect(page.getByRole("heading", { name: /Encrypted media fixture New members/ })).toBeVisible();
        await uploadFile(app, "riot.png");
        await viewRoomSummaryByName(page, app, "Encrypted media fixture");
        await page.getByRole("menuitem", { name: "Files" }).click();
        const panel = page.locator(".mx_FilePanel");
        await panel.getByText("Media", { exact: true }).click();
        const button = panel.locator(".mx_RoomMediaSearchTile").getByRole("button", { name: /^Download/ });
        await expect(button).toBeVisible();
        const downloadPromise = page.waitForEvent("download");
        await button.click();
        expect((await downloadPromise).suggestedFilename()).toBe("riot.png");
    });

    test("keeps media downloads usable with the global hide-preview setting", async ({ page, app }) => {
        const settings = await app.settings.openUserSettings("Preferences");
        await settings.getByLabel("Show media in timeline").getByRole("radio", { name: "Always hide" }).click();
        await app.closeDialog();
        await uploadFile(app, "riot.png");
        const panel = page.locator(".mx_FilePanel");
        await panel.getByText("Media", { exact: true }).click();
        const tile = panel.locator(".mx_RoomMediaSearchTile").filter({ hasText: "riot.png" });
        const link = tile.getByRole("link", { name: /^Download/ });
        await expect(link).toBeVisible();
        const downloadPromise = page.waitForEvent("download");
        await link.click();
        expect((await downloadPromise).suggestedFilename()).toBe("riot.png");
    });

    test("keeps the media action visible when its preview fails to load", async ({ page, app }) => {
        const roomId = await app.client.createRoom({ name: "Broken media fixture" });
        await app.viewRoomById(roomId);
        await app.client.sendEvent(roomId, null, "m.room.message" as EventType, {
            msgtype: "m.image" as MsgType,
            body: "broken-preview.png",
            url: "mxc://localhost/does-not-exist",
            info: { mimetype: "image/png", size: 10 },
        });
        await viewRoomSummaryByName(page, app, "Broken media fixture");
        await page.getByRole("menuitem", { name: "Files" }).click();
        const panel = page.locator(".mx_FilePanel");
        await panel.getByText("Media", { exact: true }).click();
        const tile = panel.locator(".mx_RoomMediaSearchTile").filter({ hasText: "broken-preview.png" });
        await expect(tile).toBeVisible();
        await expect(tile.getByText(/Unable to show image due to error/)).toBeVisible();
        const fallbackDownload = tile.getByRole("link", { name: /^Download/ });
        await expect(fallbackDownload).toBeVisible();
        await fallbackDownload.click();
        await expect(tile.getByRole("button", { name: "View in room" })).toBeVisible();
        await tile.screenshot({ path: "/tmp/element-search-failed-media-tile.png" });
    });

    test("keeps the download action when a video preview fails", async ({ page, app }) => {
        const roomId = await app.client.createRoom({ name: "Broken video fixture" });
        await app.viewRoomById(roomId);
        await app.client.sendEvent(roomId, null, "m.room.message" as EventType, {
            msgtype: "m.video" as MsgType,
            body: "broken-preview.webm",
            url: "mxc://localhost/does-not-exist-video",
            info: { mimetype: "video/webm", size: 10 },
        });
        await viewRoomSummaryByName(page, app, "Broken video fixture");
        await page.getByRole("menuitem", { name: "Files" }).click();
        const panel = page.locator(".mx_FilePanel");
        await panel.getByText("Media", { exact: true }).click();
        const tile = panel.locator(".mx_RoomMediaSearchTile").filter({ hasText: "broken-preview.webm" });
        await expect(tile).toBeVisible();
        const downloadLink = tile.getByRole("link", { name: /^Download/ });
        await expect(downloadLink).toBeVisible();
        await downloadLink.click();
        await expect(tile).toBeVisible();
    });

    test("keeps a long multilingual media filename and its download usable", async ({ page, app }) => {
        const name = `${"旅途中的照片和一个很长的说明".repeat(5)}.png`;
        await app.composerUploadFiles("room", {
            name,
            mimeType: "image/png",
            buffer: await readFile(getSampleFilePath("riot.png")),
        });
        const panel = page.locator(".mx_FilePanel");
        await panel.getByText("Media", { exact: true }).click();
        const tile = panel.locator(".mx_RoomMediaSearchTile").filter({ hasText: name });
        await expect(tile.getByTitle(name)).toBeVisible();
        const link = tile.getByRole("link", { name: /^Download/ });
        await expect(link).toBeVisible();
        const bounds = await link.boundingBox();
        const panelBounds = await panel.boundingBox();
        expect(bounds).not.toBeNull();
        expect(panelBounds).not.toBeNull();
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(panelBounds!.x + panelBounds!.width + 1);
        const downloadPromise = page.waitForEvent("download");
        await link.click();
        expect((await downloadPromise).suggestedFilename()).toBe(name);
    });

    test("keeps image downloads usable at real Chrome page zoom", async ({ page, app, user }, testInfo) => {
        test.skip(
            testInfo.project.name !== "ChromeZoom",
            "Browser-level zoom requires the dedicated ChromeZoom project",
        );
        test.skip(
            Boolean(process.env.PW_TEST_CONNECT_WS_ENDPOINT),
            "Browser-level zoom requires a local Chromium process; remote Playwright connections cannot load the extension",
        );
        test.setTimeout(90_000);
        expect(await app.client.evaluate((client) => client.getUserId())).toBe(user.userId);
        await uploadFile(app, "riot.png");
        const panel = page.locator(".mx_FilePanel");
        await panel.getByText("Media", { exact: true }).click();
        await verifyZoomedDownload(
            page,
            panel,
            panel
                .locator(".mx_RoomMediaSearchTile")
                .filter({ hasText: "riot.png" })
                .getByRole("link", {
                    name: /^Download/,
                }),
            testInfo,
            "image",
        );
    });

    test("keeps video downloads usable at real Chrome page zoom", async ({ page, app, user }, testInfo) => {
        test.skip(
            testInfo.project.name !== "ChromeZoom",
            "Browser-level zoom requires the dedicated ChromeZoom project",
        );
        test.skip(
            Boolean(process.env.PW_TEST_CONNECT_WS_ENDPOINT),
            "Browser-level zoom requires a local Chromium process; remote Playwright connections cannot load the extension",
        );
        test.setTimeout(90_000);
        expect(await app.client.evaluate((client) => client.getUserId())).toBe(user.userId);
        await uploadFile(app, "5secvid.webm");
        const panel = page.locator(".mx_FilePanel");
        await panel.getByText("Media", { exact: true }).click();
        await verifyZoomedDownload(
            page,
            panel,
            panel
                .locator(".mx_RoomMediaSearchTile")
                .filter({ hasText: "5secvid.webm" })
                .getByRole("link", {
                    name: /^Download/,
                }),
            testInfo,
            "video",
        );
    });

    test("shows real media downloads within narrow panels", async ({ page, app }, testInfo) => {
        await uploadFile(app, "riot.png");
        await uploadFile(app, "5secvid.webm");
        const panel = page.locator(".mx_FilePanel");
        await expect(panel.getByText("No matching files in the scanned range")).toHaveCount(0);
        await panel.getByText("Media", { exact: true }).click();
        const tile = panel.locator(".mx_RoomMediaSearchTile").filter({ hasText: "riot.png" });
        const downloadLink = tile.getByRole("link", { name: /^Download/ });
        const videoLink = panel
            .locator(".mx_RoomMediaSearchTile")
            .filter({ hasText: "5secvid.webm" })
            .getByRole("link", { name: /^Download/ });
        await expect(downloadLink).toBeVisible();
        await expect(videoLink).toBeVisible();
        await page.setViewportSize({ width: 1920, height: 900 });
        const handle = page.locator(".mx_RightPanel_ResizeWrapper .mx_ResizeHandle--horizontal");
        for (const width of [320, 400, 600]) {
            const current = await page.locator(".mx_RightPanel_ResizeWrapper").boundingBox();
            const grip = await handle.boundingBox();
            expect(current).not.toBeNull();
            expect(grip).not.toBeNull();
            await page.mouse.move(grip!.x + grip!.width / 2, grip!.y + grip!.height / 2);
            await page.mouse.down();
            await page.mouse.move(grip!.x + grip!.width / 2 - (width - current!.width), grip!.y + grip!.height / 2, {
                steps: 8,
            });
            await page.mouse.up();
            await expect.poll(async () => (await panel.boundingBox())?.width).toBeGreaterThanOrEqual(width - 2);
            const panelBounds = await panel.boundingBox();
            expect(panelBounds).not.toBeNull();
            for (const [link, filename] of [
                [downloadLink, "riot.png"],
                [videoLink, "5secvid.webm"],
            ] as const) {
                await link.scrollIntoViewIfNeeded();
                const bounds = await link.boundingBox();
                expect(bounds).not.toBeNull();
                expect(bounds!.x).toBeGreaterThanOrEqual(panelBounds!.x);
                expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(panelBounds!.x + panelBounds!.width + 1);
                const downloadPromise = page.waitForEvent("download");
                await link.click();
                expect((await downloadPromise).suggestedFilename()).toBe(filename);
            }
            const screenshot = await panel.screenshot();
            await testInfo.attach(`real-media-panel-${width}`, { body: screenshot, contentType: "image/png" });
            await panel.screenshot({ path: `/tmp/element-search-panel-${width}.png` });
        }
    });

    test.describe("download", () => {
        test.skip(isDendrite, "due to a Dendrite sending Content-Disposition inline");

        test("should download an image via the link on the panel", async ({ page, app, context }) => {
            // Upload an image file
            await uploadFile(app, "riot.png");

            // Detect the image file on the panel
            const imageTile = page
                .locator(".mx_FilePanel .mx_RoomView_MessageList .mx_EventTile")
                .filter({ has: page.locator("img[alt='riot.png']") });
            const link = imageTile.getByTestId("event-tile-slot-body").getByRole("link", { name: /^Download/ });

            const downloadPromise = page.waitForEvent("download");

            // Click the anchor link (not the image itself)
            await link.click();

            const download = await downloadPromise;
            expect(download.suggestedFilename()).toBe("riot.png");
        });
    });
});
