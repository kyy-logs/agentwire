# 0.1.1 安装流程实测

日期：2026-11-16。Windows、Node 24.9.0、Windows PowerShell，执行策略 RemoteSigned，未修改策略。

## 发现的问题

从 GitHub Release 重新下载 0.1.0 的 Windows ZIP，核对发布校验值，解压到带中文与空格的临时目录，直接运行包内 `install.ps1`。

预览后输入 `no` 正常退出，未应用 Hook、Skill、命令入口或 PATH。重新运行并输入 `yes`，原版失败：配置操作处于 applying，四个文件目标已完成，用户 PATH 实际已写入，但 PATH 所有权还未登记。底层设置进程因五秒超时被 SIGTERM 终止，CLI 报 operation_unconfirmed。

已撤销这次临时配置，并确认用户 PATH 恢复、原有四项 Hook/Skill 配置哈希未变。私人路径、原始配置和本地取证记录不随仓库发布。

## 最小修复

`src/installation/configuration.ts` 的 `setConfirmedPath` 用于安装和撤销：设置后重新读取用户 PATH。写进程超时但读到精确目标值，可以完成配置所有权记录；没有写成目标值、出现其他值或无法读取时仍然失败。不自动再次写入，不放宽其他安装校验。

四项新增回归先在旧实现运行，两个失败，确认覆盖了真实缺陷；修复后配置测试10/10通过，完整串行离线测试184/184通过，退出0、stderr为空。

## 修复包实际流程

在另一套空的隔离用户目录，运行 0.1.1 候选 ZIP 内的原版安装脚本，交互输入 `yes`，没有注入安装依赖或替换安装器的注册表操作。

| 步骤 | 结果 |
| --- | --- |
| 交互安装 | 退出0，阶段 awaiting_native_trust |
| 运行时 | 38个安装清单文件哈希全部匹配，含生成的命令启动器 |
| Codex Hook | UserPromptSubmit、Stop、Interrupt 三组 |
| Claude Hook | UserPromptSubmit、Stop、StopFailure 三组 |
| 两端 Skill | 均已生成，绝对启动器路径已替换，不含模板占位符 |
| 用户 PATH | 本次临时 bin 仅出现一次 |
| 原版启动器 status / doctor | 正常运行，均返回 disconnected |
| 原版 uninstall 预览 | 返回 preview |
| 原版 uninstall --apply | 返回 uninstalled；自有 Hook/Skill 撤销，运行时及备份保留 |
| 真实用户 PATH 与现有配置 | PATH 精确恢复，原有四项配置哈希未变 |

文档补齐后重新打最终发行包，再核对最终包与实际安装过的运行时源文件一致；不会替换旧 0.1.0 标签或附件。

## 尚未覆盖

隔离目录通过子进程用户路径变量模拟新安装，不是新建的 Windows OS 账户。只有 PATH 操作用了真实当前用户注册表，并已撤销。没有将模拟用户 Hook 加载到真实两端程序，没有代替原生信任确认，也没有在这套新配置上重复双窗口连接。

下载安装使用 GitHub CLI；未验证浏览器下载所带 Mark-of-the-Web 的提示。真实 Node 缺失、新机器、不同原生版本组合仍需单独验收。安装器的逐文件预览和完整 JSON 输出仍较长，属于待改善的使用体验。
