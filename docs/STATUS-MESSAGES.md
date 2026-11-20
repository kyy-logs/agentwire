# 状态说明

本次修改只增加展示字段和说明，不修改投递、超时、重试、配对授权或历史记录。

`labus pair result --request <id>` 在原有字段之外返回 `display`：

- `operation`：操作本身的结果与下一步。
- `notification`：结果通知的送达状态与下一步。

例如，配对操作为 succeeded、通知为 needs_check 时，显示“配对已保存；通知送达待核对”。不需要为了通知问题重新兑换连接码。查询不会发送通知、恢复操作或修改保存状态。

连接码已使用时，只有原兑换双方与当前活动配对完全对应，且没有未完成激活或连接切换，才说明“原配对仍有效”。这里的有效只指身份配对未断开，不表示对方在线或任务通信已通过验证。无法核对时只提示查询当前配对，不推荐盲目重试。已过期、撤销或已使用的旧发码结果不再被描述为可用码。

消息状态页也增加 `display`：

| 保存状态 | 用户说明 |
| --- | --- |
| pending | 消息正在排队，尚未确认提交 |
| submitting | 正在提交，尚未确认对方收到 |
| submitted | 已提交给对方，等待处理结果 |
| completed | 已记录本回合结果；业务结论未验证，结果消息送达需另行核对 |
| delivered | 有 accepted 收据与证据时才说明回复已送达 |
| needs_check | 投递或处理待核对；不猜测对方是否正在审批 |
| expired / stopped | 消息已过期或停止追踪；不代表原生 Agent 已取消任务 |

原始 `phase`、`state`、`errorCode`、收据和证据字段保留，排查时以完整记录为准。程序通知保留权限边界说明。

## 等待原因

`labus status` 的 `data.tasks.items[].display`（底层 Bus `status` 的 `items[].display`）增加可选 `waiting`。`summary` 和 `nextStep` 可直接展示；`waiting.reason` 供程序区分原因。

| reason | 说明与证据边界 |
| --- | --- |
| target_offline | 上次投递被明确拒绝，错误为 session_offline，且已有未来的重试时间。只说明上次投递时未找到目标，不证明目标现在仍离线 |
| retry_backoff | 上次投递被明确拒绝，正在等待已安排的下一次重试；附 nextAttemptAt |
| family_paused | 同一任务有 needs_check、stopped、expired 或 stoppedAt 记录，暂停后续投递；blockedBy 指向其中一条阻塞记录 |
| target_task_unresolved | 同一目标聊天有 submitting、submitted 或 needs_check 的非回复任务占用投递位置；不能据此判断模型是否忙碌或等待审批。回复不受此串行规则阻塞 |
| bus_queue | 消息仍在 Bus 排队，没有证据解释更具体的等待原因 |
| submission_in_progress | 正在提交，尚未确认对方收到 |
| awaiting_result | 已提交，尚待结果；不推断原生执行或审批状态 |
| deadline_elapsed | 保存状态尚未更新，但任务或结果等待期限已到；不表示原生任务已取消 |

等待说明基于同一查询快照中的保存记录；跨任务阻塞判断先于任务筛选和分页，返回的总数及游标仍按筛选后的记录计算。查询不启动探针、不调用原生 Agent、不重试、不修改消息。已经完成、送达、失败、过期、停止或待核对的消息不再附普通 waiting 原因。

这不是持续监控原生窗口的接口。没有直接的审批等待证据时，不显示“正在等待审批”。它也不添加聊天通知，正常聊天和往返方式保持原样。

多个门槛同时存在时，已到期限优先，其次显示同任务暂停，再显示重试等待，避免在任务已暂停时建议继续等重试。
