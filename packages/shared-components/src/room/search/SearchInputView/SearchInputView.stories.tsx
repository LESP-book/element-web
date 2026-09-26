/*
Copyright 2026 LESP-book

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import type { Meta, StoryObj } from "@storybook/react-vite";

import { MockViewModel } from "../../../core/viewmodel/MockViewModel";
import { SearchInputView, type SearchInputViewSnapshot } from "./SearchInputView";

class StoryViewModel extends MockViewModel<SearchInputViewSnapshot> {
    public change = (): void => {};
    public compositionStart = (): void => {};
    public compositionEnd = (): void => {};
    public submit = (): void => {};
    public stop = (): void => {};
    public resume = (): void => {};
}

const meta = {
    component: SearchInputView,
    title: "Room/Search/SearchInputView",
} satisfies Meta<typeof SearchInputView>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Searching: Story = {
    args: {
        vm: new StoryViewModel({
            term: "",
            placeholder: "Search by file name…",
            status: "Searching this room…",
            busy: true,
            stopped: false,
            stopLabel: "Stop searching",
            continueLabel: "Continue searching",
        }),
    },
};
