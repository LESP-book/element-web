<!--
Copyright 2026 The contributors to this document

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
-->

# Element Web 消息、文件与媒体搜索优化计划

> 这是历史研究和原始实施方案；已落地的代码、验证范围和未解决的缩放证据边界见
> [搜索功能实现参考](./search-implementation-reference.md)。本文件中的旧工作区状态不可当作当前事实。

## 1. 文档用途与执行约定

本文是供后续模型读取执行的交接计划，不是已经完成的功能说明。

> 当前执行入口为 [搜索可用性修缮方案](./search-usability-repair-plan.md)：先修消息无限 loading、
> 附件首屏与连续查找，媒体恢复单列，筛选默认折叠。与本文冲突的交互要求以新方案为准。
> 上一轮数据库问题见 [搜索审查与恢复计划](./search-optimization-review-and-recovery-plan.md)。
> 本文件继续保存原始研究与长期候选方向，不授权继续推进网格或扩大功能范围。

### 本轮工作区状态（供后续审查，不等于阶段验收）

- 阶段 3：附件有输入法安全防抖、停止/继续/重试及状态播报；消息分页改成短批次，自动滚动只扫描 Web 本地页，停止后不启动新批次。**尚无**消息输入法防抖、跨入口统一页签、跳转后会话/滚动恢复、可靠的“已搜索至”覆盖时间。
- 阶段 4：媒体采用按月虚拟网格及现有图片/视频 body 预览；文件采用虚拟紧凑列表及现有文件预览；附件发送者、日期和类型筛选进入会话及 Web 索引查询，旧索引 sender 缺省值由 event JSON 回退。**尚无**消息列表虚拟化和实际登录环境的视觉/加密媒体 E2E 验证。
- 阶段 5：Chromium 153 无头浏览器、随机隔离 IndexedDB 合成数据 1 万/10 万条，逐页扫描、首屏 20 次暖查询测量；10 万条查询暖首屏 P95 在本次运行约 4–33ms（中文、常见词、罕见词、无命中、文件名）。此为合成基准，不是用户设备的 P95 或真实历史回填耗时；没有据此引入 n-gram 或重建数据库。
- 浏览器 Worker/IndexedDB 集成测试已覆盖迁移与筛选；未读取用户实际数据库结构。`pnpm -r --workspace-concurrency=1 lint:types` 的应用源及 shared-components 通过，但浏览器测试 TS 项目仍有 SDK/既有 `SdkConfig` 类型环境错误；不把它算成全量 typecheck 通过。E2E 未运行：端口 8080 当前有现存 webpack 进程，Playwright 会复用它，不能安全证明使用本工作区构建。

- 研究基线：`a8336b3cdfc8f27016135ae447640fd860d22d6a`。
- 保存日期：2026-09-25。
- 用户目标：改善此定制版 Element Web 的消息、文件、媒体搜索体验，参考 Cinny 和 FluffyChat。
- 已完成：静态阅读搜索入口、索引、Worker、历史回溯、结果展示、相关测试和参考客户端源码。
- 未完成：登录实际部署验证、运行相关测试、性能基准、功能实现。
- 本文中的“代码事实”来自上述基线；“风险”必须通过复现或测试确认，不得汇报为已验证缺陷。
- 实施前读取仓库 `AGENTS.md`、`code_style.md`；新 UI 还须遵循 `docs/MVVM.md`。
- 如果实际代码已变化，先核对本文涉及的调用链，再调整方案；不要按旧行号机械修改。
- 不自动提交、推送、部署，不未经授权删除数据库或重建用户索引。

核心顺序：**先收拢搜索会话和分页职责，再修正确性，随后完善状态交互，最后优化展示和性能。**

建议首批实施阶段 0–2，再实施阶段 3。阶段 4 可以单独交付；阶段 5 中的全文索引升级必须以测量结果为依据。

## 2. 现状与问题证据

### 2.1 当前链路

此定制实现的主要路径是浏览器本地搜索，不是独立部署的服务端全文搜索引擎。

```text
消息搜索
RoomView → Searching.ts → EventIndex → Web Worker → IndexedDB
                                 ↑
RoomSearchView → backfillRoom → homeserver /messages → 解密、写索引

文件与媒体
FilePanel → EventIndex.loadFileEvents → IndexedDB
    ├─ 数据不足时自行 backfillRoom
    └─ UI 按分类及文件名过滤已加载事件
```

Web 当前房间消息搜索在本地索引可用时走本地路径；索引不可用时消息搜索回退服务端 `/search`。桌面 Seshat 与 Web 共用部分上层代码，必须保护桌面兼容性。

### 2.2 已确认的代码事实

| 问题                           | 依据                                                                                    | 影响                                                   |
| ------------------------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 文件名搜索只过滤已加载结果     | `FilePanel.filterByFileName()` 仅遍历 `state.events`，仅匹配 `content.body`             | 旧附件未进入列表时搜不到；文件名与描述不同时匹配不完整 |
| 消息与附件 UI 各自拥有回溯策略 | `RoomSearchView.loadMoreMessages()` 与 `FilePanel.loadFileEventsWithOptionalBackfill()` | 两条路径分别演化，结束判断和错误行为不一致             |
| UI 知道后端游标格式            | `RoomSearchView` 解析 JSON `next_batch`，通过 `(results as any).seshatQuery` 判断来源   | 视图耦合 Web IndexedDB / Seshat 实现细节               |
| 搜索范围入口与执行不一致       | `RoomSearchAuxPanel` 显示所有房间按钮，`RoomView.onSearch()` 强制改为当前房间           | 用户认为扩大了范围，实际没有                           |
| 回溯及索引错误表达不足         | 回溯错误主要写日志；`EventIndex.loadFileEvents()` 捕获错误后返回空数组                  | 无匹配、失败、索引不可用容易混淆                       |
| 分页采用较大固定预算           | 手动消息加载最多 50 页，Worker 每页最多扫描 2000 条；文件路径最多 3 次、每次 500 条回溯 | 稀疏命中、冷缓存时等待成本大，进度不可解释             |
| 媒体仍按消息列表展示           | `FilePanel.buildGroupedEventTiles()` 使用 `SearchResultTile`                            | 图片浏览密度低，不像图库                               |
| 附件读取未利用类型索引         | Worker 建有 `room_msgtype_ts`，但 `loadFileEvents()` 遍历 `room_ts` 后过滤              | 稀疏附件需要扫描大量普通消息                           |
| 平台策略使用展示名称判断       | `Searching.ts`、`EventIndex.ts` 比较 `getHumanReadableName()` 与 `Web Platform`         | 能力与平台名称耦合，扩展及回归测试困难                 |

### 2.3 需要回归测试确认的正确性风险

1. **最后一批回溯数据未消费。** 消息路径收到 `exhausted` 后直接返回；文件路径直接退出回溯循环，没有再次读索引。如果本次已写入事件但服务器不再返回下一 token，或无 token 分支补入 live timeline，新增结果可能没有展示。
2. **首次搜索遗漏当前已加载时间线。** `addRoomCheckpoint()` 仅在没有 backward token 时导入 live timeline；有 token 时直接建立历史检查点。空索引进入已有房间时，可能遗漏回溯起点之后的近期消息。
3. **同房间并发回溯。** 手动回溯、消息搜索、附件浏览和后台 crawler 共享检查点，没有明确覆盖这些入口的每房间 single-flight 协议。
4. **旧请求写回新状态。** `FilePanel` 缺少请求代次隔离，切房间、卸载或重新加载时可能接收旧请求结果。
5. **Worker 故障导致等待不结束。** RPC `onerror` 仅记录日志，pending promise 缺少统一拒绝处理，也没有查询取消协议。
6. **撤回没有同步到旧缓存。** `onRoomTimeline()` 在处理 redaction 前先执行 `shouldIndexRoom()`；非当前房间撤回可能无法删除曾经缓存的事件。
7. **编辑与延迟解密语义不完整。** Worker 使用新增并忽略重复 event ID 的方式，需核对编辑关系、重新解密、事件更新如何反映到搜索结果。
8. **附件实时更新及监听生命周期。** 当前文件面板监听安装与移除依赖房间加密状态，需验证未加密房间及切换房间的行为。

### 2.4 配置和覆盖范围

- Worker 默认接受最近 90 天事件。
- `apps/web/config.sample.json` 配置 `local_event_index_max_event_age_days: 0`，表示不限历史。
- 样例配置不代表实际部署值。实施时核对生效配置，不在文档或 UI 中武断承诺“可搜全部历史”。
- 当前房间按需索引、历史权限、解密失败、服务端保留策略都可能限制结果。
- “本地已扫完”不等于“房间历史已搜完”；“房间历史请求结束”也不等于所有消息均已成功解密。

## 3. 参考客户端与采用边界

### 3.1 FluffyChat

参考本地 `../element-phone/fluffychat`，研究版本 `03109371`。

主要文件：

- `lib/pages/chat_search/chat_search_page.dart`
- `lib/pages/chat_search/chat_search_view.dart`
- `lib/pages/chat_search/search_footer.dart`
- `lib/pages/chat_search/chat_search_images_tab.dart`
- `lib/pages/chat_search/chat_search_message_tab.dart`
- `lib/pages/chat_search/chat_search_files_tab.dart`

采用：

- 消息、图库、文件统一入口，分别维护结果和分页状态。
- 明确显示“已搜索至某个时间”与“继续搜索”。
- 图片和视频按月分组、网格浏览。

不照搬：

- 该版本媒体和文件页禁用关键词输入，主要是分类浏览，不是完整文件名搜索方案。
- 不复制其控制器生命周期或并发写法；本项目需要独立的取消、错误和请求代次保护。

### 3.2 Cinny

参考版本 `8967c13878137841e49ee17184b689a6b4da334a`：

- [MessageSearch.tsx](https://github.com/cinnyapp/cinny/blob/8967c13878137841e49ee17184b689a6b4da334a/src/app/features/message-search/MessageSearch.tsx)
- [SearchFilters.tsx](https://github.com/cinnyapp/cinny/blob/8967c13878137841e49ee17184b689a6b4da334a/src/app/features/message-search/SearchFilters.tsx)
- [useMessageSearch.ts](https://github.com/cinnyapp/cinny/blob/8967c13878137841e49ee17184b689a6b4da334a/src/app/features/message-search/useMessageSearch.ts)

采用：

- 清晰的查询条件、范围和排序表达。
- 查询条件组成稳定查询标识。
- 区分首次加载、继续加载、空结果和错误。
- 长结果列表虚拟化。

不照搬：

- 所检查的消息搜索走服务端 `/search`，不解决浏览器端加密历史检索。
- 当前本地实现只是 substring 匹配，不能直接承诺相关度排序。
- 不默认把关键词写入 URL 或永久存储；优先会话内保存状态。

## 4. 目标体验与交互契约

### 4.1 目标示意

原有搜索、文件入口保留，但最终打开同一房间搜索面板的对应页签。统一入口不意味着内部使用一个巨型 ViewModel。

```text
┌─ 在「房间名称」中查找 ─────────────── × ┐
│ [关键词 / 文件名                    ] │
│ 消息       媒体       文件             │
│ [发送者 ▾] [日期范围 ▾] [类型 ▾]      │
├──────────────────────────────────────┤
│ 已找到 24 条 · 当前结果尚不完整        │
│                                      │
│ 消息：日期 → 发送者 → 高亮摘要        │
│ 媒体：月份 → 缩略图网格               │
│ 文件：名称、类型、大小、发送者、日期   │
│                                      │
├──────────────────────────────────────┤
│ 已搜索至 2025-12-01                   │
│ [继续搜索更早历史]                    │
└──────────────────────────────────────┘
```

日期和条数只是示例，不代表当前数据。发送者、日期和类型筛选在数据层稳定后加入，不阻塞第一批修复。

### 4.2 操作规则

1. 消息空关键词不扫描；媒体和文件空关键词用于浏览。
2. 输入使用中文输入法安全的防抖；Enter 立即提交，组词期间不触发搜索。
3. 本地结果优先显示；继续加载时保留已有结果，在底部呈现状态。
4. 自动滚动加载本地结果可以保留；昂贵历史回溯有明确预算，不能无限自动抓取。
5. 改变查询或筛选产生新请求代次，不混用旧游标。
6. 页签可以保存各自的结果、游标和滚动位置；不能交叉消费其他类别的分页状态。
7. 消息结果可跳转原消息；媒体主操作为预览，文件主操作为打开或下载，另有“查看原消息”。
8. 跳转后返回可恢复关键词、页签、结果和滚动位置，先限定为会话内恢复。
9. 不支持的全局搜索入口隐藏或明确禁用，不再显示一个实际仍搜当前房间的按钮。
10. 窄屏使用全宽模式；加载反馈、焦点和操作按钮不能遮挡正文，hover 不造成布局跳动。

### 4.3 状态表达

至少区分：

| 状态             | 用户看到的行为                                 |
| ---------------- | ---------------------------------------------- |
| 尚未查询         | 输入提示，不显示假加载                         |
| 首次本地查询     | 清晰加载反馈，可修改或取消                     |
| 正在扫描本地数据 | 保留结果，说明仍在查找                         |
| 正在读取更早历史 | 已搜索范围、停止操作                           |
| 当前范围无结果   | 可以继续更早历史，而不是宣布完全无结果         |
| 可访问历史结束   | 显示结束；若解密失败或权限限制仍需说明         |
| 失败             | 保留结果、显示错误类别、提供重试               |
| 索引不可用       | 说明原因与合法降级方式，不显示空文件夹冒充成功 |

“已搜索至”必须来自扫描/覆盖信息，不从最老命中结果推算。若存在历史缺口或解密失败，不宣称此前区间已完整搜索。

## 5. 架构方案

### 5.1 职责划分

```text
共享视图：只渲染 snapshot 和发出动作
    ↓
消息 ViewModel / 附件 ViewModel：输入、请求代次、UI 状态、滚动恢复
    ↓
应用层搜索会话：provider 路由、分页、去重、取消、覆盖情况
    ↓
Web IndexedDB 适配 / Seshat 适配 / Server 适配
    ↓
EventIndex：解密、索引维护、房间回溯和检查点
```

建议应用层搜索代码放在 `apps/web/src/search/`，具体文件名由执行者结合现有约定确定。不预设泛化插件体系，也不为只有一个用途的模块引入多余工厂。

### 5.2 应用层搜索会话

由会话统一拥有：

- 查询条件与查询身份。
- provider 选择及其分页状态。
- 不透明 cursor、去重、稳定排序、按需回溯编排。
- 本地扫描结束、历史结束、覆盖限制与失败原因。
- 取消、销毁、重试与已有结果保留。

视图不得解析 `next_batch` JSON，不得访问 `seshatQuery` 判断来源。后端 token 的具体格式只能由相应适配层理解。

覆盖事实来自会话及底层回溯结果，ViewModel 只是投影成 snapshot，不重新计算一套结束规则。

### 5.3 能力与路由

通过现有平台索引扩展点及适配层表达能力，不继续比较平台展示名称：

- 本地索引是否可用。
- 支持当前房间还是跨房间。
- 支持消息、媒体、附件名称及哪些筛选。
- 支持哪些排序。
- 能否回溯、能提供何种覆盖信息。

路由原则：

- 保持当前 Web 房间搜索本地优先的意图，但由能力和策略决定。
- 本地不可用时，未加密消息可按能力使用服务端搜索。
- 加密内容不能依赖服务端搜索补齐，也不能上传解密正文到新服务。
- Web、Seshat、server 各自保留游标语义。
- 暂不恢复跨房间本地历史索引；不因统一界面扩大资源和隐私范围。

### 5.4 共享历史回溯协议

`EventIndex` 保留实际抓取、解密、入库与检查点责任，并建立每房间 single-flight：

- 消息、附件及后台 crawler 不能重复消费同一检查点。
- 返回本次扫描/新增数量、进度、是否结束及结束原因，不能只有 `exhausted`。
- 最后一批新增数据先进入查询结果，再宣布完成。
- 403、网络失败、历史结束、保留范围限制分别表达。
- 取消一个会话，不误取消另一个会话仍需使用的共享任务。
- 旧任务不能写回已切换的账号、数据库或查询会话。
- 检查点和入库的提交保持一致；失败不得静默丢失回溯位置。

### 5.5 查询和展示

- 文件名称匹配覆盖适用的 `content.filename` 与 `content.body`。
- 类型与名称过滤进入索引查询，不只过滤已加载结果。
- 明确图片、视频、文件、音频及语音消息的分类；第一批保持现有兼容行为，分类变化另行验证。
- 同时间戳用稳定次级键排序，分页不能重复或跳过事件。
- 统一纯数据规范化；首屏和后续页使用相同处理，避免只修首屏事件结构。
- 复用现有媒体下载、解密、预览和可见性规则，不建立平行实现。
- 新 ViewModel 位于 `apps/web/src/viewmodels/`，新纯视图位于 `packages/shared-components/src/`。
- 消息与附件维持独立 ViewModel，不把所有交互塞进一个大类。

## 6. 分阶段实施

### 阶段 0：建立基线与失败用例

工作：

- 核对生效配置、索引开关、测试入口与实际构建路径。
- 对第 2.3 节风险编写最小复现测试。
- 记录暖缓存、冷缓存、稀疏命中的扫描量和耗时。
- 核对旧测试是否仍在测旧 UI 或旧服务端搜索假设。

验收：

- 每个待修问题有失败测试或可重复步骤。
- 无法复现的风险明确保留为待调查，不虚构失败或通过结果。

### 阶段 1：抽出搜索会话，基本保持外观

工作：

- 引入能力路由和 provider 适配。
- 迁出两个 UI 内部的分页、去重及回溯编排。
- 增加会话身份、请求代次、取消和销毁。
- 为 Worker 异常补 pending 请求失败处理，检查关闭与账号切换生命周期。
- 建立每房间共享回溯协议。

验收：

- UI 不解析后端 token，不使用 `as any` 探测搜索来源。
- 不同能力组合和不同 cursor 格式均有路由测试。
- 旧查询不覆盖新查询；两个入口并发不重复抓取同一检查点。
- 服务端和桌面 Seshat 路径通过回归测试。

提交边界：结构调整与行为修复分开，不夹带格式化或无关重构。

### 阶段 2：修正结果完整性和文件查询

工作：

- 补齐已加载时间线，衔接历史检查点并去重。
- 最后一批历史入库后重新读取结果，再标记结束。
- 下沉类别和文件名查询。
- 修复无结果、失败、索引不可用的混淆。
- 修复撤回索引同步，明确编辑、重新解密的更新语义。
- 隐藏不支持的所有房间入口。
- 区分精确总数与当前“已找到 N 条”。

验收：

- 首次空索引、稀疏命中、最后一页、重复事件、同时间戳分页不漏不重。
- 旧附件无需先手动滚动加载到 UI 就可通过查询找到。
- `filename` 与 `body` 不同时仍按契约匹配。
- 已收到的撤回不会继续作为旧正文命中。

### 阶段 3：状态和连续操作体验

工作：

- 引入搜索范围、进度、继续、停止和重试。
- 失败保留结果，不重置用户阅读位置。
- 增加会话内跳转恢复。
- 统一入口、页签、输入行为、空状态与错误状态。
- 补齐键盘操作、焦点恢复、状态播报与翻译。

验收：

- 用户可以分辨：正在搜哪里、是否搜完、为何没找到、接下来能做什么。
- 中文输入法组词不触发请求风暴。
- 停止和切查询后不再启动旧查询的新批次。
- 不把敏感关键词或正文写入日志、URL 或遥测。

### 阶段 4：媒体、文件与筛选展示

工作：

- 图片、视频按月分组为缩略图网格。
- 文件使用紧凑列表展示名称、类型、大小、发送者与时间。
- 区分预览/下载和跳转原消息的操作。
- 懒加载缩略图，遵守现有媒体设置。
- 使用项目已有虚拟化依赖；不要另引入一套同类库。
- 增加发送者、日期范围、附件类型筛选。

验收：

- 大量结果滚动稳定，DOM 不按所有历史结果无限增长。
- 长文件名、窄屏、错误缩略图、键盘焦点均不破坏布局。
- hover/focus 操作不遮挡正文或相邻条目，不导致布局跳动。
- 预览和下载保留加密附件、认证媒体及现有失败处理能力。

### 阶段 5：按基准优化查询性能

先利用已有类型索引及有界扫描，测试 1 万、10 万事件下的常见词、稀有词、中文、文件名和无结果查询。

建议目标，需先约定设备并测量校准：

- 交互后 100ms 内提供状态反馈。
- 暖缓存首屏 P95 争取低于 500ms。
- 历史回溯使用短批次，取消后不再启动下一批。
- 长列表渲染数量不随全部结果线性增长。

只有分批扫描及类型索引仍不能达到目标时，才评估增量 n-gram 等索引。届时单独设计：数据库升级、存量迁移、空间预算、编辑/撤回更新、重建和失败恢复。

不得以“优化”为由直接删除现有用户数据库。

## 7. 验证矩阵与命令

### 7.1 必须覆盖的验证层次

| 层次               | 验证重点                                                 |
| ------------------ | -------------------------------------------------------- |
| Worker / IndexedDB | 名称、类别、分页稳定性、空扫描页、末页、更新、迁移兼容   |
| 搜索会话           | 能力路由、不同 token、取消、并发、去重、重试             |
| EventIndex         | live timeline 衔接、检查点推进、回溯末页、撤回、解密失败 |
| ViewModel / View   | 状态投影、旧请求隔离、进度、空状态、可访问性             |
| Playwright         | 真实 Worker/IndexedDB、消息和附件用户路径、跳转恢复      |

关键 E2E：

1. 搜索消息 → 继续更早历史 → 跳到原消息 → 返回恢复。
2. 搜索旧文件 → 预览或下载 → 返回恢复。
3. 媒体网格 → 预览 → 定位原消息。
4. 更早历史第一批无命中、下一批命中，最终正确结束。
5. 网络失败后已有结果保留，重试继续原位置。
6. 加密和未加密房间分别验证；索引不可用时验证合法降级或明确提示。

不能用全部 mock 的组件测试替代真实 Worker 与 IndexedDB 集成测试。

### 7.2 现有测试入口

现有相关测试：

- `apps/web/src/Searching.test.ts`
- `apps/web/src/indexing/EventIndex.test.ts`
- `apps/web/src/indexing/EventIndexPeg.test.ts`
- `apps/web/src/components/structures/RoomSearchView.test.tsx`
- `apps/web/src/components/structures/FilePanel.test.tsx`
- `apps/web/src/components/views/rooms/RoomSearchAuxPanel.test.tsx`
- `apps/web/src/components/views/elements/SearchWarning.test.tsx`
- `apps/web/playwright/e2e/timeline/timeline.spec.ts`

示例命令，从仓库根执行：

```sh
pnpm vitest run apps/web/src/Searching.test.ts apps/web/src/indexing/EventIndex.test.ts
pnpm vitest run apps/web/src/components/structures/RoomSearchView.test.tsx apps/web/src/components/structures/FilePanel.test.tsx
pnpm -r --workspace-concurrency=1 lint:types
pnpm i18n
```

新共享组件测试需在对应 workspace 运行，例如：

```sh
cd packages/shared-components
pnpm test:unit -- <实际测试文件路径>
```

E2E 按 `docs/playwright.md`，需容器运行环境。启动前检查 `lsof -ti:8080`，避免使用过期服务器。新增截图测试带 `@screenshot`；截图基线在规定 Docker 环境生成，逐张检查，不运行本地主机截图更新来掩盖失败。

格式使用 oxfmt，lint 使用 oxlint，不运行 Prettier 或 ESLint。新增测试采用 co-located Vitest，显式导入测试 API。变更覆盖率目标遵循仓库要求，不能把“未找到测试”报告为通过。

## 8. 代码导航与构建注意事项

| 责任                    | 当前路径                                                     |
| ----------------------- | ------------------------------------------------------------ |
| 搜索入口与页面状态      | `apps/web/src/components/structures/RoomView.tsx`            |
| 消息结果、分页和回溯 UI | `apps/web/src/components/structures/RoomSearchView.tsx`      |
| 文件与媒体              | `apps/web/src/components/structures/FilePanel.tsx`           |
| 搜索路由及分页          | `apps/web/src/Searching.ts`                                  |
| 索引、历史回溯、检查点  | `apps/web/src/indexing/EventIndex.ts`                        |
| 索引初始化与开关        | `apps/web/src/indexing/EventIndexPeg.ts`                     |
| 平台索引扩展点          | `apps/web/src/indexing/BaseEventIndexManager.ts`             |
| Web RPC 与索引          | `apps/web/src/indexing/web/WebEventIndexManager.ts`          |
| IndexedDB 查询与存储    | `apps/web/src/indexing/web/webEventIndex.worker.ts`          |
| Web 平台接入            | `apps/web/src/vector/platform/WebPlatform.ts`                |
| 桌面索引适配            | `apps/web/src/vector/platform/SeshatIndexManager.ts`         |
| 搜索摘要                | `apps/web/src/components/views/rooms/RoomSearchAuxPanel.tsx` |
| 搜索警告                | `apps/web/src/components/views/elements/SearchWarning.tsx`   |
| 旧附件结果展示          | `apps/web/src/components/views/rooms/SearchResultTile.tsx`   |
| 文件面板样式            | `apps/web/res/css/structures/_FilePanel.pcss`                |

**仓库根目录还残留 `src/indexing/web/`。本次追踪的应用构建路径是 `apps/web/src/indexing/web/`，不要改错目录或同时维护两份实现。** 如需清理根目录副本，应另行确认其使用者，不夹带在本次功能改动中。

新增文件使用当年版权头并确认正确版权持有人；不要盲目复制年份或让自动修复误标为 Element 官方贡献。新增公开 API 按仓库要求补 TSDoc。

## 9. 范围上限与信息安全性

本计划不包含：

- 全账户自动抓取或全局加密历史索引。
- OCR、PDF 正文、语义搜索。
- 默认无限后台回溯。
- 上传已解密内容到额外服务。
- 未经授权删库或重建。
- 重写已有媒体解密、认证和下载链路。
- 没有性能证据就引入新全文搜索引擎。

必须保护：

- 本地索引按账号和设备隔离，注销、关闭及重初始化的行为需验证。
- 旧异步请求不得越过账号或数据库生命周期边界。
- 缓存撤回、权限受限、解密失败和历史缺口不能伪装成完整结果。
- 日志与性能统计只记录耗时、数量、错误类别，不记录查询词、正文或敏感媒体地址。

## 10. 执行模型的交付清单

每阶段汇报以下内容，不能仅报告“代码已写好”：

1. 完成的具体行为和修改路径。
2. 对应需求的测试名称、运行命令及真实结果。
3. 哪些路径只经过 mock 测试，哪些经过真实 Worker/浏览器验证。
4. 性能结论的设备、数据规模、冷热缓存条件；没有测量就明确未测。
5. 未完成项、阻塞、兼容风险与下一阶段范围。
6. 本文哪些判断被实测修正，以及修正原因。

最终完成条件：正确性用例通过；UI 不再解析后端游标；消息与附件共享可靠的回溯规则；错误与覆盖范围可解释；桌面/服务端兼容路径受保护；所交付 UI 有对应测试与视觉验证。
