/*
Copyright 2026 LESP-book

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX, type ReactNode } from "react";
import { Virtuoso, type StateSnapshot, type VirtuosoHandle } from "react-virtuoso";
import { Heading } from "@vector-im/compound-web";

import { type ViewModel, useViewModel } from "../../../core/viewmodel";
import styles from "./MediaSearchGridView.module.css";

/** An attachment and its presentation details, with an app-owned source for existing preview behavior. */
export interface MediaSearchItem<T> {
    id: string;
    name: string;
    source: T;
}

/** A month heading or a responsive row of media results. */
export type MediaSearchRow<T> =
    | { key: string; label: string; items?: never }
    | { key: string; items: MediaSearchItem<T>[]; label?: never };

/** Virtualized media rows prepared by the application view model. */
export interface MediaSearchGridViewSnapshot<T> {
    rows: MediaSearchRow<T>[];
    columns: number;
}

/** Presentation-only view model for room media search. */
export type MediaSearchGridViewModel<T> = ViewModel<MediaSearchGridViewSnapshot<T>, { loadMore: () => void }>;

interface MediaSearchGridViewProps<T> {
    /** The grouped, viewport-sized media rows. */
    vm: MediaSearchGridViewModel<T>;
    /** A media-specific tile supplied by the app to preserve authenticated/encrypted previews. */
    renderTile: (item: MediaSearchItem<T>) => ReactNode;
    /** Loading, error and continuation controls in the same scrolling region as the tiles. */
    footer?: ReactNode;
    /** Restore the visible row when returning to this tab. */
    restoreStateFrom?: StateSnapshot;
    /** Access the visible row before switching tabs. */
    listRef?: React.Ref<VirtuosoHandle>;
}

function MediaFooter({ context }: { context: ReactNode }): JSX.Element {
    return <>{context}</>;
}

/** Render only visible media rows; the caller supplies an app-owned media preview tile. */
export function MediaSearchGridView<T>({
    vm,
    renderTile,
    footer,
    restoreStateFrom,
    listRef,
}: Readonly<MediaSearchGridViewProps<T>>): JSX.Element {
    const { rows, columns } = useViewModel(vm);
    return (
        <Virtuoso
            restoreStateFrom={restoreStateFrom}
            ref={listRef}
            className={styles.scroll}
            endReached={vm.loadMore}
            data={rows}
            computeItemKey={(_, row) => row.key}
            context={footer}
            components={{ Footer: MediaFooter }}
            itemContent={(_, row) =>
                row.label !== undefined ? (
                    <Heading as="h3" size="sm" className={styles.month}>
                        {row.label}
                    </Heading>
                ) : (
                    <ul className={styles.grid} style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
                        {row.items.map((item) => (
                            <React.Fragment key={item.id}>{renderTile(item)}</React.Fragment>
                        ))}
                    </ul>
                )
            }
        />
    );
}
