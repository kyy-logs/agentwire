# AgentWire Structured Collaboration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 增加显式提问、回答、交付、验收和同任务修改，使 Stop 不再被误当成业务完成。

**Architecture:** 在既有 clean-v1 消息传输上新增文件持久化的协作任务账本。动作先登记，原生工具调用和精确回合证据验证后生效；执行方 question/deliver 等待对应安全 Stop，再提交确定性 reply。发起方 answer/revise 使用同任务 followup，accept 只关闭业务任务。

**Tech Stack:** Node.js >=24、TypeScript strip-types、node:test；沿用现有 IPC、原子文件和 Agent 适配层；不安装依赖。

**Spec:** E:/projects/agentwire/docs/superpowers/specs/2026-11-20-structured-collaboration-design.md

**Execution:** 沿用用户此前选择的当前会话顺序执行；整个实现结束后一次独立审查。此计划已获用户批准；按当前会话顺序实施并进行离线验证。

## Global Constraints

- 工作区 E:/projects/agentwire，既有 linked worktree codex/local-connections-p0；基线 ae7177e9e92c46907dff74c4ef1d99947a8c3993。
- 保留双方独立上下文、原生登录及审批。本机通信，文件持久化，不引入 SQLite、第三方 API 或外部服务。
- 现有 ask/followup 与自动回传默认行为保持兼容。新功能仅对显式选择 structured 模式的新任务启用。
- 本次代码开发与离线测试不修改当前安装、用户 Hook、模型配置、活动配对或历史记录。
- 首版只支持 clean-v1 的新 structured 任务；legacy structured 请求明确拒绝。
- Stop Hook 只证明一个原生回合结束，不能靠自然语言猜测任务是否已经完成。
- 每个任务仅允许一个待回答问题；同一个原生回合只允许一个终结动作（question 或 deliver）。
- 默认 TTL=1,800,000ms；maxExecutions=6（包括初始执行）；maxQuestions=3。answer/revise 消耗原任务执行预算，幂等重试不扣第二次。
- 普通人工聊天、无关回合、reply 通知回合不能绑定成任务动作或任务结果。
- 消息正文不新增协议编号；动作关联通过工具结果和后台原生证据完成。
- 本轮不发布、不推送、不安装运行时、不切换当前连接。
- 单个任务的“发起方已验收”不等于程序验证了业务结论；businessVerdict 仍为 unverified。

## Review Focus

1. 同一聊天有多个任务、相同正文或人工插话时，禁止通过“最新任务”选择动作归属。Task 1/4 有反例测试。
2. 停机点在动作、消息、投影不同文件之间时，不得重复投递、重复扣预算或丢失等待状态。Task 2/3/5 有故障注入。
3. 现有手动 reply、followup 或旧生命周期路径可能绕过新状态机。Task 3/4 验证拒绝绕过，保护旧任务行为。
4. question/deliver 的消息展示不能与旧 reply 的“无需回信”含义冲突，也不能提高 peer 权限。Task 4/6 验证真实适配器生成的 envelope。
5. 消息已 completed/delivered、业务仍 waiting_answer/waiting_acceptance 时，连接替换与卸载不得漏检。Task 5 覆盖全部保护入口。

## 冻结的共享接口

类型位于 src/collaboration/model.ts：

- Actor = {provider: Provider; sessionId: string}
- Phase = working | question_pending | waiting_answer | delivery_pending | waiting_acceptance | completed | needs_check | expired | stopped
- ActionKind = question | answer | deliver | accept | revise
- ActionRequest = {operationId: string; taskId: string; actor: Actor; kind: ActionKind; expectedRevision: number; questionId?: string; deliveryId?: string; body?: string}
- ActionEvidence = {status:'verified'; ref:ExecutionRef; evidenceRef:string; requestSha256:string} | {status:'pending'|'unavailable'|'conflict'|'limit'; errorCode?:string}
- ActionRecord = 持久化原请求及其规范摘要、phase(pending_verification/verified/waiting_stop/prepared/committed/needs_check)、验证证据、确定性出站 ID/内容、terminalEventKey、结果引用；checkpoints 分别保存 intent 与 terminal 两个转换的 expectedRevision、nextTask 和提交阶段。
- TaskRecord = schemaVersion=1、taskId、connectionId、固定双方 Actor、phase、revision、deadline、executions、questions、currentMessageId、当前问题/交付版本、businessVerdict='unverified'、最近错误。
- revision 从 0 开始，成功业务转换递增；所有变更动作必须匹配 expectedRevision。operationId 同请求重放先返回原结果，不因版本已变而拒绝；同 ID 异请求返回 collaboration_operation_conflict。
- questionId=该 question 的 operationId；交付版本=deliver 的 operationId。accept/revise 另带 deliveryId，避免过时验收。

持久化目录为 <state>/collaboration/tasks/<taskId>.json、actions/<operationId>.json；文件路径必须位于 state 内且禁止符号链接。
每次任务变更以动作记录对应 checkpoint 中的 expectedRevision、nextTask 快照和 commit 阶段实现恢复，不假设多文件事务。question/deliver 在原生验证后的 intent checkpoint 进入 pending 状态；安全 Stop 后由 terminal checkpoint 进入 waiting_answer/waiting_acceptance；同 checkpoint 只提交一次。
所有 controller 的 *One 方法只在 bus.serial 内使用，不能在其中再调用带 serial 的 bus 公共方法，以免死锁。

## Task 1: 原生动作证据与精确回合归属

**Files:**
- Create: src/collaboration/model.ts
- Create: src/collaboration/native-actions.ts
- Modify: src/native/model.ts
- Modify: src/native/codex-evidence.ts
- Modify: src/native/claude-evidence.ts
- Test: tests/unit/collaboration-native-actions.test.ts
- Test: tests/unit/native-evidence.test.ts

**Interfaces:**
- Consumes: 既有 ExecutionRef、DispatchIntent、EvidenceReader.inspect。
- Produces: ActionEvidenceReader.proveAction(request:ActionRequest):Promise<ActionEvidence>。
- Produces: verifyActionOwnership(task:TaskRecord, action:ActionRequest, evidence:ActionEvidence, mappedInputs:DispatchIntent[]):ExecutionRef。
- 不把新增方法设为旧 EvidenceReader 的必填成员；不支持时 structured 入口拒绝，旧功能继续运行。

- [x] **Step 1: 写失败测试。** 两端分别验证实际 tool-call/tool-result 关联、operationId、规范请求摘要与精确回合；伪造 sessionId、正文里的命令样例、旁支、相同操作出现在两个回合、未完成半行、工具结果尚未落盘均不通过。相同正文的两个任务只能命中明确映射的那一个。用真实原生记录形状制作脱敏 fixture，不以臆造字段充当能力证明。
- [x] **Step 2: 运行红灯。** `node --experimental-strip-types --test tests/unit/collaboration-native-actions.test.ts`；Expected: 新模块/导出不存在导致失败。
- [x] **Step 3: 实现严格证据读取。** 请求登记时只返回 pending_verification；后续原生工具记录可读后才 verified。CLI 返回的 receipt 包含 operationId 与 requestSha256，必须与本回合实际工具调用及结果匹配；仅在文本中出现 UUID 无效。执行方还须匹配当前任务的已映射输入；发起方须匹配该任务问题/交付的接收回合，或具有真正人工来源的当前原生回合。不按时间或最近记录猜测；未知原生 schema 返回 unavailable。
- [x] **Step 4: 验证绿灯并记录来源证据。** `node --experimental-strip-types --test tests/unit/collaboration-native-actions.test.ts tests/unit/native-evidence.test.ts`；Expected: 全部通过。额外只读核对当前原生记录是否包含必要字段；若当前版本不能证明工具调用归属，停止接通动作并报告具体缺口，不降级为信任模型参数。
- [x] **Step 5: 提交。** 只提交本任务文件，commit: `feat: verify collaboration actions against exact native executions`。

## Task 2: 任务与动作文件账本

**Files:**
- Create: src/collaboration/store.ts
- Test: tests/unit/collaboration-store.test.ts

**Interfaces:**
- Consumes: Task 1 的严格类型及 schema 验证器。
- Produces: CollaborationStore(root:string)，getTask(id)、listTasks()、getAction(id)、putAction(action)、createTask(task:TaskRecord,initialMessage:MessageInput)、commitTransition(actionId:string,checkpoint:'intent'|'terminal',nextTask:TaskRecord)、inspect()。
- inspect() 只读，不创建缺失目录；返回 {unfinished:number,uncertain:number,artifactsPending:number}，坏数据抛 collaboration_storage_requires_check。
- createTask 将初始请求与 initialDispatch=prepared 原子保存在 task 中，再由 controller 使用同 messageId 提交初始消息，最后投影 initialDispatch=committed；中断时禁止绕过创建恢复直接派送。commitTransition 先保存对应 checkpoint 的 prepared+nextTask，随后原子写 task，最后标记该 checkpoint committed；intent checkpoint 完成后动作可继续 waiting_stop，terminal checkpoint 完成才成为最终 committed。恢复必须能分辨已投影版本与未投影版本。

- [x] **Step 1: 写失败测试。** 重启后保留 waiting_answer/waiting_acceptance；同 operationId 同请求返回原记录，异请求拒绝。故障注入每个原子写边界，验证只能恢复一次。损坏 schema、文件名不符、路径穿越、符号链接、孤立 tmp、动作引用缺失任务都保持可诊断并阻止准入；不存在目录的 inspect 不创建文件。
- [x] **Step 2: 红灯命令。** `node --experimental-strip-types --test tests/unit/collaboration-store.test.ts`；Expected: 新 store 模块不存在。
- [x] **Step 3: 实现。** 复用 src/store.ts 的 atomicJson 与安装路径保护模式，新增严格验证和版本比较；不修改既有 MessageStore 文件格式。不把损坏记录删除或自动补成完成。
- [x] **Step 4: 绿灯命令。** 与 Step 2 相同；Expected: 全部通过，包括故障注入。
- [x] **Step 5: 提交。** commit: `feat: persist collaboration tasks and idempotent action intents`。

## Task 3: 状态机、预算和既有消息传输接入

**Files:**
- Create: src/collaboration/controller.ts
- Modify: src/bus.ts
- Test: tests/unit/collaboration-controller.test.ts
- Test: tests/unit/bus.test.ts

**Interfaces:**
- Consumes: Task 1/2 的类型、证据读取器、Store。
- Produces: CollaborationController.openOne(input:MessageInput,actor:Actor):Promise<TaskRecord>。
- Produces: submitActionOne(request:ActionRequest):Promise<ActionRecord>（只登记，不把模型参数当作证据）。
- Produces: advanceActionOne(operationId:string):Promise<ActionRecord>（证明完成后按角色/版本/预算转换）。
- Produces: consumeTerminalOne(result:CapturedResult):Promise<{handled:boolean;reply?:MessageRecord}>。
- Produces: isStructuredFamily(taskId:string):Promise<boolean>。
- controller 使用仅进程内传入的 commitTransport/commitCaptured 回调复用 Bus 内部准入，不能经 IPC 用布尔开关绕开策略。

- [x] **Step 1: 写失败测试。** working→question_pending→waiting_answer→working；working→delivery_pending→waiting_acceptance→completed；waiting_acceptance→working(revise)。错误角色、旧交付版本、错误 questionId、同回合第二个终结动作、旧操作重放、满3个问题、第7次执行、TTL=1800000ms边界均断言精确错误；幂等重放不再扣预算。
- [x] **Step 2: 红灯。** `node --experimental-strip-types --test tests/unit/collaboration-controller.test.ts`；Expected: controller 不存在。
- [x] **Step 3: 实现。** 初始请求=task，question/deliver=父执行消息的唯一 reply，answer/revise=同任务 followup。根 taskId 与 deadline 不变；accept 不发送消息。动作出站 messageId 由 operationId+固定角色确定性派生。question/deliver 在安全 Stop 前绝不发送；answer/accept/revise 也必须先通过原生动作证明。直接原始 reply/followup 或原有自动采集若命中 structured 家族，须转交 controller 或拒绝 collaboration_action_required，禁止旁路完成任务。
- [x] **Step 4: 绿灯与旧行为回归。** `node --experimental-strip-types --test tests/unit/collaboration-controller.test.ts tests/unit/bus.test.ts`；Expected: 全通过，旧 MessageInput.kind、completed 语义、任务预算与重试校验不变。
- [x] **Step 5: 提交。** commit: `feat: add explicit collaboration questions deliveries and acceptance`。

## Task 4: Stop、展示与动作 IPC/聊天 CLI

**Files:**
- Create: src/collaboration/lifecycle.ts
- Create: src/collaboration/cli.ts
- Modify: src/main.ts
- Modify: src/labus.ts
- Modify: src/installation/connections.ts
- Modify: src/lifecycle/clean-processor.ts
- Modify: src/lifecycle/processor.ts
- Modify: src/model.ts（仅 SubmitOptions 可选展示上下文，不新增消息 kind）
- Modify: src/envelope.ts
- Test: tests/integration/collaboration-roundtrip.test.ts
- Test: tests/integration/collaboration-cli.test.ts
- Test: tests/unit/envelope.test.ts

**Interfaces:**
- Consumes: Task 3 controller 和 Task 1 原生动作证明；clean processor 继续负责精确原生结果。
- Produces: IPC collaboration-open、collaboration-action、collaboration-status；health.capabilities.structuredCollaboration=1。
- Produces: runCollaborationCommand(c,args,source,deps)；ask --mode structured、question/answer/deliver/accept/revise，动作带 --task、--operation、--revision，answer 带 --question，accept/revise 带 --delivery。text/text-file 只允许 question/answer/revise，deliver 报告只能从原生最终输出采集。
- CLI 不使用 --execution 参数作为证据，不设置身份环境变量；工具 receipt 含规范 requestSha256。动作返回 pending_verification 并正常结束，不等待自身工具结果或 Stop。
- connections 新增 sendConnectionOperation(c,source,op,payload,deps)，复用现有配对锁、精确会话和基础设施检查；旧 sendPaired/sendLegacy 默认 accept 调用保持兼容。
- SubmitOptions.collaboration 为可选的程序生成展示上下文，源自账本和当前 messageId，不允许 peer 正文指定；必须在持久化派送意图之前确定。

- [x] **Step 1: 写失败测试。** 用真实 LocalBus+NativeDispatcher+CleanProcessor+文件存储，双向各跑 question/answer/deliver/accept 和 revise；Stop-before-tool-result、Stop-before-mapping 先延后再只提交一次。缺少动作→needs_check，不完整/失败/中断不交付，reply接收回合 Stop 不回声。多个任务、同正文、普通聊天插入与伪造回合不能串线。两端实际 Adapter 生成的任务/问题/交付文案不带协议 ID，也不出现互相冲突的“无需回信/请回答”指引。
- [x] **Step 2: 红灯。** `node --experimental-strip-types --test tests/integration/collaboration-roundtrip.test.ts tests/integration/collaboration-cli.test.ts`；Expected: 新入口或 IPC 未实现。
- [x] **Step 3: 实现。** 注册一个结构化采集策略入口，旧 legacy 与 clean 路径都不能重复消费；业务状态写入和展示上下文落盘后才允许适配器副作用。question 使用工具正文，deliver 使用完整原生报告，并保存 artifactRef/sha256/truncated；信息回复继续明确无需回信。CLI 模式/参数严格白名单，稳定 operationId 写 outbox，连接变化拒绝重放，旧服务缺能力明确拒绝。
- [x] **Step 4: 绿灯与自动回传兼容。** `node --experimental-strip-types --test tests/integration/collaboration-roundtrip.test.ts tests/integration/collaboration-cli.test.ts tests/integration/clean-return.test.ts tests/integration/automatic-return.test.ts tests/unit/envelope.test.ts`；Expected: 全通过，无新增真实 Agent 任务。
- [x] **Step 5: 提交。** commit: `feat: connect structured collaboration to native lifecycle and chat commands`。

## Task 5: 恢复、停止和连接全入口保护

**Files:**
- Create: src/collaboration/recovery.ts
- Modify: src/main.ts
- Modify: src/bus.ts
- Modify: src/installation/connection-management.ts
- Modify: src/installation/connections.ts
- Test: tests/integration/collaboration-recovery.test.ts
- Test: tests/integration/connection-management.test.ts

**Interfaces:**
- Consumes: Store、controller、既有任务 stop 与 inspectConnectionWork。
- Produces: recoverCollaborationOne(controller):Promise<void>、inspectCollaborationWork(stateRoot):Promise<{unfinished:number,uncertain:number,artifactsPending:number}>。
- main 初始化在允许新准入/adapter 派送前完成协作恢复；调度仍采用单条 Bus chain。
- inspectConnectionWork 累加协作计数；disconnect/历史切换/自动替换/卸载的既有调用链统一受保护。
- stop(taskId) 同时停止对应业务任务；只保存停止追踪与审计，不宣称取消原生进程。

- [x] **Step 1: 写失败测试。** 在登记前后、任务投影前后、Bus putNew 后、Stop保存后、reply已提交但执行映射未投影时分别重启。验证固定ID、不二次计数、同任务等待状态保留；unknown只核对不重发。waiting_answer/waiting_acceptance 即便所有消息已终态仍阻止连接切换/自动替换/卸载。显式 stop保留历史；晚到 Stop 不重新打开任务。坏文件和孤立临时文件阻止切换。
- [x] **Step 2: 红灯。** `node --experimental-strip-types --test tests/integration/collaboration-recovery.test.ts`；Expected: 新恢复或业务保护未实现。
- [x] **Step 3: 实现。** 用 prepared 动作保存的 nextTask 和确定性消息修复投影；每次恢复副作用前重验 deadline、shutdown、身份、版本及任务未停止。无法证明旧提交结果时进入 needs_check，不删除、不重试。整合 graceful close，确保关停后不启动下一项动作。
- [x] **Step 4: 绿灯。** `node --experimental-strip-types --test tests/integration/collaboration-recovery.test.ts tests/integration/connection-management.test.ts tests/integration/installation-connections.test.ts`；Expected: 全通过。
- [x] **Step 5: 提交。** commit: `fix: recover collaboration safely and guard unresolved task connections`。

## Task 6: 用户状态、Skill 和能力兼容文档

**Files:**
- Modify: src/status.ts
- Modify: src/installation/guidance.ts
- Modify: assets/skills/codex/labus/SKILL.md
- Modify: assets/skills/claude/labus/SKILL.md
- Modify: README.md
- Create: docs/structured-collaboration.md
- Test: tests/unit/collaboration-status.test.ts
- Test: tests/unit/installation-skills.test.ts

**Interfaces:**
- Consumes: 已持久化协作账本和 CLI receipt，不读取模型主观结论。
- Produces: status 顶层 collaboration 分页字段，与既有消息 items 并列；每项显示角色、等待对象、阶段、revision、问题/交付引用、剩余预算、deadline 和受限错误摘要。
- status 分页每页默认50，最大100；完整正文保留在本地 artifact，不扩充 IPC 大帧。

- [x] **Step 1: 写失败测试。** 等待答案、待Stop交付、等验收、缺动作、身份不明、截止、预算耗尽显示明确原因；消息 completed 不显示为任务完成。两端 Skill 同时记录新命令与旧模式兼容；不得要求把peer当用户授权、手动复制编号到聊天或修改权限。
- [x] **Step 2: 红灯。** `node --experimental-strip-types --test tests/unit/collaboration-status.test.ts tests/unit/installation-skills.test.ts`；Expected: 协作状态/新文档契约断言失败。
- [x] **Step 3: 实现。** 新模式显式启用；工具上下文给出确切待处理任务与动作可选项，多个任务不选最新。问题到发起方，但不自动回答；报告交付到发起方，但不自动验收。记录完整自然语言使用例子及错误后的原ID核对方法。旧 service/runtime 缺 capability 的升级提示不擅自安装。
- [x] **Step 4: 绿灯。** 与 Step 2 相同；Expected: 全通过，现有 Skill 配对规则仍成立。
- [x] **Step 5: 提交。** commit: `docs: explain structured collaboration and actionable task status`。

## Task 7: 全量验证、独立审查与交付

**Files:**
- Create: docs/verification/2026-11-20-structured-collaboration.md
- Progress/evidence: .superpowers/sdd/2026-11-20-structured-collaboration-plan/（使用 skill 脚本生成；不放测试私密原文到公开文档）

**Interfaces:**
- Consumes: Tasks 1–6 的所有改动与 ledger。
- Produces: 离线机制验收报告、未验证的真实窗口边界，以及可审阅安装差异的后续入口。

- [x] **Step 1: 运行完整离线套件。** `node --experimental-strip-types --test --test-concurrency=1 tests/unit/*.test.ts tests/integration/*.test.ts`；完整输出保存证据文件。Expected: exit0、fail0，记录实际 tests/pass 数，不复用旧614结果。
- [x] **Step 2: 运行差异校验。** `git diff --check`；Expected: exit0。核对改动只在计划文件内；不提交原生聊天记录、密钥、本机绝对身份或当前状态。
- [x] **Step 3: 一次独立整体审查。** 使用 executing-plans 要求的 fresh reviewer，给出 spec、plan、基线、ledger和五条 Review Focus；当前实现者不替代独立审查。
- [x] **Step 4: 修复实质问题。** 每项先增加失败测试、看到失败、修复后看到通过；再运行完整套件。Minor 记录交付，由用户决定后续范围。
- [x] **Step 5: 写验收报告并提交。** 明确“离线机制已验证”和“当前安装/真实双方窗口尚未验证”；不凭离线夹具宣称原窗口行为成功。commit: `test: verify structured collaboration lifecycle and recovery`。

## 真实窗口验收的后续边界

代码与测试通过后准备安装差异，包含运行时与两端 Skill；如需改变 Hook 定义须单独展示差异和原生信任要求。
在具体安装授权后，双向各验证一个新 structured 任务，至少一次提问、回答、交付、验收和无回声，并保留精确原生证据。
这些步骤不自动清理当前配对、不重复旧探针，也不把一方的 peer 消息提升为另一方的执行授权。

## 自检结果

- 设计第1–5节由Task 1–4/6覆盖；第6–7节由Task 3/4覆盖；第8节由Task 2/5覆盖。
- 设计第9节兼容边界由Task 3/4/6覆盖；第10节预算与连接保护由Task 3/5覆盖；第11节由Task 6覆盖；第13–14节由Task 7及真实窗口后续边界覆盖。
- 首个风险门为真实原生工具调用归属。若只能找到输入/最终回答而不能证明工具动作，不能宣称完成该能力，不能绕过此门继续上线。
- ActionRequest 的 deliveryId、首任务 initialDispatch 和 question/deliver 双 checkpoint 已同步到共享接口，避免过时验收、半创建任务和两阶段动作丢失；任何后续接口变更都在 ledger 记录，不暗改协议。
