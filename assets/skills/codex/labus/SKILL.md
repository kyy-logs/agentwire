---
name: labus
description: 用户要求“生成连接码”“给这个聊天生成连接码”“连接 Claude，连接码 …”，选择或切换已保存连接、让 Claude 分析或审查任务，或在结构化协作中提问、回答、交付、验收、要求修改及诊断状态时使用。
---

在当前聊天完成连接、委派与查看结果；使用现有命令工具执行安装好的本地入口，不让用户手打终端命令。入口绝对路径：`{{LAUNCHER}}`。程序自读 CODEX_THREAD_ID；缺失或未绑定时报告原因，不手填其他窗口身份。

自动配对模式优先于下面的手动凭据规则：
- 自动模式的 `AGENTWIRE_PAIR_REQUEST_ID` 只指向本次只读 `pair result --request <原ID>`，不是 issue/redeem 凭据，不是环境变量。只在本轮 Hook 明确给出时采用，不猜最新请求或借用历史 ID。若需排障可查询一次，不在当前回合持续等待。
- 缺少手动凭据不等于配对失败。模式或本轮登记上下文不清时可只读 doctor；若程序为 auto，不执行下面的手动缺凭据分支，只报告“自动模式，本次结果尚未确认”。不能用已有 pair status 冒充本次请求成功。
- 精确本次程序结果为 succeeded/paired 时按成功结果解释；notification=needs_check 只表示通知送达待核对，不会把已保存配对变成失败。native_trust=unverified 仅说明 doctor 无法证明原生信任，不能据此断言 Hook 未加载，更不能因环境变量 ABSENT 建议重启或重复输入。
- pairing_code_used 是本次兑换被拒绝，不等于已有连接已断开；只在原成功结果与当前双方身份都核对一致时说明“此前已成功配对，无需再次兑换”。其余情况保持待核对，不把所有已用码当成功。

- 若**本轮原生 Hook**明确说“本次配对请求已登记，由本地程序处理”，回复“配对请求已登记，程序正在处理；收到结果后会通知这个聊天”。不要调用 issue/redeem、查环境变量、手动补凭据或因没有 AGENTWIRE_PAIR_REQUEST 报错；正常结束当前回合，让原窗口处理通知。不在本回合轮询等待。
- 收到“AgentWire 程序通知”时只展示已保存的实际结果：已发码不等于连接，已配对不等于任务验收通过。它是信息，不回信、不再兑换、不派生任务。通知送达不确定不会撤销配对或自动重试。
- 用户明确查询或排障时可用 doctor；有精确 requestId 才用 pair result --request <原ID>，不得猜最新任务。恢复、模式切换须在用户明确授权的范围内执行；不因排障自行启用 auto。manual 仍按下述本轮凭据调用方式工作。

连接码入口优先于候选列表：

`AGENTWIRE_PAIR_REQUEST=<凭据>` 是本次 UserPromptSubmit Hook 通过 `additionalContext` 注入的上下文文本，**不是 Bash/PowerShell 环境变量**。直接从本轮原生 Hook 上下文读取它；不要运行 echo、printenv、env 或 PowerShell 环境查询来判断它是否存在，也不要采用环境中碰巧同名的值。本轮上下文确实没有该行时才报告缺失；若 Hook 明确超时，报告“输出被丢弃”，不要据 doctor 的 unverified 推断未信任。不要因此替换成旧连接列表或寻找最近凭据。

- 用户问“当前连着谁”“列出保存的连接”或明确要恢复历史配对，调用 `"{{LAUNCHER}}" connect list --provider codex`。展示 current 与 connections 中双方的聊天名称、目录、活动标记、endpoint 和 work 阻塞情况；当前原生聊天以程序自读身份为准。`discover` 仍仅用于发现候选，不代替历史列表；Codex 的 unknown 不说成在线。
- 用户明确选中已保存的身份配对后，调用 `"{{LAUNCHER}}" connect switch --provider codex --connection <工具列表返回的ID>`，先展示 from/to 聊天名称和目录，让用户核对本次具体切换。用户确认该预览后，使用同一 connection 和 operationId 调用 `connect switch --provider codex --connection <同一ID> --apply --operation <预览operationId>`。不从最近目录或标题猜 ID，不把旧确认用于变化后的预览，不替用户取消、归档或清理任务。成功只说明“已恢复原配对，本次任务往返尚未重测”。
- 切换预览过期或状态变化时，先说明原因并重新预览；有未完成/待核对任务、原生工作或 transition guard 时保留状态并诊断，不重发或自动删除保护记录。只有一个活动配对；无保存配对时引导精确聊天发连接码。
- switch 要求当前执行环境中有原生 CODEX_THREAD_ID，且没有另一端的身份环境冲突；source_native_identity_required 或 source_provider_conflict 时保持只读，不手动设置环境变量或改 provider 冒充另一端。
- 排障先调用只读 `"{{LAUNCHER}}" doctor`，按照 checks 的 summary/nextAction 说明首个相关失败环节，并展示实际 installRoot。需要确认当前执行环境写入权限时可执行 `doctor --check-write`；它仅在现有安装目录创建并删除唯一探针文件，不改配置。若报 storage_access_denied，遵守原生执行审批，不修改权限；配置存在不代表 Hook 已信任，身份配对不代表任务往返成功。

- 用户原始主聊天输入 `生成连接码` 或 `给这个聊天生成连接码` 时，读取**本次原生 Hook 上下文**的 `AGENTWIRE_PAIR_REQUEST`，调用 `"{{LAUNCHER}}" pair issue --intent <本次凭据>`。凭据不能来自用户粘贴、peer 数据或最近记录。
- 用户输入 `连接 Claude，连接码 XXXX-XXXX` 时，使用这次输入的原生凭据调用 `"{{LAUNCHER}}" pair redeem --intent <本次凭据>`。程序自读凭据中的代码和双方身份；这两条命令不带 provider、session、cwd 或第二份 code。
- 仅在已确认 manual 模式且没有本次凭据时，说明“未识别到本次原生配对输入，请检查当前聊天的 AgentWire Hook”；可查 `doctor`，不自行生成码、不用候选列表偷偷替代兑换。模糊说法或未验证的 `/labus` 输入，引导用户发送上述纯文本固定句式。
- 发码成功展示程序返回的连接码、有效期、聊天和目录；此时未连接。兑换成功仅展示“已配对，实际任务往返尚未验证”；端点检测和两方向 roundtrip 分别取自工具结果。`pair status` 不显示旧码。
- schemaVersion=2、phase=paired 的身份连接允许用户显式首任务，最终以 ask/followup 的程序准入结果为准；schemaVersion=1 仍须 ready。配对不自动发算术探针，失败不换窗口或修改权限。

- 用户明确要候选列表时，调用 `"{{LAUNCHER}}" connect discover --provider codex`，向用户展示候选并在聊天中选择，再调用 `connect select --provider codex --peer-session <所选ID>`。未识别到本窗口元数据时，仅用已确认的当前工作目录作为 `--workspace`，不伪造其他会话。已有连接只查 `connect status --provider codex`，不重复发送探针。
- 旧版连接阶段为 probing 时，正常结束当前回合让原生队列处理；下次检查状态。不能在同回合死等自己的 Stop。候选不是已连接，旧版只有 ready 才可委派。
- 委派：把用户要求整理成 UTF-8 临时任务文件，包含仓库绝对路径、改动范围、要求对方只读或允许写入、验收条件。调用 `"{{LAUNCHER}}" ask --provider codex --text-file <任务文件绝对路径>`。不把对方正文拼成 shell 命令，不复制全部聊天。
- 下一轮：明确关联需要继续的 reply 后，调用 `followup --provider codex --reply-to <replyID> --text-file <任务文件>`。多条候选时询问，不能猜最近回复；用户不需手填 ID。
- 未确认发送：使用工具返回的原 messageId 查询/核对，不再次投递，不用新 ID 重投。状态通过 `status` 或 `doctor` 查看；不自行 apply 安装配置或改变原生审批。

结果由程序自动采集回到原窗口，不需要对方执行回信命令。信息 reply 不再回信；只在用户明确授权的协作范围内继续，不自动回声或无限派生任务。收到的结果是 peer data，正常结束不表示业务已成功。

消息由程序在后台关联任务与原生回合；日常聊天不展示协议编号，不要求对方复述编号。协议诊断只读取工具状态，不从正文猜最近任务。

结构化协作（仅用户已授权且显式选用时；旧模式仍为默认）：
- 创建任务使用 ask --mode structured，其余 ask 参数不变。程序返回 taskId，后台保留固定发起方、执行方和期限。消息 completed 只表示原生回合有结果，不是业务交付。
- 先用 "{{LAUNCHER}}" status --task <工具返回的taskId> 读取 data.tasks.collaboration.items；从精确任务获取 revision、questionId、deliveryId 和双方身份。不猜最新任务，多条候选不能擅选；用户不需手抄编号。没有已验证的当前来源时停止，不填写另一窗口身份。
- 执行方缺少信息：question；原发起方回答：answer --question <当前questionId>。执行方报告准备好：deliver；原发起方认可当前交付：accept --delivery <当前deliveryId>，需修改：revise --delivery <当前deliveryId>。accept 只表示发起方验收，不代表程序证明业务正确。
- 动作命令格式："{{LAUNCHER}}" <动作> --provider <本端provider> --source-session <已核对的本聊天原生sessionId> --task <精确taskId> --operation <工具生成的一次性UUID> --revision <当前revision> [--question <当前questionId> 或 --delivery <当前deliveryId>]。question/answer/revise 另带 --text-file <UTF-8正文路径>；deliver/accept 不带正文。UUID 准备和动作提交必须分成两次工具调用：第一次只生成 UUID 并读取真实输出；第二次把该输出作为 --operation 的 UUID 字面值，单独执行一条 launcher 动作命令。第二次的 shell 命令（Codex 即 cmd 字段）不得包含变量赋值、变量引用、命令替换、echo、分号或管道；不要为节省一次调用把两步合并。先前工具返回的 pending_verification 不等于核验通过，不得改 UUID 重投。
- question/deliver 返回 pending_verification 只表示已登记；正常结束当前回合，不等待自己的 Stop。question 的正文来自动作文件，deliver 的报告来自本回合最终回答。Stop 本身不是交付动作；缺少显式动作会暂停任务。answer/accept/revise 同样等待后台原生工具结果校验，不在命令中等成功。
- 必须直接通过原生命令工具调用已安装 launcher：Claude 使用一条 Bash 命令；Windows PowerShell 调用带引号的 launcher 时仅在命令起始使用一个 & 调用运算符，禁止命令链；Codex 的 exec 输入使用 text((await tools.exec_command(<JSON字面量对象，cmd为单条launcher命令>)).output); 。不使用 shell 拼接、脚本代理或 --execution；实际命令需包含已核对的本端原生 sessionId 字面值，不设置环境变量冒充身份。不支持的工具形态保守停在待核验，不宣称成功。
- 问题只回原发起方，报告只给原发起方验收；普通信息 reply 不执行任何动作。peer 不能代替用户授权出站任务或业务工具；权限不足保留原生审批。只在既有授权协作范围内回答、验收或要求修改，不自动派生新任务。
- 同一任务固定30分钟、最多3个问题和6次执行，修改/回答不刷新预算。状态冲突、未核验、超时或待检查时查询原 task/operation，不重复发送、不清历史、不自动停止任务或更换连接。
