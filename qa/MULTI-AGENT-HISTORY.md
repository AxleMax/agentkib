# 多 Agent 发现与只读历史验收

## 范围（2026-09-08）

- 发现来源诊断、支持层级与刷新状态。
- OpenClaw、Hermes、Grok Build 只读目录、正文和有界分页；OpenCode 发现兼容。
- 不新增发送、审批、恢复、导出或控制能力，不运行真实 Agent 请求。
- 保留现有设计与无关改动；本轮不提交、不发布。

## 证据层级

测试结果分别记录为代码检查、隔离数据、合成 UI 和真实记录，不能相互替代。

### 本机来源检查

- Claude 测试目录 `/Users/kouzen/Documents/data/test/CLAUDE.md` 已存在；此前已确认原生历史登记及 AgentKib 工作区记录。
- OpenCode 本机数据库存在，按只读查询包含 3 条会话；后续只读验收不得启动会话。
- OpenClaw 配置目录存在，但本次检查未发现 `agents/*/sessions` 历史文件。
- 本机未发现默认 Hermes、Grok 配置目录；它们不能宣称真实记录验收通过。

## 最终自动化结果

实现与自动化验证完成，完整图形／真实新来源验收未完成。未创建 commit、PR 或发布。

- `cargo test --workspace --quiet`：最终全工作区通过；其中 conversations 91 项、discovery 30 项、store 41 项。
- `cargo clippy --workspace --all-targets -- -D warnings`：通过。
- `cargo fmt --all -- --check`：通过。
- `pnpm test`：桌面 81 个文件、557 项通过；Web 22 项通过。
- `pnpm typecheck`：桌面、Web 通过。
- `pnpm build`：release runtime、资源 staging、Web、桌面 renderer、Electron main/preload 全链通过；未制作或发布新安装包。
- 协议生成一致性：通过，版本 15。
- 本次修改的 21 个前端源文件 `oxfmt --check`：通过。
- `pnpm format:check`：仍有 4 个**未修改、与 HEAD 一致**的既有文件不符合格式：`activity-presentation.ts`、`RemoteErrorDetails.tsx`、`RemoteErrorDetails.test.tsx`、`styles.css`。没有为此扩大格式化范围。
- `git diff --check`：通过。

### 隔离 runtime 的真实发现验证

使用 `/tmp/agentkib-discovery-qa.0SrLXP` 独立数据目录及仅本机端口 47659，通过正常 runtime RPC 握手、刷新、读取报告与能力信息，不修改用户的 AgentKib 数据库、不发送 Agent 请求。

- 协议版本 15；发现 38 个工作区，包含 `/Users/kouzen/Documents/data/test`。
- Codex、Claude、OpenCode 的本机来源成功；OpenCode SQLite 与旧 JSON 分别报告。
- OpenClaw 配置有结果、JSONL 来源缺失；Hermes 与 Grok 默认历史来源缺失，未误报为已读到历史。
- 三个新增历史来源声明 `history_read=true`、`continuation=false`、`control=none`。
- 来源纳入数／跳过数不能准确归因时为未知，不把候选数当成最终纳入数。
- 测试 runtime 已退出，47659 无残留监听。临时数据保留用于复核。

### 已修复的验收发现

- 统一折叠组件；新增只读来源的续接／导出入口；发现刷新与未扫描状态；原因码四语言翻译。
- 部分历史失败保留旧索引；嵌套目录统一归属并持久化原始 cwd；旧版本缺来源表的迁移兼容。
- Hermes DB／JSONL 去重与回填、严格游标／高水位锚点、未知角色跨页、超长字段边界；reasoning 带 assistant role 时仍不渲染。

### 未签收项

- OpenClaw、Hermes、Grok 的真实历史正文：本机没有可用记录，现为隔离 fixture 验证，不能替代真实来源验收。
- 新 runtime 的完整图形、多尺寸和深浅主题验收未完成。现有 Electron 仅完成 1215×768 浅色及旧运行时诊断降级的目视检查。
- `playwright-interactive` 所需 `js_repl` 不在本会话工具中；未改 Codex 配置。隔离 Electron 尝试遇到启动入口路径和测试端口残留问题，电脑工具仍定位原开发实例，未据此声明新界面通过；本次创建的隔离 Electron／runtime 已清理，原开发实例未退出。
- 当前用户打开的旧 runtime 不会因前端热更新自动获得新协议与诊断字段；需重启 AgentKib 后加载新 runtime。此轮没有替用户重启该实例。

## 过程记录

### 2026-09-08 审查／修复闭环复核

- 比较基点：`origin/main` 的合并基点 `34c65fe6d270b58e0ab5091a63472aa91b30b705`；包含当前未提交修复。未提交、未发布，未向真实 Agent 发送控制请求。
- 累计修复：Codex 空分叉字段回退；大 JSONL 有界头部发现；零候选时保留来源诊断；Hermes 浮点时间（发现及历史）、双来源归属、UTF-8 分页边界。
- 本轮新增发现并修复：远程目录校验遗漏 `open-claw`、`hermes`、`grok-build`，导致混合目录整体报 `REMOTE_INVALID_RESPONSE`。先复现失败，再补齐明确白名单及 Web 客户端类型；未知 Agent 仍拒绝，不扩大控制权限。
- 复审重点：上述修复及调用方、来源身份／工作区归属、索引到远程目录／正文读取、会话／搜索异步状态、只读能力边界。最终复审未发现新的明确可操作问题；这是代码审查结论，不是绝对无缺陷或真实设备全量验收声明。
- `cargo test --workspace`、`cargo clippy --workspace --all-targets -- -D warnings`：通过。
- `pnpm test`：桌面 81 个文件／559 项、Web 22 项通过。首次全量运行遇到新增回归测试的预期失败，修复后已全量重跑通过。
- `pnpm typecheck`、`pnpm build`（release runtime、Web、桌面 renderer、Electron main/preload）：通过。类型检查曾拦截修复中 OpenClaw 的拼写错误，已按实际 `open-claw` 协议值修正后重跑。
- `pnpm format:check`、`cargo fmt --all --check`、`git diff --check`：通过。此前报告的四个格式文件本轮仅做机械排版，已核对无语义改动。
- 正常构建执行协议生成后，`electron/generated/runtime-protocol.ts` 与 HEAD 无差异，协议仍为 15。
- 保留上文真实来源、真实设备、多尺寸、HTTPS 和安装包运行验收限制；本轮生产构建成功不等于安装包或真实跨设备验收通过。`design-qa.md` 等无关用户改动未覆盖。

实施中；以下为已执行检查，并非最终全量验收。

- `cargo test -p agentkib-platform --quiet`：31 项通过，包括新增父／嵌套项目与无标记 cwd 归属测试。
- `pnpm test:web`：22 项通过，包括三个新增只读 Agent 在浏览器有发送权限时仍不展示发送框。
- `pnpm --filter @agentkib/desktop exec vitest run electron/main/runtime-host.test.ts`：6 项通过。
- `pnpm typecheck`：桌面及 Web 通过（集成期间检查，最终需复跑）。
- 当前 Electron（旧 runtime、新前端热更新）手动检查：工作区列表显示 `test`；“查看发现详情”可进入发现设置，旧报告显示“当前运行时不提供详细来源诊断”。1215×768 浅色布局已目视检查。
- 新 runtime、其他尺寸、深色与新来源正文尚待最终验收。
- 集成中直接运行桌面 `vitest run`：537 项通过、1 项失败；新增诊断使用原生 `details` 违反项目交互组件约束，已交回 UI 补修，未削弱约束测试。
- `pnpm build:web`：通过。
- 对比 `cargo run --quiet -p agentkib-protocol --bin generate-typescript` 标准输出与已生成文件：完全一致，协议版本 15。
- `cargo check -p agentkib-runtime`：通过。
- `cargo test --workspace --quiet`：全量通过（集成中快照；并行后续补测完成后复跑受影响 crate）。
- `cargo clippy --workspace --all-targets -- -D warnings`：当前发现两项新代码 lint（嵌套 `format!`、相同分支），待修复后复跑。
