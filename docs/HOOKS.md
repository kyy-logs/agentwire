# Hook 与自动结果回传

首版安装由 `src/installation/configuration.ts` 合并用户级 Hook，固定 router 为 `src/installation/hook-router.ts`。具体命令由安装器按 Node 与运行时绝对路径生成，使用者无需手写会话 UUID。

## 事件与关联

| 端 | 事件 |
| --- | --- |
| Codex | UserPromptSubmit、Stop、Interrupt |
| Claude | UserPromptSubmit、Stop、StopFailure |

router 只将精确登记的 provider/session 路由到对应连接。Hook 将事件同步保存到该连接的 `lifecycle/inbox`，Bus 再处理，允许结束事件先于身份映射到达。普通人工聊天不登记为 Bus 任务结果。

未发布的配对控制入口位于上述路由过滤之前，只匹配固定的人工配对句式。
Hook 暂存白名单请求字段并通过 additionalContext 返回本回合临时凭据，
此时不构成 PairIntent，不发码也不连接。客户端用精确凭据调用程序后，
才核验原生 session、input/turn、来源、正文、cwd 和原生时间。
这适应 Codex 在 Hook 返回后才写入完整输入的时序；缺证据时拒绝，
不在 Hook 中等待、不查最近消息。peer/queue、工具及子 Agent 不能成为授权。

配对凭据两分钟首次操作有效，代码一小时有效；请求、意图、邀请、事务合计
最多 128 条、256 KiB。终态保留 24 小时，未完成或 needs_check 不清理。
该入口已验证新主聊天跨目录发码/兑换；各方向任务往返的实际范围见[验收边界](PAIRING-ACCEPTANCE.md)。

clean-v1 自动任务不从正文解析 ID：Codex 使用原生 clientUserMessageId 与 turn，Claude 使用 peer uuid、prompt 与祖先链。原生记录读取不到、格式变化或对应多回合时暂停，不拿最近一条回答拼凑结果。

`src/lifecycle/hook.ts` 负责输入采集与规范化；`src/lifecycle/clean-processor.ts` 结合 `src/native/` 下的身份存储和两端证据读取器处理 schema2；旧 manual/legacy 路径由旧处理器保留。两个处理器不会共同接管同一 schema2 任务。

## 结果提交

结果先保存为本地 artifact，再生成稳定派生 reply ID、持久回复、补父记录投影，最后标事件已处理。重复事件和恢复不能重复执行原任务。首次持久的手动或自动回复胜出。

`nativeOutcome` 表示 response_ended/error/interrupted，`businessVerdict` 仍为 unverified。Stop 本身不证明业务成功，背景工作、续行或多个 final 输出存在歧义时暂停核对。

Bus 离线时已同步的 Hook 文件保留；重启处理同一收件箱。Agent 崩溃且没有结束事件时需要人工检查。文件原子提交不等于跨进程原生执行 exactly-once，也不承诺突然断电后的绝对持久性。

## 限制与权限

- Hook 输入最大 1 MiB；结果最大 512 KiB；聊天摘要最大 2048 UTF-8 字节。
- 格式错误、缺身份或过大负载返回固定错误码，不在错误日志中打印原始事件。
- 路由和 nonce 防误关联，不能抵御同一 Windows 用户权限内的恶意进程。
- 对方输出作为 peer data，不获得更高权限；保留原生工具审批与 Hook 信任。
- 真正的原生错误/中断端到端尚未验收，不能以离线 fixture 代替。

## 排障和撤销

通过 `labus doctor`、原生 Hook 面板和连接状态中的 `bus.log` 核对；坏收件箱文件隔离到 `lifecycle/quarantine`。不删 `needs_check` 来盲重投。

卸载按配置所有权撤销本工具的精确组，保留其他 Hook、权限和外部编辑；步骤见[安装文档](INSTALL.md)。不要运行旧原型的探针或配置脚本。
