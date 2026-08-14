<p align="center">
  <img src="apps/desktop/src-tauri/icons/icon.png" width="128" alt="AgentKib app icon" />
</p>

<h1 align="center">AgentKib</h1>

<p align="center"><strong>Keep every coding agent working from the same local source of truth.</strong></p>

<p align="center">
  <a href="#english">English</a> · <a href="#简体中文">简体中文</a>
</p>

<p align="center">
  <img alt="Status: Development Preview" src="https://img.shields.io/badge/status-development_preview-f59e0b" />
  <img alt="Platform: macOS first" src="https://img.shields.io/badge/platform-macOS_first-111827" />
  <img alt="Data: Local first" src="https://img.shields.io/badge/data-local_first-16a34a" />
</p>

> [!WARNING]
> AgentKib is still a development preview. There is no official downloadable build yet; macOS users can build it from source today.

## English

AgentKib is a local-first desktop app for people who use more than one coding agent. It brings scattered project instructions, Skills, MCP connections, reusable memory, and activity into one place—without requiring an account, cloud database, or model API.

**KIB** stands for **Knowledge & Instruction Base**.

### What AgentKib helps you do

- **Find your workspaces automatically.** AgentKib reads workspace paths from supported agents and folders you explicitly authorize. It does not scan your entire disk.
- **See all agent assets in one catalog.** Browse project instructions, Skills, MCP connections, hooks, profiles, configurations, and approved memory across workspaces.
- **Understand what an agent will receive.** Preview instruction loading order, directory rules, overrides, available Skills, connections, and memory for a selected working directory.
- **Share project rules safely.** Edit common assets once, review the generated diff, and write only after explicit approval. A project does not need an AgentKib manifest before it can be discovered or inspected.
- **Use one local MCP entry point.** AgentKib can manage downstream MCP servers and expose them to supported agents through one local hub.
- **Track your progress.** View locally available Token usage, sessions, Git commits, contribution heatmaps, streaks, and achievements. Incomplete data is always labeled as incomplete.

AgentKib can also link a workspace to an Obsidian Vault and read public metadata from optional OpenClaw or Hermes remote connections. These integrations are opt-in and read-only by default.

On macOS, AgentKib can stay active in the menu bar after its window is hidden. It supports light, dark, and system appearance, plus Simplified Chinese, Traditional Chinese, Japanese, and English.

### Supported agents

- Codex
- Claude Code
- Cursor
- OpenClaw
- Hermes

AgentKib distinguishes an installed app or CLI from leftover configuration. Existing Agent Home assets can still be inventoried read-only without incorrectly marking the agent as installed.

### Typical workflow

1. Open AgentKib. Workspace discovery starts automatically; no folder selection is required.
2. Use **Workspaces**, **Assets**, and **Agents** to inspect what already exists.
3. Open a workspace to review its assets and effective context.
4. Edit shared instructions, Skills, or MCP settings when needed.
5. Review the complete diff before AgentKib changes any project or Agent Home file.

Ignored workspaces, additional scan folders, integrations, appearance, language, and local data controls are available in **Settings**.

### Local and private by default

- No account, subscription, cloud sync, or remote database is required.
- Automatic discovery does not store prompts, message bodies, conversation titles, or raw session IDs.
- Credentials, environment files, private keys, and message databases are excluded from the asset catalog.
- Git statistics do not store commit messages, diffs, file contents, or plaintext email addresses.
- Agent-proposed memory is not shared until you approve it.
- Every generated file change is shown as a diff and checked again before writing.

### Try it

The [Releases page](https://github.com/starroyhq/agentkib/releases) is reserved for future preview builds. Until then, use the [build instructions](#build-from-source) below.

---

## 简体中文

AgentKib 是一个面向多 Agent 用户的本地桌面应用。它把散落在不同项目、不同 Agent 目录中的项目指令、Skills、MCP 连接、共享记忆和使用记录集中到一个地方，不需要账号、云端数据库或模型 API。

**KIB** 代表 **Knowledge & Instruction Base（知识与指令底座）**。

### AgentKib 能帮你做什么

- **自动找到工作区**：从受支持 Agent 的本地记录和你明确授权的目录中发现项目，不会默认扫描整块磁盘。
- **统一查看 Agent 资产**：跨工作区浏览项目指令、Skills、MCP、Hooks、Profiles、配置和已批准记忆。
- **看清 Agent 实际获得的上下文**：预览指令加载顺序、目录规则、平台覆盖，以及当前可见的 Skills、连接和记忆。
- **安全共享项目规则**：公共资产只维护一次，写入前必须审查完整 Diff。项目不需要预先创建 AgentKib manifest，也能被发现和查看。
- **统一连接 MCP**：通过一个本地 MCP Hub 管理下游 Server，并提供给受支持的 Agent 使用。
- **记录使用成就**：汇总本地可获得的 Token、会话和 Git 提交，展示贡献热力图、连续活跃和成就；数据不完整时会明确标注。

AgentKib 还可以将工作区关联到 Obsidian Vault，并按需只读连接 OpenClaw 或 Hermes 的远程元数据。这些能力默认不会主动启用或写入外部内容。

在 macOS 上，窗口隐藏后 AgentKib 可以继续常驻菜单栏。界面支持浅色、深色和跟随系统，并提供简体中文、繁體中文、日语和英语。

### 支持的 Agent

- Codex
- Claude Code
- Cursor
- OpenClaw
- Hermes

AgentKib 会区分“实际安装的应用或 CLI”和“卸载后留下的配置”。即使只剩 Agent Home 资产，也可以继续只读盘点，但不会被错误标记为已安装。

### 常见使用流程

1. 打开 AgentKib，应用会自动开始发现工作区，不要求先选择文件夹。
2. 在**工作区**、**资产**和 **Agent** 页面查看已有内容。
3. 进入某个工作区，检查项目资产和有效上下文。
4. 需要统一规则时，再编辑共享 Instructions、Skills 或 MCP 设置。
5. AgentKib 修改任何项目文件或 Agent Home 文件前，都必须先由你审查完整 Diff。

忽略的工作区、补充扫描目录、集成、主题、语言和本地数据控制均可在**设置**中管理。

### 默认本地、默认私密

- 不需要账号、订阅、云同步或远程数据库。
- 自动发现不会保存 Prompt、消息正文、对话标题或原始会话 ID。
- 凭据、环境文件、私钥和消息数据库不会进入资产目录。
- Git 统计不保存提交说明、Diff、文件内容或明文邮箱。
- Agent 提议的记忆必须由你批准后才能共享。
- 所有生成的文件修改都会先展示 Diff，并在写入前再次校验。

### 体验方式

[Releases 页面](https://github.com/starroyhq/agentkib/releases)将用于后续预览版本发布。目前请按照下方[源码构建说明](#build-from-source)运行。

---

## Build from source

### Requirements / 环境要求

- macOS（当前主要验收平台）
- Xcode Command Line Tools
- Rust stable toolchain
- Node.js
- pnpm 10（仓库固定使用 `pnpm@10.8.1`）

### Run locally / 本地运行

```bash
pnpm install
pnpm dev
```

首次 Rust 编译可能需要较长时间。

### Build the macOS app / 构建 macOS 应用

```bash
pnpm tauri build
```

构建结果位于 `target/release/bundle/`。

### Validate / 验证

```bash
cargo fmt --all -- --check
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
pnpm test
pnpm typecheck
pnpm build
```

## Project status / 项目状态

- AgentKib is under active development; interfaces and local data formats may still change before the first release.
- macOS is the current acceptance platform. Other platforms are not yet release targets.
- Focused issues and pull requests are welcome.

- AgentKib 正在持续开发，首次发布前接口和本地数据格式仍可能变化。
- 当前以 macOS 为主要验收平台，其他平台暂未作为发布目标。
- 欢迎提交聚焦的问题反馈和 Pull Request。
