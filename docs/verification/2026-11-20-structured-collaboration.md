# 结构化协作：实现与离线验收报告

日期：2026-11-20。基线：`ae7177e9e92c46907dff74c4ef1d99947a8c3993`。工作分支：`codex/local-connections-p0`。

## 交付行为

新任务显式选择 `ask --mode structured` 才进入本流程；默认 ask、手动回信和原自动回传继续沿用旧模式。

1. 发起方委派任务，双方身份在任务账本中固定。
2. 执行方不确定需求时调用 question；程序验证真实工具调用和精确原生回合，等该回合安全结束后，把问题发给原发起方。
3. 发起方调用 answer，恢复同一个任务；执行预算增加一次，截止时间不刷新。
4. 执行方准备交付时调用 deliver，然后正常输出报告。精确 Stop 采集报告，任务进入“等待发起方验收”。
5. 发起方 accept 接受当前交付版本，或 revise 要求在同任务修改。accept 不再发送消息。
6. 无显式 question/deliver 的执行回合结束会进入 needs_check，不猜测报告语义，不自动变成完成。接收信息回复的回合不产生自动回声。

例：用户授权“让 Claude 实现校验，遇到问题问我，交付后由 Codex 审查”。Claude 问“空字符串是否允许”，Codex 在已授权范围回答“不允许”；Claude 实现、交付报告；Codex 审查后要求补边界用例；Claude 修改再交付；Codex 验收。每一步由明确动作推进，Stop 本身只说明回合结束。

`completed` 只表示发起方接受当前交付。程序没有独立证明业务正确，`businessVerdict` 始终为 `unverified`。

## 源码责任

| 模块 | 实现 |
| --- | --- |
| `src/collaboration/model.ts` | 固定双方、阶段、动作、版本、严格初始请求与动作校验 |
| `src/collaboration/native-actions.ts`、`native-reader.ts` | 实际工具调用/结果摘要与精确会话、回合证明；不信任模型填写身份 |
| `src/collaboration/store.ts` | 文件任务账本、不可变动作、intent/terminal 两个恢复 checkpoint |
| `src/collaboration/controller.ts`、`recovery.ts` | 串行状态机、确定性出站 ID、恢复、过期、显式停止 |
| `src/bus.ts`、`src/main.ts` | 同任务传输、禁止旧 reply/followup 绕过、能力协商和 IPC |
| `src/collaboration/cli.ts`、`src/labus.ts`、`src/installation/connections.ts` | 新模式、动作入口、当前连接校验与稳定动作 outbox |
| `src/lifecycle/clean-processor.ts` | 精确 Stop 采集；没有回复的终结不伪造 reply_committed |
| `src/adapters/codex.ts`、`src/envelope.ts` | 保留程序生成的结构化指引，聊天正文不增加协议编号 |
| `src/status.ts` | 独立业务状态、等待对象、版本、问题/交付引用与剩余预算 |
| `src/installation/connection-management.ts` | 等待回答、等待验收和未完成动作计入既有切换/替换/卸载保护 |
| 两端 `assets/skills/*/labus/SKILL.md` | 自然语言入口与明确动作规范；保留原生审批和 peer 数据边界 |

固定总时限 30 分钟，最多 3 个问题、6 次执行。重复操作不重复扣预算。异常保留原记录，不通过换 ID 重投解决；stop 停止追踪，不宣称取消厂商进程。不增加共享仓库写锁或跨机器功能。

## 验证

完整离线命令：

```powershell
node --experimental-strip-types --test --test-concurrency=1 tests/unit/*.test.ts tests/integration/*.test.ts
```

- 第一次完整套件：645/645，fail=0，exit=0。
- 最终修复后完整套件：**652/652，fail=0，exit=0**（267.93秒）。
- 最终修复定向集：29/29，fail=0；夹具修正后控制器、原生归属、双向集成与恢复定向集：26/26，fail=0。
- 修复后的首次全量运行曾为 650/652：两个旧控制器夹具复用了同一个原生回合 ID。按真实多轮记录改为各轮独立回合，保持跨任务归属校验，未放宽生产代码。最终全量结果单独列于上方。
- 差异检查：工作区及相对基线的 `git diff --check` 均为 exit=0。

关键覆盖：

- 两个方向的 question → answer → deliver → accept，及同任务 revise。
- 错误角色/会话/回合、旁支、正文冒充工具命令、请求摘要不符、重复人工输入、同正文不同任务与跨任务映射。
- Stop 先于工具结果时延后处理；重复动作/Stop 不重复投递；信息回复不回声。
- intent 与 terminal checkpoint、十个动作写入故障边界恢复，确定性消息及预算不重复。
- 截止、问题/执行预算、错误/中断/不完整报告、不确定交付及显式停止。
- 等待回答或验收时，即使传输消息已终态，连接管理仍阻止未经处置的切换和卸载。
- 真实 CodexAdapter 的 clean-v1 排队文案保留结构化上下文；旧模式全套回归。
- 两端 Skill 文本契约与离线行为场景。旧 Skill 场景未执行 deliver，新指引场景选择精确任务、deliver、正常结束；这仅证明该场景中的指引行为，不证明所有模型可靠采用。

双向集成使用真实 Bus、文件存储、IPC、NativeDispatcher 与 CleanProcessor，厂商接口/证据读取使用测试替身。原生证明模块另外用原生记录形状的脱敏夹具和只读格式核对。**没有把夹具成功当成真实窗口成功。**

## 独立审查与修复

执行过一次独立的整体审查；没有 Critical/Minor，五项 Important 均进入同一修复轮。另补一项 Windows 调用兼容问题。以下七条回归均先观察失败，再修复通过：

| 问题 | 回归 |
| --- | --- |
| Codex clean-v1 队列丢失协作上下文 | `tests/unit/codex-adapter.test.ts` 实际 Adapter 文案 |
| 已有普通任务 ID 被结构化请求占用/转换 | `structured open cannot convert or poison an existing ordinary task ID` |
| 非法初始请求先写账本，随后使恢复报错 | `invalid structured inputs never create a recoverable poison sidecar` |
| 只有 prepared 账本、没有 Bus 根消息时无法停止 | `ledger-only prepared task can be explicitly stopped without fabricating a Bus root` |
| 缺动作 Stop 回放可能暂停服务，原生终结又被伪装成回复提交 | `missing-action Stop is idempotent and explicit stop retires native work without a fake reply` |
| 原生执行映射到别的任务，仍通过人工来源回退 | `tests/unit/collaboration-native-actions.test.ts` 跨任务归属 |
| PowerShell 需要的首个 & 调用运算符被误拒绝 | 同文件单个首部调用符通过，后续 shell 链拒绝 |

未再次派发复审；最终依据为这些已观察 RED→GREEN 的回归和修复后的完整套件。

## 实现取舍与审查未判定项

以下为全部记录的取舍，保留原因和成本：

1. 技能默认 Git Bash 不存在，使用等价 Node/PowerShell 记账，不安装工具。成本：技能自带记账脚本未实际执行。
2. 使用独立、可选的原生动作证据读取器，保持旧 EvidenceReader 契约。成本：存在额外的有界转录扫描。
3. 在共享 Bus 采集入口接入结构化策略，未新增第二个 lifecycle 策略模块；两条旧采集路径均汇入该入口，新任务强制 clean-v1。成本：该共享入口的归属约束必须继续由回归测试保护。
4. 审查未证明人工动作能与 checkpoint 出站提交交错；当前准入和恢复均走 Bus 串行链，保留该约束。成本：未来若允许并行准入，必须重新检查转换原子性。
5. 审查未独立验证所有厂商转录版本、全部真实卸载入口或真实厂商退出恢复；本轮只承诺当前代码路径及离线回归。成本：厂商格式差异可能让动作保持待核验，需要真实窗口验收。
6. 审查者没有执行完整套件、安装或真实发送；实现者执行完整套件，保持安装/真实消息不在本轮范围。成本：不能宣称原窗口结构化流程已通过。

无确认后延期的 Minor。

## 当前限制与下一阶段

本轮没有更新当前运行时、用户 Hook、模型配置、活动配对，也没有发送真实任务、推送或发布。代码保留在既有开发分支。

当前原生证明只接纳 Claude 主会话 Bash 的单条已安装 launcher 命令，以及 Codex 主会话 exec 中精确的 `text((await tools.exec_command(<JSON字面量对象>)).output);` 调用形态；Windows 可在命令起始使用单个 &。任意 JS、shell 链及外部脚本代理不被接受。扫描有目录/文件/行大小上限，超界保持未核验，不模糊选取最新任务。

下一步应准备具体安装差异，经安装授权后更新运行时和两端 Skill，再在真实双方聊天中分别验证提问、回答、交付、验收、修改和无回声。若厂商审批阻止动作，保留等待或拒绝，不提高 peer 权限，不代批。本轮离线通过不替代这一步，也不证明实际业务开发正确。

使用说明见 [结构化协作](../structured-collaboration.md)；设计与逐步实现计划见 [设计](../superpowers/specs/2026-11-20-structured-collaboration-design.md)、[计划](../superpowers/plans/2026-11-20-structured-collaboration-plan.md)。
