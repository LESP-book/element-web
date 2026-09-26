<!--
Copyright 2026 The contributors to this document

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
-->

# 搜索阶段 0–2 审查与文件搜索恢复计划

> 这是旧缺陷复现与恢复方案，非当前故障清单；本轮实际实现和剩余验证边界见
> [搜索功能实现参考](./search-implementation-reference.md)。

## 1. 结论与实施边界

> 后续实现出现消息无限 loading、附件反复 Show more、媒体下载裁切。下一轮执行入口改为
> [搜索可用性修缮方案](./search-usability-repair-plan.md)。本文件保留上一轮审查证据和数据保护要求，
> 其中旧代码结论需对照当前实现核实；不要重复执行已完成修复，也不要按原计划继续扩大图库。

**结论：已有改动方向有价值，但阶段 0–2 尚不满足验收。先修数据库升级兼容和分页错误恢复，暂缓原计划阶段 3–4。**

本文接续 [search-optimization-plan.md](./search-optimization-plan.md)，不替代原计划的长期交互目标。下一执行模型应优先执行本文的 R0–R3，再评估阶段 3。

审查范围：相对于 `a8336b3cdfc8f27016135ae447640fd860d22d6a` 的当前工作区改动，包括未跟踪的 `apps/web/src/search/` 和新增 Worker 测试。HEAD 尚未变化，6luna 的实现主要在工作区，不能只审 `git log` 或忽略未跟踪文件。

本次只审查、运行验证并更新计划，没有修改功能代码，没有访问或删除用户数据库。以下行号用于定位审查时版本，实施时应重新核对。

## 2. 用户现场证据与因果判断

### 2.1 现场证据

- 截图显示附件面板，当前选中 Media，关键词为空。
- 内容为 `Could not load files. Retry to continue searching.Retry`。
- 因此至少可以确认：这是附件加载失败，不是某个文件名没有命中；仅凭截图不能判断 Files 页签是否存在另一个独立问题。
- 用户提供控制台错误：

```text
Uncaught (in promise)
IDBDatabase.transaction: 'edits' is not a known object store name
EventIndex.ts:335:20
```

该错误直接证明：实际打开的数据库缺少运行代码需要的 `edits` object store。它不等同于文件丢失，也不证明 homeserver 已经没有附件。

### 2.2 可复现的升级遗漏

当前 Worker：

- `webEventIndex.worker.ts:42`：`DB_VERSION = 3`。
- `:95–125`：只在 `onupgradeneeded` 中建立 `edits`。
- `addEventToIndex()`、`addHistoricEvents()`、`applyEventEdit()` 无条件开启包含 `edits` 的事务。
- 初始化成功后没有检查必需 stores 和 indexes。

如果此前开发构建已经创建了版本 3、但尚未包含 `edits` 的数据库，后续仍使用版本 3 打开时不会发生升级，缺失的 store 不会被补建。

独立复现使用当前 Worker 源码，经 TypeScript 转译后运行于隔离 VM 和全新 fake-indexeddb；没有操作用户数据。预置 fixture：

```text
version: 3
stores: checkpoints, events, meta, redacted
```

结果：

```text
initEventIndex → 成功
addEventToIndex → NotFoundError: No objectStore named edits in this database
addHistoricEvents → 同样失败
queryFileEvents → 空页，exhausted=true
```

**这是已复现的缺陷，也是与现场高度吻合的原因。** 用户实际数据库版本与 stores 尚未直接读取，因此不能断言用户一定使用该精确 fixture；也应检查运行中的 Worker 是否来自最新构建。

### 2.3 为什么本地明明有文件也可能整页报错

`RoomFileSearchSession.loadMore()` 在一次调用内先扫描本地，再尝试抓取历史。当历史入库遇到缺失 store 时，调用会整体失败。此前本地读取到的结果尚未交付 UI，也会被一并隐藏。

此外，实时消息监听是 async 回调，没有统一错误出口。入库失败会成为用户看到的 `Uncaught (in promise)`。修复不能只修改文件面板文案，也不能只吞掉此异常。

## 3. 审查发现（按优先级）

### P0-A：旧数据库结构不兼容，初始化却报告成功

位置：`apps/web/src/indexing/web/webEventIndex.worker.ts:42,95–129,217`。

影响：实时事件、编辑及历史入库持续失败；消息搜索也可能受影响，因为首次搜索会先索引当前时间线。

修复方向：明确向前迁移到新版本，保留数据，迁移完成后验证 schema；不通过删库重建规避问题。详见 R1。

### P0-B：附件加载中途失败会丢失已读取结果，重试跳过文件

位置：

- `RoomFileSearchSession.ts:83`：结果只存于当次调用局部 Map。
- `:107,123`：每页立即推进会话 cursor。
- `:93`：后续回溯错误直接抛出。
- `FilePanel.tsx:165–192`：只在整个 await 成功后接收结果，catch 丢弃错误详情。

已用当前会话源码和注入替身独立复现：

```text
第一次本地查询：[$local-file]，cursor=past-local-file，exhausted=true
随后历史回溯：network failed
第一次 loadMore：reject，UI 未得到 $local-file
重试：从 past-local-file 继续
返回：events=[]，hasMore=false
```

该文件在当前会话内被跳过，只有重新创建会话才可能再看到。即使修好 `edits`，普通网络错误仍会触发此问题。

修复方向：让会话持有累计已提交结果；逐页提交 cursor 与结果，并通过 partial result + typed error 返回。不要在 UI 单独补一个 catch，也不要简单回滚已提交的历史检查点。详见 R2。

### P1-A：消息分页失败后 pendingRequest 残留，重试不再发请求

位置：`Searching.ts:257–293,683–706`。

`localPagination()` 只在成功时清理 `pendingRequest`；失败后保留被拒绝的 promise。`searchPagination()` 遇到该字段直接返回它。

独立复现：连续调用两次分页，均得到同一个错误，provider 实际仅调用一次，`pendingRequest` 仍存在。

修复方向：在请求所有者的 finally 中有条件清理正在结束的请求，不清掉另一个新请求；分页失败不能提前提交下一 token。补“先失败、后成功”的实际重试测试。

### P1-B：附件查询未在建立扫描游标前索引当前时间线

消息 `Searching.ts` 已调用 `ensureRoomTimelineIndexed()`，附件会话没有等价的初始化步骤。

代码推导场景，尚未做完整浏览器复现：

1. 本地库里有较旧事件，当前房间已加载较新的附件，但尚未入库。
2. 附件查询扫描旧记录并推进 cursor。
3. 只有进入回溯流程后，`addRoomCheckpoint()` 才导入 live timeline。
4. 新入库的较新附件位于 cursor 之前，继续向更早方向扫描会跳过它。

如果已有检查点或历史完成边界，也不能保证回溯会补上该附件。

修复方向：附件会话首查前完成当前时间线准备；不能以“进入房间可能已经触发监听”替代明确契约。需新增测试验证，而不是把该推导写成已测通过。

### P1-C：新增编辑处理缺少原事件身份校验

位置：

- `EventIndex.applyEditIfNeeded()`：只把 target ID、replacement 和 timestamp 交给索引。
- Worker `applyEventEdit()`：按 target ID 覆盖内容。
- `FilePanel.onRoomTimeline()`：直接使用 `m.new_content` 替换已展示附件。

当前接口没有传递/验证编辑事件的发送者、房间或编辑 event ID。对于乱序入库也只保存内容与时间，无法在原事件到达时完整验证归属；撤回编辑事件后也没有足够关系信息恢复有效版本。

这不是当前缺失 store 报错的原因，但属于本批新增内容处理的完整性风险，不能用“编辑功能已有单测”视为完成。现有测试只覆盖内容替换与时间先后。

修复方向：优先复用 SDK 对有效 replacement 的规则；必须自建索引投影时保留编辑关系身份，验证同房间、同发送者、事件类型等规则，并测试撤回编辑。至少不得把他人的编辑投影到原作者名下。该项为静态审查发现，尚未执行端到端恶意事件验证。

### P1-D：Worker RPC 丢失错误身份，typed error 尚无法跨层成立

位置：`webEventIndex.worker.ts` 尾部 catch、`WebEventIndexManager.ts` 的 `WorkerResponse` 与 `WorkerRPC.onMessage()`。

Worker 只发送错误 message 字符串；主线程至多重建普通 Error，无法可靠区分 `NotFoundError`、`QuotaExceededError`、`VersionError`。只在会话测试中 mock typed error，不能证明实际 RPC 保留了类型。

修复方向：在搜索/索引 Worker 与 provider 边界归一化稳定错误契约，序列化传递 code、operation 和 retryability，RPC 恢复有类型的错误。会话按 code 决策，不允许 FilePanel 解析 message。范围限定在搜索/索引，不扩展成全项目错误框架。具体约定与验证见 R1、R2。

### P2：阶段 1 的边界收拢只是部分完成

值得保留：

- 新增消息、附件会话，UI 已不再直接解析 IndexedDB token。
- 分类与文件名查询下沉到 Worker，包含 filename 和 body。
- `EventIndex` 加入 per-room task 与回溯结束原因。
- Worker 失败时拒绝 pending RPC；数据库操作进入串行队列。
- 隐藏了误导性的所有房间入口，增加部分结果计数表达。
- 补充 live timeline、撤回及 checkpoint 测试。

尚未完成：

- 消息 session 仍解析 Web token，并以 `seshatQuery` 与“支持未加密本地搜索”反推 provider。
- 附件 session 从全局 `PlatformPeg` 读取能力，而不是从注入的 provider 获取。
- 两个 session 的错误提交语义不一致，附件结果仍主要由 UI 累计。
- ViewModel / snapshot 分层尚未落地，`FilePanel` 仍处理编辑与部分查询规则。
- 进度/覆盖模型仍未覆盖保留期限、解密失败等限制。

下一步做有界收拢，不立即合并两个会话或重写整个面板。详见 R3。

## 4. 下一轮执行计划

### R0：保留现场并建立回归用例

1. 读取实际浏览器数据库的 version、objectStoreNames；必要时确认索引列表，只采集结构，不导出消息内容。
2. 核对当前 app/Worker 构建、是否存在旧标签页及旧连接；本地 8080 服务器是否实际提供当前代码。
3. 不先清除站点数据、注销、删库或重置索引。用户数据是定位升级兼容问题的证据。
4. 新增以下先失败的测试：
    - v3 缺 edits、v3 缺新增 stores、完整 v3、旧 v2、新库。
    - 本地命中后历史失败，命中仍可见，重试不漏不重。
    - 第一本地页成功、第二页查询失败。
    - 消息分页首次拒绝、第二次真正发起并成功。
    - 旧本地记录 + 未索引的新 live 附件。
5. 记录问题类型、版本、操作名，不记录关键词、正文或媒体地址。

交付：结构诊断结果、回归测试和故障路径；不以清缓存后的成功作为修复证据。

### R1：非破坏性数据库迁移与索引健康状态（P0）

1. 使用一个新的、未复用的数据库版本；若当前最高版本确为 3，可迁移到 4。
2. 升级事务逐项补建缺失 store/index，保留 events、checkpoints、meta、redacted 和已有 edits 数据。不要只在 events store 不存在时才检查它的 indexes。
3. 初始化成功前检查必需 schema；发现异常返回结构化 schema 错误，不把索引标为 ready。
4. 处理 `onblocked` 与连接 `onversionchange`：旧连接应可关闭，界面应可提示关闭旧标签页后重试，避免永远等待。
5. schema version 与 meta 中应用层 `user_version` 分清职责；不能借用既有“删库重建”分支处理本次迁移。
6. 明确 Worker/RPC 恢复路径。坏掉的 readonly RPC 实例不会因为再点一次相同查询自动恢复；结构异常需要重新初始化，Worker 崩溃需要受控重建。
7. 给异步 timeline/decryption/checkpoint 入口统一错误出口。事件监听失败应更新索引健康状态并保留诊断原因，不产生未处理 rejection，也不标记索引成功。
8. 检查失败期间漏入索引的实时事件：至少保证当前时间线重新导入、检查点可继续；超出当前时间线的同步缺口单独验证，不声称迁移自动补回所有漏失历史。
9. 在 Worker/provider 边界建立最小可序列化错误契约：稳定 `code`、允许列表内的 `operation`、明确的 `retryability`。后者至少区分可直接重试、需重新初始化、需用户处理、不可重试，避免一个布尔值掩盖不同恢复条件。
10. 在错误发生处按原生异常 name/code 及操作上下文映射，而不是解析 message；例如必需 store 缺失归为 schema 错误，`QuotaExceededError` 归为配额错误，`VersionError` 归为版本不兼容。未知错误有保守兜底，不误判为可无限重试。
11. 更新 Worker response 与主线程 RPC 解码：验证载荷，恢复搜索/索引专用错误类型；串行队列 catch 不得再次压成字符串。旧字符串响应如需兼容，只映射 unknown，不靠文案猜类别。不跨 RPC 发送查询内容、正文、媒体地址或未经脱敏的原始异常文本。
12. 增加穿过真实 Worker、postMessage 和生产 RPC 解码的错误契约测试：缺 schema、版本不兼容及配额类错误到主线程后仍有正确 code、operation、retryability。配额耗尽可在测试专用 Worker 环境中注入 `QuotaExceededError`，但必须经过生产归一化与 RPC 链路，不能只 mock 主线程 typed error，也不要为测试填满用户磁盘。测试注入不得作为生产 RPC 方法暴露。

验收：从旧 v3 fixture 直接升级后可查旧附件、写新附件、回溯历史、处理编辑；全部旧事件与检查点保留。真实浏览器下多连接阻塞可恢复，无需用户删库。

### R2：修复分页提交、部分结果和重试（P0/P1）

推荐契约：会话累计已提交结果，分页成功后原子更新该页的结果及 cursor；后续步骤失败返回当前结果 + 结构化错误状态。

1. 本地首批可用结果尽快交给 UI，不等待后续远程回溯全部成功。
2. 使用 R1 在 Worker/provider 边界归一化的 typed error，例如 schema、storage、network、permission、cursor、worker、cancelled；会话按稳定 code 和 retryability 决定直接重试、重新初始化或提示用户处理，UI 只投影成翻译文案和动作。禁止 FilePanel 或会话按 message 字符串分类；保留安全的原因信息，不直接显示敏感原始异常。
3. 后续回溯失败不删除前面的本地命中；重试从最后成功提交位置继续。
4. 消息/附件遵循相同 partial-result 原则，消息 pendingRequest 必须在失败后释放。
5. 在会话内部管理 loadMore in-flight，不能仅依赖 React setState 的 loading 标记防并发。
6. 附件建立初始扫描游标前准备当前时间线，且不要每个分页重复全量导入。
7. 分类和关键词变化用新代次；旧请求可以完成共享入库，但不能写回新查询结果。
8. 按账号、房间和 event ID 去重并稳定排序；结果重试不改变已有条目的相对顺序。
9. UI 同时渲染已有结果与错误/重试提示；修复截图中正文与 Retry 粘连的问题，避免长错误文本破坏布局。

不要采用：catch 后返回空数组、清空结果、把失败标记为 exhausted、仅回滚前端 cursor 却假设历史检查点也回滚。

验收：离线、超时、Worker 失败、cursor 失败均不漏掉之前成功读取的结果；重试真实发请求，失败状态不能污染新会话。

### R3：补齐内容有效性与小范围职责收拢（P1）

1. 修复编辑身份校验、乱序编辑、撤回编辑投影；有效性规则不要在 UI 和 Worker 各写一套。
2. Searching 路由返回显式 provider handle，至少包含来源、能力、分页方法及本地耗尽解释。后端 token 保持不透明。
3. 两个会话保留，但共享小范围的回溯 outcome / partial-result / error 契约。
4. 能力从注入 provider 获取，不从全局环境猜测，也不把一个布尔能力当平台身份。
5. 先完成正确性修复，再按原计划迁移各自 ViewModel；不要为修 schema 顺便重写所有展示组件。
6. 对已实现能力重新做阶段 0–2 验收清单，明确“完成”“部分完成”“未验证”。

验收：invalid replacement 不改变原作者消息；UI 不处理编辑有效性或后端 token；两个会话的错误行为一致；Web / Seshat / server 回归通过。

### R4：修复完成后才推进体验阶段

通过 R1–R3 后，再实施原计划阶段 3：进度、可解释空状态、停止/重试、输入法安全防抖、跳转恢复。随后实施媒体网格和文件紧凑列表。

不将图库外观、相关度排序、全文引擎替换混入本轮故障修复。

## 5. 已运行的验证与局限

### 5.1 当前已有单测

```sh
pnpm vitest run apps/web/src/search/ apps/web/src/indexing/web/ \
  apps/web/src/indexing/EventIndex.test.ts apps/web/src/Searching.test.ts \
  apps/web/src/components/structures/FilePanel.test.tsx \
  apps/web/src/components/structures/RoomSearchView.test.tsx \
  apps/web/src/components/views/rooms/RoomSearchAuxPanel.test.tsx
```

结果：**10 个测试文件、64 个测试通过**。

### 5.2 当前已有浏览器测试

```sh
pnpm vitest run --project='element-web (browser)' \
  apps/web/src/indexing/web/webEventIndex.worker.test.browser.ts
```

结果：**1 个 Chromium Worker 测试通过**。这是本次实际可用的 project 名称。

该测试使用随机新库，仅验证新库文件名查询、完成 token 和删除事件。不能证明旧库升级、FilePanel 端到端、失败重试或实际 Firefox 行为正常。

### 5.3 独立审查复现

没有改产品代码，使用当前源码转译及受控依赖替身验证：

- 版本 3 缺少 edits：初始化成功，实时与历史入库失败。
- 附件本地命中后回溯失败：retry 越过已读 cursor，丢失首批结果。
- 消息分页失败：retry 重用 rejected pending promise，provider 未再次调用。

复现结果是负面证据，不是修复测试已通过。执行模型应将这些场景固化为仓库回归测试。

### 5.4 本次未验证

- 用户实际 IndexedDB 结构、运行中 Worker 版本。
- 真实登录会话、homeserver 回溯及加密附件 E2E。
- Firefox schema 升级和多标签页流程。
- 全量 typecheck、lint、i18n 生成、diff coverage。
- 性能指标。fake-indexeddb 的耗时不能作为真实浏览器基准。

## 6. 最终交付门槛

- [ ] 旧版本、不完整 v3 和完整 v3 均非破坏性升级成功。
- [ ] schema 异常不会把索引标为可用，不产生未处理 rejection。
- [ ] 缺 schema、配额和版本错误穿过真实 Worker 与生产 RPC 解码后仍保留稳定 code、operation、retryability；恢复动作不依赖 message。
- [ ] 老文件仍在，新文件可入库，消息搜索不受迁移回归影响。
- [ ] 本地结果加远端失败时，已有结果可见，重试不漏不重。
- [ ] 消息分页失败后真的可重试，不重用 rejected promise。
- [ ] 首次附件查询能覆盖当前时间线及更早历史。
- [ ] 编辑身份和撤回编辑遵循有效性规则。
- [ ] Web、桌面 Seshat、server 的适用路径有对应回归。
- [ ] 新旧库浏览器集成测试，以及附件 UI 故障恢复测试通过。
- [ ] 真实受影响浏览器保留原数据验证恢复；若无法获取，明确未验证。
- [ ] 文案与 Retry 间距修正，新增翻译按仓库要求生成。

执行时遵守 `AGENTS.md`，使用 oxfmt / oxlint、co-located Vitest，阶段性记录证据。不得把“全部已有测试通过”当作以上门槛已达成。
