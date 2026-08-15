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
  <img alt="Platform: macOS, Windows and Linux" src="https://img.shields.io/badge/platform-macOS_%7C_Windows_%7C_Linux-111827" />
  <img alt="Data: Local first" src="https://img.shields.io/badge/data-local_first-16a34a" />
</p>

> [!WARNING]
> AgentKib is still a development preview. There is no official downloadable build yet; the current source-build targets are macOS, Windows 11, Ubuntu, and Fedora.

## English

AgentKib is a local-first desktop app for people who use more than one coding agent. It brings scattered project instructions, Skills, MCP connections, reusable memory, and activity into one place—without requiring an account, cloud database, or model API.

**KIB** stands for **Knowledge & Instruction Base**.

### What AgentKib helps you do

- **Find your workspaces automatically.** AgentKib reads workspace paths from supported agents and folders you explicitly authorize. It does not scan your entire disk.
- **See all agent assets in one catalog.** Browse project instructions, Skills, MCP connections, hooks, profiles, configurations, and approved memory across workspaces.
- **Understand what an agent will receive.** Preview instruction loading order, directory rules, overrides, available Skills, connections, and memory for a selected working directory.
- **Share project rules safely.** Edit common assets once, review the generated diff, and write only after explicit approval. A project does not need an AgentKib manifest before it can be discovered or inspected.
- **Use one local MCP entry point.** AgentKib can manage downstream MCP servers and expose them to supported agents through one local hub.
- **Watch rolling plan limits.** See available Codex, Claude Code, Cursor, and configured Coding Plan windows, including remaining quota and reset time. macOS also provides a menu bar popover; Windows and Linux use the app and native tray menu.
- **Track your progress.** View locally available Token usage, sessions, Git commits, contribution heatmaps, streaks, and achievements. Incomplete data is always labeled as incomplete.

AgentKib can also link a workspace to an Obsidian Vault and read public metadata from optional OpenClaw or Hermes remote connections. These integrations are opt-in and read-only by default.

AgentKib can stay active from the system tray after its window is hidden. On Linux desktops without AppIndicator support it keeps the window reachable instead of hiding it completely. It supports light, dark, and system appearance, plus Simplified Chinese, Traditional Chinese, Japanese, and English.

### Supported agents

- Codex
- Claude Code
- Cursor
- OpenClaw
- Hermes
- DeepSeek Harness (Beta, read-only)

AgentKib distinguishes an installed app or CLI from leftover configuration. Existing Agent Home assets can still be inventoried read-only without incorrectly marking the agent as installed.
DeepSeek Harness support currently covers local workspace discovery, asset inventory, context preview, and cumulative Token usage; shared writes and MCP setup remain disabled while its storage contracts are in Beta.

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
- Quota snapshots stay on this device. Account email is kept only to identify local accounts; credentials, cookies, raw CLI output, and raw diagnostics are not stored.
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
- **查看滚动额度**：可查看 Codex、Claude Code、Cursor 及已配置 Coding Plan 的剩余额度和重置时间。macOS 还提供菜单栏面板，Windows 和 Linux 通过应用和系统托盘访问。
- **记录使用成就**：汇总本地可获得的 Token、会话和 Git 提交，展示贡献热力图、连续活跃和成就；数据不完整时会明确标注。

AgentKib 还可以将工作区关联到 Obsidian Vault，并按需只读连接 OpenClaw 或 Hermes 的远程元数据。这些能力默认不会主动启用或写入外部内容。

窗口隐藏后，AgentKib 可以继续在系统托盘运行。Linux 桌面缺少 AppIndicator 支持时，应用会保留可访问的窗口而不是彻底隐藏。界面支持浅色、深色和跟随系统，并提供简体中文、繁體中文、日语和英语。

### 支持的 Agent

- Codex
- Claude Code
- Cursor
- OpenClaw
- Hermes
- DeepSeek Harness（Beta，只读）

AgentKib 会区分“实际安装的应用或 CLI”和“卸载后留下的配置”。即使只剩 Agent Home 资产，也可以继续只读盘点，但不会被错误标记为已安装。
DeepSeek Harness 当前支持本地工作区发现、资产盘点、上下文预览和累计 Token 用量；在其存储协议仍处于 Beta 期间，不会写入共享配置或接入 MCP。

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
- 额度快照只保存在本机。账号邮箱仅用于区分本地账号；凭据、Cookie、CLI 原始输出和原始诊断不会落库。
- Agent 提议的记忆必须由你批准后才能共享。
- 所有生成的文件修改都会先展示 Diff，并在写入前再次校验。

### 体验方式

[Releases 页面](https://github.com/starroyhq/agentkib/releases)将用于后续预览版本发布。目前请按照下方[源码构建说明](#build-from-source)运行。

---

## Build from source

### Requirements / 环境要求

- macOS 13+、Windows 11、Ubuntu 22.04+ 或近期 Fedora
- macOS：Xcode Command Line Tools
- Windows：Visual Studio Build Tools 2022（MSVC 与 Windows SDK）
- Linux：GTK 3、WebKitGTK 4.1、AppIndicator、librsvg、libxdo、`gdbus` 和对应的 C/C++ 构建工具
- Rust stable toolchain
- Node.js
- pnpm 10（仓库固定使用 `pnpm@10.8.1`）

### Run locally / 本地运行

```bash
pnpm install
pnpm dev
```

首次 Rust 编译可能需要较长时间。

Linux 用户可以先运行只读环境诊断；脚本只检查依赖和桌面能力，不会调用 `sudo`：

```bash
apps/desktop/scripts/diagnose-linux.sh
```

### Build the desktop app / 构建桌面应用

```bash
pnpm tauri build
```

Linux 打包请使用下列入口；它会规范化构建权限，避免严格 `umask` 生成只能由构建用户执行的安装包：

```bash
apps/desktop/scripts/build-linux-bundles.sh
```

首次构建会下载并校验对应平台固定版本的额度 Collector；Linux 使用官方 CodexBarCLI 0.49.5 静态 musl 产物，Windows x64 从经校验的 Win-CodexBar 发布源码编译 CLI，均不会执行第三方安装器。构建结果位于 `target/release/bundle/`。Windows x64 生成 NSIS 安装包；Ubuntu/Fedora 可生成 `.deb`、`.rpm` 和 AppImage。Windows ARM64 当前作为预览架构，额度 Collector 暂不可用；Linux ARM64 包同样标记为 Preview，因为当前原生 CI 使用 Ubuntu 24.04，尚未满足正式 AppImage 的 Ubuntu 22.04 构建基线。第三方许可见 `THIRD_PARTY_NOTICES.md`。

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
- macOS remains the primary acceptance platform. Windows 11 x64 and Linux x86_64 are release build targets; Windows ARM64 and Linux ARM64 are preview targets, with Linux ARM64 built on a native runner.
- Focused issues and pull requests are welcome.

- AgentKib 正在持续开发，首次发布前接口和本地数据格式仍可能变化。
- macOS 仍是主要验收平台；Windows 11 x64 与 Linux x86_64 是发布构建目标；Windows ARM64 与 Linux ARM64 为预览目标，其中 Linux ARM64 使用原生 CI Runner 构建。
- 欢迎提交聚焦的问题反馈和 Pull Request。
