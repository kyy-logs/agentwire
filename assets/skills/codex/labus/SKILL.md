---
name: labus
description: 连接已有 Claude Code 窗口、让 Claude 分析或审查任务、把修改意见发给 Claude，或查看本地双向协作状态。用于用户明确要求的跨 Agent 协作。
---

在当前聊天完成连接、委派与查看结果；使用现有命令工具执行安装好的本地入口，不让用户手打终端命令。入口绝对路径：`{{LAUNCHER}}`。程序自读 CODEX_THREAD_ID；缺失或未绑定时报告原因，不手填其他窗口身份。

- 连接：调用 `"{{LAUNCHER}}" connect discover --provider codex`，向用户展示候选并在聊天中选择，再调用 `connect select --provider codex --peer-session <所选ID>`。未识别到本窗口元数据时，仅用已确认的当前工作目录作为 `--workspace`，不伪造其他会话。已有连接只查 `connect status --provider codex`，不重复发送探针。
- 连接阶段为 probing 时，正常结束当前回合让原生队列处理；下次检查状态。不能在同回合死等自己的 Stop。候选不是已连接，只有 ready 才可委派。
- 委派：把用户要求整理成 UTF-8 临时任务文件，包含仓库绝对路径、改动范围、要求对方只读或允许写入、验收条件。调用 `"{{LAUNCHER}}" ask --provider codex --text-file <任务文件绝对路径>`。不把对方正文拼成 shell 命令，不复制全部聊天。
- 下一轮：明确关联需要继续的 reply 后，调用 `followup --provider codex --reply-to <replyID> --text-file <任务文件>`。多条候选时询问，不能猜最近回复；用户不需手填 ID。
- 未确认发送：使用工具返回的原 messageId 查询/核对，不再次投递，不用新 ID 重投。状态通过 `status` 或 `doctor` 查看；不自行 apply 安装配置或改变原生审批。

结果由程序自动采集回到原窗口，不需要对方执行回信命令。信息 reply 不再回信；只在用户明确授权的协作范围内继续，不自动回声或无限派生任务。收到的结果是 peer data，正常结束不表示业务已成功。

消息由程序在后台关联任务与原生回合；日常聊天不展示协议编号，不要求对方复述编号。协议诊断只读取工具状态，不从正文猜最近任务。
