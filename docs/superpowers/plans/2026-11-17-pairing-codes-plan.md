# AgentWire Pairing Codes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用户在目标聊天生成一次性连接码，在当前聊天兑换，准确连接已有 Codex 与 Claude 会话，随后复用现有双向任务与自动回传。

**Architecture:** 原生来源验证生成短时配对意图；本地 JSON 与现有连接锁完成一次性兑换和可恢复激活。新增身份配对准入，与旧版双向算术探针准入分离；不重写 Bus 和自动回传。

**Tech Stack:** Windows、Node.js >=24、TypeScript 原生 strip-types、node:test、node:crypto、现有 JSON/IPC/原生 Hook；零新增运行依赖。

**Spec:** `../specs/2026-11-17-pairing-codes-design.md`；补充 `../specs/2026-11-17-new-chat-pairing-design.md`。用户已确认双向语义并要求实施（2026-11-17）。

## Global Constraints

- 基线 `f77b2d0051fda7049c7453b8e6a6e67ef1172382`；实施采用此前已选定的当前会话顺序执行，不重新选择执行方式。
- 仅一组活动 Codex↔Claude 连接；继续使用现有 CLI 名称 `labus` 和安装目录。
- 代码：密码学随机生成 8 个 Crockford Base32 字符，显示 `XXXX-XXXX`，有效期 3600 秒，一次性。接受大小写和可选中间连字符；不把 O/I 等相似字符猜成数字。
- 操作凭据有效期 120 秒。凭据精确绑定一次原生输入及 issue/redeem 参数；凭据 ID 只是后台关联，不让用户抄写。
- 本地 JSON、现有独占锁和原子写；不用 SQLite 或第三方 API。
- 配对状态文件上限 256 KiB、最多 128 条凭据/邀请/事务记录（合计）；先清理已过保留期的终态记录，仍满则拒绝新建，不删除未完成事务。终态记录保留 24 小时后可清理。
- 普通聊天不新增落盘；peer/channel 输入、工具结果、子 Agent 不得成为配对授权。会话 ID、cwd、标题或正文匹配单独均不构成来源证明。
- 不覆盖其他活动连接；不迁移旧任务；不修改原生工具权限，不用配对跳过 Hook 信任。
- P0 未通过不实施持久配对模块；测试通过不等于原生兼容已验证。
- 产品配对入口不使用预登记 session allowlist；安装完成后任意新主聊天均可通过明确人工配对输入证明身份。临时 P0 的限范围白名单不是产品架构。
- 首版精确支持 `生成连接码`、`给这个聊天生成连接码` 和 `连接 Claude/Codex，连接码 XXXX-XXXX`；只裁首尾空白，拒绝引用、代码围栏、附加正文和 peer 来源。
- 本轮仅新增设计与计划；实现、用户级安装更新与发布分别报告其真实进度。

## Review Focus

实施进度补充（2026-11-17）：CC Switch 压缩响应缺陷已获具体授权修复，原 Claude 子 Agent 现场反例已观察。按用户连续推进要求，隔离分支已完成 Task 2–5 的离线实现与 255 项回归；延后原生核验凭据解决了 Hook 早于原生输入落盘的时序问题。该顺序调整的依据与代价记录在私有执行账本，不将离线实现当作 Task 1 正式新聊天/客户端验收通过。Task 6 的真实安装、正式发码/兑换与新聊天验收仍待完成；用户配置增量和旧连接处置须具体审阅授权。下方历史顺序调整段落保留作为当时记录。

执行顺序调整（2026-11-17）：用户要求自主处理可完成的工作。当前版本 Claude 子 Agent 创建被其自动审批模型不可用阻止；P0 仍未全部通过。仅先实现 Task 2 的纯口令解析和只读原生证据核验，便于独立测试已查明的字段与时序；不接 Hook router、不持久保存意图、不生成邀请、不建连接、不更新安装。Task 1 不标完成，Task 3–6 的持久化与激活继续保留原门槛。该例外是开发顺序调整，不把旧版子 Agent 元数据回放当成新版现场通过。

1. 模型传入另一个真实 Session ID，或 peer 发送相同配对句式：拒绝授权，当前连接不变（Task 1/2）。
2. 两个不同会话同时兑换同一码、同一操作超时重试：只能一个绑定；原操作返回同一结果（Task 3/4）。
3. 写入路由后崩溃、active 指针前后崩溃：重用原 connectionId，冲突暂停，不创建第二连接或发探针（Task 4）。
4. 同标题同目录新会话、恢复后新 PID、旧连接迟到回信：只认原生会话，不重定向旧消息（Task 4/6）。
5. 明确配对成功但端点检测弱、真实投递 unknown：不能显示双向已通，也不能自动重试任务；旧版 ready 门槛保持（Task 5/6）。

---

## 文件与接口边界

新增 `src/pairing/{model,capture,store,service,cli}.ts`：依次负责契约、原生控制输入、单文件事务、连接兑换、命令适配。不增加通用 Agent 抽象或另一套消息队列。

修改：`src/installation/{model,hook-router,connections}.ts`、`src/labus.ts`、双方 Skill、`docs/USAGE.md`、`docs/HOOKS.md`、`docs/INSTALL.md`。仅当测试发现实际包收集遗漏时才修改 `scripts/package.ps1`，不预先重写安装器。

测试新增：`tests/unit/pairing-{capture,store,cli}.test.ts`、`tests/integration/pairing-{activation,recovery}.test.ts`。扩展已有 installation-router、installation-skills、installation-connections 测试。

约定所有时间戳为 ISO 字符串；可注入 `PairDeps.now():Date` 用于边界测试。标识使用现有 UUID 校验，目录使用 safePath。配对所有持久状态集中 `installRoot/pairing/state.json`，连接记录仍放原 connections 目录。

## Task 1: P0——证明两端原生身份与操作来源

**Files:** 新建私有临时探针 `<temp>/agentwire-pairing-p0/`；报告写 `docs/PAIRING-CAPABILITY.md`。本任务不创建产品 capture 模块，不改当前活动连接。

**Interfaces:**
- Consumes: `routeHook(c, provider, input)`、现有 native evidence readers、两端已安装 CLI/Hook 的实际输入与输出。
- Produces: 报告中固定 `PairCapability = {provider:Provider; supported:boolean; nativeVersion:string; inputIdentityField:string|null; provenanceMethod:string|null; ticketDeliveryMethod:string|null; reason?:string}`，并附脱敏字段示例。`supported:true` 必须同时证明输入身份、真实用户来源和凭据返回当前聊天三个条件。

- [ ] 读取 executing-plans 与 using-git-worktrees 技能，在 AgentWire 隔离工作区执行；记录基线、两端版本及 Hook 信任状态，不重装依赖。
- [ ] 准备一次性、限范围的探针和具体配置差异。优先不动现有配置；若需临时 Hook，先取得该具体范围授权并保留原生信任，结束恢复差异。
- [ ] 两端各验证：未配对主聊天的固定发码句式、固定兑换句式；同时安排普通输入、peer 相同正文、工具输出、子 Agent、另一同标题聊天作为反例。断言普通输入不落正文，反例不产生配对凭据。
- [ ] 临时测试口令仅用于来源与上下文交付验证；最终必须在未预登记的新聊天验证正式控制句式。当前 Codex 在 trim 修复后尚缺新的人工口令事件，不重用旧证据充数。
- [ ] 验证唯一凭据可由发生该输入的当前聊天获得：禁止通过“最近记录”找回；模型指定其他真实 sessionId 或复用别的 nativeInputId 必须失败。
- [ ] 写能力报告，区分原生已观察事实与离线模拟。任一 provider 不支持时停止本计划，在报告中写清缺失能力；不降级为相信 Skill 参数。
- [ ] 两端均通过才继续 Task 2；报告提交：`git add docs/PAIRING-CAPABILITY.md`，`git commit -m "docs: verify native pairing identity capabilities"`。公开报告不包含代码、会话 UUID、完整 transcript 或用户路径。

预计 0.5–1 日。此门槛的输出决定 capture 使用的真实字段；不得为满足后续接口伪造一个字段。

## Task 2: 只采集明确配对控制输入

**Files:** Create `src/pairing/model.ts`、`src/pairing/capture.ts`、`tests/unit/pairing-capture.test.ts`。

**Interfaces:**
- Consumes: Task 1 已验证的原生证明与精确凭据投递方式；既有 InstallContext、Provider、SourceRef、Candidate。
- Produces: `parsePairCommand(text:string):PairCommand|undefined`；`verifyPairIntent(c:InstallContext,provider:Provider,event:unknown):Promise<PairIntent|undefined>`。本任务只产出验证结果；持久化和 router 接入归 Task 3，避免在存储模块完成前引入临时写入实现。
- `PairCommand = {kind:'issue'} | {kind:'redeem';target:Provider;code:string}`。
- `PairIntent = {intentId:string;source:Candidate;nativeInputId:string;command:PairCommand;capturedAt:string;expiresAt:string;proofRef:string}`。proofRef 指向 Task 1 所确定的原生证据，不是模型提供的路径。
- `PairDeps = {now?:()=>Date;ensure?:typeof ensureService}`。额外原生读取依赖仅通过 capture 测试夹具注入，不接受生产 CLI 绕过参数。

- [ ] 写 RED 用例：`ordinary_and_peer_inputs_never_create_pair_intent`、`wrong_session_is_rejected`、`unpaired_chat_can_capture_explicit_command`。精确断言普通输入返回 undefined，peer 不得到 intentId，重复原生事件得到相同 intentId（幂等持久化归 Task 3）。
- [ ] 运行 `node --experimental-strip-types --test tests/unit/pairing-capture.test.ts`，记录预期缺少接口的 FAIL。
- [ ] 实现固定句式解析和经过 P0 证明的原生校验，只返回已验证的控制意图。函数不启动 daemon、不网络请求、不扫描全部历史，既有 Hook 路由此时不改。
- [ ] 新增首尾换行、新会话不在任何预登记列表、同标题同目录身份不同、原生来源不确定均正确拒绝或识别的测试；不得将无预登记条件误改成无来源证明条件。
- [ ] 增补非法 UTF-8、>1 MiB Hook 输入、缺原生输入身份、过期凭据、不同会话同句式测试。拒绝结果不得把整段聊天正文写进错误日志。
- [ ] 运行 `node --experimental-strip-types --test tests/unit/pairing-capture.test.ts`，全部 PASS 后提交本任务文件，提交信息 `feat: verify native pairing intents`。

## Task 3: 一次性代码与幂等兑换账本

**Files:** Create `src/pairing/store.ts`、`tests/unit/pairing-store.test.ts`；Modify `src/pairing/model.ts`、`src/installation/hook-router.ts`、`tests/unit/installation-router.test.ts`。

**Interfaces:**
- Consumes: Task 2 PairIntent；现有 `acquireLock(file)`、`atomicBytes(file,bytes)`、`safePath(root,file)`。
- Produces: `capturePairIntent(c:InstallContext,intent:PairIntent):Promise<void>`；`issueCode(c:InstallContext,intentId:string,deps?:PairDeps):Promise<PairIssue>`；`claimCode(c:InstallContext,intentId:string,deps?:PairDeps):Promise<PairActivation>`；`completeActivation(c:InstallContext,activationId:string):Promise<void>`；`readPairActivation(c:InstallContext,activationId:string):Promise<PairActivation>`。
- `PairIssue = {invitationId:string;code:string;issuer:Candidate;expiresAt:string}`；`PairActivation = {activationId:string;invitationId:string;redeemIntentId:string;connectionId:string;codex:Candidate;claude:Candidate;phase:'activating'|'paired'|'needs_check';createdAt:string;errorCode?:string}`。
- 所有写入持有 connection.lock；提供内部 `withPairState<T>(c:InstallContext,fn:(tx:PairTransaction)=>Promise<T>):Promise<T>`，其中 `PairTransaction = {state:PairState;commit():Promise<void>}`，每次 commit 均校验限额并原子保存当前状态。service 须先 commit activating 再做副作用，在同一回调内不得调用公开 claimCode/completeActivation 递归取锁。`PairState = {schemaVersion:1;intents:PairIntent[];invitations:Invitation[];activations:PairActivation[]}`；Invitation 含 PairIssue 字段、issueIntentId、state:`available|revoked|claimed`、可选 activationId 与 terminalAt。已处理 intent 通过对应 invitation/activation 关联幂等结果。

- [ ] 写 RED 用例：`only_one_of_two_concurrent_redeemers_wins`（不同 source）；`same_intent_retry_returns_same_code_and_connection_id`；`new_issue_revokes_previous_unclaimed_code`；`expired_code_and_wrong_provider_do_not_mutate_active_connection`。
- [ ] 运行 `node --experimental-strip-types --test tests/unit/pairing-store.test.ts`，确认 FAIL。
- [ ] 用 node:crypto 的无偏随机选择生成代码；检查现存代码冲突并重抽。实现 3600 秒代码有效期、120 秒首次操作凭据有效期、规范化规则、大小/数量限额和终态清理。已提交操作的幂等结果读取不因 120 秒到期而重新执行副作用。
- [ ] 在 claim 事务中固定双方身份与 connectionId。先于任何连接副作用持久写入 activating；已占用代码仅允许原 redeemIntentId 查回该事务，其他兑换者返回 used。有效性边界为 `now >= expiresAt` 即过期。Hook router 在未匹配路由返回之前调用 verifyPairIntent/capturePairIntent；普通聊天不写文件，重复事件只存同一凭据，既有生命周期路由不变。
- [ ] 测试 3599999/3600000 ms、119999/120000 ms、128 条上限、256 KiB 上限、损坏 JSON、活锁/死锁、符号链接路径；文件和锁复用现有保护。测试时钟可注入；不把代码输出到日志。
- [ ] 运行 pairing-store、pairing-capture 和 installation-router 三个测试文件，全部 PASS；提交 `feat: add atomic one-time pairing codes`。

## Task 4: 可恢复连接激活，不自动发送探针

**Files:** Create `src/pairing/service.ts`、`tests/integration/pairing-activation.test.ts`、`tests/integration/pairing-recovery.test.ts`；Modify `src/installation/model.ts`、`src/installation/connections.ts`、`src/pairing/model.ts`。

**Interfaces:**
- Consumes: Task 3 原子状态事务；既有 service、Bus bind、routes、active-connection 文件及 disconnect 保护。
- Produces: `redeemCode(c:InstallContext,intentId:string,deps?:PairDeps):Promise<ConnectionRecord>`；`recoverPairing(c:InstallContext,activationId:string,deps?:PairDeps):Promise<ConnectionRecord>`。返回 ConnectionRecord 允许同双方既有 legacy 连接幂等复用，不把它转换成新准入模式。
- 旧 ConnectionRecord 原样改名 LegacyConnectionRecord；`ConnectionRecord = LegacyConnectionRecord | PairedConnectionRecord`。
- `PairedConnectionRecord = {schemaVersion:2;admissionMode:'identity-pair-v1';connectionId:string;phase:'pairing'|'paired'|'offline'|'needs_check'|'disconnected';codex:Candidate;claude:Candidate;createdAt:string;pairing:{activationId:string;identity:'confirmed'};errorCode?:string}`。
- 连接模块新增内部“调用者已持锁”的激活函数 `activatePairedConnectionLocked(c:InstallContext,activation:PairActivation,deps:PairDeps):Promise<PairedConnectionRecord>`，按 spec 顺序写入/绑定；不再嵌套 selectConnection 锁。只在 pairing/service 事务路径调用，并在注释说明锁契约。

- [ ] 写 RED：`paired_activation_has_no_agent_messages`，断言精准绑定两个 sessionId、仅一组路由、零 accept/adapter.submit；`existing_other_pair_is_unchanged`，断言 active 指针/路由/旧记录字节不变，代码不被消耗。
- [ ] 运行 `node --experimental-strip-types --test tests/integration/pairing-activation.test.ts`，确认 FAIL。
- [ ] 实现新记录分支与激活顺序。连接 loader 严格区分两种 schema；legacy 分支继续校验 probeIds。新分支只确认身份与路由，不调用 beginProbes。已有不同活动连接在 claim 提交前拒绝；相同双方连接返回现有连接，邀请关联该既有 connectionId，不另建服务。
- [ ] 故障注入覆盖：claim 后、connection 写后、服务绑定后、routes 后、active 指针后、完成账本前。`recoverPairing` 精确比对每个已存身份/connectionId，补齐同一激活；冲突进入 needs_check，保留现场，不发送任务。重复 bind 必须核对现有身份一致。
- [ ] 验证未知原生任务仍阻止普通断开和换绑，显式 archive 语义不变；不移动旧 outbox/自动结果；旧回信不匹配新连接时不得投递到新目标。恢复同一 session 新 PID 重新解析；同标题新 session 不继承。
- [ ] 运行 pairing-activation、pairing-recovery 和原 `tests/integration/installation-connections.test.ts`，全部 PASS；提交 `feat: activate exact chat pairs without probes`。

## Task 5: 聊天入口、清晰状态和实际任务准入

**Files:** Create `src/pairing/cli.ts`、`tests/unit/pairing-cli.test.ts`；Modify `src/labus.ts`、`src/installation/connections.ts`、双方 `assets/skills/*/labus/SKILL.md`、`tests/unit/installation-skills.test.ts`、`tests/unit/installation-cli.test.ts`。

**Interfaces:**
- Consumes: issueCode、redeemCode、recoverPairing 与经过原生证明的精确 intentId；不使用 readCallerSource 的 Skill 参数作为配对授权。
- Produces: `runPairCommand(c:InstallContext,args:string[],io:{stdout:{write(text:string):unknown}},deps?:PairDeps):Promise<number>`。
- 工具入口：`labus pair issue --intent <原生凭据>`、`labus pair redeem --intent <原生凭据>`、`labus pair status`。代码由原生兑换意图提供，不再接受第二份模型填写的 code/source-session。恢复由原凭据查出的 activationId 驱动，不按最近记录猜。
- 新增 `inspectPairHealth(c:InstallContext,r:PairedConnectionRecord):Promise<PairHealth>`；`PairHealth = {identity:'confirmed';endpoint:Record<Provider,'detected'|'offline'|'unsupported'|'unknown'>;roundtrip:Record<'codex_to_claude'|'claude_to_codex',{status:'untested'|'observed';messageId?:string;observedAt?:string}>}`。从现有精确原生 execution/result/reply 证据读取，不单凭正文或 adapter receipt。

- [ ] 写 RED：`pair_cli_requires_native_intent_not_arbitrary_session`；`issue_and_redeem_are_symmetric`；`paired_status_never_claims_roundtrip_from_probe_only`；`legacy_needs_check_is_not_promoted`。
- [ ] 运行 pairing-cli 和 installation-cli 测试，确认新增用例 FAIL。
- [ ] 实现命令分派、结构化结果与稳定错误码。Skill 只消费原生投递给当前操作的凭据；模糊自然语言先引导用户固定句式，不自行补造凭据；用户不需要提供 UUID 或终端命令。
- [ ] Skill 描述列出固定配对入口；仅展示程序实际结果，不自行生成连接码或宣称连接成功。显式 /labus 若原生事件类型不同，独立验证来源后才启用。
- [ ] 复用 setup/configuration 现有 doctor 分派，区分配置文件存在、版本支持、当前聊天实际 Hook 观察。缺失或未加载不冒充已识别；Hook 自身缺失时由显式诊断入口提示，不静默覆盖外部配置。
- [ ] 在 ask/followup 中按 admissionMode 准入：legacy 保持 ready 要求；新 paired 允许用户显式首任务。identity 未确认、激活未完成、needs_check 或目标已明确离线时拒绝；unknown 能力不冒充已通。继续使用现有幂等 outbox、生命周期和不确定投递暂停逻辑。
- [ ] 状态固定区分“已配对”“端点检测”“实际往返”，首任务返回后按方向更新 observed；业务结论不升级为成功。status/doctor 不触发 Agent 消息，pair status 不回显连接码。
- [ ] 运行 pairing-cli、installation-cli、installation-skills 和 pairing 集成测试，全部 PASS；提交 `feat: expose chat pairing and honest connection status`。

## Task 6: 原窗口验收、兼容性与交付

**Files:** Modify `docs/USAGE.md`、`docs/HOOKS.md`、`docs/INSTALL.md`、`CHANGELOG.md`；Create `docs/PAIRING-ACCEPTANCE.md`；必要时修复前述任务的生产文件与对应测试。

**Interfaces:** Consumes: Task 1–5；Produces: 可审阅安装差异、脱敏验收矩阵、可复现包与 SHA-256；不自动发布 GitHub Release。

- [ ] 跑 `npm test`，要求 exit 0、fail 0；记录实际测试数，不预填通过数。对新失败先证伪/修复，不放宽旧门槛。
- [ ] 在隔离安装目录打包/安装，确认新 src/pairing 文件、双方 Skill 均进入运行时；撤销仍保留任务历史且不破坏其他 Hook。实际打包参数沿用 `scripts/package.ps1` 的现有接口，先读脚本再执行。
- [ ] 准备真实安装的文件级差异和回滚。用户级配置、原生 Hook 信任继续遵循已批准范围；P0 探针授权不推定成产品激活授权。只在具体变更已备好时处理尚缺的确认。
- [ ] 两个已有窗口验收发码/兑换；有另一同标题聊天时仍绑定正确 Session ID；兑换重复、过期、错误目标均不误连。先断开旧连接须遵循现有未完成任务保护，不为验收强制归档。
- [ ] 安装一次后新建未登记的双方主聊天，跨目录完成配对；期间不改配置或增加 session allowlist。验证同一会话多活跃端点拒绝歧义、Hook/Skill 缺失无虚假成功；恢复原会话保留身份。
- [ ] 每个方向执行一次明确的无业务操作任务与一次 followup，观察原生输入、结束事件、唯一结果和回送；验证 pairing 自身零算术探针。用户普通聊天不得自动变成任务或结果。
- [ ] 原生会话正常退出再恢复后复核同一身份及新端点；新聊天不得沿用旧配对；离线、投递不确定不自动重发。验证旧版 discover/select 与 ready 探针仍工作。
- [ ] 填写验收矩阵，明确 offline PASS、native PASS、未验项。文档给出固定中文句式、错误处理、代码有效期和隐私边界；不发布原始 transcript、代码或本机路径。
- [ ] 新改动引入后跑受影响测试，最终 `npm test` 全通过。提交 `docs: document one-time chat pairing and acceptance`。保留当前顺序实施方式，按执行技能完成最终独立审查后再整合；上传/发布作为后续明确动作。

## 计划审阅与时间估计

最小闭环包含原生身份门槛、代码存储、连接激活和聊天入口四块；不是重写 Bus。预计 3–5 个单人开发日，主要不确定性是 P0 的原生凭据交付与逐写入恢复测试。

已自检：设计各节均有所属任务；五项 Review Focus 均落入测试；schema 1 与 schema 2 分支明确；Task 2 的凭据经 Task 3 存储并由 Task 5 消费；Task 4 共享锁不递归取锁；所有成功陈述均有证据门槛。

当前状态（2026-11-17 更新）：Task 2–5 实现及审查修复已完成，完整离线回归 261/261。产品安装和指定旧探针归档已获具体授权并执行。正式新 Claude 聊天发码通过；Codex 兑换身份证明通过，代码超期按设计拒绝，成功兑换尚未现场通过。用户授权离开期间自主验收后，既有显式选择连接完成双向原生探针及每方向两轮真实任务/自动回传。Task 6 仍有完整连接码激活、新 Codex 聊天和本轮正常退出/恢复等未验项；不以兼容路径成功替代这些门槛。未发布新版本。
