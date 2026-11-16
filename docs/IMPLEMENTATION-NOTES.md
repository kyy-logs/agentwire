# 架构与实现取舍

AgentWire 是本地双向任务通信工具：Skill 提供聊天入口，客户端通过 IPC 提交消息，本地 Bus 进程管理持久状态，两端 adapter 投递到原聊天。不是 MCP Server，不创建付费模型 API 调用。

## 代码地图

| 文件/目录 | 职责 |
| --- | --- |
| `src/labus.ts` | 安装、发现/选择聊天、连接、ask/followup、状态与撤销的用户入口 |
| `src/installation/` | 固定运行时、配置所有权、连接/探针、后台进程及 Hook 路由 |
| `src/cli.ts` | 底层绑定、发送、检查、手动回复与服务入口 |
| `src/main.ts`、`src/bus.ts` | 单消费者、消息状态机、预算、重试、超时与关闭顺序 |
| `src/store.ts`、`src/ipc.ts` | 本地 JSON 原子记录、锁与 IPC |
| `src/adapters/` | Codex 与 Claude 的 probe/submit/reconcile |
| `src/native/` | App Server 客户端、隐藏传输身份、原生执行与送达证据 |
| `src/lifecycle/` | Hook inbox、事件规范化、精确结果收集与恢复 |
| `src/envelope.ts` | 聊天包装与 peer data 权限边界 |
| `assets/skills/` | 两端自然语言协作入口 |

## 两端传输

Codex 使用桌面捆绑的 Codex App Server stdio 与实验能力，包含 `thread/queue/add`、`thread/items/list`、`thread/turns/list`；精确传输身份保存在原生 clientUserMessageId。Claude 使用已有会话的本地认证 peer 管道，随后按原生 uuid/prompt/祖先链核对。它们都是可能随上游升级变化的兼容面。

两个 Agent 需要有可投递的原会话。Bus 是单独隐藏进程，拥有状态写入权；Hook 写收件箱，原生 Agent 独立执行。传输已接受、消息已呈现、任务已结束、业务已通过是不同事实。

## 数据与恢复

一组连接固定两个 provider/session，保存于安装根的 `connections/<connectionId>`。消息、绑定、日志、lifecycle 事件、结果及身份映射位于该连接的 state；外发票据保存在安装根 outbox。真实会话、认证文件和运行状态不属于源代码仓库。

每条消息与回复有稳定身份；同 ID 不同正文拒绝。结果先落盘、后回复、最后标处理完成；重启补投影而不重复做原业务。确认从未写入的失败才能有限重试，未知写入进入 `needs_check`，只读 reconcile 寻找真实证据。

这不是永久邮箱或分布式事务队列，没有 SQLite、远程网络监听或跨 Agent exactly-once 保证；历史需要自行归档。升级不兼容状态格式时，先保留备份并停止旧消费者，不能让旧运行时直接读取它不认识的 schema2。

## 预算、安全与并发

- 每家族最多 6 次执行，根 TTL 30 分钟，结果等待 10 分钟。
- 确定未写入的失败最多 3 次尝试，间隔 1 秒、5 秒；未知写入不自动重投。
- 自动结果不发等待提醒；信息回复不自动回声。下一轮只由授权计划显式派生。
- 原生审批不继承为对方的高权限；peer 正文不拼接成 shell 命令。
- Bus 不取消原生任务、不杀 Agent、不做文件锁。单写者或 worktree 隔离见[开发协作](DEVELOPMENT-WORKFLOW.md)。

## 首版命名兼容

产品和仓库名为 AgentWire，包版本 0.1.0。CLI/Skill 的 `labus`、`LocalAgentBus` 数据目录以及旧内部协议命名保留，避免破坏已有配置、状态和稳定派生 ID。不是将内部协议字符串全部替换成产品名。

## 扩展边界

底层 AgentAdapter 有 probe/submit/reconcile，但第三 Agent 还需补 kind/CLI 校验、来源识别、原生证据读取、安装发现及端到端验收；不能只加 adapter 就声称可用。首版没有多活动连接、自动角色规划或跨任务根的全局预算。

已验证范围和缺口见[验收边界](CLEAN-MESSAGES-ACCEPTANCE.md)。
