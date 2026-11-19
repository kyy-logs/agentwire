# Programmatic Pairing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 精确人工配对请求在模型零工具调用时也能由受限本地程序完成，并独立记录结果通知。
**Architecture:** 原生 Hook 快速登记后启动有界短进程，沿用已有证明与配对核心；文件任务与通知各自幂等，安装与模式切换守护活动 worker。
**Tech Stack:** Node >=24、TypeScript 原生 strip-types、JSON 原子文件、现有 CLI 与原生通知接口；无新增依赖。
**Spec:** `docs/superpowers/specs/2026-11-18-programmatic-pairing-design.md`。
**Execution:** 用户已直接要求“实现”，沿用此前当前会话顺序执行，不再重复询问执行方式。

## Global Constraints

- 仅限本机；文件存储，不引入 SQLite、额外 API 服务、新的常驻 daemon 或第三个 Agent。
- 自动模式显式 opt-in，默认 manual；只有启用后登记的新任务自动执行，不补跑旧请求。
- 同一 requestId/intentId 只产生一份发码或激活；通知 unknown 不重投、不重做配对。
- 人工原生证据、原生 Hook 信任与业务权限继续有效；自动执行不冒充逐次工具审批。
- 真实安装启用前准备具体范围审阅；不借历史凭据或伪造输入验收；不推送/发布。
- 现有隔离 worktree `codex/local-connections-p0` 内实现；预存修复修改保留，记录增量。

## Review Focus

- worker 退出与新 Hook 登记并发，最后一条请求不能遗留为“已接管”。归 Task2。
- disable/re-enable 期间旧任务不能突然执行；已claim恢复与新授权不能混用。归 Task1/2。
- 模型仍调用手动 CLI 时不撤销新码或重复激活。归 Task1/3。
- 通知写入 unknown、正文到期、模型不复述不能变成重复兑换或虚假送达。归 Task3。
- 运行时更新/卸载不能与短进程并发写模块，读诊断不能改账本。归 Task4。

### Task 1: 模式、受限文件账本与共用执行入口

**Files:** Create `src/pairing/jobs.ts`, `executor.ts`; Test `tests/unit/pairing-jobs.test.ts`, `tests/integration/pairing-executor.test.ts`。
**Interfaces:** `readAutomation(c)`, `setAutomation(c,enabled)`, `enqueuePairJob(c,requestId)`, `readPairJob(c,id)`, `listPairJobs(c)`, `updatePairJob(c,job)`；`executePairRequest(c,requestId,deps)` 返回实际程序结果。
- [ ] 写失败测试：manual默认；auto只纳入本generation启用后请求；重复不多建；32未决上限；坏JSON/ID拒绝；共用执行两次只发一个码，兑换恢复同一激活。
- [ ] 跑上述精确文件，确认缺入口导致 RED；实现有界读取与请求锁、generation和结果重建。
- [ ] 重跑 GREEN；保留证据与该阶段变更记录。

### Task 2: Hook 调度与短进程

**Files:** Create `src/pairing/worker.ts`; Modify `src/installation/hook-router.ts`; Test `tests/integration/pairing-worker.test.ts`。
**Interfaces:** consumes Task1；`schedulePairWorker(c)`；`runPairWorker(c,deps)`；`inspectPairWorker(c)` 只读。
- [ ] RED：Hook返回时模型未调用工具、证据稍后落盘仍发码；peer拒绝；超期不执行；重复调度、退出握手、启动失败、关闭模式不再执行。
- [ ] 实现固定参数spawn、worker启动锁/工作锁、200..1000ms有界观察、两分钟请求期限、无工作退出。
- [ ] 对临时原生记录测试两端、不依赖Bus；禁止同时拿连接锁等待证据；GREEN。

### Task 3: 原聊天通知与命令兼容

**Files:** Create `src/pairing/notifications.ts`; Modify `src/pairing/cli.ts`, `src/labus.ts`; Test `tests/unit/pairing-notifications.test.ts`, `tests/integration/pairing-automation-cli.test.ts`。
**Interfaces:** `notifyPairJob(c,id,deps)`、`reconcilePairNotification(c,id,deps)`；`pair mode --mode auto|manual [--apply]`、`pair result --request ID`、`pair recover --request ID`。
- [ ] RED：先保存稳定transport与正文再写出；unknown仅核对；通知失败不改变配对；到期不发可用码；通知精确原聊天，禁止猜最近；CLI与worker共用结果。
- [ ] 重用原生底层通知与证据，不走业务任务家族；Codex只queue/add，不queue/start；Claude写入需要原生收据。
- [ ] 新CLI严格参数、只读result与模式预览、精确恢复；跑关联配对测试 GREEN。

### Task 4: 生命周期、安装与说明

**Files:** Modify `src/installation/setup.ts`, `src/labus.ts`, `src/installation/doctor.ts`, 两端 Skill；Test 安装/诊断/CLI 的相关文件；Create `docs/PROGRAMMATIC-PAIRING.md`。
- [ ] RED：worker活动时更新/卸载拒绝；manual默认保留旧Hook行为；auto提示只解释与查程序结果；只读诊断不创建目录；停止模式不补跑旧任务。
- [ ] 接入worker检查与停用边界、精确模式提示；复核native权限变化与已授权安装范围。
- [ ] GREEN并运行 `npm test`，期望失败/取消/跳过均0。

### Task 5: 复核、安装与原窗口验收

**Files:** 本计划ledger、私有原生证据、公开验收说明。
- [ ] fresh-context全增量审查；重要问题先RED复现再修复并跑完整回归。
- [ ] 展示具体自有runtime/Skill/auto-mode增量、备份和撤销；用户明确授权该自动状态操作后启用，原生信任本人确认。
- [ ] 两端各一次真实人工输入发码及兑换；模型不调用配对工具；原窗口通知分别核对，unknown不重发。
- [ ] 任务空闲换绑、错误句式/peer负例、禁用恢复与历史保留；需要用户输入时只请求真实动作，不让用户运行诊断。
- [ ] 如通知无法现场证明，只报告已实现的执行/查询与具体通知阻塞，不能虚报完整通过。

## Commit and evidence policy

计划、阶段和最终变更可本地提交；任务1..4与原有未提交修复的共享文件先留工作树，最终显式列出文件提交，避免覆盖或丢弃预存变更。每任务 RED/GREEN、裁决、接口检查写入本计划专属私有 ledger。此为顺序执行中的提交节奏裁决；不擅自推送。
