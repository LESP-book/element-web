# 2026-09-24 上游同步记录

- 当前分支：`develop`；合并前 `dd284e9f6e`，保护分支 `backup-pre-upstream-merge-2026-09-24`。
- 目标：官方 `upstream/develop` 的 `49d715c1e9`；共同基线 `5efdc33502`。共同基线后上游 163 个提交、本地 21 个提交。
- 合并策略：`--no-ff`，不推送；以官方更新为基础，保留未被官方替代的定制行为。原有部署配置文件不纳入 Git。

## 取舍

- 保留本地浏览器索引 Worker、搜索/文件面板、按需回溯、房间列表窄侧栏、自托管 Element Call 等定制。官方的 tokenizer 模式和新时间线等改动正常并入；Web Worker 索引仍沿用本地实现，其 tokenizer 行为与原生索引不同。
- `.gitignore` 合并了本地开发目录忽略规则与官方 `.vitest` 规则。
- `RoomSearchView` 继续使用本地搜索结果和回溯加载提示；官方冲突块中的 `permalinkCreators` 属于已被本地结果视图替换的旧渲染流程，不可孤立插入。
- Element Call URL 仍按开发者设置、`element_call.url`、内置包的顺序选择；仅内置包回退地址采用官方修复的 `./widgets/element-call/` 目录，外部部署仍走 `/room` 路由。
- 修复 `RoomView` 中沿用旧结果“编辑”按钮和旧搜索占位符的测试，改为验证本地结果跳转和带初始文本发起搜索；增加三种通话 URL 优先级/路由断言。

## 验证

- `pnpm install --frozen-lockfile` 通过；SDK 依赖需要 pnpm 12.3.4，本机 Corepack 误调用其不存在的 `.cjs` 入口，安装时仅在 `/tmp/element-upstream-pnpm-bin` 使用指向现有 `.mjs` 的临时启动脚本，没有修改锁文件。
- `nx run-many -t test:unit:prepare -p`、`nx run element-web:lint:types`、`nx run element-web:build` 通过；构建有上游资源体积、maplibre 和内置 Element Call CSS 压缩警告。
- 搜索、索引、通话的 4 个 Vitest 文件 80/80 通过；房间、文件、Widget、搜索提示和侧栏的 8 个 Vitest 文件 182/182 通过（共 262 项）。侧栏的 Chromium headless shell 已按锁定的 Playwright 版本装入用户缓存。
- 冲突相关文件的 Oxfmt / Oxlint 及合并冲突标记检查通过。未运行登录态端到端、真实服务器检索或实际音视频通话。
