/*
Copyright 2026 LESP-book

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";

import { FileSearchInputViewModel } from "./FileSearchInputViewModel";

afterEach(() => {
    vi.useRealTimers();
});

describe("FileSearchInputViewModel", () => {
    it("should debounce input and ignore Enter while composing Chinese text", () => {
        vi.useFakeTimers();
        const onInvalidate = vi.fn();
        const onCommit = vi.fn();
        const vm = new FileSearchInputViewModel({ onInvalidate, onCommit, onStop: vi.fn(), onResume: vi.fn() });
        vm.compositionStart();
        vm.change("中");
        vm.submit();
        vi.advanceTimersByTime(500);
        expect(onCommit).not.toHaveBeenCalled();
        vm.compositionEnd("中文");
        vi.advanceTimersByTime(299);
        expect(onCommit).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(onInvalidate).toHaveBeenCalledOnce();
        expect(onCommit).toHaveBeenCalledExactlyOnceWith("中文");
        vm.dispose();
    });

    it("should submit immediately on Enter and cancel pending work on disposal", () => {
        vi.useFakeTimers();
        const onCommit = vi.fn();
        const vm = new FileSearchInputViewModel({
            onInvalidate: vi.fn(),
            onCommit,
            onStop: vi.fn(),
            onResume: vi.fn(),
        });
        vm.change("first");
        vm.submit();
        vi.runAllTimers();
        expect(onCommit).toHaveBeenCalledExactlyOnceWith("first");
        vm.change("second");
        vm.dispose();
        vi.runAllTimers();
        expect(onCommit).toHaveBeenCalledTimes(1);
    });
});
