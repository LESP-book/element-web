/*
Copyright 2024 New Vector Ltd.
Copyright 2019-2022 The Matrix.org Foundation C.I.C.
Copyright 2016 OpenMarket Ltd

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { createRef } from "react";
import { type MatrixEvent } from "matrix-js-sdk/src/matrix";
import type { StateSnapshot, VirtuosoHandle } from "react-virtuoso";
import { Virtuoso } from "react-virtuoso";
import FilesIcon from "@vector-im/compound-design-tokens/assets/web/icons/files";
import { MediaSearchGridView, SearchInputView, type MediaSearchItem } from "@element-hq/web-shared-components";

import { MatrixClientPeg } from "../../MatrixClientPeg";
import PlatformPeg from "../../PlatformPeg";
import { _t } from "../../languageHandler";
import SearchWarning, { WarningKind } from "../views/elements/SearchWarning";
import BaseCard from "../views/right_panel/BaseCard";
import Spinner from "../views/elements/Spinner";
import AccessibleButton from "../views/elements/AccessibleButton";
import RoomContext, { TimelineRenderingType } from "../../contexts/RoomContext";
import Measured from "../views/elements/Measured";
import EmptyState from "../views/right_panel/EmptyState";
import { ScopedRoomContextProvider } from "../../contexts/ScopedRoomContext.tsx";
import { FilterTabGroup } from "../views/elements/FilterTabGroup";
import { RoomFileSearchTile } from "../views/rooms/RoomFileSearchTile";
import { RoomMediaSearchTile } from "../views/rooms/RoomMediaSearchTile";
import { EventPresentationContextProvider } from "../../utils/EventPresentationContextProvider";
import { Layout } from "../../settings/enums/Layout";
import { FileSearchInputViewModel } from "../../viewmodels/search/FileSearchInputViewModel";
import { RoomFileSearchViewModel, type RoomFileSearchSnapshot } from "../../viewmodels/search/RoomFileSearchViewModel";
import { RoomMediaSearchViewModel } from "../../viewmodels/search/RoomMediaSearchViewModel";
import { RoomFileLiveEvents } from "../../search/RoomFileLiveEvents";
import type { RoomFileSearchFilters } from "../../search/RoomFileSearchFilters";
import { WebEventIndexError } from "../../indexing/web/WebEventIndexError";
import dis from "../../dispatcher/dispatcher";
import { Action } from "../../dispatcher/actions";
import { UserTab } from "../views/dialogs/UserTab";

function FilePanelFooter({ context }: { context: React.ReactNode }): React.ReactNode {
    return <ul className="mx_FilePanel_mediaFooter">{context}</ul>;
}

interface IProps {
    roomId: string;
    onClose: () => void;
}

interface IState {
    narrow: boolean;
    search: RoomFileSearchSnapshot;
}

/*
 * Component which shows the room's files and media list.
 */
class FilePanel extends React.Component<IProps, IState> {
    public static contextType = RoomContext;
    declare public context: React.ContextType<typeof RoomContext>;

    private card = createRef<HTMLDivElement>();
    private filesList = createRef<VirtuosoHandle>();
    private mediaList = createRef<VirtuosoHandle>();
    private readonly scrollPositions = new Map<string, StateSnapshot>();
    private searchVm: FileSearchInputViewModel | null = null;
    private resultsVm: RoomFileSearchViewModel | null = null;
    private mediaVm: RoomMediaSearchViewModel | null = null;
    private unsubscribeResults: (() => void) | null = null;
    private liveEvents: RoomFileLiveEvents | null = null;

    public state: IState = {
        narrow: false,
        search: {
            events: [],
            activeTab: FilePanelTab.Files,
            searchTerm: "",
            filters: { sender: "", fromDate: "", toDate: "", type: "all" },
            loading: true,
            exhausted: false,
            accessLimited: false,
            stopped: false,
            draftPending: false,
            localPagesRemaining: false,
            scanned: 0,
            filterInvalid: false,
            status: _t("file_panel|searching"),
        },
    };

    // Keep the legacy entry point for callers providing already-decrypted events.
    public addEncryptedLiveEvent(ev: MatrixEvent): void {
        this.liveEvents?.addLiveEvent(ev);
    }

    public componentDidMount(): void {
        const resultsVm = new RoomFileSearchViewModel();
        this.resultsVm = resultsVm;
        this.mediaVm = new RoomMediaSearchViewModel({ onEndReached: resultsVm.loadMoreLocal });
        this.searchVm = new FileSearchInputViewModel({
            onInvalidate: resultsVm.invalidateDraft,
            onCommit: (term) => {
                this.scrollPositions.clear();
                this.liveEvents?.reset(this.props.roomId);
                void resultsVm.reset(this.props.roomId, resultsVm.getSnapshot().activeTab, term);
            },
            onStop: resultsVm.stop,
            onResume: resultsVm.resume,
        });
        this.unsubscribeResults = resultsVm.subscribe(() => {
            const search = resultsVm.getSnapshot();
            if (search.activeTab === FilePanelTab.Media) this.mediaVm?.updateResults(search.events, this.state.narrow);
            this.searchVm?.updateStatus(
                search.status,
                search.loading && !search.draftPending,
                search.stopped && !search.draftPending,
            );
            this.setState({ search });
        });
        this.liveEvents = new RoomFileLiveEvents(MatrixClientPeg.safeGet(), resultsVm, this.props.roomId);
        void resultsVm.reset(this.props.roomId, FilePanelTab.Files, "");
    }

    public componentDidUpdate(prevProps: IProps): void {
        if (prevProps.roomId !== this.props.roomId) {
            this.searchVm?.reset();
            this.liveEvents?.reset(this.props.roomId);
            this.scrollPositions.clear();
            void this.resultsVm?.reset(this.props.roomId, FilePanelTab.Files, "");
        }
    }

    public componentWillUnmount(): void {
        this.unsubscribeResults?.();
        this.resultsVm?.dispose();
        this.searchVm?.dispose();
        this.mediaVm?.dispose();
        this.mediaVm = null;
        this.resultsVm = null;
        this.searchVm = null;
        this.liveEvents?.dispose();
        this.scrollPositions.clear();
    }

    private onFilterChange = (change: Partial<RoomFileSearchFilters>): void => {
        this.scrollPositions.clear();
        this.liveEvents?.reset(this.props.roomId);
        this.resultsVm?.setFilters(change);
    };

    private onSenderChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
        this.onFilterChange({ sender: event.target.value });
    };

    private onFromDateChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
        this.onFilterChange({ fromDate: event.target.value });
    };

    private onToDateChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
        this.onFilterChange({ toDate: event.target.value });
    };

    private onTypeChange = (event: React.ChangeEvent<HTMLSelectElement>): void => {
        this.onFilterChange({ type: event.target.value as RoomFileSearchFilters["type"] });
    };

    private onMeasurement = (narrow: boolean): void => {
        this.setState({ narrow });
        if (this.state.search.activeTab === FilePanelTab.Media) {
            this.mediaVm?.updateResults(this.state.search.events, narrow);
        }
    };

    private onFillRequest = async (backwards: boolean): Promise<boolean> => {
        const search = this.resultsVm?.getSnapshot();
        if (backwards || !search || search.error || search.stopped || search.draftPending || !search.events.length)
            return false;
        this.resultsVm?.loadMoreLocal();
        return false;
    };

    private onOpenIndexSettings = (): void => {
        dis.dispatch({ action: Action.ViewUserSettings, initialTabId: UserTab.Security });
    };

    private onReload = (): void => {
        PlatformPeg.get()?.reload();
    };

    public render(): React.ReactNode {
        if (MatrixClientPeg.safeGet().isGuest()) {
            return (
                <BaseCard
                    className="mx_FilePanel mx_RoomView_messageListWrapper"
                    onClose={this.props.onClose}
                    header={_t("right_panel|files_button")}
                >
                    <div className="mx_RoomView_empty">
                        {_t(
                            "file_panel|guest_note",
                            {},
                            {
                                a: (sub) => (
                                    <a href="#/register" key="sub">
                                        {sub}
                                    </a>
                                ),
                            },
                        )}
                    </div>
                </BaseCard>
            );
        }

        const room = MatrixClientPeg.safeGet().getRoom(this.props.roomId);
        if (!room) {
            return (
                <BaseCard
                    className="mx_FilePanel mx_RoomView_messageListWrapper"
                    onClose={this.props.onClose}
                    header={_t("right_panel|files_button")}
                >
                    <div className="mx_RoomView_empty">{_t("file_panel|peek_note")}</div>
                </BaseCard>
            );
        }

        const emptyState = (
            <EmptyState
                Icon={FilesIcon}
                title={_t("file_panel|empty_heading")}
                description={_t("file_panel|empty_description")}
            />
        );

        const isRoomEncrypted = MatrixClientPeg.safeGet().isRoomEncrypted(this.props.roomId);

        const search = this.state.search;
        const filteredEvents = search.events;

        const listItems: React.ReactNode[] = [];
        if (!filteredEvents.length && !search.loading && !search.error) {
            listItems.push(
                <li key="file-panel-empty" className="mx_FilePanel_empty">
                    {search.accessLimited
                        ? _t("file_panel|history_access_limited")
                        : search.exhausted
                          ? emptyState
                          : _t("file_panel|found_in_scanned_range")}
                </li>,
            );
        }

        if (search.error) {
            listItems.push(
                <li key="file-panel-error" role="alert" className="mx_FilePanel_empty">
                    {search.filterInvalid
                        ? _t("file_panel|invalid_date_range")
                        : search.error instanceof WebEventIndexError
                          ? search.error.code === "connection_blocked"
                              ? _t("file_panel|operation_pending")
                              : search.error.retryability === "reinitialize" ||
                                  search.error.retryability === "user_action"
                                ? _t("file_panel|index_needs_attention")
                                : search.error.code === "cursor_unavailable"
                                  ? _t("file_panel|history_cursor_failed")
                                  : _t("file_panel|load_failed")
                          : search.error.message}
                    {search.error instanceof WebEventIndexError && search.error.code === "connection_blocked" ? (
                        <>
                            <AccessibleButton kind="link_inline" onClick={this.onReload}>
                                {_t("action|reload")}
                            </AccessibleButton>
                            <AccessibleButton kind="link_inline" onClick={this.onOpenIndexSettings}>
                                {_t("common|go_to_settings")}
                            </AccessibleButton>
                        </>
                    ) : this.resultsVm &&
                      search.error instanceof WebEventIndexError &&
                      search.error.retryability === "retry" ? (
                        <AccessibleButton kind="link_inline" onClick={this.resultsVm.retry}>
                            {_t("action|retry")}
                        </AccessibleButton>
                    ) : null}
                </li>,
            );
        }

        if (search.loading) {
            listItems.push(
                <li key="file-panel-loading-more" className="mx_FilePanel_loading">
                    <Spinner />
                    <span>{_t("file_panel|scanned_count", { count: search.scanned })}</span>
                    <AccessibleButton kind="link_inline" onClick={this.resultsVm?.stop ?? null}>
                        {_t("file_panel|stop_search")}
                    </AccessibleButton>
                </li>,
            );
        }

        if (search.stopped) {
            listItems.push(
                <li key="file-panel-stopped" className="mx_FilePanel_noMore">
                    <span>{_t("file_panel|scanned_count", { count: search.scanned })}</span>
                    <AccessibleButton kind="link_inline" onClick={this.resultsVm?.resume ?? null}>
                        {_t("file_panel|continue_search")}
                    </AccessibleButton>
                </li>,
            );
        }

        if (
            !search.exhausted &&
            !search.accessLimited &&
            !search.loading &&
            !search.error &&
            !search.stopped &&
            !search.draftPending
        ) {
            listItems.push(
                <li key="file-panel-more" className="mx_FilePanel_noMore">
                    <AccessibleButton kind="link_inline" onClick={() => void this.resultsVm?.loadMore()}>
                        {_t("file_panel|continue_search")}
                    </AccessibleButton>
                </li>,
            );
        }

        if ((search.exhausted || search.accessLimited) && filteredEvents.length > 0) {
            listItems.push(
                <li key="file-panel-no-more" className="mx_FilePanel_noMore">
                    <div className="mx_RoomView_topMarker">
                        {search.accessLimited ? _t("file_panel|history_access_limited") : _t("no_more_results")}
                    </div>
                </li>,
            );
        }

        return (
            <ScopedRoomContextProvider
                {...this.context}
                timelineRenderingType={TimelineRenderingType.File}
                narrow={this.state.narrow}
            >
                <BaseCard
                    className="mx_FilePanel"
                    onClose={this.props.onClose}
                    withoutScrollContainer
                    ref={this.card}
                    header={_t("right_panel|files_button")}
                >
                    <Measured sensor={this.card} onMeasurement={this.onMeasurement} />
                    <SearchWarning isRoomEncrypted={isRoomEncrypted} kind={WarningKind.Files} />

                    <div className="mx_FilePanel_controls">
                        {this.searchVm ? <SearchInputView vm={this.searchVm} /> : null}

                        <FilterTabGroup
                            name="file-panel"
                            value={search.activeTab}
                            onFilterChange={(tab) => {
                                if (tab === search.activeTab) return;
                                const term = this.searchVm?.settleDraft() ?? search.searchTerm;
                                const list = search.activeTab === FilePanelTab.Files ? this.filesList : this.mediaList;
                                list.current?.getState((state) =>
                                    this.scrollPositions.set(`${this.props.roomId}/${search.activeTab}`, state),
                                );
                                this.liveEvents?.reset(this.props.roomId);
                                void this.resultsVm?.reset(this.props.roomId, tab, term);
                            }}
                            tabs={[
                                { id: FilePanelTab.Media, label: _t("file_panel|tab_media") },
                                { id: FilePanelTab.Files, label: _t("right_panel|files_button") },
                            ]}
                        />
                        <details className="mx_FilePanel_advancedFilters">
                            <summary>{_t("file_panel|filters")}</summary>
                            <div className="mx_FilePanel_filters">
                                <label>
                                    {_t("file_panel|filter_sender")}
                                    <input type="text" value={search.filters.sender} onChange={this.onSenderChange} />
                                </label>
                                <label>
                                    {_t("file_panel|filter_from")}
                                    <input
                                        type="date"
                                        value={search.filters.fromDate}
                                        onChange={this.onFromDateChange}
                                    />
                                </label>
                                <label>
                                    {_t("file_panel|filter_to")}
                                    <input type="date" value={search.filters.toDate} onChange={this.onToDateChange} />
                                </label>
                                <label>
                                    {_t("file_panel|filter_type")}
                                    <select value={search.filters.type} onChange={this.onTypeChange}>
                                        <option value="all">{_t("file_panel|filter_all_types")}</option>
                                        {search.activeTab === FilePanelTab.Media ? (
                                            <>
                                                <option value="m.image">{_t("file_panel|filter_images")}</option>
                                                <option value="m.video">{_t("file_panel|filter_videos")}</option>
                                            </>
                                        ) : (
                                            <>
                                                <option value="m.file">{_t("file_panel|filter_files")}</option>
                                                <option value="m.audio">{_t("file_panel|filter_audio")}</option>
                                            </>
                                        )}
                                    </select>
                                </label>
                            </div>
                        </details>
                    </div>

                    <EventPresentationContextProvider layout={Layout.Group}>
                        {search.activeTab === FilePanelTab.Media && this.mediaVm ? (
                            <div className="mx_FilePanel_mediaViewport">
                                <MediaSearchGridView
                                    vm={this.mediaVm}
                                    renderTile={this.renderMediaTile}
                                    footer={<ul className="mx_FilePanel_mediaFooter">{listItems}</ul>}
                                    restoreStateFrom={this.scrollPositions.get(`${this.props.roomId}/media`)}
                                    listRef={this.mediaList}
                                />
                            </div>
                        ) : (
                            <Virtuoso
                                ref={this.filesList}
                                restoreStateFrom={this.scrollPositions.get(`${this.props.roomId}/files`)}
                                className="mx_FilePanel_scrollPanel"
                                data={filteredEvents}
                                computeItemKey={(_, event) => event.getId() ?? `${event.getRoomId()}-${event.getTs()}`}
                                itemContent={(_, event) => <RoomFileSearchTile event={event} />}
                                endReached={() => void this.onFillRequest(false)}
                                context={listItems}
                                components={{ Footer: FilePanelFooter }}
                            />
                        )}
                    </EventPresentationContextProvider>
                </BaseCard>
            </ScopedRoomContextProvider>
        );
    }

    private renderMediaTile = (item: MediaSearchItem<MatrixEvent>): React.ReactNode => (
        <RoomMediaSearchTile item={item} />
    );
}

export default FilePanel;

enum FilePanelTab {
    Media = "media",
    Files = "files",
}
