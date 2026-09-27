# OpenTerminal 设计说明文档

> 状态：与代码同步（分支 feat/single-pipeline，2026-09）
> 配套阅读：[架构文档](architecture.md) · [流程图](flows.md)
> 历史设计定稿（Web 端 decoration 卡片层，v3–v8 演进）见
> [design-single-pipeline.md](design-single-pipeline.md)

本文回答「为什么这么设计」。每条给出：**决策 → 理由 → 落点**（代码位置）。

## 1. 设计原则

| # | 原则 | 含义 |
|---|---|---|
| P1 | 终端能力归原生 | 补全/历史/全屏程序/嵌套 shell/clear 一律 PTY + 真 shell 提供，项目零实现、零白名单 |
| P2 | 单管线显示 | PTY 字节流是唯一显示管线；AI 输出以带内事件叠加，不做第二套显示路由 |
| P3 | 记账不路由 | 核心只从 OSC 标记**记账**（历史/退出码/AI 上下文），不解析屏幕、不猜提示符 |
| P4 | 误判无损 | 意图分类错误的代价被压到「多跑一次 LLM / 多一步代执行」，双向可恢复 |
| P5 | 密码不落盘 | 明文凭据只进 OS 钥匙串；库/配置/日志里永远只有引用 |
| P6 | 兜底不打死主流程 | 历史库、token 估算、凭据库、系统画像等辅助设施异常时静默降级 |

反面教材（§2 审计结论，详见历史设计文档）：白名单模式不可持续——每份命令
白名单背后都拖着行为兜底补丁，兜底补丁本身又是新代码。单管线化净删约
1300 行命令侧自研代码。

## 2. 关键决策

### 2.1 单管线真终端（P1/P2）

**决策**：CLI 与 Web 都只有一条 PTY → 终端的字节管线。AI 工具命令经
`__ot_exec__` 前缀注入**同一个 PTY**，输出天然出现在主终端里，无需「输出块
归属」逻辑。

**理由**：vim/top/tmux、Tab 补全、Ctrl+R、嵌套 shell（`sudo su -`）在真终端
里免费正确；任何自研重造都是长期维护负债。AI 命令走同一 PTY 还让用户能
亲眼看到 AI 在跑什么。

**落点**：`core.py` 模块头（显示模型三件事）；`backend.py`；注入行回显治理
`core._on_exec_text`（EXEC 相位吞除注入行回显）。

### 2.2 带内 OSC 记账（P3）

**决策**：shell hook（bash/zsh/pwsh 注入脚本）在带内发 OSC 133 相位标记 +
私有 OSC 6337 行报告；`StreamRouter` 增量解析。

**理由**：提示符、退出码、cwd、命令行文本的第一手信源是 shell 自己。带内
标记随字节流有序到达，天然与显示同步；屏幕解析/正则猜提示符脆弱且和嵌套
shell、自定义 PS1 冲突。实例号 `<i>` 区分父/嵌套 shell，`su -` 换壳后由
`_ensure_integrated` 重注入。

**落点**：`shell_integration.py`（build_script / StreamRouter）；
`core.py _on_stream_event / _on_exec_start / _on_exec_end`。

### 2.3 意图分类：前缀 + LLM 兜底（P4）

**决策**：`?` 强制 AI、`!` 强制命令、`/` 斜杠命令由 hook 前缀判定；其余行
hook 启发式 + 核心 `_llm_classify` 单次兜底。启发式词表（疑问词正则、内建
词表）已全删。

**理由**：单管线下分类错误无损——命令被判成 AI，agent 用 `__ot_exec__`
照样执行；自然语言被判成命令，shell 报 not found 后救援卡接手（§2.6）。
词表必然漏词，LLM 兜底一次调用换准确率。

**落点**：`shell_integration.py` hook 脚本 Enter 绑定；`core.py _llm_classify /
_on_frontend_line / _on_ai_line`。

### 2.4 本地截获层 _CaptureLayer

**决策**：审批（Enter/Backspace/e）、救援（y/n）、密码/主机密钥应答的按键
在**前端本地**截获消费，不经 PTY 往返；其余按键字节原样直通。

**理由**：决策键若发给远端 shell 会产生回显/历史污染，且 SSH 往返延迟会让
「按 Enter 确认」手感粘滞。密码输入本地截获还能保证不回显（远端 stty 管不
到本地 raw 态）。Web 端 approvalKeys/auth 同规则，两端行为一致。

**落点**：`term_frontend.py _CaptureLayer`（状态机 approval/rescue/password/
host_key；待决期 Ctrl+C 钉死为拒绝/忽略）；编辑流（e 键）摘挂 stdin reader
交接 prompt_toolkit，结束后复原 raw 态与状态行。

### 2.5 渲染纪律：阶梯修复 + 状态行零占位协议

**决策 1（阶梯）**：raw 态终端（`tty.setraw` 关掉 OPOST/ONLCR）下，所有
渲染器直写路径必须把 `\n` 翻译成 `\r\n`；PTY 字节**不翻译**（内层 PTY 行
纪律已做 ONLCR，再翻会双写）。

**理由**：真机 bug——AI 流式输出 markdown 表格每行起始位置逐行右移。翻译
收口在唯一 choke point `_stream_write`（与 rich 路径 `_WriterFile` 同法：
先归一 `\r\n`→`\n` 再翻译，幂等）。

**决策 2（状态行）**：任务期单行状态（spinner + 计时 + token）用
`\r\x1b[K` 擦除协议：任何正文输出前先擦状态行，输出后按需重画；
`_drawn/_fresh` 两个光标位跟踪在屏状态，`note_write` 让直写字节路径也
参与协议。

**理由**：状态行必须「零占位」——不能把正文顶到第二行、不能在滚动历史里
留残渣。

**决策 3（思考框）**：思考流（ai_think）行缓冲后画进蓝色圆角边框盒
（rich Panel 同款 ROUNDED 字形），CJK 按显示宽 2 列折行 pad；token 到达
打断思考即关框；收束打 `… 思考 N 行`；终端宽 <24 退化为裸暗灰流。

**理由**：用户要求思考过程有视觉边界、与正文流（不框）区分。行缓冲保证
每根框线整宽对齐，与状态行擦除协议兼容（先 erase 再出整行）。

**落点**：`term_frontend.py _stream_write / _StatusLine / _think_* 系列 /
_display_width / _wrap_display`；测试 `tests/test_term_render.py`、
live 回归 `tests/live/test_cli_live.py::test_ai_multiline_no_staircase`。

### 2.6 审批与救援（HIL）

**决策**：Policy 三级分级（auto/approve/deny）。审批面板风险色
（high 红框 / normal 蓝框），操作提示行**加粗黄色**（醒目性优先于美观）；
决策后本地合成定格回执行（`✓ 已执行` / `✗ 已拒绝`）。用户命令非零退出
（非 130/143 中断）→ 挂救援卡，y 交 AI 分析修复、n 忽略。

**理由**：安全模型「要动手得经你同意；闯祸的事直接不做」的交互面。回执
本地合成是因为决策发生在截获层，远端不知情，不等事件往返。救援卡把
「命令打错」变成一键 AI 接手，是 §2.3 误判无损的兜底闭环。

**落点**：`policy.py`；`agent.py DenyMiddleware`；`core.py ask_approval /
_approval_risk / _maybe_rescue / _on_rescue_decision`；
`term_frontend.py _on_approval / _on_rescue / _receipt_*`。

### 2.7 凭据与密码生命周期（P5）

**决策**：
- 记住的连接密码存 keyring（`host/user/port` 三元键），SQLite 只有元数据；
- 命令集内联密码（`> @名称=密码`）保存时抽取入 keyring（`cmdset:名称` 键），
  落库文本改写为 `> @名称` 引用；
- 连接成功后 `_backfill_password` 补存：已记住但凭据缺失（上次存库失败）
  时把本次实际用的密码补进钥匙串；未记住的连接不替用户做主；
- 删除主机 / 删除命令集引用时同步清理 keyring 条目；
- keyring 不可用（无桌面 Linux）静默降级为现场询问。

**落点**：`secrets_store.py`、`cmdset.py`、`connections.py _backfill_password`、
`web/server.py`、`cli.py _maybe_remember`。

### 2.8 存储演进与迁移

**决策**：存储从 TOML 演进到 SQLite（`connections.db` / `history.db`），
迁移全部**单向、幂等、尽力而为**：

1. 旧 `connections.toml` 首次访问一次性导入空库，原文件改名 `.migrated`
   留档（改名失败不影响正确性——库非空即不重复导入）；
2. 跳板机功能下线：`_retire_jumps` 收尾迁移——先逐行清 keyring 里的跳板机
   遗留密码，再 `DROP TABLE jumps`、`ALTER TABLE saved DROP COLUMN jump`
   （SQLite <3.35 无 DROP COLUMN 时留墓碑列，SQL 层不再引用）；
3. 旧库缺列（如 commands）用 `ALTER TABLE ADD COLUMN` 惰性补齐。

**理由**：用户数据无价，迁移失败不能打挂启动；孤儿凭据是安全问题，删表
前必须先清。

**落点**：`connections_db.py`；回归测试 `tests/test_connections.py
::test_retire_jumps_drops_table_column_and_secrets`。

### 2.9 SSH 连接安全与韧性

**决策**：
- **TOFU**：known_hosts 未收录 → 展示指纹询问，信任则写入；已收录但不符 →
  硬失败（可能重装系统或中间人），绝不静默覆盖。哈希条目不解析（视为未知）。
- **密码认证顺序**：keyring 记住的密码先于交互提示尝试；现场输入的密码记在
  `last_password`，断线重连复用（不再二次询问）。
- **重连一次**：断线自动重连仅一次，失败即上报 closed——避免无限重试掩盖
  真故障。

**落点**：`ssh_pty.py`（_trust_unknown_host / _connect_one /
_recover_connection）；无头面 TOFU 不询问，未收录直接结构化报错（退出码 69）。

### 2.10 无头面：给外部 AI 工具的协议

**决策**：`ot exec` / `ot list` 输出结构化 JSON；退出码分层——远程命令退出
码原样透传（<64，与 ssh 行为一致），工具自身错误用保留码（64 用法 / 65 目标
不存在 / 66 deny / 67 需审批 / 68 连接失败 / 69 指纹未收录）。

**理由**：调用方是 Claude Code 等 Agent，需要机器可判的「远程成败」vs
「调用问题」。审批不交互：出路只有人的动作（交互界面记住允许 / 改 config）。

**落点**：`headless.py`。

## 3. 已知限制

| 限制 | 说明 |
|---|---|
| bash <4（macOS 自带 3.2） | `bind -x` 拿不到 READLINE_LINE，Enter hook 分类不工作 → AI 触发链不可用（live 测试对该环境 skip）；zsh 与 bash ≥4 全功能 |
| 加密私钥口令 | 走 getpass（Web 端在服务进程控制台，已知限制） |
| 思考框窄终端 | 宽度 <24 列退化为裸暗灰流（画不下框线） |
| resize 与思考框 | 盒打开期间 SIGWINCH 改宽，已画框线与新行宽不一致（视觉瑕疵，事件级短暂） |
| 无桌面 Linux | keyring 不可用 → 密码每次现场询问（功能不受影响） |
| token 计数 | 网关不回传 usage 时为 tiktoken 估算口径（前端加 ≈ 标识） |

## 4. 测试策略

| 层 | 套件 | 手段 |
|---|---|---|
| 纯逻辑 | `tests/test_*.py`（394 例） | StringIO console + FakeCore，协议消息直调；ANSI 样式断言另开 force_terminal |
| 真终端 | `tests/live/`（12 例） | PtyApp 子进程跑真 LocalPtySession + 用户默认 shell + 真 hook 注入；ScriptedRunner 替换 TaskRunner 按剧本发事件；断言原始字节流几何（无阶梯 = 无裸 `\n`） |
| 真模型 | `tests/live/::test_gateway_real_ai_task` | 网关可达性 skip；真 `ot` 二进制 + 真模型流式 |
| 无头 | `tests/test_headless.py` | 子进程退出码 + JSON payload |

断言纪律：断言即权威，禁止迁就实现放松；live 失败附 2000 字符屏文本取证。
运行：`.venv/bin/python -m pytest tests -q`（含 live 则不 ignore）。
