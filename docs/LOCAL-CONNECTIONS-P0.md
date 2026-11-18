# 本机连接管理 P0（源码开发版）

本功能扩展连接码开发预览；不在 v0.1.1 Release 中。仍只有一组活动配对，不引入远程 Broker、SQLite 或新的依赖。当前安装不会因检出此分支自动更新。

## 在聊天中使用

向当前 Agent 说「当前连着谁？列出这个聊天保存的连接」。更新后的 labus Skill 会列出当前活动连接，以及当前原生聊天参与过的历史连接，展示双方名称、目录、端点观察及未完成任务。新发现的候选聊天仍通过 discover 选择，两份列表不是同一件事。

选中历史连接后说「切换到这个连接」。程序先生成五分钟有效的预览；核对旧、新聊天名称及目录，再确认执行。程序在执行前重新检查身份、绑定、路由、目标端点及两边任务，在确认 Bus 正常退出后再重读持久化状态。不会停止 Claude/Codex 程序，不会替用户取消或归档任务，不会发算术测试或复制历史。恢复后的服务由下一次明确委派按需启动。

从 Codex 使用的命令形态（Skill 代执行，用户无需填写 UUID）：

```text
labus connect list --provider codex
labus connect switch --provider codex --connection <列表中的连接ID>
labus connect switch --provider codex --connection <同一连接ID> --apply --operation <预览operationId>
labus doctor
labus doctor --check-write
```

Claude 侧 connect 命令使用 `--provider claude --source-session ${CLAUDE_SESSION_ID}`，由 Skill 使用原生替换值；doctor 不带会话参数。不能用其他聊天的会话 ID 冒充当前聊天。修改全局路由的 switch 额外要求当前执行环境提供匹配的原生会话变量；仅有 Skill 替换参数的 Claude 环境本阶段只能查看列表，切换会明确拒绝。不得手动设置环境变量来绕过该检查。

## 切换的边界

- 只恢复已保存的 schema-v2 身份配对。旧版 schema-v1 探针连接需要重新走精确聊天配对，不会直接升级为可信身份。
- 活动连接和目标连接都必须包含当前原生聊天；不允许当前第三个聊天修改另一组活动配对。
- 未完成消息、未知交付、尚无结束证据的原生执行、生命周期积压或隔离数据都会阻止切换。
- 新任务在预览后到达会使执行失败；预览不是占用会话，也不是取消任务许可。
- 中途崩溃或 Bus 退出未确认时，`connection-transition.json` 保留，后续派发/激活暂停。P0 不提供自动猜测回滚；用 doctor 检查原状态，保留该文件和历史，由维护者核对后恢复。
- 旧连接、任务、结果、日志和原始会话 ID 全部保留。切换不证明新一轮任务往返已通过。

## 诊断

doctor 的 `ok` 表示诊断命令成功返回，具体健康情况看 `checks`：`ok / warning / error / unverified`。错误包含 code、summary、nextAction。它独立报告安装文件、安装产物哈希、实际运行目录、原生信任未知、路由/绑定、任务积压、Bus 和端点。Codex 历史存在不能证明窗口在线。

默认 doctor 只读。`--check-write` 在现有安装根目录尝试唯一临时文件的写入、同步和清理，不创建缺失安装目录。测试的是本次执行环境，不是永久权限承诺。权限不足需按原生提示申请本次执行审批，不修改权限或沙箱设置。诊断不会打印邀请码、临时配对凭据、IPC token 或聊天正文。

新版 Bus 在启动时保存与当前 IPC token 绑定的只读诊断能力记录。doctor 只有确认该记录后才发送只读查询；旧服务或能力无法确认时显示 unverified，不用可能写日志的旧 health 请求试探。切换也会拒绝未确认的协议或异常服务状态，需要先审阅运行时更新与原服务恢复。

## 验证范围

离线测试使用临时用户目录、真实文件和测试 IPC，覆盖双向原生来源、预览/执行、身份保留、无探针、过期/变化、任务晚到、旧版互斥、退出不确定及中断保护。权限拒绝分支通过受控文件系统错误注入测试；不声称在所有 Windows ACL 环境实测。

初次离线阶段两端 Skill 做独立的命令选择场景检查，该模拟不等于真实 Claude/DeepSeek 加载或往返验证。后续已在用户明确授权下更新本机安装并完成同一对真实聊天的历史恢复及恢复后正向往返；完整离线测试 324/324。反向往返在恢复前独立验证，不同聊天对迁移和真实 Desktop queue/start 尚未在本轮实测。阶段证据、修复及其范围见[真实窗口验收](LOCAL-CONNECTIONS-P0-LIVE-ACCEPTANCE.md)和[修复记录](LOCAL-CONNECTIONS-P0-REPAIR.md)。GitHub Release 保持原版本。
