/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { isMobileWebShellEnabled, shouldRedirectToMobileGuide } from "../../../../src/utils/device/mobileWebShell";

type MockWindow = {
    innerWidth: number;
    navigator: { userAgent: string };
    matchMedia: (query: string) => { matches: boolean };
};

const makeWindow = ({
    innerWidth = 390,
    userAgent = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/123 Mobile Safari/537.36",
    coarsePointer = true,
    standalone = false,
}: {
    innerWidth?: number;
    userAgent?: string;
    coarsePointer?: boolean;
    standalone?: boolean;
} = {}): MockWindow => ({
    innerWidth,
    navigator: { userAgent },
    matchMedia: (query: string) => ({
        matches:
            (query === "(pointer: coarse)" && coarsePointer) ||
            (query === "(display-mode: standalone)" && standalone),
    }),
});

describe("mobileWebShell", () => {
    it("enables the mobile web shell when the rollout flag is on and the viewport is phone-sized", () => {
        expect(isMobileWebShellEnabled({ mobile_web_shell_enabled: true }, makeWindow())).toBe(true);
    });

    it("does not enable the mobile web shell when the rollout flag is off", () => {
        expect(isMobileWebShellEnabled({ mobile_web_shell_enabled: false }, makeWindow())).toBe(false);
    });

    it("does not enable the mobile web shell on wide desktop-sized viewports", () => {
        expect(
            isMobileWebShellEnabled({ mobile_web_shell_enabled: true }, makeWindow({ innerWidth: 1280 })),
        ).toBe(false);
    });

    it("suppresses the legacy mobile-guide redirect when the mobile shell is enabled", () => {
        expect(shouldRedirectToMobileGuide({ mobile_web_shell_enabled: true }, makeWindow())).toBe(false);
    });

    it("keeps the legacy mobile-guide redirect as the rollback path when the shell is disabled", () => {
        expect(shouldRedirectToMobileGuide({ mobile_web_shell_enabled: false }, makeWindow())).toBe(true);
    });
});
