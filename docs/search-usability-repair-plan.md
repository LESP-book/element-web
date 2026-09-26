<!--
Copyright 2026 The contributors to this document

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
-->

# 搜索可用性修缮方案：先找得到，再谈展示升级

> 本文件保留历史审查、修缮顺序及当时的复审判断；当前实现与验证范围以
> [搜索功能实现参考](./search-implementation-reference.md) 为准。第 8.5 节中的缩放证据缺口仍需单独留意。

## 1. 执行入口与本轮结论

> 最新复审：见第 8.5 节。**B1 功能修复通过；B2 缩放测试可运行，但比例标签和截图取景需修正，暂不全项通过。** 不再重做搜索功能。
> 原 S1–S3 已有实质改进，不要求重做整套方案；本次复审没有修改功能代码。

本方案是给 6sol 的下一轮执行交接，优先级高于前两份计划中与其冲突的交互要求：

- [原始优化计划](./search-optimization-plan.md)
- [数据库与错误恢复计划](./search-optimization-review-and-recovery-plan.md)

保存日期：2026-09-26。研究基线 HEAD 仍为 `a8336b3cdfc8f27016135ae447640fd860d22d6a`，但主要实现位于当前未提交工作区，包含未跟踪文件。执行前检查完整工作区，不只查看提交记录；不要回滚覆盖其他模型的代码。

**本轮不是再做一次搜索重构，也不是补完所有原计划功能，而是修好三个已经妨碍使用的问题：**

1. 打开 Files / Media 自动寻找首批附件，不靠反复点 Show more 推动内部扫描。
2. 消息搜索在开发与正常运行环境都能显示结果或明确结束，不永久 loading。
3. 媒体先恢复完整可用的单列布局，下载和跳转按钮不被裁切。

同时折叠高级筛选，减少控件对结果区域的挤占。暂不增加新筛选、新网格样式、新索引引擎或新基础设施。

### 对前两版方案的纠偏

前面的“昂贵历史回溯必须有界”被落实成了“首次不回溯，每次点击只查一个历史批次”。这限制了资源，却把后台工作转嫁给用户，稀疏附件因此经常出现空列表。**有界工作单元不应该等于一次用户操作。** 本方案明确替换这一行为要求及相应测试。

网格的目的原本是提高浏览效率，不是必须保留的目标。当前适配没有正确处理消息体内的下载控件，不能为了保住多列而隐藏按钮、缩小文字或继续裁切内容。**本轮先回到单列，网格另议。**

## 2. 现场表现与代码证据

### 2.1 文件与媒体：多次点击才能看到结果

用户截图和反馈：

- Files 关键词为空、无明显筛选条件，却显示当前扫描范围没有文件，只能点 Show more。
- Media 也要多次继续后才出现附件。
- 顶部展开了发送者 ID、日期范围、附件类型，明显挤占结果空间。

当前代码：

- `RoomFileSearchViewModel.reset()` 最后调用 `loadMore(true, generation, false)`，首次明确禁止历史回溯。
- `RoomFileSearchSession.ts` 固定 `MAX_SCAN_PAGES = 3`、`MAX_BACKFILL_PAGES_PER_LOAD = 1`。
- `loadMoreLocal()` 和滚动触底只允许本地查询，不启动历史抓取。
- `FilePanel.onFillRequest()` 在结果为空时直接返回。
- 会话内部虽然按页累积结果，当前 ViewModel 仍等待整次 `loadMore()` 返回后才更新 UI。
- 切换页签通过 `reset()` 清空结果并重建会话，没有页签内结果与滚动恢复。

因此首次本地索引无附件时，初次浏览会直接落到部分空状态。若连续多个历史批次只有文字，没有文件，则每次点击只推进一批，出现用户反馈的反复空返回。

这不是单纯把 Show more 按钮自动点几次即可解决，也不是文件一定不存在。

### 2.2 消息一直 loading：已复现的 StrictMode 生命周期错误

应用入口 `apps/web/src/vector/app.tsx` 用 `<StrictMode>` 包裹 MatrixChat。

`RoomSearchView.tsx` 当前行为：

1. 在 render 中把 `RoomMessageSearchSession` 存到 ref。
2. effect setup 调用 `handleSearchResult()`，先通知 `onUpdate(true)`。
3. effect cleanup 销毁 `sessionRef.current`。
4. StrictMode 的开发期 effect 重放再次 setup，却复用同一个已 dispose 的 session。
5. `acceptInitial()` 因 disposed 返回 null，结果回调直接退出，不通知结束。

已用当前真实组件、真实 session 和受控搜索 promise 做两组对照复现：

```text
普通根渲染：
visible=true, disposed=0, accepted=[true], loading=false, finished=true

根级 StrictMode：
visible=false, disposed=1, accepted=[false,false], loading=true, finished=false
```

两组输入是同一条成功搜索结果。这证明无需慢服务器或大数据库也能卡住。

注意：测试必须开启**根级** StrictMode，例如当前测试工具支持的 `reactStrictMode: true`。只在非 StrictMode provider 内嵌套 `<StrictMode>`，可能不触发 React 19 的首次 effect 重放，会漏掉问题。

本次临时复现测试已删除，没有修改产品代码；执行模型应将正向回归固化到正式测试中。不要把上述“预期复现坏行为”的通过当成修复通过。

### 2.3 消息 loading 还存在其他未收束出口

`handleSearchResult()` 先设置 loading，再在以下情况直接退出：

- 返回 null；
- `acceptInitial()` 拒收（dispose、client 或 index 身份变化）；
- 捕获 `AbortError`。

此外，成功回调内部还会处理高亮、线程与渲染数据。如果这些步骤抛异常，当前 `promise.then(success, failure)` 的第二个参数不会捕获 success 内部抛出的异常。

因此只让 StrictMode 重建 session 还不够：当前查询的取消、索引重初始化、结果转换失败，也必须有终止状态。旧查询则只能被丢弃，不能结束新查询的 spinner。

### 2.4 媒体下载被裁切：组件适配边界错误

代码链路：

- `RoomMediaSearchTile.tsx` 把 `ImageBodyFactory` / `VideoBodyFactory` 整体放进 preview 区。
- FilePanel 上下文是 `TimelineRenderingType.File`。
- `MBodyFactory.tsx` 在此上下文会让图片和视频 body 同时渲染 `FileBodyFactory` 下载内容。
- `_FilePanel.pcss` 对 tile 和 preview 都设置 `overflow: hidden`；preview 又设 `aspect-ratio: 1`。
- 新增的独立 actions 区只有名称及“跳转原消息”，没有自己的下载动作。

实际被裁的是“图片/视频 + 下载操作”的整块消息体，而不是纯缩略图。这与截图的 Download 左边缺字、按钮只剩一半吻合。

`RoomMediaSearchTile.test.tsx` 把 ImageBodyFactory/VideoBodyFactory mock 成简单按钮，所以现有测试看不到真实下载控件及尺寸问题。

## 3. 本轮用户体验契约

以下是实施与验收要求，不是可选建议。

### 3.1 打开附件面板

- 默认只显示标题、搜索框、Media / Files 页签和收起的“筛选”。
- 已缓存或当前时间线已有的附件优先显示；不要等整批远程抓取结束才显示。
- 本地首批不足时，在同一次用户打开操作内自动进行**有界、可停止**的历史查找。
- 一个内部批次没有命中，只说明要继续扫描，不能立即把工作交给用户点按钮。
- 找到第一条就发布，继续补到首屏目标或预算结束。初始目标建议 20 条；这是 UI 目标，不是把 `/messages` limit 改成 20。
- 若服务端限制或附件很稀疏，不保证无限历史立即可见，但必须展示真实扫描进度、停止原因和继续入口。
- 切页签保留该房间当前查询的结果与滚动位置，不每次从头扫描。缓存只在面板/房间会话内，离开后有界释放。

### 3.2 “继续查找”是一段查找，不是一页 RPC

一次打开、提交关键词、继续查找都由会话启动一次前台任务：

```text
读已有本地结果 → 发布命中
        ↓ 本地扫描还有页
继续小批扫描 → 发布命中 / 更新进度 / 让出执行
        ↓ 本地范围耗尽且允许历史
回溯一小批 → 入库 → 继续查询
        ↓
达到目标 / 真实结束 / 错误 / 停止 / 时间预算耗尽
```

建议初始调度参数：

- 首屏或继续查找目标：20 条新增可见结果。
- 单次用户任务软预算：8 秒。
- 批次之间让出执行；停止后不启动下一批。
- 具体网络/Worker 操作另有有限等待与恢复规则，软预算不能中断一个永不返回的 await。

这些是待浏览器实测校准的工程起点，不是已经测得的性能承诺。可以按目标设备调整，但不能退回“一次按钮只推进一页”。

到预算时：停止 spinner，保留已找到的结果，显示“已扫描 X 条，仍有更早历史未查”及“继续查找更早记录”。不要显示“没有文件”或宣称已搜完。

“已搜索至某日期”只能来自真实扫描覆盖，不能用最老命中日期冒充；如果当前底层不能提供可靠日期，先显示扫描条数即可，不扩大为覆盖区间重构。

自动触底只读本地缓存是允许的保守策略；首次打开与用户主动继续必须能够跨越多个历史批次。空结果首屏不能依赖列表触底来推进。

### 3.3 消息搜索

- 每次提交产生独立查询身份。
- 首次有结果、无结果、失败、主动停止、当前查询被替换都必须有明确结局。
- 本地结果可尽快展示，必要的准备/补索引不能无限阻塞已有可用结果。
- 继续扫描使用和附件一致的小范围任务 outcome 约定，不必合并两个 session。
- 不用整页加载覆盖已有命中；正在继续查找时反馈放在底部。
- 停止按钮在首次查询阶段也有效，不只在翻页或回溯阶段出现。

### 3.4 媒体先恢复单列

本轮目标示意：

```text
┌─ 文件与媒体 ───────────────────── × ┐
│ [搜索文件名……                   ] │
│ Media   Files           [筛选 ▾]   │
├────────────────────────────────────┤
│ 2026 年 9 月                       │
│ ┌────────────────────────────────┐ │
│ │ 图片 / 视频预览，保持合理比例   │ │
│ └────────────────────────────────┘ │
│ 图片.png                           │
│ [下载 · 79 KB]       [查看原消息]   │
│                                    │
│ 下一条媒体……                       │
├────────────────────────────────────┤
│ 正在查找更早记录 · 已扫描 1500 条   │
│ [停止]                             │
└────────────────────────────────────┘
```

- 单列、按时间分组；不强制正方形，不截整个消息体。
- 下载、错误、加载和隐藏媒体提示都占据正常布局空间，不放到裁切视口中。
- 文件名允许省略并提供完整名称，操作文本不能省略到无法识别。
- 预览与下载复用现有认证、解密、MediaEventHelper 和下载链路。
- 如果暂时无法拆出干净的预览适配，先用完整 media body 的自然高度单列布局，确保内置下载可见且不重复再加一个下载按钮。
- 不把上下文伪装成 Room/Search 来“消除下载按钮”，不全局修改消息体样式以适配这个面板。
- 后续如恢复网格，必须单独设计纯预览适配器 + 不裁切的动作区；本轮不做。

### 3.5 筛选与错误提示

- 高级筛选默认折叠，展开时再占空间；保留已有筛选能力，但不新增项。
- 页签与结果紧邻，顶部不再长期展示大片表单和重复“不完整”提醒。
- 错误和恢复动作按 typed error 的 code / retryability 选择，不一律显示 Retry。
- 当前 ViewModel 把 typed error 转为通用 Error 的投影需修正：保留恢复动作所需字段，视图只显示翻译文案和动作。
- 配额、版本阻塞、需重新初始化的问题不能无限点击相同请求；需要用户处理时明确说明。

## 4. 实现边界：修在责任所有者，不再叠补丁

### 4.1 底层工作与用户任务分离

保留 provider / EventIndex 的有界单步读取、抓取和单房间并发协调。会话拥有一次用户动作的连续调度、累计结果和停止条件。

消息与附件只共享必要的小型结果约定，例如：

- `matches`：本批新增可见结果；
- `progress`：扫描条数或可靠时间进度；
- `continuation`：能否继续本地/历史；
- `stopReason`：目标达到、结束、预算、取消、错误。

具体名字服从现有代码。禁止为了这轮修缮建立通用任务框架，禁止把两个会话合成巨型 ViewModel。

每一批成功后立即发布结果及 cursor，后续失败保留已提交结果。ViewModel 订阅进度/结果，不等待整次调度结束；跨代次提交必须受身份检查约束。

### 4.2 消息生命周期必须按请求所有权修复

采用符合仓库生命周期规范的 VM，或在 effect 内创建并捕获本次 session；两种方式选一个最小可靠方案即可。

必须满足：

1. 每次 setup 捕获本次 session、不可混淆的 generation，以及独立 disposed/cancelled 标记。
2. cleanup 只销毁自己捕获的对象。
3. 异步回调不得通过可变 `sessionRef.current` 把旧请求结果写入新 session。
4. 不能依赖共享 aborted ref：第二次 setup 把它重置为 false 会重新放行第一次 setup 的回调。
5. 当前代次每个完成路径转入 ready/error/stopped/superseded 等明确状态；只有旧代次可以静默丢弃。
6. client/index 替换导致拒收时，若仍是当前查询，要明确结束并提示重新发起/恢复；不能无声 return null。
7. 当前 AbortError 与旧查询取消分别处理。旧查询的 finally 不能把新查询 loading 关掉。
8. 结果转换、高亮、线程处理异常也进入当前代次错误出口。
9. 父组件 searchId 与本地 effect/session generation 一起校验；StrictMode 中同一个父 searchId 仍可能有多次 effect setup。

禁止：关闭 StrictMode、将 disposed 改回 false、只清空 ref 却让旧回调读新 ref、所有 finally 无条件 onUpdate(false)。

### 4.3 等待预算不能破坏共享任务

- 给真正可能悬挂的 Worker/RPC、解密准备、网络等待设置受控终止或可恢复状态；先定位而非盲目给每个函数加 timeout。
- 调度软预算耗尽后，不再启动新批次；已有共享回溯可以安全完成入库，但不得重新点亮已停止查询的 spinner。
- 不能仅 Promise.race 超时后马上开始另一个同身份任务，造成双重 cursor/检查点提交。
- 被中止或替换的查询丢弃自身 UI 回调，不取消其他消费者仍在使用的房间历史任务。

### 4.4 保留已经修好的底层能力

当前已看到 v4 非破坏性 schema、typed RPC error、逐房间回溯、累计附件结果、首次附件 timeline 准备、消息 pendingRequest 清理等实现。不要为了展示退回单列而把这些逻辑整体回滚。

这些实现是否完全正确不在本次全文审计范围内；保留已有回归测试。涉及本轮路径才做有界修正，不再扩展账号生命周期/数据库框架。

### 4.5 附件结果只有一个权威所有者，实时失效必须同步

当前静态代码存在两份累计结果：`RoomFileSearchSession.results` 保存全量 Map，`RoomFileSearchViewModel` 又将每次全量返回追加到 snapshot。`redactEvent()` / `replaceEvent()` 只改 VM，没有修改 session。下一页返回旧累计记录时，已撤回或编辑后不再匹配的附件会被追加回来；即使 IndexedDB 已正确删除，内存缓存仍会复活它。

S2 必须同时收拢这项所有权。推荐最小方案：

- session 是查询结果的唯一权威所有者，接收已验证的 remove/update/invalidate 实时事件，重新判断匹配并发布权威 snapshot。
- VM 只投影结果与 UI 状态，不再把 session 的全量数组与另一份累计数组合并。用于按 ID 查找的派生 Map 可以保留，但不能成为独立写入源。
- 实时新增、撤回、有效编辑通过同一个结果提交边界处理，不另建一条仅修改 UI 的路径。
- 在查询尚未返回时发生撤回/编辑，也必须在提交迟到分页时生效：维护当前会话内必要的删除标记或版本信息，避免旧页覆盖更新。不能只在当前 Map 删除一次便认为完成。
- 页签保留的非活跃 session 也必须接收失效事件；或明确标记失效，在恢复展示前重新验证，不能先闪现旧正文再刷新。
- 失效记录限定在账号、房间及会话生命周期内，销毁时释放；本轮不增加数据库 schema 或全局事件框架。

若执行者选择增量事件协议而非 session 权威 snapshot，也必须说明谁持有结果与跨批次删除/版本信息。两种方式择一，禁止继续合并两套全量累计结果。

新增确定性回归：首次展示 A → 撤回 A（或有效编辑使 A 不再匹配）→ 下一批携带旧 A 与新 B → 只展示 B；另外覆盖更新发生在 pending 页返回之前、编辑仍匹配时展示新内容，以及非活跃页签收到失效后切回不复活 A。这是静态可推导缺陷，本次尚未运行该新增回归，执行者需先固化测试。

## 5. 执行顺序与每步验收

### S1：先消除消息无限 loading（P0）

修改范围以 `RoomSearchView.tsx`、`RoomMessageSearchSession.ts` 及必要的父查询状态为主。

先补测试，再修改生命周期：

- 根级 StrictMode，成功 promise 返回后出现真实消息。
- pending → cleanup → setup → resolve，只有正确会话提交。
- 旧 promise 比新 promise 更晚完成，不能污染新结果或 spinner。
- 当前 AbortError 正常停止，旧 AbortError 不影响新查询。
- index/client 替换后当前查询不再永久等待。
- null、拒收、结果转换异常均有明确当前状态。
- 长时间未完成请求有可见停止/恢复出口。

验收：在 `pnpm start` 对应开发环境实际搜索一条当前房间可见消息，结果显示、可跳转；普通构建也通过。不能只有不含 StrictMode 的单测。

### S2：恢复首屏附件和一次连续查找（P0）

涉及 `RoomFileSearchSession.ts`、`RoomFileSearchViewModel.ts` 及少量查询动作接入。

- 首次打开本地先显示，必要时自动启动有预算的历史查找。
- 一次继续跨多批空历史，逐批发布结果和进度。
- 更新那些断言“初次绝不回溯”“一次显式操作只回溯一批”的旧测试；保留“不无限自动抓取、不并发重复抓取”的真正约束。
- 补当前时间线附件、旧历史稀疏附件、多个空页后命中、没有附件、错误及取消。
- 按第 4.5 节统一结果所有权和实时失效处理，去掉 VM 对 session 全量结果的第二次累计合并。
- 加入面板会话内页签结果/滚动恢复，不因切换丢掉已找到的数据；非活跃页签的撤回/编辑必须同步失效。

验收 fixture：本地没有附件，连续 4 个历史页仅含文字，第 5 页包含目标文件；总耗时在任务预算内。打开面板即可看到文件，点击次数必须为 0。同样对 media 验证。已有一批结果后再查更早附件，一次继续即可跨越空页。

超出预算的 fixture 则必须结束 spinner，说明尚未查完，提供继续动作；不承诺任意久远附件都零等待。

### S3：媒体单列与紧凑控件（P1，但属于本轮必做）

- 移除当前媒体多列使用路径，恢复自然高度单列；不删除媒体底层能力。
- 去掉裁切整个 body 的方形 preview 约束。
- 高级筛选收起，状态文案简化，Retry 和正文有正常间距。
- 如继续使用虚拟列表，确保可变高度媒体加载后重新测量，不把下载操作裁到虚拟行之外。
- 检查 RoomMediaSearchTile 中 helper 的 useMemo 创建、effect destroy 是否也能承受 StrictMode 生命周期；只修本组件必要范围。

验收：真实图片/视频 body 中下载按钮可见且可点击，实际下载成功；宽高不同图片、长文件名、加密媒体、预览关闭、加载失败均不损坏操作区。

### S4：端到端验收后才宣布完成

执行下一节的浏览器矩阵，提交实际截图/测试输出与未验证事项。用户三项投诉都闭环后，再讨论未来网格或更多筛选，不提前继续原始阶段 4–5。

## 6. 测试与证据要求

### 6.1 本次已验证

运行当前已有测试：

```sh
pnpm vitest run apps/web/src/search/ apps/web/src/viewmodels/search/ \
  apps/web/src/components/structures/RoomSearchView.test.tsx \
  apps/web/src/components/structures/FilePanel.test.tsx \
  apps/web/src/components/views/rooms/RoomMediaSearchTile.test.tsx
```

结果：**11 个文件、70 个测试通过**，同时有现存 act/JSX 等警告。它们没有覆盖根级 StrictMode 和真实媒体裁切，也有测试在固化“必须手动回溯”的不良产品行为。

另用临时受控组件测试复现根级 StrictMode 卡住，结果见第 2.2 节。复现测试只证明缺陷存在，不是修复验收。

未执行：用户登录环境操作、完整浏览器截图验证、全量 lint/typecheck、实际网络/索引性能测试。本次不把截图诊断冒充浏览器交互复现。

### 6.2 必须补的集成测试

| 场景                              | 通过条件                                                    |
| --------------------------------- | ----------------------------------------------------------- |
| 根级 StrictMode 搜消息            | 成功结果显示，loading 结束                                  |
| 当前取消、旧取消、索引替换        | 当前状态收束，旧代次不影响新代次                            |
| 打开 Files，附件在第 5 个历史批次 | 预算内自动出现，不点击 Show more                            |
| Media 同样稀疏                    | 与 Files 使用同样查找行为                                   |
| 前一批有命中、下一批慢或报错      | 前一批立即可见，之后不丢失                                  |
| 无结果且继续令牌存在              | 自动推进到预算，显示部分扫描状态                            |
| 真实历史结束                      | 无结果/没有更多，不提供无效继续按钮                         |
| 停止、切查询、切房间              | 不再发起旧任务的新批次，迟到结果不污染                      |
| 重复触底/重复点击                 | 同一查询无并发游标推进                                      |
| 切页签返回                        | 有效结果和滚动恢复，不无故重新从头查；失效结果不得闪现      |
| 撤回/编辑后继续分页               | 旧累计页或迟到页不能复活已撤回或不再匹配的 A，新 B 正常出现 |
| 编辑后仍匹配                      | 保留有效新内容，后续旧页不能覆盖                            |
| 非活跃页签收到撤回/编辑           | 切回不会显示旧正文或被移除附件                              |
| 消息和附件同时回溯                | 保留 EventIndex 的共享安全规则                              |
| schema/配额/网络错误              | UI 展示正确恢复动作，不无效 Retry 循环                      |

至少一条端到端路径使用真实 Worker + IndexedDB + 实际面板，不把整个 session/provider 替换成预设结果。

### 6.3 视觉与媒体验收

使用真实 ImageBodyFactory / VideoBodyFactory / FileBodyFactory，不 mock 成 Preview 按钮。可 mock 网络媒体资源，但保留真实布局与动作链路。

面板宽度至少覆盖 320、400、600 CSS px；浏览器缩放至少 100%、150%、200%，同时检查中文和英文。对用户实际浏览器优先验证，Chromium 自动化不能代替另一个浏览器的现场结论。

检查：

- 下载按钮的可见矩形与命中区均在可用区域内，没有任何字被截掉。
- 无横向滚动，不靠全局 overflow:visible 把控件挤到邻项上。
- 图片、视频、隐藏预览、失败回退都可下载/查看原消息。
- 长译文可换行，操作之间不重叠，键盘焦点完整可见。
- 媒体加载前后列表重新测量正确，不跳到别的条目。
- 默认控件为搜索框、页签和折叠筛选；大部分面板留给结果。

截图测试带 `@screenshot`，按仓库规定环境生成并人工查看差异，不能更新基线掩盖裁切。修缮完成汇报需有真实窄面板截图，而不只是 Storybook 的假 tile。

## 7. 交付限制与最终检查

执行前读取 `AGENTS.md`、`code_style.md`；新的 UI 遵循 MVVM。使用 oxfmt / oxlint、co-located Vitest；翻译变化运行 `pnpm i18n`。不要擅自提交、推送、部署或删除用户数据。

分开提交逻辑：消息生命周期、连续查找调度、媒体布局/控件整理，不夹带大范围格式化或数据库重构。

本轮禁止的“修法”：

- 将 MAX_SCAN_PAGES 或回溯 limit 单纯调大。
- 在 FilePanel 递归调用点击处理器或给 Show more 自动点击。
- 为停止 spinner 无条件 finally 改全局 loading。
- 关闭 StrictMode、复活已 dispose 会话。
- 隐藏下载按钮、裁切按钮、伪造 timeline 上下文、缩小字体掩盖空间不足。
- 删库后用新库通过来宣称修好升级用户体验。
- 为网格增加更多包装组件而不验证真实消息 body。

完成前逐项提供证据：

- [ ] 消息在开发 StrictMode 和正常构建中均可搜、可结束。
- [ ] 打开附件在稀疏 fixture 下无需点击即可找到首批结果。
- [ ] 一次继续自动跨越多页，无需用户代替内部循环。
- [ ] 首个命中增量显示，超预算/无结果/失败/停止均可解释。
- [ ] 媒体单列、下载完整且真正可用，筛选默认收起。
- [ ] 分页、取消、切页签及错误重试不漏不重、不串状态。
- [ ] 附件结果只有一个权威所有者；撤回/编辑后分页、迟到结果、非活跃页签恢复均不复活旧内容。
- [ ] 原有数据库迁移、typed error、加密媒体及账号隔离测试未回归。
- [ ] 新测试覆盖真实应用生命周期与真实媒体布局，不只测替身。
- [ ] 汇报实际测试、截图、剩余限制；未验证的用户现场明确标注。

**只有这三条用户主路径好用，才算本轮完成。新增组件数量、通过测试总数或更复杂的架构都不能替代这个判断。**

## 8. Sol 执行后复审：暂不通过，限定补修 A1–A3

### 8.1 已有改进与验证结果

复审仍以当前工作区为对象，HEAD 未变化。确认已有改善：

- 消息 effect 内重新创建会话，增加查询代次与身份校验，根级 StrictMode 回归通过。
- 附件增加 `searchUntilTarget()`，不再把每一历史页直接交给用户点击；首批查询可自动回溯，逐步发布结果。
- 附件 session 成为累计结果所有者，VM 不再合并两套全量结果；缓存页签接收 live 更新。
- 媒体去掉方形裁切约束，恢复单列；筛选默认折叠。

本次实际运行：

1. 搜索/session/VM、FilePanel、RoomSearchView、真实和替身媒体 body、Searching、indexing 相关单测：**184 通过，2 跳过**；跳过不计通过。
2. `pnpm vitest run --project='element-web (browser)' apps/web/src/indexing/web/webEventIndex.worker.test.browser.ts`：**5 个 Chromium 测试通过**。
3. `cd packages/shared-components && pnpm test:unit -- src/room/search/`：**3 个 Chromium 共享组件测试通过**。
4. `pnpm exec tsc --noEmit -p apps/web/tsconfig.json`：通过，无诊断输出。
5. `git diff --check`：通过。
6. 另写临时正向回归验证遗漏边界：**3 个用例失败**，对应下述编辑回匹配、编辑乱序、挂起请求恢复。临时测试已清理，未修改功能代码；执行者应固化等价正式回归。

没有执行登录态完整 E2E、真实面板窄屏/缩放截图、实际媒体下载或全量 lint。不能据此无条件通过。

### A1（P1）：有效编辑投影仍不正确，必须统一规则

位置：`RoomFileSearchSession.ts:143–189`，`RoomFileLiveEvents.ts:81–92`，以及索引侧 `webEventEditStore.ts` 的编辑投影规则。

**已实测失败一：匹配 → 不匹配 → 再匹配不能恢复。**

```text
查询 report
A = report.pdf → 显示
同作者有效编辑 A = other.pdf → 正确移出结果
再次有效编辑 A = report-v2.pdf → 应重新出现，实际仍为空
```

原因：`replace()` 将不匹配与撤回都记录为 `replacements[id] = null`。`edit()` 只从当前命中 results 查原事件；A 离开结果后找不到原事件，且 replacements 已有键，不再接受下一次编辑。后续扫描页也被 `accept()` 拒收。

**已实测失败二：迟到旧编辑覆盖新内容。**

```text
A 原始附件
编辑 E2：timestamp=30，body=new.pdf
随后收到 E1：timestamp=20，body=old.pdf
预期仍为 new.pdf，实际变为 old.pdf
```

当前实时与 pending 编辑没有统一的最新修订选择。Worker 已有 sender/room 校验、timestamp/event ID 比较，但内存会话按到达顺序覆盖，形成两套不一致规则。

**静态可推导、尚未执行新增回归：撤回编辑无法还原有效内容。**

A 经编辑 E 显示新名称后，撤回 E 的关联 ID 是 E，不是 A。实时桥只调用 `redactEvent(E)`，没有使 A 重新投影。即使 Worker 恢复了 A，session 对 A 的 replacements 仍使新读出的 A 被拒收；缓存页签也会保留已撤回的编辑内容。

限定修法：

1. 分开原事件的永久撤回标记、已知事件最新有效投影、当前查询是否匹配三种事实。
2. 保留必要的原作者、房间、类型、原内容及编辑 ID/时间；匹配只决定可见集合，不删除后续修订需要的身份。
3. 与现有 SDK/索引有效编辑规则对齐；可抽窄范围纯 projector 复用，不能在 VM/视图追加更多编辑分支。
4. 撤回编辑要重新选择前一有效编辑或原内容；撤回原事件则始终不复活。
5. 同样处理 pending 页与非活跃页签，迟到旧页不能覆盖更晚有效投影。
6. 不新增数据库 schema，不建立全局事件框架。

验收：上述两个实测用例通过，并补 E2→E1 乱序、撤回 E2 恢复 E1、撤回全部编辑恢复原内容、原事件撤回后编辑不复活、pending 页及非活跃页签同场景。不要只覆盖一次编辑后隐藏。

### A2（P1）：8 秒预算无法结束悬挂操作，停止后继续仍会卡住

位置：`RoomFileSearchSession.ts:202–240,261,287,328`，`RoomFileSearchViewModel.ts:221–280`。

已在真实 session/VM 配受控 pending provider 的测试中复现：

```text
初始 queryFileEvents 永不完成
推进计时 60 秒：loading=true
用户 Stop → Continue
再推进 60 秒：loading=true，provider 调用数仍为 1
```

原因：时间预算仅在 `await loadMore()` 之间判断；单次索引准备、查询或网络请求不返回，预算没有机会执行。停止虽能关闭当前 UI loading，但 resume 又通过旧 `this.loading.promise.then(...)` 等待同一个悬挂任务。

限定修法：

1. 区分用户任务软预算与单个底层操作的有限等待；明确网络、Worker 和解密准备各自的恢复所有者。
2. 到达等待上限时当前 UI 进入明确的可恢复/需处理状态，不永远 searching；已提交结果继续显示。
3. 对失效 Worker/provider 采用现有 typed error 与受控重初始化能力，旧 generation 的响应不能写回新会话。
4. 对共享回溯，先确认旧操作仍在执行、已失败或已完成，再决定等待提示/继续消费；不能仅 race 超时后发起竞争性重复回溯。
5. Continue 不能无条件再次等待永不完成的旧 promise。若暂时无法安全恢复，应明确显示阻塞原因和重新初始化动作，而不是伪装为正在继续搜索。
6. 确保每个批次开始前检查剩余任务预算，尽量避免软预算结束后再启动昂贵工作。

验收：使用 fake timers 固化悬挂 query、timeline 准备与 history 请求场景；超过约定上限后 UI 离开 loading。验证停止/继续后的合法恢复、旧请求迟到无污染、共享任务无双重提交。不要只测“停止之后旧请求最终 resolve”的顺利场景。

### A3（验收阻塞）：下载裁切与真实文件首屏仍缺浏览器证据

`RoomMediaSearchTile.real.test.tsx` 确实使用真实 body，但运行在 happy-dom，仅断言 Download 文本找到且有可点击祖先。它不计算真实布局，没有验证控件可见矩形、200% 缩放或实际下载成功。

这不意味着已经证明当前单列仍有裁切；结论是**尚未证明用户投诉已解决**。共享组件 Chromium 测试和 Worker 浏览器测试也不能替代实际 FilePanel 与媒体 body 的组合验证。

补充第 6.2–6.3 节的实际证据，至少：

- 开发 StrictMode 下搜索真实消息并跳转。
- 真实面板 + Worker/IndexedDB，前 4 个历史页无附件、第 5 页命中，预算内零点击展示。
- 面板 320/400/600 CSS px，100%/150%/200% 缩放，图片与视频真实下载控件无裁切，点击产生正确下载。
- 加密附件、隐藏预览、失败回退和长名称/译文。
- 截图实际查看，不仅生成文件；按仓库规定环境管理基线。

若环境不能提供登录态或媒体服务，明确列为未验证，不能宣布全面通过。完成 A1/A2 不要求扩大 UI 功能，A3 只做验收所需测试和发现问题的局部修复。

### 8.2 下一轮交付口径

只补修 A1–A3，不重做已通过的 StrictMode 主路径、数据库迁移或整套媒体组件。提交三个遗漏场景的正式回归与浏览器证据后再复审。保持数据不清空、旧功能不回退、错误不吞掉的边界。

### 8.3 A1–A3 补修后复审：加密实时编辑仍需修正

本次重新审核完整工作区，没有修改产品代码。结论：**暂不通过，但仅剩局部修正和验收补充，不要求重做 A1–A3。**

#### 已验证的改善

- 普通附件的匹配→不匹配→再匹配、乱序编辑、撤回编辑恢复、pending 页与缓存页签已有正式回归。
- 悬挂操作有有限等待；超时退出 loading，保留结果并提示等待/重新加载。旧操作未完成时继续不再伪装为新的查询，也不并发重复回溯。
- 已重新运行真实面板 E2E：跨四个空历史页自动找到第五页文件、消息搜索与跳转、加密图片下载、隐藏预览、图片/视频失败回退、长文件名、320/400/600 CSS px 面板内图片/视频下载，**8 个通过**。
- 已查看本次生成的 320 和 600 px 面板截图：图片和视频下载按钮完整，没有原先方格裁切。
- 相关单测 **203 通过、2 跳过**；Chromium Worker 测试 **6 通过**；Web TypeScript 与 `git diff --check` 通过。

#### B1（P1，已实测）：加密实时附件编辑后消失

位置：`apps/web/src/search/RoomFileSearchSession.ts` 的 `project()`，当前约第 273 行：

```ts
new MatrixEvent({ ...original.event, content: latest.content });
```

SDK 已解密事件的 `.event.type` 仍是 wire 类型 `m.room.encrypted`，明文类型位于 `clearEvent`，由 `getType()` 返回。展开 `.event` 不复制解密状态，因此新的投影对象被当作 `m.room.encrypted`，在 `matchesRoomFileSearchEvent()` 的消息类型检查中被排除。

用真实 SDK MatrixEvent 和 `makeEncrypted()` 保留明文状态构造临时回归，实际得到：

```text
原附件：report.pdf，getType()=m.room.message，event.type=m.room.encrypted
live add → 结果数 1
有效编辑：report-new.pdf，仍匹配 report
预期结果：[report-new.pdf]
实际结果：[]
撤回该编辑 → 原 report.pdf 恢复
```

临时测试已删除，输出保存在 `/tmp/review-a123-encrypted-edit.log`；这些 `/tmp` 路径是本机复审证据，不是持久交付物。已有加密图片下载 E2E 没有编辑步骤，不能覆盖此问题。

限定修法：使用 SDK 有效事件接口或明确正确的明文投影，避免复制 wire 事件后丢失解密后的类型与内容。核对原事件 ID、房间、作者、时间以及媒体解密参数仍保留；不改数据库 schema，不新增框架。

正式验收：

1. 已解密的 live 原附件 + 已解密有效编辑，仍匹配时显示最新名称。
2. 在加密事件形态下重复匹配→不匹配→再匹配、乱序编辑及撤回编辑恢复。
3. pending 页和非活跃页签至少各一条等价回归。
4. 编辑后跳转仍指向原事件，加密媒体下载所需信息不丢失。

#### B2（验收缺口）：补真实页面缩放，不能用设备像素比例代替

`apps/web/playwright/e2e/right-panel/file-panel.spec.ts:357` 的窄面板测试只调整 viewport 和面板宽度，没有改变浏览器页面缩放。现有 `/tmp/a3-device-scale.log` 记录的设备比例测试不等价于页面 150%/200% 缩放，且该用例不在当前文件中。

这不是已复现的裁切回归；结论是第 8 节要求的缩放矩阵尚无足够证据。补真实页面缩放下的图片/视频按钮可见性、点击与下载验证，保存截图并查看。面板宽度断言应同时校验上下界，避免测试实际宽度更大却也通过；下载验证宜检查 `download.failure()` 或文件内容，不只比对文件名。

本次 E2E 输出：`/tmp/review-a123-e2e.log`；测试产物：`/tmp/review-a123-e2e-results`。下一轮只处理 B1、B2，保留已有普通编辑、超时恢复和真实面板通过证据。

### 8.4 B1/B2 后续实现记录：已修正 B1，补充专用缩放验收

本轮没有扩大搜索架构，改动限定在索引边界、Session 投影和浏览器验收：

#### B1：加密附件投影

- `EventIndex.mapFileEvents()` 现在用索引显示事件的 `getType()` 规范化 `original_event` 的 clear type；不再把当前显示投影当作原件内容。
- `IEventAndProfile.original_event` 的契约明确要求由 `eventToJson(getEffectiveEvent())` 提供未编辑、可搜索的 clear attachment content。这样 raw type 可以是 `m.room.encrypted`，但 `msgtype`、`file.url`、`file.key`、`iv`、`hashes` 必须来自原件 clear content。
- `RoomFileSearchSession.makeProjectedEvent()` 只在 Session 内构造有效投影，保留 clear type；编辑内容缺少 `file`、`info` 或 `url` 时，从原件补齐这些媒体字段，但不复用原件的 `body`/`filename` 覆盖编辑查询条件。
- 正式回归覆盖真实 SDK 解密事件、编辑匹配、迟到旧编辑、编辑撤回、原件撤回、索引页和缓存刷新失败/成功；加密投影还通过 `MediaEventHelper` 的实际下载/解密链路验证。

#### B2：页面缩放证据边界

- 普通 `Chrome` 项目不会加载扩展。普通 Playwright headless 的 `page.keyboard` 不会触发浏览器 UI 缩放，因此不能把普通 Chrome 运行误报为页面缩放证据。
- 新增隔离的 `ChromeZoom` 项目和 `playwright/page-zoom-extension/`，扩展只调用真实 `chrome.tabs.setZoom`；测试仍通过 `ControlOrMeta+0` / `ControlOrMeta+Shift+Equal` 驱动，并只断言真实 `document.documentElement.clientWidth` 逐档下降、面板内边界、实际下载内容。测试标签 `100/150/200` 表示验收档位，不假设各平台快捷键恰好按 25% 递增。
- `ChromeZoom` 使用专用 persistent context；复制项目的 context 选项，仍运行仓库既有 page/config/user fixtures，并在测试中校验浏览器内 Matrix client 的用户 ID 等于 fixture 用户。它是**专用重建 context 的缩放证据**，不是普通 `Chrome` context 的完全等价证据；若验收要求严格同一启动链路，仍需在 harness 层提供原生扩展加载能力。
- `PW_TEST_CONNECT_WS_ENDPOINT` 下明确跳过 ChromeZoom 缩放用例，因为远程连接不能加载本地扩展。
- 预览失败测试只验证下载入口可见且点击不抛错；不存在的 MXC 资源不声称产生成功下载。真实可下载资源的下载文件内容仍由加密下载、隐藏预览、长文件名和窄面板测试验证。

本轮最终验证：相关 Vitest **18 个文件、201 个测试通过**；Chromium Worker **6 个通过**；普通 Chrome 真实面板回归 **8 个通过**；专用 ChromeZoom 缩放回归 **2 个通过**；Web TypeScript、改动文件 oxlint/oxfmt、`git diff --check` 通过。

### 8.5 Luna 修改后独立复审：B1 通过，B2 仅剩验收工具修正

本次重跑：相关单测 **207 通过、2 跳过**，Chromium Worker **6 通过**，普通 Chrome 面板 E2E **8 通过**，ChromeZoom **2 通过**，Web TypeScript 通过。B1 加密实时投影的原阻塞已修复；本次没有发现新的搜索功能阻塞，不要求继续改动产品代码。

但亲自查看本次生成的缩放截图后，B2 不能完整通过：

1. `/tmp/element-search-panel-image-zoom-100.png` 是正确的 Files/Media 面板；`image-zoom-150.png`、`image-zoom-200.png`、`video-zoom-200.png` 却是页面顶部搜索框及 Rooms/Mentions，完全没有媒体或下载按钮。这些图片不能用作缩放后下载区无裁切的视觉证据。原因可能是真实浏览器缩放下 locator screenshot 的坐标换算，尚未证实；不能反过来据此声称产品发生裁切。
2. 扩展 `page-zoom-extension/background.js` 自行定义 `[1, 1.25, 1.5, 1.75, 2]`，而 `verifyZoomedDownload()` 用 3 次 increase 表示 150，实际对应 175%。这不是平台快捷键档位差异。当前只断言 viewport 变小，也不校验实际达到目标倍率。

限定收尾：

- 扩展提供 set/get zoom 的完成确认，测试等待 `chrome.tabs.getZoom` 或等价确认返回 1、1.5、2。若继续使用快捷键，依扩展自身档位调整次数，并仍读回实际比例，避免异步消息未完成就断言。
- 修正缩放截图取景。可先截完整 viewport，再按实际图像坐标保存/标注目标区域；不要继续把错误 locator 截图当成面板截图。
- 重新查看图片和视频在真实 150%/200% 下的面板、下载按钮截图，保留现有点击和实际下载内容验证。
- 保留专用 context 的证据边界说明；本次没有要求将整个 Playwright harness 重构为同一启动链路。

本轮日志：`/tmp/review-luna-unit.log`、`/tmp/review-luna-worker.log`、`/tmp/review-luna-e2e.log`、`/tmp/review-luna-zoom.log`；产物 `/tmp/review-luna-zoom-results`。这些是本机复审证据，不是持久交付路径。只需修正 B2 测试与产物，不重做已通过的 B1。
