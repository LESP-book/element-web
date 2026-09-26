/*
Copyright 2026 LESP-book

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { MockViewModel } from "../../../core/viewmodel/MockViewModel";
import { MediaSearchGridView, type MediaSearchGridViewSnapshot } from "./MediaSearchGridView";

class StoryViewModel extends MockViewModel<MediaSearchGridViewSnapshot<string>> {
    public loadMore = (): void => {};
}

const meta = {
    component: MediaSearchGridView,
    title: "Room/Search/MediaSearchGridView",
    decorators: [
        (Story) => (
            <div style={{ height: 500, maxWidth: 480 }}>
                <Story />
            </div>
        ),
    ],
} satisfies Meta<typeof MediaSearchGridView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
    args: {
        vm: new StoryViewModel({
            rows: [
                { key: "month", label: "September 2026" },
                { key: "row", items: [{ id: "example", name: "Example photo", source: "example" }] },
            ],
            columns: 3,
        }),
        renderTile: (item) => <li>{item.name}</li>,
    },
};
