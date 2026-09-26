/*
Copyright 2026 LESP-book

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX } from "react";
import { Button, Form, Search } from "@vector-im/compound-web";

import { type ViewModel, useViewModel } from "../../../core/viewmodel";
import styles from "./SearchInputView.module.css";

/** Search input and continuation status provided by its application view model. */
export interface SearchInputViewSnapshot {
    term: string;
    placeholder: string;
    status: string;
    busy: boolean;
    stopped: boolean;
    stopLabel: string;
    continueLabel: string;
}

interface SearchInputViewActions {
    change: (value: string) => void;
    compositionStart: () => void;
    compositionEnd: (value: string) => void;
    submit: () => void;
    stop: () => void;
    resume: () => void;
}

/** A pure search input with an announced status and explicit stop/continue actions. */
export type SearchInputViewModel = ViewModel<SearchInputViewSnapshot, SearchInputViewActions>;

interface SearchInputViewProps {
    /** The view model which owns input composition, debounce and continuation state. */
    vm: SearchInputViewModel;
}

/** Renders a search input without owning a query or a provider cursor. */
export function SearchInputView({ vm }: Readonly<SearchInputViewProps>): JSX.Element {
    const { term, placeholder, status, busy, stopped, stopLabel, continueLabel } = useViewModel(vm);
    return (
        <div className={styles.root}>
            <Form.Root
                onSubmit={(event) => {
                    event.preventDefault();
                    vm.submit();
                }}
            >
                <Search
                    name="file_panel_search"
                    value={term}
                    placeholder={placeholder}
                    onChange={(event) => vm.change(event.currentTarget.value)}
                    onCompositionStart={vm.compositionStart}
                    onCompositionEnd={(event) => vm.compositionEnd(event.currentTarget.value)}
                />
            </Form.Root>
            <div className={styles.footer}>
                <span role="status" aria-live="polite">
                    {status}
                </span>
                {busy ? (
                    <Button type="button" kind="secondary" size="md" onClick={vm.stop}>
                        {stopLabel}
                    </Button>
                ) : null}
                {stopped ? (
                    <Button type="button" kind="secondary" size="md" onClick={vm.resume}>
                        {continueLabel}
                    </Button>
                ) : null}
            </div>
        </div>
    );
}
