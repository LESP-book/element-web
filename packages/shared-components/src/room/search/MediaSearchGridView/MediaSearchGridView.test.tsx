/*
Copyright 2026 LESP-book

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React from "react";
import { render, screen } from "@test-utils";
import { VirtuosoMockContext } from "react-virtuoso";
import { describe, expect, it, vi } from "vitest";

import { MockViewModel } from "../../../core/viewmodel/MockViewModel";
import { MediaSearchGridView, type MediaSearchGridViewSnapshot } from "./MediaSearchGridView";

class TestMediaSearchGridViewModel extends MockViewModel<MediaSearchGridViewSnapshot<string>> {
    public loadMore = vi.fn();
}

describe("MediaSearchGridView", () => {
    it("should render month headings and only viewport rows using the caller's existing tiles", () => {
        const events = Array.from({ length: 90 }, (_, i) => `Photo ${i}`);
        const vm = new TestMediaSearchGridViewModel({
            columns: 3,
            rows: [
                { key: "month", label: "September 2026" },
                ...Array.from({ length: 30 }, (_, index) => ({
                    key: `row-${index}`,
                    items: events.slice(index * 3, index * 3 + 3).map((name) => ({ id: name, name, source: name })),
                })),
            ],
        });
        const { container } = render(
            <VirtuosoMockContext.Provider value={{ viewportHeight: 400, itemHeight: 100 }}>
                <div style={{ height: 400 }}>
                    <MediaSearchGridView
                        vm={vm}
                        renderTile={(item) => <li>{item.name}</li>}
                        footer={<button type="button">Continue search</button>}
                    />
                </div>
            </VirtuosoMockContext.Provider>,
        );
        expect(screen.getByText("September 2026")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Continue search" })).toBeInTheDocument();
        expect(screen.getByText("Photo 0")).toBeInTheDocument();
        expect(container.querySelectorAll("li").length).toBeLessThan(events.length);
    });
});
