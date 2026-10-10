# -*- coding: utf-8 -*-
"""shell_integration 单测：StreamRouter 分块解析、探测、注入行构造。"""
import base64
import shlex
import shutil
import subprocess

import pytest

from openterminal.shell_integration import (
    EXEC_PREFIX,
    PROBE_TAG,
    StreamRouter,
    agent_exec_line,
    build_script,
    injection_line,
    injection_lines,
    history_inject_line,
    history_quiet_line,
    parse_probe,
    probe_command,
    strip_ansi,
    toggle_line,
)

NL = chr(10)      # 生成 shell 探针脚本用的换行

A = b"\x1b]133;A;1\x07"
B = b"\x1b]133;B;1\x07"
C = b"\x1b]133;C;1\x07"
D = b"\x1b]133;D;0;1;/tmp\x07"


def _feed_all(router, data, chunk=1):
    """按 chunk 大小切块喂入，收集全部事件。"""
    evs = []
    for i in range(0, len(data), chunk):
        evs.extend(router.feed(data[i:i + chunk]))
    return evs


# --- StreamRouter ---

def test_router_prompt_cycle_whole_chunk():
    r = StreamRouter()
    r.phase = StreamRouter.INPUT
    evs = r.feed(A + b"box:~$ " + B)
    assert ("prompt_start", 1) in evs
    assert ("prompt", "box:~$") in evs
    assert any(e[0] == "live" and "box:~$" in e[1] for e in evs)


def test_router_exec_cycle_and_phase_switch():
    r = StreamRouter()
    r.phase = StreamRouter.INPUT
    evs = r.feed(C + b"out1" + D + b"tail")
    kinds = [e[0] for e in evs]
    assert "exec_start" in kinds
    assert any(e[0] == "exec" and e[1] == "out1" for e in evs)
    assert any(e[0] == "exec_end" and e[2] == 0 and e[3] == "/tmp"
               for e in evs)
    assert any(e[0] == "live" and e[1] == "tail" for e in evs)
    assert r.phase == StreamRouter.INPUT


def test_router_report_kinds():
    r = StreamRouter()
    r.phase = StreamRouter.INPUT
    evs = r.feed(b"\x1b]6337;1;CMD;echo hi\x07"
                 b"\x1b]6337;1;AI;\xe7\x9c\x8b\xe7\x9c\x8b\xe7\xa3\x81\xe7\x9b\x98\x07"
                 b"\x1b]6337;1;EXEC;__ot_off=1\x07")
    reports = [e for e in evs if e[0] == "report"]
    assert reports[0] == ("report", 1, "CMD", "echo hi")
    assert reports[1][2] == "AI" and "磁盘" in reports[1][3]
    assert reports[2] == ("report", 1, "EXEC", "__ot_off=1")


def test_router_split_across_chunks_every_boundary():
    """标记序列在任意字节边界切开都能正确解析（分块传输核心保障）。"""
    data = A + b"ps> " + B + C + b"hello" + D
    whole = _feed_all(StreamRouter(), data, chunk=len(data))
    for size in (1, 2, 3, 5, 7):
        r = StreamRouter()
        r.phase = StreamRouter.INPUT
        evs = _feed_all(r, data, chunk=size)
        marks = [e for e in evs if e[0] != "live" and e[0] != "exec"]
        assert marks == [e for e in whole if e[0] != "live" and e[0] != "exec"]
        # 逐字节喂时合并不跨调用：拼接后内容一致
        assert "".join(e[1] for e in evs if e[0] == "live") == \
               "".join(e[1] for e in whole if e[0] == "live")
        assert "".join(e[1] for e in evs if e[0] == "exec") == "hello"


def test_router_swallow_phase_drops_data_keeps_marks():
    r = StreamRouter()          # 默认 SWALLOW：注入回显丢弃但标记仍解析
    evs = r.feed(b"iex ...\r\n" + A)
    assert not any(e[0] in ("live", "exec") for e in evs)
    assert ("prompt_start", 1) in evs
    # A 之后相位已转 INPUT：提示符文本正常放行（前端迷你终端要显示它）
    evs = r.feed(b"PS> " + B)
    assert ("prompt", "PS>") in evs
    assert any(e[0] == "live" and "PS>" in e[1] for e in evs)


def test_router_osc_st_terminator_and_csi_passthrough():
    r = StreamRouter()
    r.phase = StreamRouter.INPUT
    evs = r.feed(b"\x1b]133;C;7\x1b\\out\x1b]133;D;1;7;\x07")
    assert ("exec_start", 7) in evs
    assert any(e[0] == "exec_end" and e[1] == 7 and e[2] == 1 for e in evs)
    # CSI（颜色等）原样放行给前端渲染
    evs = r.feed(b"\x1b[31mred\x1b[0m")
    live = "".join(e[1] for e in evs if e[0] == "live")
    assert "\x1b[31m" in live and "red" in live


def test_router_cwd_with_semicolon():
    r = StreamRouter()
    r.phase = StreamRouter.EXEC
    evs = r.feed(b"\x1b]133;D;2;1;/weird;path\x07")
    e = [x for x in evs if x[0] == "exec_end"][0]
    assert e[2] == 2 and e[3] == "/weird;path"


def test_router_max_osc_guard():
    r = StreamRouter()
    r.phase = StreamRouter.INPUT
    evs = r.feed(b"\x1b]" + b"x" * (StreamRouter.MAX_OSC + 10))
    # 未终结 OSC 超限后按普通数据放行，不吞流
    assert "".join(e[1] for e in evs if e[0] == "live").startswith("\x1b]")


def test_router_utf8_split_mid_char():
    r = StreamRouter()
    r.phase = StreamRouter.INPUT
    data = "中文输出".encode()
    evs = _feed_all(r, data, chunk=1)
    assert "".join(e[1] for e in evs if e[0] == "live") == "中文输出"


# --- 探测 ---

def test_parse_probe_bash_zsh_ps():
    assert parse_probe(f"noise\n{PROBE_TAG}bash5.2.15|-d\n") == ("bash", "-d")
    # $BASH_VERSION 真实值带括号/连字符（如 5.1.8(1)-release）：此前字符类
    # 在 ( 截断导致整体不匹配，所有 bash 主机静默回退批处理模型
    assert parse_probe(f"{PROBE_TAG}bash5.1.8(1)-release|-d") == ("bash", "-d")
    assert parse_probe(f"{PROBE_TAG}bash3.2|-d") == (None, "-d")   # macOS 老 bash
    assert parse_probe(f"{PROBE_TAG}zsh5.9|-D") == ("zsh", "-D")
    assert parse_probe(f"{PROBE_TAG}powershell|ok") == ("powershell", "-d")
    assert parse_probe(f"{PROBE_TAG}none|none") == (None, "-d")
    assert parse_probe("") == (None, "-d")
    assert parse_probe("command not found") == (None, "-d")


def test_probe_command_families():
    assert PROBE_TAG in probe_command("windows")
    assert "Get-Module PSReadLine" in probe_command("windows")
    p = probe_command("linux")
    assert PROBE_TAG in p and "BASH_VERSION" in p and "-D" in p


# --- 注入行构造 ---

def test_injection_line_posix_and_ps():
    # 分片注入：每片是完整 shell 行（\r 结尾），eval 后跟 bind 独立行
    chunks = injection_lines("bash", 3, "-d")
    assert all(c.endswith(b"\r") for c in chunks)
    assert all(len(c) < 1024 for c in chunks), "单片不得超 tty canonical 缓冲"
    # 前导空格：静默窗口（history_quiet_line）内原生入史被整体跳过
    assert all(c.startswith(b" ") for c in chunks)
    # eval 是倒数第二行，bind 是最后一行（bind 不进 base64 块）
    assert chunks[-2].decode().lstrip().startswith("eval")
    assert "bind -x" in chunks[-1].decode()
    b64 = "".join(
        c.decode().split("'")[1] for c in chunks[:-2])
    script = base64.b64decode(b64).decode()
    assert "__ot_i=3" in script

    # 单行版本内容与分片一致（拼接后等价）
    line = injection_line("bash", 3, "-d")
    assert line == b"".join(chunks)

    # PowerShell 无前导空格机制，维持原样
    line = injection_line("powershell", 1)
    assert not line.startswith(b" ")
    b64 = line.decode().split("FromBase64String('")[1].split("'")[0]
    script = base64.b64decode(b64).decode()
    assert "__ot_i = 1" in script and "Set-PSReadLineKeyHandler" in script


def test_agent_exec_line_roundtrip():
    cmd = 'echo "q\'uote $x" && ls | grep a\nsecond line'
    line = agent_exec_line("bash", cmd, "-D")
    assert line.startswith(EXEC_PREFIX.encode()) and line.endswith(b"\r")
    b64 = line.decode()[len(EXEC_PREFIX):].split("echo ")[1].split(" |")[0]
    assert base64.b64decode(b64).decode() == cmd

    line = agent_exec_line("powershell", cmd)
    b64 = line.decode().split("FromBase64String('")[1].split("'")[0]
    assert base64.b64decode(b64).decode() == cmd


def test_toggle_line_scopes():
    assert toggle_line("bash", True) == (EXEC_PREFIX + "__ot_off=0\r").encode()
    assert toggle_line("bash", False) == (EXEC_PREFIX + "__ot_off=1\r").encode()
    # PS 赋值必须显式 $global:（handler 作用域）
    assert b"$global:__ot_off=1" in toggle_line("powershell", False)


def test_build_script_instance_substitution():
    for shell in ("bash", "zsh", "powershell"):
        s = build_script(shell, 7)
        assert "@@INST@@" not in s
        assert "7" in s


def test_build_script_unknown_shell():
    with pytest.raises(KeyError):
        build_script("fish", 1)


# --- 单管线 §5.6：历史自然回滚（clear=0）+ 青色输入回显 ---

def test_build_script_clear_flag_off():
    """__ot_clear=0：命令历史自然累积进唯一 xterm 的 scrollback，不再每命令清屏。"""
    for shell in ("bash", "zsh"):
        s = build_script(shell, 1)
        assert "__ot_clear=0" in s
        assert "__ot_clear=1" not in s
    ps = build_script("powershell", 1)     # build_script 返回 str
    assert "$global:__ot_clear = 0" in ps
    assert "__ot_clear = 1" not in ps and "__ot_clear=1" not in ps


def test_bash_script_cyan_repaint_default_ps1():
    """bash：PS1 不配色（提示符用终端默认前景白，对齐 main 分支），提交后
    __ot_repaint 重绘命令（readline 不支持输入中着色）；颜色参数化，缺省青。"""
    s = build_script("bash", 1)
    ps1 = s[s.index("PS1="):s.index("__ot_repaint")]
    assert "38;5;51" not in ps1             # 提示符不再青色
    assert "__ot_repaint" in s              # 提交后重绘函数
    assert r"\033[38;5;%sm%s\033[0m\n" in s   # 颜色由 $2 参数化
    assert "${2:-51}" in s                  # 缺省青（工具/用户命令）


def test_zsh_script_cyan_postedit_default_ps1():
    """zsh：PS1 不配色 + POSTEDIT 提交后重绘；颜色按 kind 参数化。"""
    s = build_script("zsh", 1)
    ps1 = s[s.index("PS1="):s.index("__ot_submit")]
    assert "38;5;51" not in ps1
    assert "POSTEDIT=" in s
    assert 'col=51' in s and '[[ "$kind" == AI ]] && col=33' in s


def test_bash_ai_branch_repaints_blue():
    """Workbench 观感：用户自然语言行蓝色重绘（38;5;33），命令保持青。"""
    s = build_script("bash", 1)
    ai = s[s.index("if [ \"$kind\" = AI ]"):]
    assert '__ot_repaint "$t" 33' in ai[:ai.index("fi")]
    # EXEC 注入行仍走缺省青
    assert "__ot_repaint \"$d\"" in s


def test_bash_ai_and_exec_branches_repaint_cyan():
    """M1：bash AI 行与 EXEC 注入行都经 __ot_repaint 青色重绘——默认色回显
    与 __ot_exec__ 前缀/base64 包装不再残留屏上（此前 AI 分支只 printf 换行）。"""
    s = build_script("bash", 1)
    ai = s[s.index("if [ \"$kind\" = AI ]"):]
    assert "__ot_repaint" in ai[:ai.index("fi")]
    assert "__ot_exec_run" in s and "__ot_repaint" in s[s.index("__ot_exec_run"):]
    # base64 包装注入体在回显前解码回原命令
    assert "'eval \"$(echo '*" in s and "base64 -d" in s
    assert "export -f __ot_prompt_cmd __ot_run __ot_submit __ot_repaint __ot_exec_run" in s


def test_bash_script_restores_termios_for_child_shells():
    """真机「sudo su - 后按键不可见」：bind -x 回调内 eval 自执行命令，bash 不
    恢复 termios，su/ssh 子 shell 继承 readline 裸模式（-echo -icanon -isig）。
    脚本须注入时检出 -echo 先 stty sane 自愈并快照，两处 eval 前按快照恢复。"""
    s = build_script("bash", 1)
    assert '__ot_tty_save=$(stty -g 2>/dev/null)' in s
    assert '*" -echo "*) stty sane' in s
    restore = '[ -n "$__ot_tty_save" ] && stty "$__ot_tty_save" 2>/dev/null'
    assert s.count(restore) == 2, "__ot_run 与 off 路径各一处 eval 前恢复"
    # 恢复必须落在 eval 之前（子 shell 起步即正常 tty）
    for frag in ("__ot_run", ):
        body = s[s.index(frag + "() {"):]
        body = body[:body.index("eval ")]
        assert restore in body
    assert 'export __ot_tty_save' in s


def test_zsh_ai_branch_postedit_and_exec_decode():
    """M1：zsh AI 分支同样 POSTEDIT 青色重绘；EXEC 注入体显示前解码。"""
    s = build_script("zsh", 1)
    assert 'if [[ "$kind" == AI ]]; then' in s
    assert "POSTEDIT=" in s[s.index('if [[ "$kind" == AI ]]; then') - 200:]
    assert "show=" in s and 'base64 -d' in s   # EXEC 包装解码为可读命令


def test_powershell_script_cyan():
    """PowerShell：PSReadLine 输入即时青色 + prompt 函数提示符不配色
    （默认前景白，对齐 main 分支）。"""
    s = build_script("powershell", 1)
    assert "Set-PSReadLineOption" in s and "#39c5cf" in s
    prompt = s[s.index("function global:prompt"):]
    assert "38;5;51" not in prompt[:prompt.index("}", prompt.index("return"))]


# --- strip_ansi ---

def test_strip_ansi():
    assert strip_ansi("\x1b[31mred\x1b[0m") == "red"
    assert strip_ansi("\x1b]133;A;1\x07ps> \x1b]133;B;1\x07") == "ps> "
    assert strip_ansi("\x1b]0;title\x1b\\text") == "text"


# --- history_inject_line ---

def test_history_inject_line_bash():
    line = history_inject_line("bash", ["ls -la", "ls -la", "df -h"])
    assert line.endswith(b"\r")
    assert line.startswith(b" ")               # 静默窗口前导空格
    b64 = line.decode().split("echo ")[1].split(" |")[0]
    # 连续重复去重
    assert base64.b64decode(b64).decode() == "ls -la\ndf -h"
    assert b"history -r" in line
    # 自删 history -d "$HISTCMD" PTY 实测无效且有误删相邻条目风险，已移除
    # （入史抑制改走静默窗口，残留清理由脚本尾部保洁兜底）
    assert b"history -d" not in line


def test_history_inject_line_zsh():
    line = history_inject_line("zsh", ["ls"])
    assert line.endswith(b"\r")
    assert line.startswith(b" ")               # 静默窗口前导空格
    assert b"fc -R" in line


def test_history_inject_line_powershell():
    line = history_inject_line("powershell", ["Get-ChildItem"])
    assert line.endswith(b"\r")
    assert b"HistorySavePath" in line
    b64 = line.decode().split("FromBase64String('")[1].split("'")[0]
    assert base64.b64decode(b64).decode() == "Get-ChildItem"


def test_history_inject_line_empty():
    assert history_inject_line("bash", []) == b""
    assert history_inject_line("bash", ["", "  "]) == b""


def test_is_internal_line_filters_injection_junk():
    """注入内部行判定：分片装配/回显包装不入历史，普通命令不误杀。"""
    from openterminal.shell_integration import is_internal_line

    assert is_internal_line("__ot_inj='X19vdF9pPTEK'")
    assert is_internal_line('__ot_inj="$__ot_inj"\'MSDK…\'')
    assert is_internal_line('eval "$(echo "$__ot_inj" | base64 -d)"')
    assert is_internal_line("__ot_exec__ ls -la")
    assert is_internal_line("  __ot_pad 3")
    assert is_internal_line('__ot_hc="$HISTCONTROL"; HISTCONTROL=ignorespace')
    assert not is_internal_line("df -h")
    assert not is_internal_line('echo __ot_inj 是变量名')


def test_script_tail_absorbs_chunk_splice():
    """分片二次追加（__ot_inj=B+C1）不得改写 export -f 名单。

    实测根因：C1 解码恰以 ot_prompt_cmd 开头（__ 切在 C0/C1 边界），追加后
    export 行末名被拼成假函数名，shell 报 "export: ... not a function"。
    尾部 : __ot_script_end 把拼接点吸进无害参数。该性质与脚本字节布局无关
    （旧实现钉死 b64[700:1400] 的巧合边界，脚本一改即失效）：直接用实测的
    恶意断片做追加体验证。
    """
    s = build_script("bash", 1).encode()
    assert s.endswith(b": __ot_script_end")
    hostile = (b"ot_prompt_cmd __ot_run __ot_submit __ot_repaint __ot_exec_run\n"
               b"echo spliced\n: __ot_script_end")
    t = s + hostile
    exp = [ln for ln in t.splitlines() if ln.startswith(b"export -f")]
    assert exp == [
        b"export -f __ot_prompt_cmd __ot_run __ot_submit __ot_repaint __ot_exec_run"]
    # 拼接点落在吸收行：假函数名只作为 : 的参数，不产生可执行行
    assert b": __ot_script_endot_prompt_cmd" in t
    for ln in t.splitlines():
        if ln.lstrip().startswith(b"#"):
            continue
        assert b"__ot_exec_runot_prompt_cmd" not in ln


def test_bash_pad_branch_erases_echo_line():
    """bash pad 分支不得上移擦行：bash 5.x 的 readline 进 bind -x 回调前已
    自行发 \\r\\x1b[K 擦掉「提示符+__ot_pad N」回显行、光标停在回显行行首
    （真机 CentOS bash 5.1.8 字节级实测），分支再 CUU 上移一行必然把上一行
    内容吃掉（真机：AI 蓝色提交行/命令输出行被 pad 擦掉 = 「中文提交行消失」
    根因）。分支只补 N 个换行：光标行（readline 已自清）+ N 个换行恰得 N 行
    占位。zsh 的 zle 进 widget 前不换行、无自擦，zsh 分支保持同行 \\r\\033[2K
    （parity 基准）。"""
    from openterminal.shell_integration import _BASH_SCRIPT, _ZSH_SCRIPT
    branch = _BASH_SCRIPT.split("'__ot_pad '*)", 1)[1].split("return 0 ;;", 1)[0]
    assert "\\033[1A\\033[2K" not in branch, \
        "bash pad 分支不得 CUU 上移擦行（bash 5.x 光标在回显行上，上移吃掉上一行）"
    assert "\\n%.0s" in branch, "bash pad 分支缺 N 个换行占位"
    repaint = _BASH_SCRIPT.split("__ot_repaint() {", 1)[1].split("__ot_run() {", 1)[0]
    assert "\\033[1A\\033[2K" in repaint, "bash 重绘缺上移擦回显行（真机白回显行根因）"
    assert "COLUMNS" in repaint and "for ((i=0; i<k; i++))" in repaint, \
        "bash 重绘缺折行循环擦除（真机长命令白漏半行根因）"
    assert "same" in repaint, "bash 重绘缺同行擦除模式（真机连按 Enter 吃横幅根因）"
    empty = _BASH_SCRIPT.split("if [ -z \"$t\" ]; then", 1)[1].split("return 0", 1)[0]
    assert "same" in empty, "空行分支未按真空行/空白行分流擦除模式"
    zbranch = _ZSH_SCRIPT.split("'__ot_pad '*)", 1)[1].split("zle .accept-line", 1)[0]
    assert "\\r\\033[2K" in zbranch, "zsh 分支擦行是 parity 基准，不得回退"


def test_bash_run_restores_readline_tty_mode():
    """__ot_run eval 后必须还回 readline 裸模式快照：eval 前按 __ot_tty_save 恢复
    正常态供子命令，eval 后不还裸模式则下个提示符跑 canonical——Tab 补全/↑ 历史
    /Ctrl+R 字面回显全失效（真机：首条命令后 ↑ 打出 ^[[A）。"""
    from openterminal.shell_integration import _BASH_SCRIPT
    run = _BASH_SCRIPT.split("__ot_run() {", 1)[1].split("__ot_exec_run() {", 1)[0]
    assert "__ot_rl_tty" in run, "__ot_run 缺 readline 裸模式还原"
    assert run.index('eval "$1"') < run.index('__ot_rl_tty')
    submit = _BASH_SCRIPT.split("__ot_submit() {", 1)[1].split("__ot_run(", 1)[0]
    assert "__ot_rl_tty=$(stty -g" in submit, "__ot_submit 缺裸模式快照"


# --- ↑/↓ 历史召回 = 历史命令（用户命令 + AI 工具命令），不含自然语言 ---

def test_ai_lines_stay_out_of_shell_history():
    """自然语言不得写入 shell 历史（真机「按 ↑ 翻看的全是历史输入的自然语言，
    而不是历史命令」根因）：三 shell 的 AI 分支只做 清缓冲+重绘+6337 上报。"""
    bash = build_script("bash", 1)
    ai = bash[bash.index('if [ "$kind" = AI ]'):]
    assert "history -s" not in ai[:ai.index("return 0")]
    zsh = build_script("zsh", 1)
    tail = zsh[zsh.index('if [[ "$kind" == AI ]]; then'):]
    assert "print -s" not in tail
    ps = build_script("powershell", 1)
    # AddToHistory 仅剩 2 处：! 强制命令分支 + EXEC 工具命令分支
    assert ps.count("AddToHistory") == 2


def test_exec_tool_commands_enter_shell_history():
    """AI 工具命令（EXEC 注入）解码后写入 shell 历史：↑ 能召回工具命令；
    base64 包装体记解码后的可读原文，多行体跳过（单行召回装不下换行）。"""
    bash = build_script("bash", 1)
    fn = bash[bash.index("__ot_exec_run() {"):]
    fn = fn[:fn.index("\n}")]
    assert 'history -s -- "$d"' in fn
    assert '*"$nl"*) ;;' in fn, "多行体须跳过入史"
    zsh = build_script("zsh", 1)
    # 包装体解码成单行：BUFFER 换成原文走 accept-line 原生入史（同明文路径）；
    # zsh 侧不得出现 print -s——widget 内无法抑制 accept-line 原生入史
    # （localoptions histignorespace 在 widget 返回时已还原，PTY 实验证实），
    # 再 print -s 就是双份历史
    assert 'BUFFER="$show"; CURSOR=${#show}' in zsh
    assert "print -s" not in zsh
    ps = build_script("powershell", 1)
    ex = ps[ps.index("$line.StartsWith('__ot_exec__ ')"):]
    assert "AddToHistory($h)" in ex[:ex.index("__ot_exec_inline")]


def test_internal_lines_stay_out_of_shell_history():
    """注入管线内部行（__ot_inj 分片装配 / eval 解包）不入 shell 历史：
    每任务重注入 ~8 条 base64 分片，进史后 ↑ 翻历史全是垃圾。
    （bash 侧：入史是 hook 显式 history -s，可精确排除；zsh 侧入史是
    accept-line 原生行为、widget 内无法抑制——见 EXEC 分支实验注释。）"""
    bash = build_script("bash", 1)
    # history -s 与青色重绘同属「非内部行」分支（内部行分支为空动作）
    assert ('*) history -s -- "$line" 2>/dev/null; __ot_repaint "$exp" ;;'
            in bash)


# --- 注入垃圾不得污染 shell 历史（用户报障：↑ 召回的全是 __ot_inj 分片） ---

def test_history_quiet_line_snapshot_and_enable():
    """静默行：快照双 shell 的「前导空格跳过入史」开关后临时打开。
    快照必须先于覆盖；本行自身以 __ot_hc= 开头（is_internal_line 成立，
    hook 在位时按内部行静默处理、尾部保洁清除）。"""
    line = history_quiet_line()
    assert line.endswith(b"\r") and line.startswith(b"__ot_hc=")
    s = line.decode()
    assert '__ot_hc="$HISTCONTROL"' in s                 # bash 快照
    assert '__ot_his="$options[hist_ignore_space]"' in s  # zsh 快照
    assert s.index("__ot_hc=") < s.index("HISTCONTROL=ignorespace")
    assert "setopt hist_ignore_space 2>/dev/null" in s
    from openterminal.shell_integration import is_internal_line
    assert is_internal_line(s)


def test_script_tails_purge_legacy_history_junk():
    """脚本尾部历史保洁：旧版本已落盘/已载入的注入垃圾（分片、探测包装行、
    历史注入行、静默行）必须在安装时清掉——它们随 HISTFILE 每次会话重载，
    ↑ 头几页全是看不懂的 base64（用户截图报障现场）。
    bash：降序 history -d（升序错位）+ 非纯数字防御（多行命令续行无编号）；
    zsh：无逐条删除 API——fc -W 快照→过滤→HISTSIZE=0 清空→fc -R 读回整体
    重建（fc -R 追加语义，PTY 实验证实；不用 fc -p 推栈——栈上旧表的未落盘
    条目会在退出追加保存时写回垃圾，且 fc -p 重置 HISTFILE/HISTSIZE/
    SAVEHIST 为空/30/0，均 PTY 实测）。两侧都做 HISTFILE 落盘文件过滤重写。"""
    bash = build_script("bash", 1)
    assert bash.rstrip().endswith(": __ot_script_end")
    assert 'history -d "$__ot_n"' in bash and "sort -rn" in bash
    assert "*[!0-9]*) continue" in bash          # 续行防御
    zsh = build_script("zsh", 1)
    assert 'fc -W "$__ot_mh"' in zsh
    assert 'HISTSIZE=0; HISTSIZE="$__ot_hs"' in zsh
    assert 'fc -R "$__ot_cf"' in zsh
    assert not any(l.strip().startswith("fc -p") for l in zsh.splitlines()), \
        "禁用以 fc -p 推栈重建（注释提及不算）"
    # 垃圾行判定模式：覆盖分片/探测/静默/历史注入/pad/EXEC 全部内部行形态
    for s in (bash, zsh):
        pat = s.split("__ot_jk='", 1)[1].split("'", 1)[0]
        for frag in ("_ot_inj", "__ot_exec__", "__ot_pad ", "__ot_hc=",
                     "__OT", r"\.ot_hist_"):
            assert frag in pat, f"保洁模式缺 {frag!r}"
        # HISTFILE 落盘文件过滤重写
        assert 'grep -vE "$__ot_jk"' in s and 'cat "$__ot_cf"' in s


def test_script_tails_restore_history_quiet_window():
    """静默窗口必须按快照收口：用户原 HISTCONTROL / hist_ignore_space 还原；
    快照缺失（静默行没跑过）不得动用户设置。"""
    bash = build_script("bash", 1)
    assert '[ -n "${__ot_hc+x}" ] && HISTCONTROL="$__ot_hc"' in bash
    zsh = build_script("zsh", 1)
    assert ('[[ -n "${__ot_his+x}" && "$__ot_his" != on ]]'
            ' && unsetopt hist_ignore_space') in zsh.replace(" 2>/dev/null", "")


def test_zsh_widget_suppresses_internal_line_history():
    """zsh 重注入内部行的原生入史抑制：widget 内 accept-line 的入史发生在
    widget 返回之后且绕过 zshaddhistory（PTY 实验证实）——唯一可靠组合是
    全局 setopt hist_ignore_space + 前导空格 BUFFER，命令起跑后由
    __ot_preexec（preexec_functions 注册）按静默行快照还原。"""
    zsh = build_script("zsh", 1)
    assert "__ot_preexec" in zsh
    assert "preexec_functions=(__ot_preexec $preexec_functions)" in zsh
    # 抑制分支是内部行 case 模式的第二处出现（第一处是 POSTEDIT 重绘豁免）
    sup = zsh[zsh.rindex("'__ot_inj='*|'_ot_inj='*|'__ot_hc='*"):]
    sup = sup[:sup.index("zle .accept-line")]
    assert "setopt hist_ignore_space" in sup
    assert '[[ "$BUFFER" == \' \'* ]] || BUFFER=" $BUFFER"' in sup
    assert "__ot_sup=1" in sup

# --- P0-2 注入行原子性：裸壳（__ot_exec__ 不在位）不得执行命令体任何一段 ---

def _usable_bash() -> str | None:
    """可模拟裸壳的 bash 绝对路径。

    Windows 上 subprocess 里的裸名 ``bash`` 会命中 System32 的 WSL 存根
    （不走 PATH 顺序），它丢弃 ``-c`` 脚本之后的实参、stderr 还喷 wsl: 翻译
    告警——一律用 which 解析出的绝对路径，并实测实参可达才认。
    """
    exe = shutil.which("bash")
    if not exe:
        return None
    try:
        r = subprocess.run(
            [exe, "-c", 'printf %s "$1"', "sh", "OT"],
            capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return None
    return exe if r.returncode == 0 and r.stdout == "OT" else None


_BASH = _usable_bash()
_BASH_SKIP = pytest.mark.skipif(
    _BASH is None, reason="需要可用的 bash 模拟裸壳")


def _bare_bash(line: str):
    """在 __ot_exec__ 不在位的裸 bash 里跑一行（真机落回来的跳板机 pe 壳）。"""
    return subprocess.run(
        [_BASH, "--noprofile", "--norc", "-c", line],
        capture_output=True, text=True, timeout=15)


def test_agent_exec_line_quoted_body_is_single_word():
    """shlex 模拟 POSIX 分词：整行恒为「一条命令 + 一个字面参数」——
    ;/&&/|/反引号/$() 全是参数内字面量，不是操作符。"""
    for cmd in ("head -2 x.log; echo ====",
                "a && b || c",
                "echo `id`",
                "echo $(whoami) | grep r",
                "for f in a b; do echo $f; done",
                "cd /tmp; rm -rf x; echo done"):
        line = agent_exec_line("bash", cmd, "-d").decode().rstrip("\r")
        assert shlex.split(line) == [EXEC_PREFIX.strip(), cmd], cmd


def test_agent_exec_line_falls_back_to_base64_on_quote_or_newline():
    """含单引号/换行/非 ASCII 的命令回落 base64 包装：本体锁在码里（裸壳解析
    看不到任何操作符），整行仍是单条命令 + 一个 eval 参数。"""
    for cmd in ("echo 'q'; touch /tmp/x", "a\nb", "echo 中文"):
        line = agent_exec_line("bash", cmd, "-d").decode().rstrip("\r")
        assert line.startswith(EXEC_PREFIX)
        words = shlex.split(line)
        assert words[:2] == [EXEC_PREFIX.strip(), "eval"] and len(words) == 3, line
        assert cmd not in line, "命令本体不得以明文出现（会被裸壳解析）"
        b64 = line[len(EXEC_PREFIX):].split("echo ")[1].split(" |")[0]
        assert base64.b64decode(b64).decode() == cmd


@_BASH_SKIP
def test_agent_exec_line_bare_shell_no_side_effect(tmp_path):
    r"""注入行落进 ``__ot_exec__`` 不在位的裸壳：命令体任何一段都不得执行。

    真机症状正是 ``;`` 分段——第一段报 command not found，**其余段照常执行**
    （本次是只读命令运气好，破坏性命令会实际生效）。
    """
    m1, m2 = tmp_path / "seg1", tmp_path / "seg2"
    cmd = (f"touch {m1}; echo PWNED; echo `id` && echo ALSO"
           f"; echo $(touch {m2})")
    line = agent_exec_line("bash", cmd, "-d").decode().rstrip("\r")
    r = _bare_bash(line)
    assert not m1.exists() and not m2.exists(), "touch 段不得执行"
    assert "PWNED" not in r.stdout and "ALSO" not in r.stdout, \
        "echo 段不得执行"
    assert r.returncode != 0, "裸壳里整行只剩一条不存在的命令"


@_BASH_SKIP
def test_agent_exec_line_base64_form_bare_shell_atomic(tmp_path):
    """base64 包装的对偶用例：命令体（含反引号/$()）锁在码里不得执行，
    裸壳至多跑包装器自己的 echo|base64 -d 子进程。"""
    m = tmp_path / "seg"
    cmd = f"echo 'q'; touch {m}; echo `id`"
    line = agent_exec_line("bash", cmd, "-d").decode().rstrip("\r")
    r = _bare_bash(line)
    assert not m.exists(), "命令体不得执行"
    assert r.returncode != 0


@_BASH_SKIP
def test_hook_unwraps_quoted_exec_body():
    r"""hook 的 ``__ot_exec__`` 分支解一层单引号还原原命令（注入行原子化的
    对偶）。直接跑 build_script 里的真实语句，不复制一份样例。"""
    script = build_script("bash", 1)
    unwrap = next((ln.strip() for ln in script.splitlines()
                   if 'case "$t" in' in ln and "#?" in ln), None)
    assert unwrap, "build_script 缺 __ot_exec__ 解包语句"
    probe = "echo hi; echo `id`"
    body = 't="$1"' + NL + unwrap + NL + 'printf %s "$t"'
    r = subprocess.run(
        [_BASH, "--noprofile", "--norc", "-c", body, "sh", f"'{probe}'"],
        capture_output=True, text=True, timeout=15)
    assert r.stdout == probe, r.stdout + r.stderr




def test_bash_repaint_same_row_erase_on_bash5():
    """bash 5.x 重绘必须「k-1 次上移擦折行段 + 同行擦」，不得整段上移。

    bash 5.x 的 readline 进 bind -x 回调前自己发 CR+EL 把回显行擦净、光标停在
    回显行行首（真机 2026-10-08 字节级实测 CentOS bash 5.1.8：回车后先到
    raw 4 字节 CR+EL，且早于 6337 上报标记）。此时重绘再 CUU k 次就上到回显行的
    上一行、连真实输出一起吃掉——每命令吃一行（真机：sudo su - 的 Last login
    行、上一条命令的青色行逐条消失，屏幕逐命令上塌）。bash 4 及更早按旧实测
    （C-m 已画换行、光标在回显行下一行行首）保留 k 次上移擦，未在真机复核。
    """
    from openterminal.shell_integration import _BASH_SCRIPT
    repaint = _BASH_SCRIPT.split("__ot_repaint() {", 1)[1].split("__ot_run() {", 1)[0]
    assert "BASH_VERSINFO" in repaint, "重绘未按 bash 大版本分流擦行几何"
    v5, v4 = repaint.split("BASH_VERSINFO", 1)[1].split("else", 1)
    assert "for ((i=1; i<k; i++))" in v5, "bash 5.x 分支须只上移 k-1 次擦折行段"
    assert chr(92) + "r" + chr(92) + "033[2K" in v5, "bash 5.x 分支缺同行擦除"
    assert "for ((i=0; i<k; i++))" in v4, "bash 4 分支须保留旧的 k 次上移擦"


# --- 宏式 Enter（bind -x hook + accept-line）------------------------------
# 只 bind -x '"\C-m"' 吞 Enter 时 readline() 永不返回、PS1 不重展开：换目录后
# 空闲提示符的目录冻结（真机 2026-10-09：cd /etc 后仍显示 ~）。改为双段宏
# （\e[44~ 跑 hook、\e[45~ accept 空行）后 bash 每命令重跑 PROMPT_COMMAND 并重
# 展开 PS1，代价是回调返回时 readline 必先拿陈旧 rl_prompt 重画一次提示符——
# 由 __ot_prompt_cmd 的收尾擦行收拾。以下测试锁住这套几何。

BS = chr(92)


def _bash_prompt_cmd() -> str:
    from openterminal.shell_integration import _BASH_SCRIPT
    return _BASH_SCRIPT.split("__ot_prompt_cmd() {", 1)[1].split("\n}", 1)[0]


def test_bash_enter_is_two_stage_macro():
    """Enter 必须是「bind -x hook + accept-line」双段宏，不得回到直接吞。

    bind 命令由 injection_lines 在 eval 之后独立注入（不进 base64 块）——
    bind -x 经 eval 注入时 keymap 关联丢失。中间键用 \\C-o（单字节）而非
    \\e[44~（多字节 CSI）——bash 4.2 的 bind -x 在宏展开时对多字节序列的
    keymap 查找失败。"""
    from openterminal.shell_integration import injection_lines
    lines = injection_lines("bash", 1)
    joined = b"\n".join(lines).decode()
    assert "bind -x '\"" + BS + "C-o\": __ot_submit'" in joined
    assert "bind '\"" + BS + "e[45~\": accept-line'" in joined
    assert "bind '\"" + BS + "C-m\": \"" + BS + "C-o" + BS + "e[45~\"'" in joined
    assert "bind '\"" + BS + "C-j\": \"" + BS + "C-o" + BS + "e[45~\"'" in joined
    # 旧形态（bind -x 直接吃 Enter）不得复活：那等于 readline() 永不返回
    assert "bind -x '\"" + BS + "C-m\"" not in joined
    assert "bind -x '\"" + BS + "C-j\"" not in joined


def test_bash_prompt_cmd_erases_stale_readline_redraw():
    """宏尾 accept 前 readline 必用陈旧 rl_prompt 重画一次提示符（真机字节级
    实测），PROMPT_COMMAND 须按缓存宽度算折行数擦净，否则每命令留一行重复
    提示符——换目录后那行还挂着旧目录。"""
    pc = _bash_prompt_cmd()
    assert '"${__ot_clr:-}"' in pc, "擦行须由 __ot_clr 门控（裸周期不擦）"
    assert BS + "033[%dA" + BS + "r" in pc and BS + "033[2K" in pc
    assert "for ((i=1; i<k; i++))" in pc, "多折行提示符须逐段擦"
    assert "(( k > 1 ))" in pc, "CSI 0A 按 1 处理：k=1 时不得再上移"
    assert "__ot_clr=" in pc, "旗标用后即清，不得连擦两轮"


def test_bash_stale_erase_is_fork_free():
    """擦行块内不得有命令替换：陈旧重绘与擦行之间一次 fork（wc/id）就可能把擦行
    拖出 core 的重注入抑制窗（_ev_prompt 后仅留 80ms）——陈旧行被吞、擦行却放行，
    前端白擦掉一行真实输出。宽度改为建 __ot_p0 时算好缓存进 __ot_w0。"""
    pc = _bash_prompt_cmd()
    erase = pc.split('if [ -n "${__ot_clr:-}" ]; then', 1)[1].split("\n  fi", 1)[0]
    # 只禁命令替换 $(…) 与反引号；算术展开 $((…)) 是内建，不 fork
    assert "$(" not in erase.replace("$((", "") and "`" not in erase, "擦行块须零 fork"
    assert "__ot_w0" in erase
    build = pc.split('if [ "$p0" != "${__ot_p0:-}" ]; then', 1)
    assert len(build) == 2, "宽度须缓存复用（提示符串没变就不重算）"
    assert "wc -c" in build[1]


def test_bash_p0_mirrors_ps1_shape():
    """__ot_p0 必须与 PS1 展开同形，否则擦行按错宽度算折行数 k（多擦吃真实
    输出、少擦留残行）。"""
    from openterminal.shell_integration import _BASH_SCRIPT
    assert "[" + BS + "u@" + BS + "H " + BS + "w]" + BS + "$ " in _BASH_SCRIPT
    pc = _bash_prompt_cmd()
    assert 'p0="[${USER:-$(id -un)}@$HOSTNAME $d]$c "' in pc
    assert 'd="${PWD/#$HOME/' + BS + '~}"' in pc and "c='#'" in pc
    assert '[ "$EUID" != 0 ] && c=' in pc


def test_bash_run_pads_partial_line_after_d_marker():
    """输出不以换行收尾时须补 COLUMNS 空格 + CR（zsh PROMPT_SP 同法）把陈旧重绘
    推到纯空白行：否则提示符接在输出尾巴后画（真机 printf abc → "abc[root@… ~]# "），
    收尾擦行就连真实输出一起擦。补白必须在 D 标记之后——否则空格进 exec 缓冲，
    污染 run() 返回值与转录。"""
    from openterminal.shell_integration import _BASH_SCRIPT
    run = _BASH_SCRIPT.split("__ot_run() {", 1)[1].split("__ot_exec_run() {", 1)[0]
    fill = "printf '%*s" + BS + "r' \"${COLUMNS:-80}\" ''"
    assert fill in run, "缺半行补白"
    assert run.index(BS + "033]133;D") < run.index(fill) < run.index("return 0")


def test_bash_empty_branch_clears_buffer_for_macro_accept():
    """宏尾 accept-line 收的必须是空行：纯空白行留着会被 bash 当命令收下并进史
    （HISTCONTROL=ignorespace 不保证处处开着，且前导空格行仍会执行）。"""
    from openterminal.shell_integration import _BASH_SCRIPT
    empty = _BASH_SCRIPT.split('if [ -z "$t" ]; then', 1)[1].split("return 0", 1)[0]
    assert 'READLINE_LINE=""; READLINE_POINT=0' in empty


def test_bash_clr_flag_survives_reinjection():
    """重注入是 eval 新脚本，而 __ot_clr 由本轮提交回调先置位——init 用普通赋值
    就把这轮收尾擦行清了，注入链每片净多占一行（抑制窗内前端看不见，PTY 与前端
    就此错行）。故三个收尾状态只能「未定义时兜底赋空」。"""
    from openterminal.shell_integration import _BASH_SCRIPT
    head = _BASH_SCRIPT.split("__ot_prompt_cmd() {", 1)[0]
    for v in ("__ot_clr", "__ot_p0", "__ot_w0"):
        assert ': "${%s:=}"' % v in head, "%s 须用 := 兜底初始化" % v
        assert ("\n%s=" % v) not in head, "%s 不得用普通赋值初始化" % v
    # 收尾状态是提示符周期内的化妆量，不导出：子 shell 里取空即「不擦」，
    # 天然安全（${__ot_clr:-} 形式在 nounset 下也不炸）
    for ln in _BASH_SCRIPT.splitlines():
        if ln.startswith("export"):
            for v in ("__ot_clr", "__ot_p0", "__ot_w0"):
                assert v not in ln, "%s 不该出现在导出名单" % v
