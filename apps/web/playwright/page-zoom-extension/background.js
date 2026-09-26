/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

const zoomFactors = [1, 1.25, 1.5, 1.75, 2];
const zoomIndexes = new Map();

chrome.runtime.onMessage.addListener((message, sender) => {
    if (!sender.tab?.id) return;

    let index = zoomIndexes.get(sender.tab.id) ?? 0;
    if (message.action === "reset") index = 0;
    if (message.action === "increase") index = Math.min(index + 1, zoomFactors.length - 1);
    zoomIndexes.set(sender.tab.id, index);
    void chrome.tabs.setZoom(sender.tab.id, zoomFactors[index]);
});

chrome.tabs.onRemoved.addListener((tabId) => zoomIndexes.delete(tabId));
