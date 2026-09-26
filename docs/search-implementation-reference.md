<!--
Copyright 2026 LESP-book

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
-->

# 搜索功能实现参考（2026-09-26）

本文记录本轮消息、文件和媒体搜索**已落地的代码与行为**，供维护、排障和回归使用。历史方案与复审过程分别见 [原始优化方案](search-optimization-plan.md)、[索引恢复方案](search-optimization-review-and-recovery-plan.md) 和 [可用性修缮方案](search-usability-repair-plan.md)；那些文档中的旧故障描述或待办不代表当前实现状态。此文档不声称全量搜索性能、所有用户数据库形态或所有浏览器组合均已验收。

## 1. 用户可见行为

- **消息**：房间搜索保留本地索引、桌面索引和服务端搜索的能力路由；房间 Web 本地搜索先确保当前时间线已索引，随后分页并在需要时按共享房间历史继续回溯。结果按事件身份合并、排序、保留上下文和跳转。当前搜索的 loading、停止、错误、分页与回填状态分别收束；旧查询结束不会覆盖新查询。全房间搜索仍遵循现有路由，不把房间局部回溯误用到全局搜索。
- **文件/媒体**：打开面板即开始查找，首次目标为约 20 条新结果；没有本地命中时会在同一用户任务内自动跨多个空历史批次，逐批公布已提交的结果，而非要求每页点击“继续查找”。达到结果目标、历史终点、任务预算、错误或停止时结束本轮；需要更多历史时提供明确继续入口。滚动仅可读本地页，不暗中发起共享网络回溯。
- **筛选**：文件名/搜索词输入、媒体/文件页签、发件人、日期与类型筛选；高级筛选默认折叠。筛选条件变更使旧游标失效，日期无效、访问受限、索引错误、等待旧操作及已扫描但暂无线索分别有状态提示；停止和继续不等于删除索引。
- **媒体**：媒体为可变高度单列和月份分组，文件列表与媒体列表都使用虚拟化。图片/视频仍用原有 body、认证媒体和解密下载路径；原 body 的下载按钮不放入固定正方形裁切框。可跳回原消息，隐藏预览和预览失败仍保留下载入口。

## 2. 代码所有权与数据流

| 层             | 关键文件                                                                                                                                                                                                                                               | 责任                                                                                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 搜索路由       | `apps/web/src/Searching.ts`、`src/indexing/EventIndex.ts`                                                                                                                                                                                              | 按索引能力和房间加密状态选择搜索源、分页、当前时间线准备与历史回溯；不将 Web 游标当成服务器游标。以下 `src/` 均相对 `apps/web/`。                                            |
| 消息会话与视图 | `src/search/RoomMessageSearchSession.ts`、`src/components/structures/RoomSearchView.tsx`、`RoomView.tsx`                                                                                                                                               | 会话拥有游标、累计结果和停止代次；视图用会话身份及请求代次控制 loading、错误、发布和销毁。根级 React StrictMode effect 重放时只清理本次 effect 捕获的会话。                  |
| 附件会话       | `src/search/RoomFileSearchSession.ts`、`RoomFileLiveEvents.ts`、`matchesRoomFileSearchEvent.ts`、`RoomFileSearchOriginals.ts`                                                                                                                          | 会话独占累计结果、原件/编辑修订/撤回、扫描游标和回溯进度；实时桥接 SDK 时间线及解密事件。匹配只决定可见性，不把暂时不匹配当成永久撤回。                                      |
| 附件 UI 状态   | `src/viewmodels/search/{FileSearchInputViewModel,RoomFileSearchViewModel,RoomMediaSearchViewModel}.ts`、`src/components/structures/FilePanel.tsx`                                                                                                      | 输入防抖与停止/继续；VM 投影会话快照、管理页签缓存和查询代次；面板渲染状态、筛选、虚拟列表。非活跃页签仍接收实时编辑和撤回。                                                 |
| 共享展示       | `packages/shared-components/src/room/search/{SearchInputView,MediaSearchGridView}/`、`src/components/views/rooms/{RoomFileSearchTile,RoomMediaSearchTile}.tsx`、`src/components/views/messages/MBodyFactory.tsx`、`res/css/structures/_FilePanel.pcss` | 搜索框、媒体列表、单列文件/媒体 body、样式和下载入口；样式不用整块 preview 的 overflow 裁切下载区。                                                                          |
| Web 索引       | `src/indexing/web/{WebEventIndexManager,WebEventIndexDatabase,WebEventIndexError,webEventEditStore,webEventIndex.worker,webEventIndexIdb}.ts`、`src/indexing/{BaseEventIndexManager,EventIndexPeg}.ts`                                                 | account/device 隔离的 IndexedDB、Worker RPC、查询与编辑投影、迁移与明确的错误/恢复边界。实际 app 的 Worker 路径是 `apps/web/src/indexing/web/`，不是仓库根目录的同名旧路径。 |

入口与顺序：`RoomView` / `FilePanel` → 对应 session/VM → `EventIndex` → Web Worker/IndexedDB 或已有搜索提供者 → 累计结果 → 视图。共享回溯通过索引层管理：停止视图并不擅自取消另一消费者的写入；失效查询的回调不得提交 UI。

## 3. 历史、索引与错误边界

### 房间历史和预算

`RoomFileSearchSession` 每个底层步最多读取 50 条、本地扫描最多 3 页、每步最多启动一次共享回溯（最多 500 条）。前台 `searchUntilTarget()` 将多个小步串成一次用户操作，以约 20 条新结果为首屏目标、8 秒为软任务预算，批次之间让出执行权并增量发布。消息会话另用自己的分页和回溯额度（历史回溯上限 1000），不要把附件参数照搬过去。

单步操作等待超过预算时，UI 离开 loading、保留已提交结果，并显示 `connection_blocked` 和等待/重新加载的操作说明；**底层正在进行的共享写入未必已经取消**。继续之前须先确认旧操作结束，不可对同一游标启动并发回溯。网络、索引、访问范围和被禁用的旧代次分别有明确状态；错误时不能把部分成功结果丢掉或假称历史完全耗尽。

### IndexedDB 和编辑

Web 索引使用按 account/device 命名的数据库，当前 schema **v4**。初始化检查必需 stores/key paths/indexes；升级会补建缺失结构并验证，无法安全兼容时抛出有类型错误，**不通过清空用户数据库修复**。连接阻塞、版本不兼容与存储错误分别暴露；Worker RPC 以 `code`、`operation`、`retryability` 的受限结构传递错误。Worker 失败和账号切换的 pending 请求有身份隔离及恢复约束。

索引保留原始可用附件内容，另存有效编辑关系和撤回事实。编辑必须属于同一作者、房间、消息类型；按 timestamp 和 event ID 决定最新有效编辑。撤回编辑后重新投影到前一有效编辑或原件，撤回原件则不再复活。附件 session 对实时编辑、待完成页、索引页和缓存页签采用同一身份/版本边界；迟到旧编辑与旧分页不得覆盖较新的投影。加密原件的 raw 类型可能是 `m.room.encrypted`，投影必须保留解密后的 `m.room.message` 有效类型和下载所需 `url`/`file`/`info`，不能用编辑前的 `body`/`filename` 覆盖新名称。`EventIndex.mapFileEvents()` 将索引原件的 clear 类型和未编辑 clear content 交给 session，避免全部编辑撤回后恢复到错误文件名。

这套策略仅适用于已能解密且有权限读取的事件；历史受限/尚未解密时不承诺搜索到不可访问内容。保留现有认证媒体 URL、加密解密和账号隔离路径。

## 4. 验证入口与已知边界

从仓库根目录运行（除非命令中切换目录）：

```sh
pnpm vitest run apps/web/src/search/ apps/web/src/viewmodels/search/ \
  apps/web/src/components/structures/RoomSearchView.test.tsx \
  apps/web/src/components/structures/FilePanel.test.tsx \
  apps/web/src/components/views/rooms/RoomMediaSearchTile.test.tsx \
  apps/web/src/components/views/rooms/RoomMediaSearchTile.real.test.tsx \
  apps/web/src/Searching.test.ts apps/web/src/indexing/
pnpm vitest run --project='element-web (browser)' \
  apps/web/src/indexing/web/webEventIndex.worker.test.browser.ts
pnpm exec tsc --noEmit -p apps/web/tsconfig.json
cd apps/web && pnpm exec playwright test playwright/e2e/right-panel/file-panel.spec.ts --project=Chrome
cd apps/web && pnpm exec playwright test playwright/e2e/right-panel/file-panel.spec.ts --project=ChromeZoom
```

Playwright 需要容器运行时和正确的 app 服务；运行前检查 8080 端口是否已有旧服务。**不要**运行本地截图基线更新命令来掩盖差异；若有截图变化，人工查看。按文件路径选用 Jest/Vitest，shared-components 测试需从它自己的 workspace 运行。新增或调整译文后执行 `pnpm i18n`。

本轮独立复审已运行的部分：相关 Vitest **207 通过、2 跳过**；Chromium Worker **6 通过**；普通 Chrome 面板 E2E 定向 **8 通过**；专用 ChromeZoom **2 通过**；Web TypeScript 通过。E2E 包含四个空历史批次后第五页命中、真实消息搜索跳转、加密媒体下载、预览隐藏/失败、长文件名和 320/400/600 CSS px 窄面板下载；加密附件编辑的 session 测试还验证 `MediaEventHelper` 下载解密。**这些数字是当次定向运行结果，不是全量 lint、全量 e2e 或性能覆盖结论。**

### 缩放验收的诚实边界

`ChromeZoom` 是带本地扩展的独立 persistent context，通过 `chrome.tabs.setZoom` 改浏览器缩放，普通 Chrome 不加载扩展；远程 `PW_TEST_CONNECT_WS_ENDPOINT` 不作为这项证据。它不是普通 Chrome context 的同链路证明。还应注意：当前扩展档位为 `1, 1.25, 1.5, 1.75, 2`，测试用三次 increase 标为“150”时实际对应 **175%**，测试仅验证 viewport 变小；复审看到的部分 150/200 标签截图误截为页面顶部导航，而不是 Files 面板。因此不能引用这些截图声称已视觉确认**精确 150%/200%** 下的下载区。用户现场感觉正常、下载 E2E 通过与该视觉证据缺口是不同的结论。若需严格缩放验收，应读取实际 zoom 值、改正次数和截图坐标后重验。

## 5. 维护约束

- 不用“无限 Show more”、提高扫描常量或递归点击代替一次有预算的用户查找；不要为了恢复 UI 取消共享索引写入或清理用户数据库。
- 只让 session 拥有附件累计结果，VM 为快照投影；任何实时 invalidation 都要覆盖 pending 查询和非活跃页签。
- 修改索引投影时同步覆盖明文/加密原件、乱序编辑、编辑撤回、原件撤回、晚到页、账号切换与非破坏性迁移。
- 修改媒体布局时实际检查真实 body 和下载行为，不能只依赖 mock body 或元素存在性断言。
- 本轮新增 `react-virtuoso` 的 Web workspace 显式依赖及锁文件记录；新增共享搜索组件及其导出、翻译、Playwright 专用缩放工程和对应测试均随实现保留。
