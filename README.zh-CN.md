# OpenTerminal

[![CI](https://github.com/JaquariusJ/OpenTerminal/actions/workflows/ci.yml/badge.svg)](https://github.com/JaquariusJ/OpenTerminal/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

[English](README.md) | 中文

> ⚠️ **Beta 阶段**:OpenTerminal 会在真实机器上执行真实命令——包括你的生产
> 服务器。审批系统(见[安全模型](#安全模型))会拦截所有改动性命令,但通过前
> 请仔细确认。

在自带终端里输入自然语言,自动翻译成目标系统的命令并执行;自带远程连接,
不需要 Xshell。基于 deepagents(LangGraph)构建。

## 能力

- 自然语言 ↔ 命令自动甄别,命令直接执行、任务交给 Agent
- 持久 shell(cd/export/venv 状态保留);Linux/macOS 本地(POSIX PTY)、
  Windows 本地(ConPTY,PowerShell)、SSH 远程 Linux
- 系统画像与方言翻译:Ubuntu→apt、CentOS 7→yum、Rocky/Fedora→dnf、Alpine→apk、macOS→brew
- 分级审批:只读自动、高危审批、灾难命令拒绝;失败自我修正(10 轮预算)
- Ctrl+R 终端透传模式(vim/top/tmux),Ctrl+O 返回;自带 SSH,支持跳板机(~/.ssh/config)
- Windows 可作为客户端连接远程 Linux
- Web 终端(`ot web`):浏览器多 tab 终端 + 服务器侧栏,与 CLI 共用同一套 Agent 核心

## 安装

需要 Python 3.10+。

```sh
conda create -n openterminal python=3.12 -y
conda activate openterminal
pip install -e .
mkdir -p ~/.openterminal && cp .env.example ~/.openterminal/.env
# 编辑 ~/.openterminal/.env 与 config.toml(模型网关)
```

## 模型网关配置

启动时依次加载当前目录 `.env`、`~/.openterminal/.env`,然后读取
`~/.openterminal/config.toml`。**两者都可以不创建**——缺省时使用内置默认值:

- 网关:`http://127.0.0.1:15721`(Anthropic 兼容协议)
- 模型:`claude-sonnet-4-6`
- API Key:读取环境变量 `ANTHROPIC_API_KEY`

`~/.openterminal/config.toml` 可选示例(所有字段均可省略,省略即取默认值):

```toml
[model]
base_url = "http://127.0.0.1:15721"
model = "claude-sonnet-4-6"
api_key_env = "ANTHROPIC_API_KEY"

[shell]
timeout_default = 120        # 单条命令最长等待秒数
max_output_bytes = 102400    # 单条命令输出截断
max_tool_turns = 10          # Agent 工具调用轮次预算

[policy]
mode = "tiered"              # tiered(分级)| approve-all | deny-all
# auto_extra / approve_extra / deny_extra 可追加精确匹配的自定义规则

[target.prod-web]
mode = "ssh"
host = "prod-web.example.com"
```

配置目录可用环境变量 `OPENTERMINAL_HOME` 覆盖(测试即用它做隔离)。
会话 transcript 写入 `~/.openterminal/sessions/`,远程主机画像缓存于
`~/.openterminal/hosts.toml`。

## 使用

```sh
ot                       # 主菜单:连接主机 / 管理主机 / 退出(↑/↓ 光标选择)
ot connect prod-web      # ~/.ssh/config 中的主机
ot ssh deploy@host:2222  # 直接指定 user@host:port
```

主菜单列出可连目标:`local`(本机终端)、记住的连接、经跳板机的目标
(子列表)。新增 / 编辑 / 删除主机与跳板机统一在「管理主机」里做。记住的
连接存放在 `~/.openterminal/connections.toml`(本机私有,不进 git 仓库)。
记住连接时若用了密码认证,密码会存入**系统凭据库**(Windows 凭据管理器 /
macOS Keychain / Linux Secret Service,经 keyring 库),下次选中该连接直接
免密登录;无可用凭据库(如无桌面的 Linux)则每次连接时输入,不影响使用。

REPL:直接输入命令或中文需求;`!` 强制命令、`?` 强制任务;
`/target` 切主机、`/system` 手动方言、`/clear` 新任务、`/model` 查看模型、
`/exit` 退出;Ctrl+R 终端透传模式,Ctrl+O 返回。

### 输出策略

界面按环节分框呈现(类似云厂商工作台的样式):

- 模型的中间思考过程实时显示在独立的 **💭 思考过程** 框中,每段思考在命令
  开始执行时定格成框;
- 命令以 **执行** 面板呈现,输出原样透传;命令非零退出只附一行退出码提示,
  **不**视为失败(探测类命令非零退出是常态,如 `command -v` 查缺工具、
  `grep` 无匹配);
- 最终总结单独成 **📝 总结** 框;被安全策略/审批拒绝、预算耗尽时附原因行。

## 安全模型

核心原则:**只查看不改服务器的操作自动执行;删除文件或任何会改动服务器的
操作都属于高危,必须经你审批;灾难命令直接拒绝。**

三级命令策略(`src/openterminal/policy.py`):

- **auto**:纯查看类命令自动执行(ls/cat/pwd/df/ps、`ip addr show` 等查询、
  `git status/log`、find(不带 -exec/-delete)等)
- **approve**:高危——删除文件(rm/rmdir)、任何改动服务器的操作(写文件/
  重定向、mv/mkdir/touch、安装卸载、systemctl 服务操作、sudo 提权、网络
  配置、改主机名、`git config` 写配置等),以及无法静态判定的命令——弹
  审批面板,可选 `y` 执行 / `e` 编辑 / `n` 拒绝 / `a` 本会话始终允许
- **deny**:灾难命令直接拒绝并把原因回灌模型(`rm -rf /`、mkfs、dd 写块
  设备、fork 炸弹、关机重启、重定向到 /dev 盘等),模型必须改道

拒绝/失败不会原样重试:Agent 系统提示词规定同一失败命令最多重试一次、被拒
命令不得换皮重试;连续工具调用受轮次预算保护,触顶后给出有界报告。

## Web 终端(ot web)

`ot web` 启动本地 Web 终端:左侧栏服务器列表(local / 直接连接 / 经跳板机),
右侧多 tab 浏览器终端,具备与 CLI 相同的 ot 核心能力(自然语言任务、分级
审批、💭思考/⚙执行/📝总结面板)。默认绑定 `http://127.0.0.1:8080` 并自动
打开浏览器。

- 每个 tab 一个 ShellSession + 一个 Agent;`Ctrl+R` 或按钮切换透传模式
  (vim/top)
- 密码/主机密钥经浏览器弹窗输入;记住的密码仍走系统凭据库免密
- 局域网访问:`ot web --host 0.0.0.0 --token <TOKEN>`(绑定非本机地址必须带
  token)
- 配置:`~/.openterminal/config.toml` 的 `[web] host/port/token`
- 交互命令(`su`/`sudo su -`/`sudo -i` 等)判为透传操作;sudo/密码提示会被
  立即识别并给出指引,替代 120s 超时丢会话

## 跳板机

跳板机在「管理主机」中集中管理(存 connections.toml `[[jumps]]`);添加或
编辑主机时可指定"经跳板机"。连接经跳板机代理到目标(先连 jump 再 tunnel,
密码认证的跳板机同样可用);跳板机密码存入系统凭据库后下次免密。

## 架构

自然语言 REPL + deepagents(LangGraph)Agent + 持久 shell 会话三层。输入
经意图分类分流:直接命令走会话执行,任务交给 Agent 多轮工具调用;命令分级
策略(auto/approve/deny)在 Agent 中间件层强制。

```
┌───────────────────────────────────────────────────────────┐
│ 入口  src/openterminal/app.py                              │
│   ├─ Cli(cli.py):prompt_toolkit + rich 的 REPL 主循环       │
│   │    ├─ intent.py      命令 vs 自然语言任务 分类           │
│   │    ├─ agent.py      deepagents 装配 / TaskRunner / 审批 │
│   │    ├─ policy.py     命令分级(auto/approve/deny)        │
│   │    ├─ backend.py    PtyShellBackend:会话→deepagents 适配│
│   │    └─ connections.py 目标列举 / 会话工厂(open_session)   │
│   └─ web/:FastAPI + TabWorker 浏览器终端(`ot web`)          │
└───────────────────────────┬────────────────────────────────┘
                            │ open_session
        ┌───────────────────┼────────────────────┐
        ▼                   ▼                    ▼
  local_pty.py        local_win.py          ssh_pty.py
  POSIX PTY           Windows ConPTY        asyncssh(跳板机 tunnel)
        └────────────── shell_session.py ────┘
        BasePtySession:哨兵捕获主循环
        (BEGIN/END 标记、超时、截断、断线重连、密码提示兜底)

  支撑:sysprobe.py 系统画像|secrets_store.py 系统凭据库(keyring)|
        transcript.py 会话 JSONL|config.py 配置|
        render.py / taskview.py / approval.py / rawmode.py(CLI 展示)
```

关键模块:

| 模块 | 职责 |
|---|---|
| app.py | 入口:加载 .env / config.toml;`ot connect/ssh` 直达,否则进选择框 |
| cli.py | REPL 主循环:输入甄别、`/` 命令、目标切换、审批交互、raw 透传入口 |
| intent.py | 命令 vs 任务分类(规则 + LLM 兜底;`!`/`?` 强制) |
| agent.py | `create_deep_agent` 装配、系统提示词(方言表)、TaskRunner 流式执行、Deny / HumanInTheLoop 中间件 |
| policy.py | 静态命令分级:只读 auto、改动 approve、灾难 deny(sudo/docker/git 细分) |
| backend.py | PtyShellBackend:文件操作沿用 LocalShellBackend,execute 走持久 PTY 会话 |
| connections.py | 目标(local / ssh_config / 记住的连接 / 跳板机)列举与 `open_session` 工厂 |
| shell_session.py | BasePtySession:哨兵捕获、超时中断、输出截断、断线恢复、密码提示兜底 |
| local_pty.py / local_win.py | POSIX PTY / Windows ConPTY(PowerShell)会话实现 |
| ssh_pty.py | asyncssh 远程会话:跳板机先连 jump 再 tunnel,TOFU 主机密钥 |
| sysprobe.py | 探测目标系统画像(发行版/包管理器/服务管理器),hosts.toml 缓存 |
| secrets_store.py | 连接密码存取:keyring → Windows 凭据管理器 / Keychain / Secret Service |
| transcript.py | 会话记录:`~/.openterminal/sessions/<日期>/<会话id>.jsonl` |
| rawmode.py | Ctrl+R 终端透传模式(vim/top/tmux 等全屏程序) |
| render.py / taskview.py / approval.py | rich 分框展示、任务面板/思考流、审批决策助手 |
| web/ | `ot web`:FastAPI 服务端、每 tab 一个 worker、WS 协议、浏览器前端(xterm.js) |

命令输出用 BEGIN/END 哨兵标记切分(shell_session.py),实时 tee 给展示层;
`_run_lock` 保证单会话命令严格串行——一个 PTY 就是一条交互 shell,模型并发
发起的 execute 会排队。

项目**没有模型级长期记忆**:Agent 的 checkpointer 用 `MemorySaver()`
(纯内存,重建 agent 即清空)。持久化的是"事实型"数据:

| 存储 | 位置 | 内容 |
|---|---|---|
| 配置 | `~/.openterminal/config.toml` | 模型网关 / shell 超时 / 策略 / 目标 |
| 连接 | `~/.openterminal/connections.toml` | 记住的连接 + 跳板机 |
| 密码 | 系统凭据库(keyring) | 连接密码,不落明文文件 |
| 主机画像缓存 | `~/.openterminal/hosts.toml` | 各主机系统画像,免重复探测 |
| 会话记录 | `~/.openterminal/sessions/<日期>/` | 输入/命令/审批/总结的 JSONL |
| 主机密钥 | `~/.ssh/known_hosts` | TOFU 指纹确认后写入 |

## 测试

```sh
pytest -q
```

跳过的用例均为平台/环境门控(Windows 上跳过 POSIX 专属的本地 PTY 测试等)。
sshd 门控测试需要显式开启:

```sh
# 在本机先起好一个密钥登录的 sshd,然后:
OT_TEST_SSH=1 OT_TEST_SSH_HOST=127.0.0.1 OT_TEST_SSH_PORT=2222 pytest -m ssh
```

前端单测(无需浏览器):

```sh
node --test tests/js/*.test.cjs                            # 静态前端
cd src/openterminal/web/frontend/ui && npm ci && npm test  # React island
```

## 贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。欢迎提 Issue 和 Pull Request。

## 致谢

- [deepagents](https://github.com/langchain-ai/deepagents) & LangGraph — Agent 运行时
- [xterm.js](https://xtermjs.org/) — 浏览器终端(内置于 `web/frontend/vendor/`)
- [asyncssh](https://github.com/ronf/asyncssh) — SSH 客户端

## 许可证

[Apache License 2.0](LICENSE)
