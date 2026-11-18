# Windows 安装、连接与卸载

本分支新增的连接码入口属于未发布实现，尚未完成产品原窗口/新聊天验收，
不能把下面已发布 0.1.1 的安装验证算作连接码验证。
当前进度及正式验收步骤见[连接码验收](PAIRING-ACCEPTANCE.md)。

AgentWire v0.1.1 是 Windows 技术预览；已验证组合及未覆盖场景见[验收边界](CLEAN-MESSAGES-ACCEPTANCE.md)。0.1.0 在真实脚本安装中暴露 PATH 写后超时问题，建议使用 0.1.1。

## 环境要求

- Windows；Node.js >=24，`node` 已在 PATH 中。
- Codex Desktop 与 Claude Code 已安装并各自登录。不是任意 Codex CLI 都具备本版所需的桌面队列能力。
- 两个目标聊天已打开；首次安装后核对 Skill 是否加载，必要时按原生方式刷新或恢复聊天。

安装器不下载 Node，不接入第三方模型 API，不修改两端的原生工具审批。

## 安装步骤

从 GitHub Release 下载 `agentwire-0.1.1-windows.zip` 并解压，或克隆源码，然后运行：

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

在安装了本分支且确认双方加载新 Skill/Hook 后，可在真正目标聊天输入
`生成连接码`，再在另一聊天输入 `连接 Claude，连接码 XXXX-XXXX`
（反向为 `连接 Codex，连接码 XXXX-XXXX`）。代码来自本地程序，一小时有效，
一次使用。标题和目录只供核对，路由绑定原生聊天身份，不要求双方同目录。
新聊天无需添加到配置白名单。缺本回合 Hook 凭据时不发码、不按标题猜选。

`paired` 仅表示身份配对，程序不自动发送算术探针；用户可明确委派首任务，
再按逐方向原生结果判断实际往返。它与下面旧版 `ready` 验证保持分离。
已有其他活动连接须先按原有保护处理，兑换不会自动覆盖或归档。

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

Windows 的 PATH 通知可能晚于注册表写入。0.1.1 在设置进程结束或超时后重新读取用户 PATH，只有精确等于目标值才登记安装/撤销成功。终端环境未刷新时，可先使用 `%LOCALAPPDATA%\LocalAgentBus\bin\labus.cmd` 的绝对路径，或在刷新环境后重开终端；两端 Skill 使用绝对路径，不依赖 PATH 通知。

已安装的 `labus.cmd` 会在自身子进程中固定 `AGENTWIRE_INSTALL_ROOT`，始终读取所属安装的状态。Codex 沙箱可能重定向 `LOCALAPPDATA`；在沙箱中应使用 Skill 中的完整启动器路径，不能重新拼接沙箱的 `%LOCALAPPDATA%`。安装目录固定不授予额外权限：若原生执行环境要求访问审批，仍须按原生流程处理。直接从源码首次安装且未指定该环境变量时，继续使用当前用户的 `LOCALAPPDATA` 默认位置。

配对会写入项目目录外的用户级状态。Codex 通过 `exec_command` 执行发码、兑换时，应以 `sandbox_permissions: "require_escalated"` 发起原生执行审批，并说明访问 AgentWire 本地状态的用途；这不修改权限配置，也不代替用户批准。若无法获批，应停止并报告。`pairing_storage_access_denied` 表示本地状态访问被拒绝，不能据此认定已创建激活事务或连接码已占用。凭据到期后必须等待新的原始输入，不能重放旧请求。

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
