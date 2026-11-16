# Windows 安装、连接与卸载

AgentWire v0.1.0 是 Windows 技术预览；已验证组合及未覆盖场景见[验收边界](CLEAN-MESSAGES-ACCEPTANCE.md)。

## 环境要求

- Windows；Node.js >=24，`node` 已在 PATH 中。
- Codex Desktop 与 Claude Code 已安装并各自登录。不是任意 Codex CLI 都具备本版所需的桌面队列能力。
- 两个目标聊天已打开；首次安装后核对 Skill 是否加载，必要时按原生方式刷新或恢复聊天。

安装器不下载 Node，不接入第三方模型 API，不修改两端的原生工具审批。

## 安装步骤

从 GitHub Release 下载 `agentwire-0.1.0-windows.zip` 并解压，或克隆源码，然后运行：

```powershell
powershell -NoProfile -File .\install.ps1
```

先展示将要修改的运行时、两端 Hook、两端 Skill 和用户 PATH。输入 `yes` 才应用；默认退出而不应用。安装使用 `%LOCALAPPDATA%\LocalAgentBus`，命令和 Skill 暂保留 `labus` 名称。

若现有 PowerShell 策略阻止脚本，保留策略，使用 Node 直接查看预览：

```powershell
node --experimental-strip-types src/labus.ts setup
```

根据输出检查 `runtime.operationId` 和 `configuration.operationId`，再执行下面的命令，将占位内容替换成该次预览的两个操作 ID：

```powershell
node --experimental-strip-types src/labus.ts setup --apply --operation <runtime-operation-id> --configuration-operation <configuration-operation-id>
```

不要复制尖括号占位符直接执行。预览生成的操作记录包含待应用内容与哈希；外部修改导致不一致时会拒绝覆盖。无需 `npm install`。

## 原生信任

安装完成后，在 Codex Hooks 设置审核本工具的 UserPromptSubmit、Stop、Interrupt；在 Claude `/hooks` 核对 UserPromptSubmit、Stop、StopFailure。命令指向已安装的 Hook router；Windows 命令可能以 PowerShell EncodedCommand 包装。不要停用原有 Hook，也不要绕过原生信任。

两个 Skill 写入用户的 `.agents/skills/labus` 与 `.claude/skills/labus`。Skill 使用绝对程序路径，不依赖已有窗口继承新 PATH。终端的 `labus` 命令需在 PATH 更新后可见。

## 选择聊天与连接

在 Codex 说「列出可以连接的 Claude 聊天，让我选」，或在 Claude 说「连接我打开的 Codex」。明确选择目标后，程序进行双向探针；只有 `ready` 才表示连接成功。历史候选、活进程、已入队都不是送达证明。

当前回合需结束才能消费原生队列时，正常结束后再检查，不在同回合阻塞等自己的 Stop。已有连接只查状态，不重复探针。首版只允许一组活动连接，换窗口需要明确断开和重新选择。

连接成功后，用自然语言委派任务即可；首次或新的工具命令仍可能触发两端自身的审批。

## 排障

```text
labus status
labus doctor
```

检查连接状态、未完成任务、原生信任和对方窗口。`needs_check` 表示需核对，不代表业务失败或可安全重做。离线任务只有有限重试与期限，不是无限期邮箱。不要删除历史或换新编号盲重发。

后台 Bus 隐藏运行，无开机自启；重连使用同一状态。发现运行时正被使用时，安装器拒绝覆盖。更新前先正常结束/处理在途任务并断开，不杀原生 Agent。旧原型的固定会话 Hook 必须先精确撤销，不能新旧消费者同时接管。

## 断开和卸载

```text
labus disconnect
labus disconnect --apply
labus uninstall
labus uninstall --apply
```

无 `--apply` 时只预览。未完成任务阻止正常断开/卸载；先在原窗口核对。`disconnect --apply --stop` 停止后续 Bus 动作，不撤回已投递的原生工作。已经尝试执行但终态未知时保留路由与服务、进入 `needs_check`。

只有明确接受不再采集迟到结果时才使用 `disconnect --apply --archive`；它也不取消原生 Agent。不要以断开替代业务取消。

卸载只撤销本工具拥有的精确配置组，不覆盖外部编辑；自有组被外部修改时报告待核对。保留消息、结果、日志、备份与运行时，不 purge 历史。回滚到不认识 schema2 的旧原型时，不能让旧运行时直接打开当前状态，见[干净消息](clean-messages.md)。
