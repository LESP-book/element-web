/*
Copyright 2024 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { chromium, type BrowserContextOptions } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { test as commonBase } from "@element-hq/element-web-playwright-common";
import {
    type Services as BaseServices,
    type WorkerOptions as BaseWorkerOptions,
} from "@element-hq/element-web-playwright-common/lib/fixtures";
import { type HomeserverContainer } from "@element-hq/element-web-playwright-common/lib/testcontainers/index.js";

import { type OAuthServer } from "./plugins/oauth_server";
import { DendriteContainer, PineconeContainer } from "./testcontainers/dendrite";
import { type HomeserverType } from "./plugins/homeserver";
import { SynapseContainer } from "./testcontainers/synapse";
import { startMatrixRTCBackend, type StartedMatrixRTCBackend } from "./testcontainers/matrix-rtc";

const pageZoomExtension = fileURLToPath(new URL("./page-zoom-extension", import.meta.url));

export interface Services extends BaseServices {
    // Set in legacyOAuthHomeserver only
    oAuthServer?: OAuthServer;
    /**
     * The started MatrixRTC backend (LiveKit SFU + lk-jwt-service) for the worker.
     * Only set when the `matrixRTC` option is on.
     */
    matrixRTCBackend?: StartedMatrixRTCBackend;
}

export interface WorkerOptions extends BaseWorkerOptions {
    homeserverType: HomeserverType;
    /**
     * Start a real MatrixRTC backend (LiveKit SFU + lk-jwt-service) and configure Synapse to announce it,
     * so that Element Call can hold real calls with media. Synapse only.
     */
    matrixRTC: boolean;
}

export const test = commonBase.extend<{}, Services & WorkerOptions>({
    homeserverType: ["synapse", { option: true, scope: "worker" }],
    matrixRTC: [false, { option: true, scope: "worker" }],
    matrixRTCBackend: [
        async ({ matrixRTC, network, logger }, use) => {
            if (!matrixRTC) {
                await use(undefined);
                return;
            }
            const backend = await startMatrixRTCBackend(network, logger);
            await use(backend);
            await backend.stop();
        },
        { scope: "worker" },
    ],
    _homeserver: [
        async ({ homeserverType, matrixRTCBackend }, use) => {
            let container: HomeserverContainer<unknown>;
            switch (homeserverType) {
                case "synapse":
                    container = new SynapseContainer();
                    break;
                case "dendrite":
                    container = new DendriteContainer();
                    break;
                case "pinecone":
                    container = new PineconeContainer();
                    break;
            }

            if (matrixRTCBackend) {
                if (!(container instanceof SynapseContainer)) {
                    throw new Error(`The matrixRTC option is only supported with Synapse, not ${homeserverType}`);
                }
                container
                    .withConfig(matrixRTCBackend.synapseConfig)
                    .withCopyFilesToContainer(matrixRTCBackend.synapseFiles);
            }

            await use(container);
        },
        { scope: "worker" },
    ],

    context: async ({ homeserverType, synapseConfig, context, _homeserver }, use, testInfo) => {
        testInfo.skip(
            !(_homeserver instanceof SynapseContainer) && Object.keys(synapseConfig).length > 0,
            `Test specifies Synapse config options so is unsupported with ${homeserverType}`,
        );

        if (testInfo.project.name !== "ChromeZoom") {
            await use(context);
            return;
        }

        if (process.env.PW_TEST_CONNECT_WS_ENDPOINT) {
            await use(context);
            return;
        }

        await context.close();
        const userDataDir = await mkdtemp(`${tmpdir()}/element-playwright-zoom-`);
        const projectUse = testInfo.project.use;
        const launchOptions = projectUse.launchOptions ?? {};
        // Recreate the context options before adding the extension. The normal page/user fixtures still run against
        // this context; the zoom tests also assert the fixture-provided user identity before touching the UI.
        const contextOptions: BrowserContextOptions = {
            acceptDownloads: projectUse.acceptDownloads,
            baseURL: projectUse.baseURL,
            bypassCSP: projectUse.bypassCSP,
            colorScheme: projectUse.colorScheme,
            contrast: projectUse.contrast,
            deviceScaleFactor: projectUse.deviceScaleFactor,
            extraHTTPHeaders: projectUse.extraHTTPHeaders,
            forcedColors: projectUse.forcedColors,
            geolocation: projectUse.geolocation,
            hasTouch: projectUse.hasTouch,
            httpCredentials: projectUse.httpCredentials,
            ignoreHTTPSErrors: projectUse.ignoreHTTPSErrors,
            isMobile: projectUse.isMobile,
            javaScriptEnabled: projectUse.javaScriptEnabled,
            locale: projectUse.locale,
            offline: projectUse.offline,
            permissions: projectUse.permissions,
            proxy: projectUse.proxy,
            reducedMotion: projectUse.reducedMotion,
            screen: projectUse.screen,
            serviceWorkers: projectUse.serviceWorkers,
            storageState: projectUse.storageState,
            timezoneId: projectUse.timezoneId,
            userAgent: projectUse.userAgent,
            viewport: projectUse.viewport,
        };
        const zoomContext = await chromium.launchPersistentContext(userDataDir, {
            ...contextOptions,
            ...launchOptions,
            channel: "chromium",
            headless: false,
            args: [
                ...(launchOptions.args ?? []),
                "--headless=new",
                `--disable-extensions-except=${pageZoomExtension}`,
                `--load-extension=${pageZoomExtension}`,
            ],
        });
        try {
            await use(zoomContext);
        } finally {
            await zoomContext.close();
            await rm(userDataDir, { recursive: true, force: true });
        }
    },
});
