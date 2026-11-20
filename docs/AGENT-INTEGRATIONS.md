# Agent 接入层（第一阶段）

公共入口为 `src/agents/registry.ts`；`AgentIntegration` 契约在 `src/agents/model.ts`。当前只登记 Codex 和 Claude 两个内置实现，不从外部路径加载插件。

每个 Agent 的接入模块集中描述：

- 原生会话环境变量与原有 Skill 身份兼容策略。
- 有界会话发现，支持精确 sessionId 查找，不选择最近聊天替代目标。
- 原生回合 ID 字段、转录目录和转录文件名约束。
- 人工配对输入的原生记录证明；Claude 的 Skill 伴生记录排除仍要求完整工具谱系。
- 运行时 Adapter 和 EvidenceReader 的装配。具体传输实现继续保留在 adapters/，原生结果与送达证据解析保留在 native/。

调用关系：

```text
installation/discovery -> registry -> Agent.discover
installation/source    -> registry -> 会话来源策略
pairing/capture        -> registry -> Agent.provePairInput
lifecycle/normalize    -> registry -> 原生回合字段与事件约束
main                   -> registry -> Adapter + EvidenceReader
Bus                    -> AgentAdapter.probe / submit / reconcile
```

注册入口导入不启动 CLI、不发消息、不写配置。Adapter/EvidenceReader 的实现模块按运行时装配需要延迟导入。装配操作本身也不探测或发送。

公共配对流程继续负责安全路径、快照读取、大小限制、时间有效性和状态写入。Agent 实现只解释本家的原生记录，不能自行签发连接码或改变权限。消息队列、去重、超时、重试、暂停与结果状态仍由原有 Bus/生命周期流程管理。

## 兼容范围

本次不迁移磁盘记录，不修改旧连接、消息 schema、连接码入口、Hook 命令或 Skill。Provider 联合类型和配对结构仍限定 Codex/Claude；不宣称已经支持任意第三种 Agent。

后续接第三种 Agent 时，可在 agents/ 增加实现并登记，复用上述公共流程；仍需单独扩展 Provider 类型、两端配对结构/校验、安装配置/入口、原生传输及结果证据读取。Codex 专用队列泵和其他尚存的双端策略也需逐项核对。第一阶段统一的是接入能力入口，不是通用多 Agent 编排。

## 验证

`tests/unit/agent-registry.test.ts` 覆盖未知/原型名拒绝、精确聊天发现、来源策略、人工输入证明、无投递副作用的运行时装配、来源冲突及原生回合字段。已有 pairing-capture、lifecycle、adapter 与 roundtrip 测试继续覆盖协议兼容性。

2026-11-20 已更新本机运行时：仅替换 11 个适配层文件，正常重启 Bus，并验证已安装的 registry/Adapter/EvidenceReader 装配。安装阶段的 Hook、权限、配对记录及历史文件哈希保持不变。随后按用户选择正常断开旧配对、保留历史，将当前 Codex 连接到指定 Claude。

本次实现验证：完整离线测试 604/604 通过（0 失败）；覆盖现有配对、安装/回滚、原生证据、双向多轮消息与生命周期回归。测试输出保存在执行机器临时目录的 agentwire-agent-registry-full-tests.txt。另已完成针对本次拆分与改动前备份的独立只读审查，未发现行为或安全回归。原窗口通信回归已核对：内置 Codex→Claude、Claude→Codex 两个探针均返回 667，transport=observed 且 answer=expected；另有 Codex→Claude 25×15 任务返回 375，精确关联同一任务的 followup 返回 376。4 次执行均只提交一次，原生回合映射、结果哈希、终止事件及回复送达证据一致；共 4 个任务/续行与 4 条回复，无在途、待核对或待处理生命周期工件。该反向探针验证传输及自动回传，不等于重新验收 Claude 模型主动调用 ask。普通人工聊天插话本轮未单独实测，仍仅由既有离线回归覆盖。此处不声称业务代码任务或第三 Agent 已验收。
