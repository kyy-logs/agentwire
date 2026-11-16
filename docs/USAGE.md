# AgentWire 日常使用

先完成[安装与连接](INSTALL.md)。日常在聊天中使用两端 `labus` Skill，终端命令主要用于诊断和自动化。

## 一次协作

在 Codex 中说：

> 让 Claude 只读审查当前项目未提交的改动，重点检查超时与取消边界，不修改文件。

Skill 将目标仓库绝对路径、改动范围、只读职责和验收条件整理到 UTF-8 任务文件，再调用安装好的客户端。只传必要任务上下文，不复制完整聊天。

Claude 收到消息后，按原审批处理并正常回答；Bus 自动识别该任务的原生回合、收集结果并送回原 Codex。不要额外让对方执行 reply，也不必复述任务编号。

需要继续时说：

> 根据 Claude 刚才的审查意见修复这两项问题，运行测试，再请它复查。

下一轮由 Agent 在授权范围内显式调用 followup；程序保留任务家族。多条回复无法唯一确认时应让用户选择，不能猜最近一条。

Claude → Codex 同理。可先说「让 Codex 分析这个错误，只读，不修改配置」。

## 命令接口

Skill 内部使用：

```text
labus connect discover --provider codex
labus connect select --provider codex --peer-session <selected-session-id>
labus connect status --provider codex
labus ask --provider codex --text-file <absolute-task-file>
labus followup --provider codex --reply-to <reply-id> --text-file <absolute-task-file>
```

反向使用 `--provider claude`。这些命令应在对应 Agent 会话上下文执行；Codex 读取原生 `CODEX_THREAD_ID`，Claude 使用原生会话变量/Skill 替换值。缺少来源身份时拒绝发送，不能手填其他会话冒充当前窗口。占位参数仅表示格式。

同一发送的重试必须沿用原返回的消息 ID；CLI 保存带连接和目标身份的 outbox 票据，活动连接变更时拒绝跨连接重试。不能因超时而生成新 ID 重新做业务。

查看状态：

```text
labus status
labus doctor
```

## 怎么看结果

「本回合已结束；业务结论未验证」表示程序已经收集到了对方输出，并不代表编译、测试或业务验收成功。结果应包含实际测试命令、退出码及相关文件。长结果可能截断，完整 artifact 保存在本地状态目录。

信息回复无需回声或确认；没有明确下一轮计划时直接结束。自动任务不会发送多余的等待提醒。

## 未完成与异常

- `pending/submitting/submitted/queued`：任务尚在投递或等待处理，不能据此认为对方已执行。
- `needs_check`：投递、回合关联或终态存在不确定性；先核对原窗口和原消息，不自动重做。
- 结果等待超时：停止正常等待，不代表原生工具已取消。
- 窗口离线：按有限重试与总期限处理；恢复同一聊天后检查连接状态。

一个任务家族最多 6 次执行、30 分钟期限，结果等待 10 分钟；审批等待也计时。更多安全和恢复边界见[架构说明](IMPLEMENTATION-NOTES.md)和[开发协作](DEVELOPMENT-WORKFLOW.md)。
