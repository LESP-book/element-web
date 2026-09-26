/*
Copyright 2026 LESP-book

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
    BaseViewModel,
    type MediaSearchGridViewModel,
    type MediaSearchGridViewSnapshot,
    type MediaSearchItem,
    type MediaSearchRow,
} from "@element-hq/web-shared-components";
import type { MatrixEvent } from "matrix-js-sdk/src/matrix";

import { getUserLanguage } from "../../i18n/settings";

interface Props {
    onEndReached: () => void;
}

/** Groups media events into month headings and virtualizable responsive rows. */
export class RoomMediaSearchViewModel
    extends BaseViewModel<MediaSearchGridViewSnapshot<MatrixEvent>, Props>
    implements MediaSearchGridViewModel<MatrixEvent>
{
    public constructor(props: Props) {
        super(props, { rows: [], columns: 1 });
    }

    public loadMore = (): void => this.props.onEndReached();

    public updateResults = (events: MatrixEvent[], _narrow: boolean): void => {
        const columns = 1;
        const rows: MediaSearchRow<MatrixEvent>[] = [];
        let currentMonth = "";
        let row: MediaSearchItem<MatrixEvent>[] = [];
        for (const event of events) {
            const eventId = event.getId();
            if (!eventId) continue;
            const date = new Date(event.getTs());
            const month = `${date.getFullYear()}-${date.getMonth()}`;
            if (month !== currentMonth) {
                if (row.length) rows.push({ key: `row-${row[0].id}`, items: row });
                row = [];
                currentMonth = month;
                rows.push({
                    key: `month-${month}`,
                    label: new Intl.DateTimeFormat(getUserLanguage(), { year: "numeric", month: "long" }).format(date),
                });
            }
            const content = event.getContent();
            row.push({ id: eventId, name: content.filename || content.body || "", source: event });
            if (row.length === columns) {
                rows.push({ key: `row-${row[0].id}`, items: row });
                row = [];
            }
        }
        if (row.length) rows.push({ key: `row-${row[0].id}`, items: row });
        this.snapshot.merge({ rows, columns });
    };
}
