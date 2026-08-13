# AgentKib

> The local Knowledge & Instruction Base for every agent.

**AgentKib** 中的 **KIB** 代表 **Knowledge & Instruction Base**：为不同 Agent 提供统一的知识、指令与公共资产底座。它让 Codex、Claude Code、OpenClaw、Hermes 等工具可以围绕同一套项目规则、Skills、MCP 连接和经审批的共享记忆工作。

AgentKib 是一个本地优先、Git 原生的全局 Agent 资产控制台。

当前 MVP 会从 Codex、Claude Code、OpenClaw 与 Hermes 的本地配置和会话元数据自动发现仍然存在的工作区，并统一盘点项目指令、Skills、MCP 连接和经审批的共享记忆。

核心行为：

- `.agentkib/manifest.yaml` 是可进入 Git 的公共资产真相源。
- `AGENTS.md`、`CLAUDE.md`、Skills 与 MCP 配置通过统一 ChangeSet 生成，应用前检查 Diff 与文件哈希。
- OpenClaw / Hermes Home 写入必须在 Changes 页面单独勾选授权。
- SQLite、审计和备份保存在系统应用数据目录，不进入项目。
- 自动发现只读取路径、Agent 来源、会话数量和时间；不保存会话 ID、标题、Prompt、消息正文或凭据。
- 不默认扫描 Home 或整块磁盘。Settings 中由用户授权的扫描目录是 Agent 元数据之外的补充来源。
- 进入本地索引不会创建 manifest，也不会修改任何项目或 Agent Home；所有写入仍须经 ChangeSet、Diff 和确认。
- `agentkib-mcp` 是独立 stdio 服务；安装后无需保持桌面 App 运行。
- macOS 菜单栏图标常驻，后台每 15 分钟刷新资产索引。第一次关闭窗口会询问隐藏到菜单栏或退出；隐藏后 Dock 不再显示 AgentKib，只有菜单栏“退出 AgentKib”或将关闭行为改为“退出应用”才会结束进程。
- “成就”页只读汇总四类 Agent 已记录的 Token、会话和纳管仓库 Git 活动，并提供近 52 周热力图与里程碑徽章。
- “我的提交”使用本机 Git 邮箱的 HMAC 摘要匹配；不会保存明文邮箱、提交说明、代码 Diff 或原始会话 ID。数据源缺失时会明确显示覆盖范围和“不完整”。

## 开发

```bash
pnpm install
pnpm dev
```

第一次运行会直接进入全局 Home 并异步自动发现工作区。可以从 Workspaces 进入单项目详情；编辑公共指令、Skills 或 MCP 后，点击“生成变更”，确认完整 Diff 再应用。未发现项目时可添加授权扫描目录或手动添加文件夹。

首次导入会识别根目录及嵌套的 `AGENTS.md`、Claude/Codex/Hermes 平台覆盖和共享 Skill 目录。Skill 同步覆盖完整 UTF-8 文本目录（包括 `references/`、`scripts/` 等）；二进制 Skill 资产首版会被明确拒绝，不会静默丢失。

Rust 核心验证：

```bash
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
```

CLI 示例：

```bash
cargo run -p agentkib-cli -- scan /path/to/project
cargo run -p agentkib-cli -- context /path/to/project codex
cargo run -p agentkib-cli -- validate /path/to/project
```

## Manifest 示例

```yaml
schema_version: 1
workspace:
  id: your-project-id
  name: your-project
instructions:
  shared: |
    # Project rules
  scoped:
    - path: packages/api
      content: Use the API package conventions.
  platform_overrides: {}
skills: []
connections: []
memories:
  require_approval: true
adapters:
  codex: { enabled: true, generated_hashes: {} }
  claude-code: { enabled: true, generated_hashes: {} }
  open-claw: { enabled: true, generated_hashes: {} }
  hermes: { enabled: true, generated_hashes: {} }
```
