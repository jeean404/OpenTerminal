# OpenTerminal

[![CI](https://github.com/jeean404/OpenTerminal/actions/workflows/ci.yml/badge.svg)](https://github.com/jeean404/OpenTerminal/actions/workflows/ci.yml)
[![PyPI](https://img.shields.io/pypi/v/ot-cli.svg)](https://pypi.org/project/ot-cli/)
[![Python](https://img.shields.io/badge/python-3.11%2B-blue.svg)](https://www.python.org/downloads/)
[![Downloads](https://img.shields.io/pypi/dm/ot-cli.svg)](https://pypi.org/project/ot-cli/)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

**用大白话指挥你的终端——活它来干。**

[English](README.md) · [安装](#安装) · [安全模型](#安全模型)

<div align="center">
  <img src="docs/images/demo-terminal.gif" width="860" alt="OpenTerminal 终端演示:先敲普通命令，再说人话——思考、分析、只读探查自己跑、删除卡在审批、最后落下总结表"><br><br>
  <img src="docs/images/demo-web.gif" width="860" alt="OpenTerminal 浏览器演示:同一条流程——自然语言任务、流式分析、破坏性命令进审批、执行、由真实输出汇成的总结表">
</div>

> ⚠️ **Beta**：OpenTerminal 在真实机器上执行真实命令——包括生产服务器。
> 改动性命令都要经你审批（见[安全模型](#安全模型)），但点「执行」之前还是请
> 看一眼它要干什么。安全类漏洞披露见 [SECURITY.md](SECURITY.md)。

## 介绍

OpenTerminal 是一款面向习惯使用 shell 的用户的自然语言终端 Agent。你用大白话说出想要的结果，它自己琢磨出命令、在你的真实 shell 里执行，再把结果汇总给你。想直接敲命令也照常一行不差地执行，vim / top / tmux 这类全屏程序原生接管——它就是你的终端，不是一个套壳的命令执行器。

无需额外依赖，终端（`ot`）和浏览器（`ot web`）都支持，底层是同一套核心；本机 shell 与 SSH 远程主机都可以，跨 macOS、Linux、Windows。

上面两张动图是同一条任务的真界面录屏：普通命令 → 说人话 → 思考与分析 → 只读探查自己跑 → 删目录卡在审批 → 总结表。录制走的是脚本化 Agent，命令、策略判定和每一行输出都是真的，随时可重录（见 `tools/demo-recorder`）。

## 主要功能

**自然语言任务。** 一句话就是一条任务：AI 流式给出思考与分析，执行完把结果汇总成 markdown 表格，表里的每一行都来自真实命令输出。命令和人话共用一个输入行——`!` 强制命令、`?` 强制任务，Ctrl+C 随时中断。斜杠命令有 `/help` `/target` `/system` `/clear` `/model` `/exit`。你在任务之间手动敲的命令也会以滚动摘要（命令 + 退出码 + 输出尾部）并进模型上下文，不占窗口。状态行显示本会话 token 用量，网关回传就用真值，否则退化为本地估算。

**Shell 与远程。** 会话持久，`cd`、环境变量、venv 跨任务保留；全屏程序经真 PTY 直通原生内联。发行版方言自动探测（apt / yum / dnf / apk / pacman / brew），可用 `/system` 手动覆盖。主机来自 `~/.ssh/config`、临时 `user@host:port` 或记住的连接；密码存系统凭据库，不落明文文件，嵌套 `ssh` / `sudo` / `su` 的密码提示会自动填。支持连接后命令集——跳板机接力、`su -` 换用户这类事登录即自动跑完，密码写一次 `> @名称=密码`，落库只留引用。

**技能与工具。** 内置技能包随包分发（`SKILL.md` 挂在 `/skills/`），模型遇到对应任务才按需读取；Web 界面可逐个启停、上传 `.md` / `.zip`、从本机目录导入。MCP 服务器在「工具」入口粘贴 Claude Desktop / `.mcp.json` 配置即可批量导入（stdio、HTTP、SSE），可启停、可连接测试，与内置工具并列生效。

**Web UI。** 服务器侧栏 + 多 tab 终端，每个 tab 可在 Agent 视图与纯 Shell 视图切换。文件面板支持分块断点续传。密码、主机密钥用浏览器弹窗输入；绑定非本机地址必须带 token。设置页覆盖终端字号与滚动缓冲、主题与背景、技能、工具、模型，界面语言中英原地切换、不刷新页面。

**无头调用。** `ot exec -t <目标> -c "<命令>" --output json` 一次跑一条策略闸门把关的命令，输出机器可读，可接 cron、CI，或交给另一个 Agent。

## 安装

三选一——预编译二进制（无需 Python）、包管理器、源码。

**预编译二进制**：从 [Releases](https://github.com/jeean404/OpenTerminal/releases) 下载解压，把 `ot` 放进 `PATH`。`vX.Y.Z` 换成最新 tag：

| 平台 | 附件 |
|---|---|
| macOS（Apple Silicon） | `ot-vX.Y.Z-macos-arm64.tar.gz` |
| macOS（Intel） | `ot-vX.Y.Z-macos-x86_64.tar.gz` |
| Windows（x64） | `ot-vX.Y.Z-windows-x64.zip` |

```sh
# macOS
tar -xzf ot-vX.Y.Z-macos-arm64.tar.gz
sudo mv ot/ot /usr/local/bin/ot        # 或任意在 PATH 里的目录
```

Windows 解压后把 `ot` 目录加进 `PATH`，运行 `ot.exe`。

> Intel Mac 的二进制是发版时手工构建挂载的（GitHub 已退役 Intel macOS runner）。某个 release 缺这个附件时走下面的 pipx 即可，两种架构都可用。
>
> macOS 首次启动可能被 Gatekeeper 拦（二进制为 ad-hoc 签名）：执行一次 `xattr -cr "$(command -v ot)"` 清除隔离属性，或右键 → 打开。首次运行会触发一次性系统安全扫描，之后启动不到 1 秒。
>
> Windows 可能弹 SmartScreen（二进制未签名）：**更多信息 → 仍要运行**。

**pipx / uv**（PyPI 包名 `ot-cli`，装完提供 `ot` 命令，模块名仍是 `openterminal`）：

```sh
pipx install ot-cli
# 或
uv tool install ot-cli
```

需要 Python 3.11+。旧名 `open-terminal-agent`（仅 0.1.0）已弃用，新版本一律以 `ot-cli` 发布。

**源码**：

```sh
conda create -n openterminal python=3.12 -y   # 或任意 virtualenv
conda activate openterminal
pip install -e .
```

## 配置方式

模型网关在 **设置 → 模型** 里配：填协议、URL、模型和 API Key，启用后新建的终端才使用它，已打开的不受切换影响。配置元数据存 `~/.openterminal/connections.db`，API Key 存操作系统凭据库，不写进项目配置文件。CLI 仍兼容环境变量和 `config.toml` 的 `[model]`。

其余设置写 `~/.openterminal/config.toml`：

```toml
[shell]
timeout_default = 120        # 单条命令最长等待秒数
max_output_bytes = 102400    # 单条命令输出截断
max_tool_turns = 10          # Agent 工具调用轮次预算

[policy]
mode = "tiered"              # tiered(分级) | approve-all | deny-all
# auto_extra / approve_extra / deny_extra 可追加精确匹配的自定义规则

[target.prod-web]
mode = "ssh"
host = "prod-web.example.com"
user = "deploy"
# 连接后命令集——登录成功后逐行执行。
# "> @名称=密码" 那一行会把密码抽进系统凭据库，落库只留 "> @名称";
# 密码框应答时按这个引用去取。
commands = [
  "su - deploy",
  "> @deploy_pw",
]
```

配置目录可用环境变量 `OPENTERMINAL_HOME` 覆盖（测试即用它做隔离）。会话记录写入 `~/.openterminal/sessions/`，主机画像缓存在 `~/.openterminal/hosts.toml`。

## 支持平台

| 项 | 支持 |
|---|---|
| 操作系统 | macOS、Linux、Windows |
| 本机 shell | macOS / Linux 走 PTY；Windows 走 ConPTY + PowerShell |
| 兼容 shell | zsh 与 bash ≥ 4 全功能；bash 3.2（macOS 自带）拿不到 `READLINE_LINE`，自然语言触发链不可用 |
| Python | 3.11+（pipx / 源码安装时需要；预编译二进制不需要） |
| 模型网关 | Anthropic 兼容与 OpenAI 兼容，可配多组 |

## 系统架构

<div align="center">
  <img src="docs/images/architecture.svg" width="860" alt="OpenTerminal 架构图">
</div>

三层结构：自然语言前端（终端或 Web）、deepagents（LangGraph）Agent、持久 shell 会话。自然语言直接交给 Agent 多轮调用工具，命令执行是 Agent 的子能力，经同一个会话；三级策略在 Agent 中间件层强制，提示词内容绕不过审批闸门。内置技能以文件形式挂在 `/skills/`，模型读技能和读普通参考文件走同一条路；MCP 工具经 `langchain-mcp-adapters` 接进来，与内置工具并列。

显示走单管线：PTY 字节流原样直达终端，shell 集成 hook 用带内 OSC 标记记账（历史、退出码、AI 上下文），Agent 工具命令经 `__ot_exec__` 注入同一个 PTY，输出天然归位。单会话内命令严格串行——一个 PTY 就是一条交互 shell，Agent 并发发起的 execute 会排队。哨兵切分只保留给无头 `ot exec` 与能力探测等非显示路径。

项目没有模型级长期记忆——Agent 的 checkpointer 在内存里，重启即清空。持久化的是「事实型」数据：

| 存储 | 位置 | 内容 |
|---|---|---|
| 配置 | `~/.openterminal/config.toml` | 模型网关 / shell 超时 / 策略 / 目标 |
| 数据库 | `~/.openterminal/connections.db` | 记住的连接及命令集、模型配置、技能启停、MCP 服务器、背景参数 |
| 技能 | `~/.openterminal/skills/` | 用户技能包（每目录一个 `SKILL.md`），同名覆盖内置 |
| 背景 | `~/.openterminal/wallpapers/` | 自定义背景媒体；浏览器端不留存 |
| 命令历史 | `~/.openterminal/history.db` | 每 target 的历史，重连灌回 shell |
| 密码 | 系统凭据库（keyring） | 连接密码、命令集内联密码——不落明文文件 |
| 主机画像缓存 | `~/.openterminal/hosts.toml` | 免重复探测 |
| 会话记录 | `~/.openterminal/sessions/<日期>/` | 输入 / 命令 / 审批 / 总结的 JSONL |
| 主机密钥 | `~/.ssh/known_hosts` | TOFU 确认后写入 |

## 支持模式

**终端模式（`ot`）。** 直接在你的终端里跑，本机 shell 加一个主菜单（连接、管理主机）。说人话就是任务，敲命令就在真 shell 里执行，`!` 与 `?` 可以强制指定。Ctrl+C 中断任务回到提示符，`/exit` 退出。这是单管线实现：命令输出、AI 卡片、命令历史都在同一个字符流里。

**浏览器模式（`ot web`）。** 起一个 Web 服务，默认 <http://127.0.0.1:8080>。左侧服务器侧栏选目标，tab 想开几个开几个；每个 tab 可在 Agent 视图（AI 卡片 + 审批）与纯 Shell 视图之间切换，tab 标签上各自显示连接状态。密码与主机密钥走浏览器弹窗，记住的密码下次连接免密。局域网访问用 `ot web --host 0.0.0.0 --token <TOKEN>`，绑定非本机地址必须带 token。

**无头模式（`ot exec` / `ot list`）。** 给脚本和别的 AI 编程工具（Claude Code、Codex、opencode 等）当子进程调用，不进 REPL。一次一条命令、过同一套策略闸门、输出结构化 JSON。退出码分层：远程命令退出码原样透传（0–63），工具自身错误用 64 以上的保留码，调用方因此能分清「命令失败」与「调用失败」。无头下审批永不卡住，一律结构化拒绝，出路只有人的动作。

## 安全模型

一句话：**只看随便看；要动手得经你同意；闯祸的事直接不做。**

三级命令策略（`src/openterminal/policy.py`）：

- **auto**：纯查看类自动执行——`ls`/`cat`/`df`/`ps`、`git status/log`、不带 `-exec/-delete` 的 `find` 等。
- **approve**：改动系统的都要审批——删文件、写文件、装软件、`systemctl`、`sudo`、网络配置，以及静态规则拿不准的命令。弹审批面板，`y` 执行 / `e` 编辑 / `n` 拒绝 / `a` 本会话始终允许（Web 界面是按钮，高危命令另有二次确认）。
- **deny**：灾难命令直接拒绝，拒绝原因回灌给模型让它改道——`rm -rf /`、mkfs、`dd` 写块设备、fork 炸弹、关机重启、重定向到 /dev 盘等。

这道闸门在 **Agent 中间件层**强制，不在提示词里——提示词写得再好也只是「请」，中间件才是「不许」，再会说的 prompt 也绕不过去。被拒和失败的命令不会被原样重试：同一失败最多重试一次，被拒命令不得换皮重试，工具调用轮次也有预算上限。每条输入、命令、审批、总结都落 JSONL 会话记录（`~/.openterminal/sessions/`）。

## 主要特征

**它是真 shell，不是命令执行器。** `cd`、环境变量、venv 跨任务保留，vim / top / tmux 原生接管。要做到这一点只能走真 PTY 直通，壳里加一层 hook 用带内标记记账——代价是 bash 3.2 这类老壳支持不全，见[支持平台](#支持平台)。

**闸门在中间件层。** 审批不依赖模型自觉，也不依赖提示词约束，而是 Agent 工具调用路径上的强制检查。这是它跟「直接放行」那类工具最本质的差别。

**失败有预算，不无限重试。** 同一失败最多重试一次，被拒命令不允许换皮重来，工具调用轮次有上限。刷屏式自纠是很多 Agent 让人失去信任的原因。

**一方一言。** 同一句需求，Ubuntu 出 apt、CentOS 7 出 yum、Rocky 出 dnf、Alpine 出 apk、macOS 出 brew；探错了还能用 `/system` 手动改。

**一切留痕。** 输入、命令、审批决策、总结全落 JSONL，出问题能回看当时到底发生了什么。

**没有长期记忆，只有事实状态。** 会话记忆随重启清空，留下的是配置、连接、历史、密钥这类事实数据——不会悄悄记住你不想让它记住的东西。

## License

[Apache License 2.0](LICENSE)
