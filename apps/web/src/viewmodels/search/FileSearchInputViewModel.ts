/*
Copyright 2026 LESP-book

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
    BaseViewModel,
    type SearchInputViewModel as SearchInputViewModelInterface,
    type SearchInputViewSnapshot,
} from "@element-hq/web-shared-components";

import { _t } from "../../languageHandler";

interface Props {
    onInvalidate: () => void;
    onCommit: (term: string) => void;
    onStop: () => void;
    onResume: () => void;
}

const DEBOUNCE_MS = 300;

/** Owns file-search input composition, debouncing and continuation actions. */
export class FileSearchInputViewModel
    extends BaseViewModel<SearchInputViewSnapshot, Props>
    implements SearchInputViewModelInterface
{
    private timer: ReturnType<typeof setTimeout> | null = null;
    private composing = false;
    private dirty = false;

    public constructor(props: Props) {
        super(props, {
            term: "",
            placeholder: _t("file_panel|search_placeholder"),
            status: _t("file_panel|searching"),
            busy: true,
            stopped: false,
            stopLabel: _t("file_panel|stop_search"),
            continueLabel: _t("file_panel|continue_search"),
        });
    }

    /** Display the parent's committed load state without recomputing query results. */
    public updateStatus = (status: string, busy: boolean, stopped: boolean): void => {
        this.snapshot.merge({ status, busy, stopped });
    };

    public change = (term: string): void => {
        this.snapshot.merge({ term });
        if (this.isDisposed) return;
        if (!this.dirty) {
            this.props.onInvalidate();
            this.dirty = true;
        }
        if (!this.composing) this.schedule();
    };

    public compositionStart = (): void => {
        this.composing = true;
        this.clearTimer();
    };

    public compositionEnd = (term: string): void => {
        this.composing = false;
        this.change(term);
    };

    public submit = (): void => {
        if (this.composing || this.isDisposed) return;
        this.clearTimer();
        this.dirty = false;
        this.props.onCommit(this.getSnapshot().term);
    };

    public stop = (): void => {
        if (this.isDisposed) return;
        this.props.onStop();
    };

    public resume = (): void => {
        if (this.isDisposed) return;
        this.props.onResume();
    };

    /** Commit the current draft on tab change without scheduling a second query. */
    public settleDraft = (): string => {
        this.clearTimer();
        this.dirty = false;
        return this.getSnapshot().term;
    };

    /** Reset the draft when moving to a different room. */
    public reset = (): void => {
        this.clearTimer();
        this.composing = false;
        this.dirty = false;
        this.snapshot.merge({ term: "" });
    };

    private schedule(): void {
        this.clearTimer();
        this.timer = setTimeout(this.submit, DEBOUNCE_MS);
    }

    private clearTimer(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
    }

    public override dispose(): void {
        this.clearTimer();
        super.dispose();
    }
}
