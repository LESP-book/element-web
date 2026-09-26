/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

document.addEventListener("keydown", (event) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    if (event.key === "0") {
        event.preventDefault();
        void chrome.runtime.sendMessage({ action: "reset" });
    } else if (event.shiftKey && (event.key === "=" || event.key === "+")) {
        event.preventDefault();
        void chrome.runtime.sendMessage({ action: "increase" });
    }
});
