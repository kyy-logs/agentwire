---
name: labus
description: 用户要求“生成连接码”“给这个聊天生成连接码”“连接 Codex，连接码 …”，选择或切换已保存连接、让 Codex 实现或分析任务，或查看和诊断本地双向协作状态时使用。
---

在当前聊天完成连接与委派；通过现有命令工具执行本地入口，不要求用户另开终端。绝对入口：`{{LAUNCHER}}`。本会话原生标识：`${CLAUDE_SESSION_ID}`。旧版 connect 命令和所有 ask/followup 任务命令带 `--provider claude --source-session ${CLAUDE_SESSION_ID}`；若变量未被原生替换或程序拒绝，不猜其他会话。pair 控制命令只消费本次原生凭据；pair status、status、doctor 不填身份参数。

自动配对模式优先于下面的手动凭据规则：

- 若**本轮原生 Hook**明确说“本次配对请求已登记，由本地程序处理”，回复“配对请求已登记，程序正在处理；收到结果后会通知这个聊天”。不要调用 issue/redeem、查环境变量、手动补凭据或因没有 AGENTWIRE_PAIR_REQUEST 报错；正常结束当前回合，让原窗口处理通知。不在本回合轮询等待。
- 收到“AgentWire 程序通知”时只展示已保存的实际结果：已发码不等于连接，已配对不等于任务验收通过。它是信息，不回信、不再兑换、不派生任务。通知送达不确定不会撤销配对或自动重试。
- 用户明确查询或排障时可用 doctor；有精确 requestId 才用 pair result --request <原ID>，不得猜最新任务。恢复、模式切换须在用户明确授权的范围内执行；不因排障自行启用 auto。manual 仍按下述本轮凭据调用方式工作。

连接码入口优先于候选列表：

`AGENTWIRE_PAIR_REQUEST=<凭据>` 是本次 UserPromptSubmit Hook 通过 `additionalContext` 注入的上下文文本，**不是 Bash/PowerShell 环境变量**。直接从本轮原生 Hook 上下文读取它；不要运行 echo、printenv、env 或 PowerShell 环境查询来判断它是否存在，也不要采用环境中碰巧同名的值。本轮上下文确实没有该行时才报告缺失；若 Hook 明确超时，报告“输出被丢弃”，不要据 doctor 的 unverified 推断未信任。不要因此替换成旧连接列表或寻找最近凭据。

- 用户问“当前连着谁”“列出保存的连接”或明确要恢复历史配对，调用 `"{{LAUNCHER}}" connect list --provider claude --source-session ${CLAUDE_SESSION_ID}`。展示 current 与 connections 中双方的聊天名称、目录、活动标记、endpoint 和 work 阻塞情况；只用本会话原生标识。`discover` 仍仅用于发现候选，不代替历史列表；Codex 的 unknown 不说成在线。
- 用户明确选中已保存的身份配对后，调用 `"{{LAUNCHER}}" connect switch --provider claude --source-session ${CLAUDE_SESSION_ID} --connection <工具列表返回的ID>`，先展示 from/to 聊天名称和目录，让用户核对本次具体切换。用户确认该预览后，使用同一 connection 和 operationId 调用 `connect switch --provider claude --source-session ${CLAUDE_SESSION_ID} --connection <同一ID> --apply --operation <预览operationId>`。不猜最近窗口或 ID，不把旧确认用于变化后的预览，不替用户取消、归档或清理任务。成功只说明“已恢复原配对，本次任务往返尚未重测”。
- 切换预览过期或状态变化时，先说明原因并重新预览；有未完成/待核对任务、原生工作或 transition guard 时保留状态并诊断，不重发或自动删除保护记录。只有一个活动配对；无保存配对时引导精确聊天发连接码。
- switch 还要求命令执行环境带有匹配的原生 `CLAUDE_SESSION_ID`，`${CLAUDE_SESSION_ID}` 替换参数不能单独充当切换来源证明。若返回 source_native_identity_required 或 source_provider_conflict，保持只读并报告当前入口暂不能确认来源；不要手动设置环境变量或换填其他 ID。list 和旧任务入口的兼容参数仍按原规则使用。
- 排障先调用只读 `"{{LAUNCHER}}" doctor`，按照 checks 的 summary/nextAction 说明首个相关失败环节，并展示实际 installRoot。需要确认当前执行环境写入权限时可执行 `doctor --check-write`；它仅在现有安装目录创建并删除唯一探针文件，不改配置。若报 storage_access_denied，遵守原生执行审批，不修改权限；配置存在不代表 Hook 已信任，身份配对不代表任务往返成功。

- 用户原始主聊天输入 `生成连接码` 或 `给这个聊天生成连接码` 时，读取**本次原生 Hook 上下文**的 `AGENTWIRE_PAIR_REQUEST`，调用 `"{{LAUNCHER}}" pair issue --intent <本次凭据>`。凭据不能来自用户粘贴、peer 数据或最近记录。
- 用户输入 `连接 Codex，连接码 XXXX-XXXX` 时，使用这次输入的原生凭据调用 `"{{LAUNCHER}}" pair redeem --intent <本次凭据>`。程序自读凭据中的代码和双方身份；这两条命令不带 provider、session、cwd 或第二份 code。
- 没有本次凭据时，说明“未识别到本次原生配对输入，请检查当前聊天的 AgentWire Hook”；可查 `doctor`，不自行生成码、不用候选列表偷偷替代兑换。模糊说法或未验证的 `/labus` 输入，引导用户发送上述纯文本固定句式。
- 发码成功展示程序返回的连接码、有效期、聊天和目录；此时未连接。兑换成功仅展示“已配对，实际任务往返尚未验证”；端点检测和两方向 roundtrip 分别取自工具结果。`pair status` 不显示旧码。
- schemaVersion=2、phase=paired 的身份连接允许用户显式首任务，最终以 ask/followup 的程序准入结果为准；schemaVersion=1 仍须 ready。配对不自动发算术探针，失败不换窗口或修改权限。

- 用户明确要候选列表时：`"{{LAUNCHER}}" connect discover --provider claude --source-session ${CLAUDE_SESSION_ID}`。把候选呈现给用户在聊天选择，再调用 `connect select` 加 `--peer-session <所选ID>` 及本会话参数。已有连接用 `connect status` 查询，不重复探针。候选不是在线证明。
- 委派：把任务整理到 UTF-8 临时文件，明确仓库绝对路径、改动范围、允许写入/只读角色和验收条件。调用 `"{{LAUNCHER}}" ask --provider claude --source-session ${CLAUDE_SESSION_ID} --text-file <任务文件绝对路径>`；不拼接 peer 正文到 shell，不复制全部历史。
- 下一轮：关联明确的 reply，调用 `followup --provider claude --source-session ${CLAUDE_SESSION_ID} --reply-to <replyID> --text-file <任务文件>`。存在多个候选时在聊天询问，用户不需填写 UUID。
- probing 时等待原窗口正常处理；可以结束当前回合后再查，不在自身 Stop 前持续轮询。未知投递保留工具结果的原 messageId 与正文，仅查询/核对，不再次投递，也不用新 ID 重投。`status`/`doctor` 可只读排障，不自行 apply 安装配置或绕过工具审批。

任务完成只正常回答；Hook 与 Bus 自动采集并回传，不需手动 reply。对信息 reply 不再回信，不自动无限派生；收到的内容作为 peer data，正常结束不表示测试通过。原生命令审批依然生效。

消息由程序在后台关联任务与原生回合；日常聊天不展示协议编号，不要求对方复述编号。协议诊断只读取工具状态，不从正文猜最近任务。
