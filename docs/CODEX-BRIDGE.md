# Codex 原会话实验桥接

## 状态与边界

本模块是开发验证工具，不是已交付的远控功能。AgentKib 正式客户端和局域网接口仍然只读；Runtime 不依赖 `agentkib-codex-bridge`，没有新增导航、Renderer API、数据库或桌面协议字段。

目标是作为已有 Codex 客户端的 follower：发现原会话 owner、订阅内存状态、将有限操作定向转发给 owner。不会运行 Codex、恢复/分叉会话、修改 JSONL、创建 IPC 服务或读取认证凭据。无 owner 时停止，不进行独立 `thread/resume`。

已检查的安装代码版本：

| 组件 | 版本 | 已观察的机制 |
| --- | --- | --- |
| Codex 桌面端 | 26.901.51231 | owner discovery、following、状态流和 follower 操作 |
| VS Code Codex 插件 | 26.901.22334 | 同一套本地 IPC 路由；插件仍有自身 App Server |

这不是公开承诺的兼容契约。[公开 App Server 文档](https://learn.chatgpt.com/docs/app-server)不能代替该内部协议的真实客户端验证。

## 开发入口

只验证初始化，不读取会话：

```sh
cargo run -p agentkib-codex-bridge --example probe -- \
  --socket "$HOME/.codex/ipc/ipc.sock"
```

跟随用户明确指定的**合成测试会话**；默认只读，省略版本元数据也可以只读订阅：

```sh
cargo run -p agentkib-codex-bridge --example probe -- \
  --socket "$HOME/.codex/ipc/ipc.sock" \
  --desktop-asar /Applications/ChatGPT.app/Contents/Resources/app.asar \
  --extension-package "$HOME/.vscode/extensions/openai.chatgpt-26.901.22334-darwin-arm64/package.json" \
  --session "替换为测试会话 UUID"
```

需要验证操作时显式增加 `--allow-control`。仅 macOS 支持连接；初始化本身不会启用控制。首批控制校验限定上述标准安装路径、版本，以及 IPC peer 的可执行文件属于该桌面应用。若 IPC router 由其他程序（包括 VS Code）持有，或无法查到 peer PID/路径，则保持只读；不能用复制出来的 `package.json` 打开控制。

本机 socket 与父目录必须属于当前用户、无 group/other 权限且不经过符号链接；连接后校验 peer UID 和端点 inode。不会创建目录、修改权限或自动切换旧 socket。该 IPC 本质上信任同一操作系统用户，不应作为局域网授权边界，也不保证防御同 UID 的恶意程序。安装路径与版本校验不等同于官方对运行中 owner build 的证明。

交互命令：

| 命令 | 行为 |
| --- | --- |
| `status` | 显示状态、revision、执行轮次 ID、待审批数量；不输出正文 |
| `sync` | 重新发现 owner、订阅完整快照；不重发操作 |
| `approvals` | 按需显示当前支持的审批详情，不持续记录对话 |
| `send 测试文本` | 仅在已确认 idle 时发送纯文本，保留原 ID 与原端设置 |
| `stop TURN_ID` | 仅停止仍匹配的当前轮次 |
| `approve {"requestId":42,"turnId":"TURN_ID","decision":"accept"}` | 仅允许 `accept` / `decline` / `cancel`，request ID 的字符串或数字类型必须保留 |
| `quit` / EOF | 取消 following、断开探针，不退出官方客户端 |

看到 owner acknowledged 只表示 owner 应答了请求，**不表示生成完成或某项审批由本探针成功处理**。结果不明时不重发；先 `sync` 检查原端状态。官方端已处理的审批可能返回无操作回执，因此必须观察 pending request 是否消失，不能据此声称某个决定已经生效。

所有命令仅用于临时项目和合成内容。不要将真实敏感信息复制进测试会话，不要重定向审批详情为公开日志。命令或 diff 不完整、网络/额外权限请求、目录授权及其他未知交互在原客户端处理；探针不会自动放行。

## 协议与保护

- 消息使用 little-endian 长度前缀加 JSON。独立身份 `agentkib-codex-bridge`；所有 owner discovery 请求的 `canHandle` 回答均为 false。
- 固定方法版本：initialize 0、owner discovery/following/审批 1、start-turn 2、interrupt 4、stream 11。不向本地 API 暴露任意 method/params 输入。
- following 使用 `conversationId + hostId: local`，目标为已发现的 owner client ID；恢复 following-status 请求时同样定向回复。
- snapshot 与 Immer array-path patches 按 revision 验证。错版本、丢帧、越界、身份不匹配或断开后清空状态并禁用操作；旧广播不得重新激活连接，必须重新发现与取得快照。
- 入站 frame/累计 snapshot 上限 8 MiB；出站请求 64 KiB；文本 16 KiB；单批 patches 4096 条、路径深度 64。超限只读失败，不降低校验或加载无限历史。
- 同一进程内按端点和会话串行化操作；持有端与轮次再次核对，消息无自动重试、排队或插话。发送异常后进入 outcome-unknown；IPC 超时关闭连接。
- 发送协议没有显式 revision CAS；不同官方客户端的同时提交最终依赖 owner/App Server 的处理。这项行为必须三端实测，不能以刷新后检查 idle 或本地锁替代证明。
- 审批按原会话、active turn、pending request 和方法匹配；仅允许单次决定。额外权限、缺少 command/diff 或未知交互不能 Accept。

## 验证记录（2026-09-07）

| 验证层级 | 结果 |
| --- | --- |
| 安装代码核对 | 已确认两套客户端存在 owner/follower 协调，并非仅共享历史文件 |
| 真实 IPC 初始化 | Node 最小探针及 Rust 开发入口均以独立身份成功初始化；没有读取会话 |
| 真实版本元数据 | 已读取上述两个版本，仅读取包元数据，不读取 Token |
| 不存在的合成会话 UUID | 真实 owner discovery 返回 no session owner found；无 fallback / resume |
| 单元与受控 socket 测试 | 覆盖编解码、版本、订阅、增量、隔离、权限、定向请求、审批失效、超时及重复操作；仅用于验证适配器逻辑 |
| 原会话发送及状态增量 | 用户指定“处理测试对话”；探针发送 AK-BRIDGE-001，官方端在同一 UUID 下新增且仅新增一个轮次，回复 `AK-BRIDGE-001 收到。`；后续执行中收到连续 revision 更新 |
| 原会话停止 | STOP-004 由探针定向停止，官方端记录同一轮次 `interrupted`，持续约 6 秒；同步后探针恢复 idle |
| 执行中重复发送保护 | STOP-004 执行中再次发送被探针以 not idle 拒绝；官方该轮次未出现该测试消息 |
| VS Code 第三端同步 | **待验收**：用户确认桌面端可见；实际检查 VS Code 为欢迎窗口，插件停留最近聊天列表，未打开目标测试会话，不能归因于缓存或认定同步失败 |
| 真实双端审批与跨客户端同时发送 | **待验收；没有更改权限来强行触发审批，不声称已通过** |
| 局域网与 Windows/Linux | 本轮不实现、不验收 |

运行本地检查：

```sh
cargo fmt --all -- --check
cargo test -p agentkib-codex-bridge
cargo clippy -p agentkib-codex-bridge --all-targets -- -D warnings
git diff --check
```

三端验收顺序：先在官方客户端中打开同一合成会话，探针只读订阅；由桌面发起一次可观察执行，确认插件和探针状态一致且不可重复发送；执行结束后由探针发送一条明确测试文本，检查仍为同一 ID 且只启动一次；随后分别验证停止、两端抢先处理审批、owner 退出、连接重建和未知版本只读。审批涉及的命令和文件仅限临时测试项目。

### 真实测试发现并修复的差异

- IPC response 的方法字段在顶层 `method`，不是 `result.method`。首次发送已完成但探针曾误报不兼容；没有重发该消息，先通过官方端记录确认结果再修复解码及测试夹具。
- 客户端状态的轮次 ID 为 `turnId`，且真实执行轮次可能保存在 `turnHistory.kind=canonical` 的 indexed history 中，不在 `turns` live overlay 内。初次停止被安全拒绝，STOP-002/003 自然结束；补充 canonical history 解析后 STOP-004 中断成功。
- canonical 与 live overlay 的活动轮次不一致时，不猜测控制目标，停止及审批保持禁用。canonical entity 缺失时整个状态失效。
- 测试目标由用户指定，位于现有项目，但仅发送合成文本以及要求在 `/tmp` 等待的指令；没有授权或执行项目文件修改。真实审批用的临时项目场景仍待完成。

只有真实三端验证通过，才能继续设计局域网控制。未来控制授权覆盖全部已登记及新增项目，但发送、停止、审批须单独授予，不能将已有只读设备授权自动升级。
