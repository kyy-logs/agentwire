# 配对原生能力：P0 阶段报告

日期：2026-11-17。状态：P0 原生能力已有实证，但仍未全部通过；子 Agent 原生负例被 Claude 自动审批的模型不可用错误阻止。仅按计划中记录的执行顺序例外完成 Task 2 纯读取核验代码，持久配对、路由与安装仍未实施。

最新自主处理结果：子 Agent 独立有界复测仍得到一次相同的自动审批模型不可用错误，随后停止，不改权限、不重放旧请求。本机已配置代理的只读健康与模型列表接口均 HTTP 200；这不证明其分类模型可用，也未据此修改代理或模型配置。

已有真实子 Agent 元数据可用于隔离分支回放：Codex 样本版本与本机一致，来源为 subagent；Claude 样本为 2.1.268，isSidechain=true，明确不是当前 2.1.318 的现场样本。以该元数据替换四类固定控制正文均拒绝，仅声明元数据回放通过，仍不提升当前子 Agent 原生验收。

新增产品代码只含 `src/pairing/model.ts` 和 `capture.ts`，尚未接入任何现有入口。正式句式解析、两端原生来源/输入/cwd 精确匹配、120秒原生时间期限、受限路径和最近8MiB证据窗口均为只读操作；证据缺失或迟于 Hook 尚未写入时返回未验证，不在 Hook 内等待。新增 15 项测试先观察 RED 再 GREEN；完整离线回归 `npm test` 在普通隔离临时目录 exit 0，199 pass / 0 fail / 0 skipped。先前沙箱目录运行因多处 rename EPERM 失败，原始失败日志另存，不计为通过；普通目录复跑实际覆盖 junction 拒绝用例。尚未进行新代码的当前原窗口正式句式验收，不宣称“生成连接码”已可使用。

## 当前结果（覆盖下文早期调查状态）

| 验证 | 当前证据 | 结论 |
|---|---|---|
| Codex 人工发码 / 兑换诊断 | 精确 session、turn、composer 根来源、正文 Hash、developer 凭据上下文、final_answer / task_complete | 两项原生阳性通过 |
| Claude 人工发码 / 兑换诊断 | 精确 session / promptId、human、非 sidechain、正文 Hash、同输入的 hook_additional_context/system | 两项原生识别和上下文交付通过；兑换模型未回显 ACK，不算模型服从通过 |
| Codex 队列相同口令 | 精确 Hook 回合为 queue，Hook 执行时亦读到该来源；完整输入和回合结束可查 | 能区分于人工 composer；临时证据核验器拒绝 |
| Claude peer 相同口令 | 精确 transport uuid / promptId 为 peer；持久正文有厂商包装，Hook Hash 对应原始提交口令 | 能区分于 human；临时证据核验器拒绝 |
| Codex 工具输出相同口令 | 实际工具输出与前后事件集合 | 未新增发码 Hook 事件 |
| Claude 工具输出相同口令 | Bash 工具结果 is_error=false、输出 trim 后精确相等；未新增发码 Hook 事件 | 原生工具输出负例完成 |
| 子 Agent 相同口令 | Claude 实际 Agent 工具两次返回相同自动审批错误，未执行子 Agent | 原生验收未通过；离线拒绝分支不替代此项 |
| 同标题不同聊天 | 既有新会话 ID 与原聊天不同；错身份离线用例拒绝 | 正式产品的同标题配对还需原窗口验收 |

临时来源核验原型先观察到 RED（4 pass / 1 fail），实现后 5/5；随后真实 Claude 数据揭示工具续行共享 promptId，新增该边界先 RED（5 pass / 1 fail），排除 tool_result 后 6/6。原生记录矩阵 6/6：双方人工发码与兑换允许核验，双方 peer/queue 口令拒绝。探针自身的限范围/隐私自检另有 6/6。这些均为私有 P0 原型和调查结果，不是产品模块、正式授权或全量安装验收。

自动审批原始原因：`claude-opus-4-8 is temporarily unavailable, so auto mode cannot determine the safety of Agent right now.` 请求本来只要求一次子 Agent 测试，Claude 自行又尝试一次，均返回错误；本端未再次提交请求、不继续重试，不调整权限或绕过分类。Agent 未执行，不能报告子 Agent 负例成功。

另有必须解决的时序事实：Codex Hook 捕获发生在完整 user 输入持久记录之前，间隔约 0.589 秒。队列负例的 at-Hook 快照能读到精确 task_started/queue，但 matchingInputRecords=0。不能按原计划假定 Hook 内始终能完成输入 Hash 复核；实际发码/兑换动作必须在完整原生输入可验证之后才准入，证据未齐时保持未授权。此项接口调整仍待后续任务实现，未把未验证请求提升为 PairIntent。

当前未创建任何持久配对产品模块，未激活产品安装，未改变 Bus 连接；两端诊断 ACK 不是一次性连接码。一次性 Codex 观察器已完成并发送唯一续行通知，不继续运行或重复投递。

本报告对应 `docs/superpowers/plans/2026-11-17-pairing-codes-plan.md` Task 1。产品基线 0.1.1；隔离工作区起点 `4b21331`。已按用户对具体增量的授权追加临时诊断 Hook，已备份并核对；当前运行时与活动连接未修改。

## 已执行

- 隔离工作区离线基线：`npm test`，184 pass，0 fail，exit 0。
- 临时观察脚本自检：普通输入/其他会话不采集；过期/非输入事件忽略；诊断凭据不等于配对授权。3 pass，0 fail。临时脚本不是产品实现，不加入运行时。
- 后续临时脚本回归：处理桌面末尾换行、缺原生输入身份时只记录限范围固定口令的拒绝元数据、不采集普通输入；当前 6 pass，0 fail，exit 0。它们是离线测试，不计为原生通过。
- 只读检查 Codex 当前原会话的 `thread/items/list`、`thread/turns/list`，并导出当前二进制自带实验协议 schema。没有 queue/add、turn/start 或模型调用。
- 对明确的既有 Claude 原会话只读提取输入记录的字段与来源分类，不导出正文。

## 观察结果

| 项目 | Codex | Claude Code |
|---|---|---|
| 本机版本 | 0.169.0-alpha.11.1 | 2.1.318 |
| 原生聊天 ID | CODEX_THREAD_ID 与原生查询 | 原生 sessionId |
| 原生输入身份 | turnId / userMessage.id | promptId / uuid |
| 来源证据 | Hook 提供的当前 transcript_path 中精确 turn_attribution 实测 composer；items/turns 投影仍不能替代它 | 已观察 origin.kind=human / peer；tool_result 有独立 block 类型 |
| Hook 回传上下文 | 原窗口实测：精确回合 developer 上下文包含诊断凭据，最终 ACK 匹配 | 当前选定聊天实测 hook_additional_context/system 绑定精确人工输入；发码回显 ACK，兑换未回显 |
| 未配对聊天实际发码/兑换 | 发码诊断阳性通过；兑换与负例控制未完成 | 发码诊断阳性通过；兑换输入与上下文附件已匹配，但模型未按要求回显 ACK；完整负例未完成 |
| 普通聊天、对方相同正文、工具输出、子 Agent、错窗口负例 | 未完成 | 只观察到现存原生分类，尚未完成固定口令对照 |

Codex 旧 JSONL 中观察到 task_started 的 turn_attribution，包含 composer 来源。但当前会话使用分页历史；旧文件不是当前回合证明，不能拿旧来源记录授权新输入。未为产品引入原生数据库读取或 SQLite 依赖。

## 当前能力记录

Codex 新增原生阳性证据：trim 修复后的直接人工口令产生真实 Hook 记录。只读解析该 Hook 指定的当前 transcript_path，逐项核对 session_meta、精确 turn_id、composer 根回合、原输入 Hash、同回合 developer 凭据、精确 final_answer 与 task_complete，全部匹配。此结果不是用户随后复制 ACK 得出的，也不是合成命令结果。私有验证报告为 codex-issue-evidence.json，passed=true。确认发码诊断路径，但不把它算成正式发码或完整 P0。

只读现存历史还观察到队列任务的 turn_trigger=queue，可与 composer 区分；有人工粘贴的 peer 格式文本仍属 composer，说明不能按正文外观判定来源。这不是固定口令的真实 peer/工具/子 Agent 负例验收，不能代替剩余控制。当前 Hook 不直接提供 origin，后续核验必须使用精确当前回合，禁止使用整个聊天的“最近 composer”。

当前 Claude 新增两次真实输入：发码输入的 session/promptId、人类来源、主聊天、原文 Hash 和最终 ACK 行及 parentUuid 链全部匹配。最终回答含额外解释，因此只声明精确 ACK 行返回，不声明整条回答是一行。兑换输入也已匹配上述身份与 Hash；同一输入的原生祖先链中有 hook_additional_context 附件，renderedRole=system，附件和 rendered 均含该次独立凭据；最终模型回答却否认协议、没有回显 ACK。原生上下文交付与模型遵循指令必须分开计，不要求重发已提交输入，不据此声称完成正式兑换。私有证据为 claude-current-issue-evidence.json 和 claude-redeem-diagnosis.json。

补充实测：用户选择继续原 Claude 聊天。其固定发码口令的原生 user 记录为 `origin.kind=human`，sessionId 与 promptId 精确匹配临时 Hook 记录；Hook 诊断凭据与最终 ACK 完全一致，最终 `end_turn` 回答经 parentUuid 链追溯到该人工输入。Claude 发码阳性路径通过。尚未验证兑换路径、完整负例或 Codex 路径，因此总体 supported 仍为 false。

另一个新开的 Claude 聊天未在白名单内，其运行 Python 自行生成的 ACK 没有后台探针凭据，不计为通过。用户级 Claude 配置在追加探针后被外部改写，临时和 Bus Hook 条目均缺失；修改来源未证实，未覆盖修复。已有原 Claude 阳性证据早于此项诊断，不能推定后续 Hook 仍可执行。

```json
[
  {
    "provider": "codex",
    "supported": false,
    "nativeVersion": "0.169.0-alpha.11.1",
    "inputIdentityField": "turn_id",
    "provenanceMethod": "observed: Hook transcript_path, exact session and turn, root composer attribution and prompt hash",
    "ticketDeliveryMethod": "observed: exact-turn native developer context and matching final answer",
    "reason": "issue_positive_verified_redeem_and_live_negative_controls_pending"
  },
  {
    "provider": "claude",
    "supported": false,
    "nativeVersion": "2.1.318",
    "inputIdentityField": "prompt_id",
    "provenanceMethod": "observed: exact native sessionId and promptId, origin.kind=human, isSidechain=false, hash and parentUuid lineage",
    "ticketDeliveryMethod": "observed: exact-prompt hook_additional_context system attachment; issue ACK returned, redeem ACK not followed",
    "reason": "native_issue_and_redeem_context_observed_live_negative_controls_and_client_consumption_pending"
  }
]
```

`supported:false` 在此表示尚未通过完整门槛，不是断言厂商不支持。即便 additionalContext 测通，Codex 来源缺口仍必须补足；不能根据字符串、最近记录或模型填写 ID 放行。

## 下一步与配置范围

用户随后批准对当前唯一在线 Claude 聊天启用探针。按当前配置准备具体增量、另存字节备份，仅追加一条 UserPromptSubmit 并切换私有诊断 scope 到该在线聊天，保留原有其他设置、Codex scope 和原失效时间；核对其余配置完全相同。该授权不建立 Bus 连接，不证明新聊天产品配对已实现。仍等待 trim 修复后的 Codex 人工口令和当前 Claude 的真实输入证据。

用户已批准“安装一次，新聊天直接配对”的补充设计并要求实施；计划已同步固定入口、新聊天不预登记、故障诊断和跨目录验收。P0 限范围白名单仅用于临时探针，不能带入产品配对准入。Task 1 门槛保持，尚未开始产品 capture/store 等模块。

Codex 补充诊断：按 cwd 查询的 hooks/list 显示探针 enabled=true、trusted；功能标志 hooks=true。独立 App Server 无法查询原桌面会话的已加载 Hook（thread not found），因此不能把 cwd 查询当原会话已加载证明。同一 EncodedCommand 在隔离合成目录执行成功，返回有效 additionalContext；不计入原生验收。用户正常重开桌面并返回同一聊天后，纯文本口令仍未生成探针记录，未证实“重启能解决”的假设。

随后通过厂商元数据定位到了迁移后的当前 rollout。原生固定口令末尾含换行符，而临时探针使用未经 trim 的全字符串比较：两条纯文本输入均 exact=false、trimExact=true。新增实际格式回归先失败（3 pass/1 fail），修正临时脚本仅裁掉首尾空白后变为 4/4；包含额外正文或代码围栏仍拒绝。命令配置未变，未扩大会话范围。修复后的原生路径仍待一次新的人工输入验证，不能据离线测试直接判定通过。

当前 rollout 的 task_started 还实际观察到本次口令的 turn_trigger=composer 及完整根回合身份，修正此前“仅能看到旧 composer 记录”的调查范围。产品应验证 Hook 提供的当前 transcript_path 与该回合证据；本次仅临时只读厂商元数据定位文件，不将数据库访问带入运行时。

临时只读查询了厂商已有诊断日志，发现当前聊天的 legacy_notify 有 Windows OS206 错误；它属于另一路 after_agent Hook，未据此认定是新 UserPromptSubmit 的失败原因。此诊断未为 AgentWire 引入数据库、持久化机制或运行依赖。

私有临时目录保存固定口令探针、两份 UserPromptSubmit 增量、配置基线 Hash 和撤销说明。用户已批准该具体增量，已完成两端各追加一个独立 Hook 组及原字节备份；等待原生信任与用户固定口令输入。探针只处理两条固定测试口令、精确登记的两个会话，24 小时失效；普通聊天不落盘。它不创建配对授权，不操作 Bus，不变更原连接。

若真实 Hook 与可核验的原生证据仍不能补足 Codex 输入来源，记录明确限制并停止后续产品实现，提出最小的替代设计供用户评估；不悄悄降低标准。

## 参考与证据边界

- [Codex UserPromptSubmit schema](https://github.com/openai/codex/blob/main/codex-rs/hooks/schema/generated/user-prompt-submit.command.input.schema.json)：字段列表没有直接的 human/peer 来源字段。
- [Codex Hook 实现](https://github.com/openai/codex/blob/main/codex-rs/hooks/src/events/user_prompt_submit.rs)：请求序列化和 additionalContext 处理。
- [Codex TurnAttribution](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/turn_input.rs)：turn_trigger 与来源信息的内部契约。公开 main 代码不等于本机二进制的全部行为；本报告以本机实际响应为准。
- [Codex Hook 文档](https://learn.chatgpt.com/docs/hooks#userpromptsubmit)、[Claude Hook 文档](https://code.claude.com/docs/en/hooks#userpromptsubmit)：上下文输出契约，不代替当前窗口的实测。
- 仓库 `src/installation/source.ts:readCallerSource`、`src/installation/hook-router.ts:routeHook`、`src/native/{codex,claude}-evidence.ts`：当前实现的身份读取、已配对路由过滤和原生证据机制。

公开报告不包含真实会话 ID、本机路径、随机诊断凭据或原始聊天。
