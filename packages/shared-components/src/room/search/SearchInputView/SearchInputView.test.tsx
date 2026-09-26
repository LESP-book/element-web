/*
Copyright 2026 LESP-book

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React from "react";
import { fireEvent, render, screen } from "@test-utils";
import { describe, expect, it, vi } from "vitest";

import { MockViewModel } from "../../../core/viewmodel/MockViewModel";
import { SearchInputView, type SearchInputViewSnapshot } from "./SearchInputView";

class TestSearchInputViewModel extends MockViewModel<SearchInputViewSnapshot> {
    public change = vi.fn();
    public compositionStart = vi.fn();
    public compositionEnd = vi.fn();
    public submit = vi.fn();
    public stop = vi.fn();
    public resume = vi.fn();
}

describe("SearchInputView", () => {
    it("should announce state and forward input, composition and stop actions", () => {
        const vm = new TestSearchInputViewModel({
            term: "",
            placeholder: "Search files",
            status: "Searching this room",
            busy: true,
            stopped: false,
            stopLabel: "Stop searching",
            continueLabel: "Continue searching",
        });
        render(<SearchInputView vm={vm} />);
        const input = screen.getByPlaceholderText("Search files");
        fireEvent.compositionStart(input);
        fireEvent.change(input, { target: { value: "文" } });
        fireEvent.compositionEnd(input, { data: "文", target: { value: "文" } });
        fireEvent.click(screen.getByRole("button", { name: "Stop searching" }));
        expect(vm.compositionStart).toHaveBeenCalledOnce();
        expect(vm.change).toHaveBeenCalledWith("文");
        expect(vm.compositionEnd).toHaveBeenCalledWith("文");
        expect(vm.stop).toHaveBeenCalledOnce();
        expect(screen.getByRole("status")).toHaveTextContent("Searching this room");
    });

    it("should show only the continue action while stopped", () => {
        const vm = new TestSearchInputViewModel({
            term: "test",
            placeholder: "Search files",
            status: "Paused",
            busy: false,
            stopped: true,
            stopLabel: "Stop searching",
            continueLabel: "Continue searching",
        });
        render(<SearchInputView vm={vm} />);
        fireEvent.click(screen.getByRole("button", { name: "Continue searching" }));
        expect(vm.resume).toHaveBeenCalledOnce();
        expect(screen.queryByRole("button", { name: "Stop searching" })).not.toBeInTheDocument();
    });
});
