# 本机连接管理 P0：实施与验收

日期：2026-11-18。开发分支：`codex/local-connections-p0`；基线：`13a618e`。不包含用户级安装、Hook 配置、当前配对或 GitHub Release 的变更。

## 结果

- 四项计划任务已实现：保存连接检查、预览与安全切换、具体诊断、两端聊天入口及文档。
- 原生 Windows / Node v24.9.0；零新增依赖，仍为 JSON 文件存储、一个活动配对。
- 基线完整离线测试 **264/264**；修复后完整 `npm test` **295/295，0 fail，exit 0**。原始输出保留于本次隔离工程的 `evidence/local-connections-p0/full-tests-after-review.txt`，该目录不提交到公共仓库。
- 最初受限沙箱中的文件操作测试出现 EPERM，未作为产品失败放宽断言；在获得原生执行批准后重跑。中途一次自动审批额度错误导致命令未执行，用户指示继续后重试成功。
- 两端 Skill 完成旧版基线和新版命令选择模拟。未调用实际 Claude/DeepSeek 或 Codex 模型，不把模拟认作真实窗口加载或往返验收。

## 独立审查与修复

独立 reviewer 对 `13a618e..7481128` 给出 7 项 Important、1 项 Minor，无 Critical。一次修复流程覆盖全部问题；未进行第二轮同范围审查。修复靠失败回归及最终全量测试验证，不声称 reviewer 独立复审通过。

| 问题 | 回归证据与处理 |
|---|---|
| 高层 guard 可被低层 IPC 绕过 | `installed Bus rejects low-level accept, reply-current and bind while a switch guard survives`：原实现失败；接收端及安装上下文启动/调度入口检查保护记录。standalone Bus 保持兼容。 |
| Claude 声明 ID 可单独决定切换来源 | `switch cannot use a declared Claude session without matching native execution context`：原实现失败；切换要求同端原生环境，拒绝缺失/混合来源，list 与旧任务回退保留。 |
| 预览后新任务已结束便可绕过空闲检查 | `a task accepted then stopped after preview still invalidates that preview`：原实现失败；快照增加两侧消息 ID 集合摘要。 |
| resultRef 指向丢失或错关联回复 | `completed parent cannot hide a missing or incorrectly linked reply`：原实现失败；检查回复类型、方向、任务及父子关联；核验原生/生命周期引用与文件名。 |
| 离线持久证据损坏或服务已暂停仍可切换 | `offline lifecycle evidence corruption and execution filename mismatch block switching`：原实现失败；检查 events、clean-hints、results、executions，异常健康状态在停止服务前拒绝；补 `paused Bus health blocks switching before shutdown even with empty task storage`。 |
| 默认 doctor 间接 mkdir/写日志 | 既有 live-Bus 测试增加全状态树对比，原实现失败；专用无写入诊断查询及 token 绑定能力发现，覆盖正常、坏记录、旧能力缺失。 |
| 没有 active pointer 时漏查旧路由 | `doctor reports orphan routes even when the active pointer is missing`：原实现失败；无活动记录也按空路由表核对。 |
| 已断开历史被标为 active | `normal disconnected history is never labeled as an active connection`：原实现失败；用 lastSelected 表示历史，active=false。本次按“当前连着谁”的核心用户效果提升为 Important，一并修复。 |

修复开始前定向用例 **30 tests / 22 pass / 8 fail**，修复后含补充健康分支的定向用例 **31/31**，最终完整套件 **295/295**。

## 实施判断与边界

1. 原健康证据检查使用 `store.list()` 会创建目录；改为只读枚举并保留既有身份/结果核验，再为 IPC 增加专用只读能力。若核验遗漏，可能漏报真实往返证据；已有健康测试和全树不变测试覆盖当前实现。
2. 中断后 guard 保留，仍需人工核对，不自动回滚或重放。风险/代价：异常时可用性降低，优先保证不错误换绑或重复派发。
3. 列表可单独展示全局 current，当前聊天参与的历史列表仍精确过滤。风险/代价：本机调用者可见全局连接元数据；不承诺多用户隔离。
4. Codex 只有精确历史、端点 unknown 时沿用原有目标准入能力；展示不宣称在线。风险/代价：首次真实任务仍可能无法投递，需原生证据才能确认往返。
5. 原台账 Ruling 只修复了 messages/ 枚举；reviewer 找出的另一条 IPC 写入路径已独立修复，不能把前一修复当作默认 doctor 无写入的证明。
6. 当前安装、原生 Hook 信任及真实双方往返不在此次离线完成范围。风险/代价：用户需更新安装后才能使用新入口；CLI/Hook 组合兼容性仍需实机验收。
7. Claude 缺少命令进程中的原生会话环境时，本版拒绝 switch，保留只读列表。风险/代价：部分 Claude 入口暂不能直接切换；不得通过设置变量冒充原生身份。

没有延期的审查 Minor；唯一 Minor 已按用户可见影响提升并修复。代码保留于隔离分支，未合并、推送、发布或替换当前安装。
