# 本机连接管理 P0：真实窗口验收

日期：2026-11-18（北京时间）。最新结果：同一对真实聊天的历史恢复、恢复后正向完整往返及切换回合事件修复通过；反向往返已在此前独立验证。三轮修复已安装，完整离线测试为 **324/324**。不同聊天对之间的迁移和真实 Desktop `queue/start` 路径未在本次窗口验收。下文保留基于 `7830d3d` 的初次失败及逐轮核对过程，最新结果见末节和 [阻塞修复记录](LOCAL-CONNECTIONS-P0-REPAIR.md)；不把初次失败记录或离线测试等同于最新完整实机结论。

## 已核对

| 项目 | 实际结果 |
| --- | --- |
| 更新安装 | 正常停止空闲 Bus，备份后安装 15 个运行时文件及两端 Skill。配对、路由及两端 Hook 设置在安装前后哈希一致；原 Bus 正常恢复。没有修改业务代码、原生权限或登录配置。 |
| 只读诊断 | 已安装版本运行 doctor 前后，原连接状态树的 58 个文件内容一致。显式 check-write 探针完成并移除。 |
| 列表及来源检查 | 本聊天历史与其他聊天的全局活动配对分开显示。当前聊天尝试恢复另一聊天的活动连接时被 source_session_mismatch 拒绝；配对及路由未改变。 |
| 原连接断开 | 用户明确选择改用当前聊天后，正常断开另一聊天的活动连接；历史保留，没有清除未处理事件。 |
| 连接码兑换 | 当前独立人工输入对应的原生 Hook 凭据兑换成功，精确配对当前 Codex 与用户恢复的 Claude。没有通过候选选择替代兑换，没有手填来源身份。 |
| 正向请求及采集 | 一次 Codex → Claude 请求被原 Claude 接收并正常回答 AGENTWIRE-P0-FORWARD-OK；自动结果已持久化。 |
| 多轮接续 | 对该精确回复提交一次 followup，原 Claude 正常处理，并按授权只提交一次反向 ask。 |
| 反向完整往返 | Claude → Codex 原生 clientId 与回合精确匹配；Codex 正常回答 AGENTWIRE-P0-REVERSE-OK；自动回传在原 Claude 的 peer 输入行得到确切交付证据。Claude 后续也确认收到。 |

## 尚未通过的项目

### 正向自动回传至 Codex

原正向回执和 followup 的信息回执没有找到匹配其 transportId 的 Codex 原生输入。第一次回执等待超过结果期限后转为 needs_check。原生队列只读查询返回空。

聊天中出现过同正文的正向回执，但其原生 clientId 与原回执 transportId 不同，分隔符文本也不同。因此不能将该行作为原回执自动交付证明，也不能仅凭这些事实断言是人工复制、原生队列丢失或其他具体原因。此前“正向已自动到达”的判断已收回。

初次验收没有重发、改写投递状态或用新消息 ID 替代原消息。后续独立修复回归中，新的一轮正向任务只执行一次，结果在原 Codex 回合结束后自动入站，精确 clientId/会话/回合匹配，Bus 状态 delivered；该轮完整往返通过。旧两条回执仍未验证，未拿新成功覆盖旧缺口。新增队列泵没有启动该轮任务，是原 Desktop 消费原生队列完成。

### 保存连接恢复及成功切换

修复前，本聊天的历史身份连接存在一条没有 input/execution 绑定的 Stop 事件。生命周期处理器对其返回 missing_input_binding 并保持 deferred；连接检查把未应用事件算作 artifactsPending，恢复预览因此返回 connection_storage_requires_check。

修复前，当前新配对也存在一条未关联 Stop。现已按精确的已验证配对控制意图处理这两条 Stop，并保留原事件，两处 artifactsPending 均为 0。两条上述回执仍缺少准确交付证明；恢复预览转为 connection_native_work_outstanding，成功切换的空闲前置条件仍不满足，未执行 apply。未删除事件、补造 input、猜测身份或绕过保护。

仍需要为可核验的未关联事件及投递不确定回执准备明确的恢复/处置流程，并在真实窗口验证后，才能声称历史恢复及 A/B 成功切换通过。新配对往返不能替代这一验收。

## 观察器说明

一次性观察器在反向回执短暂为 needs_check 时结束并要求核对；约两秒后 Bus 的原生证据核对将同一回执更新为 delivered。原观察器快照保留，结论以随后重新读取的原消息、原生输入及采集结果为准，没有重跑任务。

## 当前状态和证据

当前新配对与 Bus 保持运行。旧历史及未确定交付记录完整保留；未新增循环发送或长期观察服务。初次验收未修改生产源码；后续修复修改并安装了 8 个运行时文件，已备份且配置/原消息内容不变。没有推送或发布。

本地原始证据在隔离工程的 `evidence/local-connections-p0/`，不提交公开仓库：

- `live-install-preview.json`、`live-install-result.json`：安装预览、备份和执行结果。
- `live-readonly-and-source.json`、`live-write-access-and-status.json`：只读、来源拒绝及写入探针。
- `live-restore-attempt.json`：正常断开及历史恢复拦截。
- `live-current-diagnostic.json`：原任务、结果、收据及 Claude 原生输入。
- `live-codex-delivery-inspection.json`、`live-native-queue.json`：原生身份检查及队列查询。
- `live-window-monitor.json`：保留的一次性观察器早期状态。
- `live-acceptance-status.json`、`progress.md`：最新汇总、边界与结论修正。

## 用户批准处置后的历史恢复（续验中）

用户已明确批准归档当前测试连接并保留全部 8 条历史记录，再恢复同一对原生聊天的旧身份配对。产品 archive 成功；原消息、native intent、结果、事件和应用记录的逐文件哈希全部不变。归档没有证明那两条旧信息回执送达。

旧状态缺少可核验的诊断协议描述时，先确认其 IPC 不可达且工作为空，通过正常服务入口为该旧状态生成描述，再取得恢复预览。审阅的双方会话和目录完全一致；使用同一 operationId 在有效期内 apply 成功。精确路由、bindings、active pointer 和 transition guard 检查均通过。此处只确认历史身份恢复成功。

恢复后仅提交一次新的无工具标记任务。原 Claude 已接收、执行一次并输出指定结果，自动采集成功；回复的原生队列已接受。当前 Codex 回合尚未结束，回复仍待精确原生入站证据，因此尚不能声明恢复后完整往返或全部 P0 通过。限时只读观察器核对同一消息的 transportId、会话、回合和收据，不发送任务、不重试。完成后还须核对切换当前回合的 Stop 是否正确归属；不得把新未关联事件自动忽略。

私有证据：`archive-restore-preview.json`、`restore-apply-result.json`、`restored-live.json`、`restored-doctor.json`、`restored-observation.json`。本次未修改产品源码、原生 Hook 定义或权限，没有推送或发布。

## 历史恢复往返及切换回合修复结果

后续观察确认恢复任务的 7 项核对全部通过：精确恢复身份、归档历史不变、原任务仅执行一次、原 Claude 的指定结果、父子回复关联、delivered 收据，以及独立原生读取匹配 transportId / 原会话 / 原生回合。该次恢复后的 Codex → Claude → Codex 完整往返通过；没有重发旧任务。

观察同时复现了切换中间回合的遗留问题：输入 Hook 已写入旧连接，而 Stop 按新路由进入恢复连接，导致一个 missing_input_binding 事件。新增 `installation/lifecycle-control.ts` 只用已完成切换记录和旧连接中同 provider/session/execution 的已应用普通输入证明其来源；确认原 activation、时间、唯一切换证明，排除绑定、冲突及可能的自动任务。仅已有严格门允许的无输出、无错误、无后台或续行标志 Stop 可以标记已处理；失败、中断及不明事件继续保留。

审查中补充了未映射 intent 的拒绝边界：同一会话的未映射协作 intent 默认阻止豁免；只有通过原记录、active attempt、方向、两端 session 和正文摘要核验的非 auto informational reply 可以排除。此判断不证明该 reply 已送达，也不将 Stop 绑定到它；原回执和归档历史不修改。

新增 4 项集成测试（包含双向切换及多组安全边界），先复现失败，再修复；最终完整 **324/324**、定向 **8/8**，均 exit 0、fail/skipped 0。独立复审无剩余安装阻断项。备份后更新 3 个运行时文件并正常重启 Bus；原始异常 Stop 保留且已应用，当前 unfinished / uncertain / nativeOutstanding / artifactsPending 全部为 0。配置、Hook、Skill、权限、配对、原消息及归档证据内容未变。没有推送或发布。

本次完成的是同一对真实聊天的历史身份恢复、恢复后正向完整往返和切换回合事件修复。此前反向往返已独立验证；本次恢复后没有再次发起反向任务。不同聊天对之间的迁移及真实 Desktop `queue/start` 路径仍未在本次窗口验收，不把这些额外范围标为已通过。

私有追加证据：`switch-control-red-native.txt`、`switch-control-review-red.txt`、`switch-control-reply-red.txt`、`switch-control-focused.txt`、`switch-control-full.txt`、`switch-control-live-proof.json`、`switch-control-install-result.json`、`switch-control-final-doctor.json`。
