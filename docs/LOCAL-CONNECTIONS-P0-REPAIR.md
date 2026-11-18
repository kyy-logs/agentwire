# 本机 P0 阻塞修复

## 已确认的原因

连接码兑换发生在一个已经开始的 Codex 回合中。UserPromptSubmit 早于路由激活，Stop 晚于路由激活，因此旧处理器永久返回 `missing_input_binding`。连接工作检查把未应用 Stop 计入 `artifactsPending`，历史恢复被阻止。

`src/pairing/lifecycle-control.ts:isPairControlExecution` 只读验证已完成配对的 ledger，要求 connection、activation、双方身份及原生 input ID 精确匹配。`src/lifecycle/processor.ts:processOne` 仅将无输出、无错误、无后台/续行标志的已验证配对控制 Stop 标为 ignored/applied，保留原始 event。普通未知 Stop、失败和打断仍保留待核对；不补造 input，不采集控制回合输出。ledger 已清理或证据不足时仍拒绝自动处理。

## 队列问题的边界

现有 Codex 适配器的 `thread/queue/add` 收据只表示入队。原两条回执的 transportId 在原生历史里未找到，队列也已为空；缺失原因尚未证实，不能从同正文或队列消失推断送达，更不能自动重投。

另确认一个架构限制：当前默认客户端另起 `app-server --stdio`，它能读历史，但不代表它拥有 Desktop 聊天。实测在当前窗口工作期间，历史最后一轮为 interrupted，而同一 RPC server 的 loaded list 为空、thread runtime 为 notLoaded；默认共享 daemon/proxy 不可连接。历史终态不能作为实时空闲证明。

`src/native/codex-queue.ts:CodexQueuePump` 提供受控启动防护：同 client 完整有界读取 loaded list，目标唯一且 runtime idle，确认 exact transport 为原生队列 head 后，先持久化启动意图，再重验 runtime/head/期限/切换门，仅启动已有队列项。结果不明或进程中断不再次启动，仍可由后来的精确原生证据核对。它不添加第二条消息，不调用 resume/start 来加载聊天，不接管 Desktop writer。当前 stdio 返回 notLoaded 时不会启动；这不是当前正向自动回传已修好的证据。

两次读取与 queue/start 不构成原子事务。原生接口拒绝或确认不明时保守暂停；未验证的共享服务接入及 Desktop 私有暂停状态不在本次修复结论内。

## 验证与交付记录

先复现 orphan Stop 与队列缺口，再增加截止时间、未知结果后恢复、真实 worker 接线、运行时 active/notLoaded、身份不符和落盘后变 busy 的回归。审查发现的 failure/interrupt 范围问题也先用失败用例复现后收紧。

完整测试、定向测试及安装结果在本地 `evidence/local-connections-p0/repair-*`；此目录不公开提交。安装保留现有配对、原消息、Hook、Skill 和权限配置。旧两条未确认交付的回执不改为 delivered，不重发，也不自动归档。成功历史切换仍需满足它们的显式处置及真实窗口验收条件。

最终完整离线测试 310/310、定向 20/20，均 exit 0、fail/skipped 0。独立复审后无剩余安装阻断项。运行时 8 文件安装完成；保护文件与原消息哈希一致，正常恢复 Bus。原两条 Stop 的 event 保留，当前与历史连接的 artifactsPending 均为 0。历史恢复预览现被两条旧回执的 nativeOutstanding 拦截，未执行切换。

另提交一次新的无工具标记任务：精确原 Claude 已执行一次、正确最终文本已自动采集。当前 Codex 回合结束后，同一条回复已自动入站。独立原生读取复核 clientUserMessageId 对应的 clientId、原始会话及回合全部精确匹配；Bus 状态为 delivered，整轮正向往返通过。限时只读观察器已退出，未重发任务、未手工回信。

本次没有调用 queue/start：由原 Desktop 消费已入队消息完成。它证明更新后这一轮空闲自动回传成功，不能证明新增泵启动路径已获真实 Desktop 验收，也不能解释旧两条回执为何缺失。本次新入站不作为旧回执送达证据。

当前 unfinished=0、uncertain=0、artifactsPending=0，但旧回执 nativeOutstanding=2 仍保留。完整 P0（特别是历史恢复、成功切换）仍未通过；不得自动归档当前连接、清除旧收据或绕过切换保护。

## 第二轮：过期回执核对和断开恢复

继续修复时又复现了两个入口不一致的问题：`LocalBus.check` 跳过 expired，导致旧信息回复即使后来有精确原生证据也不能核对；`disconnectLocked` 的旧检查只看任务，漏掉未确认的 reply/native intent 和生命周期记录，还会先撤路由后确认 Bus 退出。

本轮只改 `src/bus.ts` 和 `src/installation/connections.ts`：

- 仅显式 check 可核对已经发送的 clean-v1 expired reply。有精确 native 证据才改 delivered，并标 late；没有证据不写记录。不重发，不更改父任务，不允许过期任务继续 followup；tick 不永久轮询 expired。
- 断开复用完整工作检查，未知 native 交付仍须显式 archive；明确 rejected/未写入的任务不会误挡正常断开。未应用或损坏生命周期状态仍阻止断开。
- 关闭前写入现有 durable transition guard，阻止直接 IPC 新投递；Bus 确认关闭后再次检查，再撤路由。IPC 不可达但匹配的 managed PID 仍活着时不视作退出。失败保留 guard 和现场，成功后只删除本次操作的 marker。失败残留 guard 仍须按原 P0 手动核对，不能自动删除。

10 个新增回归覆盖上述边界；初始 RED 6 失败，后续关闭竞态 2 失败、存活 PID 门 1 失败，均已修正。最终相关 31/31、完整 320/320，exit 0、fail/skipped 0，独立复审无剩余安装阻断项。

两个运行时文件已备份并更新，仅正常重启 Bus；原配对、路由、权限、Hook、Skill 和原消息保持不变。真实旧两条回执已通过新入口各核对一次，仍为 expired，缺少精确原生入站证明，没有擅改为 delivered、重发或归档。当前 Bus 运行，未完成/需检查消息及待应用事件均为 0，旧 nativeOutstanding 仍为 2；继续历史切换验收需要明确选择如何处置旧测试连接。

后续用户已明确授权归档该测试连接并恢复同一对聊天的旧配对。archive 与经预览的 switch apply 均已成功，8 条原历史及关联证据内容保持不变，没有将旧未知交付标为 delivered。恢复后新提交的一次任务已在原 Claude 执行并采集结果；回复等待当前 Codex 结束回合后的精确原生入站。完整恢复往返及切换回合结束事件仍待核对，不能用身份恢复成功代替通信验收。见 `LOCAL-CONNECTIONS-P0-LIVE-ACCEPTANCE.md` 的续验记录。

## 第三轮：切换回合的跨连接 Stop

恢复后的新任务已完整往返，7 项精确身份/结果/原生入站核对通过。同时确认同回合的 input 留在旧连接、Stop 进入新连接，使目标 artifactsPending=1。

最小补丁新增 `src/installation/lifecycle-control.ts` 并接入现有 callback，将忽略原因改为通用 `verified_control_execution`。仅依据 applied switch、相同 activation/端点、源中早于预览的同回合 ordinary/applied input，且无绑定/冲突/可能自动工作时处理严格空 Stop。源只读、不复制 input、不捕获普通聊天文本、不产生 reply。未映射 intent 默认阻止；精确原记录证明为非 auto 信息回复时才排除该候选，不更改其交付状态。

真实原始事件和隔离失败回归均支持根因；独立审查发现的未映射 intent 边界也先 RED 后修正。最终完整 324/324、定向 8/8，独立复审无安装阻断。备份后安装 3 个运行时文件，原异常事件 retained/applied，当前四类工作计数全部为 0；保护配置及源历史哈希保持不变。历史恢复及该轮正向往返通过，其他聊天对迁移和真实 queue/start 不在本轮已验证范围。完整证据索引见真实窗口验收文档末节。
