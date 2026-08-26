<p align="center">
  <img src="apps/desktop/src-tauri/assets/app-icon-white.png" width="128" alt="AgentKib" />
</p>

<h1 align="center">AgentKib</h1>

<p align="center"><strong>在一个本地桌面应用里，检查、同步和交接多个 Coding Agent 的项目上下文。</strong></p>

<p align="center">
  <a href="#简体中文">简体中文</a> · <a href="#english">English</a>
</p>

<p align="center">
  <a href="https://github.com/starroyhq/agentkib/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/starroyhq/agentkib/actions/workflows/ci.yml/badge.svg" /></a>
  <a href="https://github.com/starroyhq/agentkib/actions/workflows/windows-x64.yml"><img alt="Windows" src="https://github.com/starroyhq/agentkib/actions/workflows/windows-x64.yml/badge.svg" /></a>
  <a href="https://github.com/starroyhq/agentkib/actions/workflows/linux.yml"><img alt="Linux" src="https://github.com/starroyhq/agentkib/actions/workflows/linux.yml/badge.svg" /></a>
  <img alt="Development preview" src="https://img.shields.io/badge/status-development_preview-f59e0b" />
  <img alt="Local first" src="https://img.shields.io/badge/data-local_first-16a34a" />
</p>

> [!WARNING]
> AgentKib 仍处于开发预览阶段，[Releases](https://github.com/starroyhq/agentkib/releases) 提供的安装包尚未签名。本地数据格式和部分功能可能继续调整；macOS Gatekeeper 和 Windows SmartScreen 可能显示安全提醒。
> AgentKib is a development preview. Installers on [Releases](https://github.com/starroyhq/agentkib/releases) are currently unsigned, and local data formats and some features may still change. macOS Gatekeeper and Windows SmartScreen may show warnings.

## 简体中文

如果你在同一个项目里使用 Codex、Claude Code、Cursor 或其他 Coding Agent，项目规则和工具配置通常会散落在 `AGENTS.md`、`CLAUDE.md`、`.cursor/rules`、Skills 和多个 MCP 文件中。久而久之，不同 Agent 看到的内容会不一致，也很难判断哪些配置已经过期。

AgentKib 会读取本机已有的工作区和配置，让你在一个界面里完成三件事：

- **看清楚**：查看每个 Agent 在当前目录实际能读到哪些 Instructions、Skills 和 MCP。
- **安全同步**：先生成 ChangeSet 和完整 Diff，确认后再把公共配置写给不同 Agent。
- **继续工作**：把 Codex 或 Claude Code 的有效会话上下文脱敏后生成交接包；目标也是 Codex 或 Claude Code 时，还能打开一个不自动发消息的新会话。

基础的发现、诊断和同步不需要 AgentKib 账号、云端数据库或模型 API。**KIB** 代表 **Knowledge & Instruction Base（知识与指令底座）**。

### 它如何工作

```text
发现本机已有工作区
        ↓
预览上下文并诊断缺失、漂移或重复
        ↓
生成 ChangeSet 和完整 Diff
        ↓
你确认后，才写入项目或 Agent Home
```

浏览、预览和诊断本身不会创建 manifest，也不会修改 Agent 配置。工作区不需要提前准备 `.agentkib/manifest.yaml`；只有首次保存共享资产时，AgentKib 才会把 manifest 放进待确认的 ChangeSet。

| 名词 | 在 AgentKib 中的含义 |
| --- | --- |
| Instructions | 项目规则，例如 `AGENTS.md`、`CLAUDE.md` 和 Cursor Rules |
| Skills | 可以被 Agent 复用的任务说明与配套文件 |
| MCP | Agent 可以调用的本地工具或远程服务连接 |
| ChangeSet | 真正写文件之前，让你审查的一组变更及 Diff |

### 快速开始（开发预览）

需要 Rust stable、Node.js、pnpm 10，以及当前平台的 [Tauri 2 系统依赖](https://v2.tauri.app/start/prerequisites/)。macOS 需要 Xcode Command Line Tools；Windows 需要 Visual Studio Build Tools 2022 和 Windows SDK；Linux 需要 GTK 3、WebKitGTK 4.1、AppIndicator、librsvg 和 libxdo。

```bash
pnpm install
pnpm dev
```

启动后：

1. 等待 AgentKib 自动发现本机已有工作区，或手动添加扫描目录。
2. 打开工作区的“诊断”，检查不同 Agent 的 Instructions、Skills 和 MCP 状态。
3. 在“指令上下文”中确认某个 Agent 在指定目录实际可见的内容。
4. 需要统一配置时生成 ChangeSet，检查完整 Diff 后再应用。
5. 需要换 Agent 继续时，从 Codex 或 Claude Code 会话详情创建交接。

自动发现只读取已知 Agent 的本地配置和历史元数据，不会默认扫描整块磁盘。

### 主要能力

- **工作区与上下文**：发现已有项目，集中查看不同 Agent 的规则、Skills、MCP 和有效加载顺序。
- **诊断与同步**：找出缺失、漂移、无效或完全重复的配置，并在写入前展示 ChangeSet 和完整 Diff。
- **会话交接**：复用 Codex 或 Claude Code 的原生压缩上下文，排除工具与推理记录，生成脱敏、可编辑的 Markdown 或 JSON。
- **其他本地工具**：管理 MCP Server，只读浏览 Git，并查看额度、Token、活动热力图和成就；应用可在系统托盘继续运行，并可在设置中手动检查更新。

界面支持简体中文、繁體中文、日本語和 English，并提供浅色、深色与跟随系统主题。

### 支持的 Agent

| Agent | 发现与盘点 | 上下文诊断与同步 | 会话浏览与交接 |
| --- | --- | --- | --- |
| Codex | 支持 | 支持 | 支持 |
| Claude Code | 支持 | 支持 | 支持 |
| Cursor | 支持 | 支持 | — |
| OpenClaw | 支持 | 支持 | — |
| Hermes | 支持 | 支持 | — |
| DeepSeek Harness | Beta，只读 | 仅诊断，不写入 | — |

AgentKib 会区分“已安装”和“只发现了卸载后留下的本地数据”。涉及 Agent Home 的写入会单独请求授权；DeepSeek Harness 的存储协议仍处于 Beta，因此不会被写入或配置 MCP。

### 本地与隐私边界

- 不需要登录，也不提供 AgentKib 云同步；普通发现、诊断和交接不会调用模型或上传项目资产。
- 自动发现只保存路径、来源、数量和时间等聚合元数据，不保存 Prompt、消息正文、对话标题或原始 Session ID。
- 创建交接时按需读取本地会话，排除工具和推理内容并按内置规则遮盖常见敏感值；正文不写入 SQLite、日志或审计详情。
- 交接文件保存在项目的 `.agentkib/handoffs/`，该目录默认加入 `.gitignore`；保存前仍应检查完整 Diff。
- 只有交接内容超过安全上限且你明确确认时，才会把脱敏内容交给本机来源 Agent CLI 总结；这可能调用模型并消耗额度。
- 所有文件写入都检查路径边界和原始哈希，并经过 Diff、备份与写后验证。Agent Home 写入使用单独的高风险确认流程。

凭据、Cookie、Token、`.env`、私钥和消息数据库不会被收录为资产或写入日志。Git 统计不保存提交说明、Diff、文件内容或明文邮箱；额度快照只保存在本机。Agent 提议的记忆只有在用户批准后才会被其他 Agent 检索。

可选的 Obsidian、OpenClaw Remote Gateway 和 Hermes Remote Gateway 集成均需主动配置，并保持各自的权限边界。

### 平台状态

| 平台 | 状态 |
| --- | --- |
| macOS 13.3+（Apple Silicon / Intel） | 主要开发与验收平台 |
| Windows 11 x64（WebView2 111+） | PR 验证平台代码；发布工作流构建并烟测 NSIS |
| Ubuntu 22.04 x64（WebKitGTK 2.40+） | 核心 CI 平台；发布工作流构建并验证 `.deb` 与 AppImage |
| Fedora x64 | PR 验证平台代码；发布工作流构建并验证 `.rpm` |
| Windows ARM64 / Linux ARM64 | Preview；发布工作流生成并验证预览包 |

Windows 的完整环境、启动、打包和安装说明见 [Windows 指南](docs/WINDOWS.md)。维护者按 [桌面发布流程](docs/RELEASE.md) 推送版本标签后，CI 会构建、校验并发布未签名的多平台预览包；PR 和普通分支 push 只运行检查，不发布安装包。开发和验证命令见文末的[开发说明](#development)。

安装包与校验文件发布在 [Releases](https://github.com/starroyhq/agentkib/releases)，问题反馈请前往 [GitHub Issues](https://github.com/starroyhq/agentkib/issues)。首个包含更新器的版本仍需手动安装；之后 macOS、Windows 和 Linux AppImage 可在设置中检查并安装正式更新，Linux DEB/RPM 会打开 Release 页面交由系统包管理方式更新。

macOS 安装包目前尚未签名和公证。请先核对 Release 中的 SHA-256 校验文件，将 AgentKib 拖入“应用程序”后，再执行以下命令解除隔离属性：

```bash
xattr -cr /Applications/AgentKib.app
```

只应对从 AgentKib 官方 Releases 下载且校验通过的应用执行此命令。

---

## English

If you use Codex, Claude Code, Cursor, or other coding agents in the same project, rules and tool configuration tend to spread across `AGENTS.md`, `CLAUDE.md`, `.cursor/rules`, Skills, and multiple MCP files. Over time, agents can see different or outdated context.

AgentKib is a local desktop app that helps you:

- **See clearly** what Instructions, Skills, and MCP connections each agent can actually load.
- **Synchronize safely** by reviewing a complete ChangeSet and diff before shared configuration is written.
- **Keep working** by turning redacted Codex or Claude Code context into a handoff package. When the target is also Codex or Claude Code, AgentKib can open a new session without sending an automatic first message.

Core discovery, diagnostics, and synchronization do not require an AgentKib account, cloud database, or model API. **KIB** stands for **Knowledge & Instruction Base**.

### How it works

```text
Discover existing local workspaces
              ↓
Preview context and diagnose missing, drifted, or duplicated assets
              ↓
Generate a ChangeSet and complete diff
              ↓
Write to the project or Agent Home only after you approve
```

Browsing, previewing, and diagnosing do not create a manifest or modify agent configuration. A workspace does not need an existing `.agentkib/manifest.yaml`; the manifest is added to the reviewed ChangeSet only when shared assets are saved for the first time.

| Term | Meaning in AgentKib |
| --- | --- |
| Instructions | Project rules such as `AGENTS.md`, `CLAUDE.md`, and Cursor Rules |
| Skills | Reusable task instructions and their supporting files |
| MCP | Connections to local tools or remote services an agent can call |
| ChangeSet | A group of file changes and diffs you review before anything is written |

### Quick start — development preview

Install Rust stable, Node.js, pnpm 10, and the [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform. The desktop runtime requires macOS 13.3+, WebView2 111+ on Windows 11, or WebKitGTK 2.40+ on Linux.

```bash
pnpm install
pnpm dev
```

After launch:

1. Let AgentKib discover existing workspaces, or add a scan folder.
2. Open a workspace's Doctor page to check Instructions, Skills, and MCP across agents.
3. Use Instruction Context to confirm what an agent can actually see in a directory.
4. When configuration needs to be shared, generate a ChangeSet and review the complete diff before applying it.
5. To switch agents, create a handoff from a Codex or Claude Code session.

Discovery reads known agent configuration and history metadata; it does not scan the entire disk by default.

### Main capabilities

- **Workspaces and context**: discover existing projects and see each agent's rules, Skills, MCP connections, and effective load order in one place.
- **Diagnostics and synchronization**: find missing, drifted, invalid, or exactly duplicated configuration, then review a ChangeSet and complete diff before writing.
- **Session handoff**: reuse native compacted Codex or Claude Code context, exclude tool and reasoning records, and produce redacted, editable Markdown or JSON.
- **Other local tools**: manage MCP servers, browse Git read-only, and view quota, Token usage, heatmaps, and achievements while the app can continue from the system tray and manually check for updates in Settings.

The UI supports Simplified Chinese, Traditional Chinese, Japanese, and English, with light, dark, and system themes.

### Supported agents

| Agent | Discovery and inventory | Context diagnostics and sync | Session browsing and handoff |
| --- | --- | --- | --- |
| Codex | Yes | Yes | Yes |
| Claude Code | Yes | Yes | Yes |
| Cursor | Yes | Yes | — |
| OpenClaw | Yes | Yes | — |
| Hermes | Yes | Yes | — |
| DeepSeek Harness | Beta, read-only | Diagnostics only | — |

AgentKib distinguishes an installed app or CLI from leftover local data. Agent Home writes require separate approval. DeepSeek Harness remains a read-only Beta target and is never written to or configured for MCP.

### Local and private by default

- No login or AgentKib cloud sync is required. Ordinary discovery, diagnostics, and handoffs do not invoke a model or upload project assets.
- Discovery stores aggregate metadata such as paths, sources, counts, and timestamps—not prompts, message bodies, conversation titles, or raw session IDs.
- Handoff creation reads local transcripts on demand, excludes tool and reasoning records, and uses built-in rules to redact common sensitive values. The body is not stored in SQLite, logs, or audit details.
- Handoff files are written to `.agentkib/handoffs/` and ignored by Git by default; always review the complete diff before applying.
- Only when a handoff exceeds the safety limit and you explicitly confirm does AgentKib send redacted content to the local source-agent CLI for summarization, which may invoke a model and consume quota.
- Every generated file change checks path boundaries and original hashes, shows a diff, creates a backup, and validates the result after writing. Agent Home changes use a separate high-risk confirmation flow.

Credentials, cookies, tokens, environment files, private keys, and message databases are not cataloged as assets or written to logs. Git analytics do not retain commit subjects, diffs, file contents, or plaintext email addresses. Agent-proposed memory is not shared until you approve it.

Optional Obsidian and OpenClaw/Hermes Remote Gateway integrations must be configured explicitly and retain their own permission boundaries.

### Platform status

| Platform | Status |
| --- | --- |
| macOS 13.3+ (Apple Silicon / Intel) | Primary development and acceptance platform |
| Windows 11 x64 (WebView2 111+) | Platform code checked on PRs; NSIS built and smoke-tested manually |
| Ubuntu 22.04 x64 (WebKitGTK 2.40+) | Core CI platform; `.deb` and AppImage built and verified manually |
| Fedora x64 | Platform code checked on PRs; `.rpm` built and verified manually |
| Windows ARM64 / Linux ARM64 | Preview; core compilation or tests plus preview packages |

See the [Windows guide](docs/WINDOWS.md) for setup, development, packaging, installation, and usage. Maintainers can generate unsigned multi-platform preview packages with the [desktop package workflow](docs/RELEASE.md). Pull requests and ordinary pushes run checks without producing installers. The first updater-capable release still requires a manual installation; subsequent stable releases can update in-app on macOS, Windows, and Linux AppImage, while DEB/RPM installations open the Release page for a package-manager-safe update.

The macOS package is not currently signed or notarized. Verify it against the SHA-256 file in the Release, drag AgentKib into Applications, and then remove its quarantine attributes:

```bash
xattr -cr /Applications/AgentKib.app
```

Only run this command for an app downloaded from the official AgentKib Releases page whose checksum you have verified.

<a id="development"></a>

### 开发 / Development

在仓库根目录构建当前平台的桌面包。Build a desktop package for the current platform from the repository root:

```bash
pnpm tauri build
```

Linux 环境诊断与打包脚本 / Linux environment and package scripts:

```bash
apps/desktop/scripts/diagnose-linux.sh
apps/desktop/scripts/build-linux-bundles.sh
```

构建产物位于 `target/release/bundle/`。Build output is written to `target/release/bundle/`. Third-party licenses are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

```bash
cargo fmt --all -- --check
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
pnpm test
pnpm typecheck
pnpm build
```

AgentKib is a development preview. Unsigned preview installers and checksums are published on [Releases](https://github.com/starroyhq/agentkib/releases); macOS Gatekeeper and Windows SmartScreen may show warnings. For feedback, use [GitHub Issues](https://github.com/starroyhq/agentkib/issues).
