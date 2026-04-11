/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { type IConfigOptions } from "../../IConfigOptions";

type MatchMediaResult = Pick<MediaQueryList, "matches">;

export interface WindowLike {
    innerWidth: number;
    navigator: {
        userAgent: string;
    };
    matchMedia?: (query: string) => MatchMediaResult;
}

const PHONE_MAX_WIDTH = 767;

function matchesMediaQuery(windowLike: WindowLike, query: string): boolean {
    try {
        return windowLike.matchMedia?.(query)?.matches ?? false;
    } catch {
        return false;
    }
}

function isNativeMobileUserAgent(windowLike: WindowLike): boolean {
    return /iPad|iPhone|iPod|Android/i.test(windowLike.navigator.userAgent);
}

export function isMobileWebShellEnabled(
    config: Pick<IConfigOptions, "mobile_web_shell_enabled">,
    windowLike: WindowLike,
): boolean {
    if (!config.mobile_web_shell_enabled) {
        return false;
    }

    const isPhoneSizedViewport = windowLike.innerWidth <= PHONE_MAX_WIDTH;
    const hasMobileSignals =
        matchesMediaQuery(windowLike, "(pointer: coarse)") ||
        matchesMediaQuery(windowLike, "(display-mode: standalone)") ||
        isNativeMobileUserAgent(windowLike);

    return isPhoneSizedViewport && hasMobileSignals;
}

export function shouldRedirectToMobileGuide(
    config: Pick<IConfigOptions, "mobile_web_shell_enabled">,
    windowLike: WindowLike,
): boolean {
    if (isMobileWebShellEnabled(config, windowLike)) {
        return false;
    }

    return isNativeMobileUserAgent(windowLike);
}
