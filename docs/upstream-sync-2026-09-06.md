# 2026-09-06 上游同步记录

## 范围与状态

- 工作分支：`develop`。
- 合并前：`79913d8463`；保护分支：`codex/backup-develop-pre-upstream-20260906-79913d8`。
- 上次共同基线：`a73f8c389b`（2026-08-08）。
- 本次目标：`5efdc335023d8538425c656b97cddb7213c5c7f3`（2026-09-04），来自官方 `upstream/develop`，新增 213 个提交。
- 合并结果暂存，未提交、未推送。`new-cloudflare-pages` 保持原提交。
- 实际本地配置保留为被忽略的 `apps/web/config.json`，未纳入提交。

## 官方新增功能

### v1.12.26（2026-08-18）

- 自定义用户状态，显示和清除自己的通话状态。
- Widget 的 RTC 服务发现。
- 注册限流提示。
- 包含模块的 Docker 镜像。
- 时间线共享组件与视图模型迁移。

来源：[官方发布说明](https://github.com/element-hq/element-web/releases/tag/v1.12.26)。发布说明中已经包含在上次共同基线里的功能，例如分组展开状态持久化，不重复计入本次新增。

### v1.12.27（2026-09-01）

- 输入框链接预览改版及 URL 预览协议更新。
- 创建、编辑房间分组时选择房间。
- 可将房间活动视为未读。
- 敲门请求通知。
- 菜单直接设置用户状态，状态表情选择器支持最近使用的表情。
- 自定义主题从实验功能移到开发工具。
- 用户验证 CA 模块接口。
- 左侧分隔条的提示与光标交互改进。

来源：[官方发布说明](https://github.com/element-hq/element-web/releases/tag/v1.12.27)。

### 稳定版之后的 develop

- 默认联系人分组（#34713）。
- 拖动房间时折叠分组（#34290）。
- 时间线用户标签显示状态（#34832）。
- 刚上传的图片直接复用，避免再次下载（#34753）。
- 多位数字角标（#33637）。
- 提示公开房间也向组织外用户开放（#34876）。

上述条目来自本次已拉取的官方提交记录。自定义用户状态仍受实验开关与服务器协议支持约束；URL 预览包也有实验开关，不代表所有新功能默认开启。

## 合并决策

- 保留浏览器 IndexedDB/Worker 本地索引、索引年龄配置及控制器。
- 保留文件/媒体分类、文件名搜索、房间/全局搜索、摘要、分页和跳转。
- 保留自托管 Element Call 配置 URL、hash 参数和终止事件授权。
- 保留 68px 窄房间列表、头像未读角标、分隔条层级修复、循环依赖规避和 Webpack fallback。
- 搜索取消采用官方 `AbortError` 处理；搜索结果接入官方 `EventPresentationContextProvider`。
- 文件面板采用官方共享消息组件，移除其替代的旧消息样式，同时保留本地分类、搜索、分组、滚动和跳转样式。该样式冲突通过 Antigravity CLI 解决并独立复核。
- RTC 发现接口与参数签名采用官方实现。
- 测试跟随官方迁移到 Vitest 和新文件位置，保留本地行为断言。跳转测试隔离全局 dispatcher，避免测试触发真实房间切换。
- 不额外升级依赖：通过 `pnpm install --frozen-lockfile` 安装官方锁定版本，依赖清单和锁文件与目标上游一致。

## 验证

- 生产构建 `pnpm --dir apps/web build` 通过；存在 5 条 CSS/资源体积/构建性能警告。
- 12 个相关测试文件共 214 项通过：LoggedInView 21、RoomSearchView 10、FilePanel 2、SearchResultTile 2、EventIndex 2、Call 61、CallStore 3、ElementWidgetDriver 46、WidgetMessaging 24、RoomListItemView 22、SearchWarning 17、RoomSearchAuxPanel 4。
- 主代理独立复测搜索、文件面板、搜索提示、搜索辅助面板、搜索跳转及侧栏；子代理执行其余目标验证。每次单元测试命令受项目要求的 60 秒执行上限约束，此限制未加入产品代码。
- 冲突源文件与迁移测试的 Oxlint、Oxfmt，以及 FilePanel Stylelint 检查通过。
- 相对上游的差异空白检查通过，无未解决的 Git 冲突。
- 英文、简体中文、繁体中文及示例配置 JSON 解析通过。
- 生成的 Jitsi 页面包含真实 SVG，不含旧组件源码字符串。
- 浏览器检查：生产包欢迎页及登录入口正常显示；未登录账号，未验证真实房间搜索和端到端通话。

### 类型检查边界

`apps/web` 下 `tsc --noEmit` 未通过，共 7 条错误，均位于官方锁定的 `matrix-js-sdk` 源码：

- `embedded.ts`：4 条，RTC LiveKit 的 `MSC4533` 能力与 Widget API 方法类型不匹配。
- `rendezvous/MSC4108SignInWithQR.ts`：3 条，二维码登录载荷类型错误。

未通过屏蔽错误、修改第三方源码或额外刷新依赖来规避检查。生产构建和上述目标测试成功不等于全量类型检查或登录态端到端测试通过。

侧栏浏览器单测还输出了嵌套 button 的 React 警告，断言通过；本次未扩大范围重构该交互。
