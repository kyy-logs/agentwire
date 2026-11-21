
# 结构化协作（离线实现，待原窗口验收）

这是显式选择的新模式，默认 `ask` 与自动回传保持原行为。用户可说“把这个任务交给 Claude，使用提问和验收流程”；两端 Skill 负责查精确工具状态及调用命令，用户不需复制协议 ID。

```mermaid
stateDiagram-v2
 working --> question_pending: 执行方 question + 原生证据
 question_pending --> waiting_answer: 精确 Stop
 waiting_answer --> working: 原发起方 answer
 working --> delivery_pending: 执行方 deliver + 原生证据
 delivery_pending --> waiting_acceptance: 精确 Stop / 采集报告
 waiting_acceptance --> working: 原发起方 revise
 waiting_acceptance --> completed: 原发起方 accept
```

Stop 只表示一个回合结束。没有显式 question/deliver 的结构化执行回合会进入 needs_check，不会猜报告语义。completed 表示发起方接受当前交付，businessVerdict 始终 unverified。普通信息回复不触发自动回信。

命令由 Agent 通过已安装入口执行，保留原生审批：
- `labus ask --provider <本端> --mode structured --text-file <任务>`（Claude 兼容参数另需本会话 source-session）。
- 动作共有 `question / answer / deliver / accept / revise`，必须带 `--provider <本端> --source-session <本聊天原生UUID> --task <精确taskId> --operation <新UUID> --revision <当前版本>`。
- question/answer/revise 带 `--text-file <正文>`；answer 另带 `--question <当前questionId>`；accept/revise 另带 `--delivery <当前deliveryId>`。deliver/accept 禁止正文。deliver 的最终报告由该精确回合 Stop 采集。
- `labus status --task <taskId>` 的 `data.tasks.collaboration` 展示业务阶段、固定双方、版本、问题/交付版本、预算。消息列表与协作账本分开；completed/delivered 的消息不意味着业务结束。
- IPC `collaboration-status` 单独支持 taskId、limit(1–100，默认50)、after；其游标独立于消息 status。CLI 不支持翻页，精确任务过滤可避免按“最新任务”猜测。

动作首先返回 pending_verification，随后后台核对原生工具结果的请求摘要、工具调用、精确会话和回合，再推进状态。执行方仅可在绑定任务执行回合提问/交付；发起方仅可在该任务的问题/报告接收回合操作，或通过经验证的人工来源操作。模型填写的 ID 不是权限证明。原生工具记录缺失、冲突、部分写入或超界一律不推进。

当前支持形态：Claude 主会话 Bash 单条已安装 launcher 命令，Codex 主会话 exec 中精确的 `text((await tools.exec_command(<JSON字面量对象>)).output);`。动作命令必须显式包含本端 sessionId，Windows PowerShell 可在命令起始使用单个 & 调用运算符；不接受任意 JS、shell 链或外部脚本代理。独立证据读取器限单文件16MiB、单行2MiB、目录2万项；超出限制保持未核验，不切到模糊匹配。现有 reader/适配器协议不变。

文件账本位于连接 state/collaboration/tasks 与 actions。intent 和 terminal 两个 checkpoint 分别先存确定性动作/消息，再提交任务版本；重启保留原 messageId，不重复扣预算。默认期限30分钟，复杂任务可在创建时使用 `ask --mode structured --timeout-minutes 60` 选择1小时（只接受30或60）。新任务返回固定 deadline；回答、修改、幂等重放不刷新期限或预算，旧账本未记录 timeoutMinutes 时按30分钟策略兼容。最多3个问题、6次执行（回答及修改会消耗）。超时不等于原生取消。等待答案、等待验收与未完成动作均阻止连接切换和卸载；需要用户明确处置，禁止自动删除保护记录。

异常排查：用原 task/operation 查询状态，保留文件、消息和原生记录；不得换 ID 重投或把未知送达当失败后重试。needs_check、revision_conflict、action_unverified、budget_exhausted、storage_requires_check 分别需要核对精确回合/当前版本/原生证据/剩余预算/原始存储。stop 只停止 Bus 追踪，不取消厂商进程。

本次不修改真实安装、Hook、模型权限或配对，也未验证真实厂商窗口中的结构化工具调用。离线集成使用真实 Bus/存储/IPC/clean 处理器与替身厂商接口；完整测试与独立审查结果另见 verification 报告。Skill 的文本契约和离线行为场景不保证每种模型都能可靠执行，最终动作准入由程序校验。


## 超时、恢复与审批观察

```text
labus ask --provider codex --mode structured --timeout-minutes 60 --text-file <UTF-8任务绝对路径>
```

普通 ask/followup 不接受 timeout-minutes；不能借参数续期旧任务。CLI outbox 固定创建时所选时限，任务与传输消息共享固定 deadline。后台证据核验跨过期限时只结束该任务的追踪，不将预期超时当成全服务存储故障；真实损坏仍暂停服务。迟到 Stop 不发送新报告，不表示厂商工作已取消。

若 accept 已通过原生核验、且 completed 任务已经持久保存，崩溃恢复可在期限后完成同一 checkpoint 的记账。必须精确匹配原请求、双方身份和整个已保存任务；不接受新的迟到 accept，不修改业务验收结果。

status/collaboration-status 可附带 nativeSession，只读取原生会话状态白名单，绝不把对方正文或 lastError 当作审批证据。当前 Claude 实现要求唯一存活 PID、精确 sessionId、绝对目录、30秒内的原生 updatedAt、waiting/permission prompt。缺失、歧义、损坏、过期、未来时间均不显示审批。该字段是查询时的瞬时观察，scope=session、taskAssociation=unconfirmed；无法证明审批属于哪个任务，不能用来停止计时、跳过审批或改变业务阶段。Codex 当前无可靠审批来源时保持未确认。
