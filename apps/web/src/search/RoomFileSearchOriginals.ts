/*
Copyright 2026 LESP-book

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import type { MatrixEvent } from "matrix-js-sdk/src/matrix";

import type { IEventAndProfile } from "../indexing/BaseEventIndexManager";

// The Web index returns a projected event for display and its original for edit re-projection.
const originals = new WeakMap<MatrixEvent, { original: MatrixEvent; edits: IEventAndProfile["file_edits"] }>();

/** Keep original content alongside an indexed attachment without adding private fields to SDK events. */
export function rememberOriginalFileEvent(
    event: MatrixEvent,
    original: MatrixEvent,
    edits: IEventAndProfile["file_edits"],
): void {
    originals.set(event, { original, edits });
}

/** Recover the unedited base of a projected indexed event, when the provider supplies it. */
export function getOriginalFileEvent(
    event: MatrixEvent,
): { original: MatrixEvent; edits: IEventAndProfile["file_edits"] } | undefined {
    return originals.get(event);
}
