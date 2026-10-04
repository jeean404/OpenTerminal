"""全场景 PTY live 套件（计划 Task 8）：CliCore+TermFrontend 单管线真机验收。

驱动方式：每个用例独立起一个 PtyApp 子进程跑 tests/live/cli_driver.py
（进程内 CliCore + TermFrontend，真 LocalPtySession + 用户默认 shell + 真
hook 注入），ScriptedRunner 按 --scenario 替换 openterminal.agent.TaskRunner
（事件形态侦查结论见 cli_driver.py 模块头）。

断言纪律：断言即权威，禁止迁就实现放松；发现的缺陷以 AssertionError 附
2000 字符屏文本上报（_pty_harness.expect 的取证语义）。屏文本是累积字节流
（含 ANSI 序列），「无残留」类断言用 expect_absent（新到输出内不得再现），
重复出现的面板用计数断言。

用例与计划 Task 8 清单 1-10 对应；test_password_prompt_hidden（9）按计划
在 local 目标下恒 skip（触发条件写明在 docstring）；网关档（10）在
127.0.0.1:15721 不可达或 ot 不在时 skip。
"""
from __future__ import annotations

import os
import pathlib
import re
import socket
import subprocess
import sys
import time

import pytest

# 模块级跳过须在 _pty_harness 导入之前：Windows 没有 fcntl/pty/termios，
# 顶层导入会直接 ImportError，ci.yml 的 windows-latest 矩阵会收集失败
if sys.platform == "win32":
    pytest.skip("CLI live 套件依赖 pty/termios，仅 POSIX", allow_module_level=True)

from ._pty_harness import PtyApp

REPO = pathlib.Path(__file__).resolve().parents[2]
DRIVER = pathlib.Path(__file__).resolve().parent / "cli_driver.py"
OT_BIN = "/opt/miniconda3/envs/openterminal/bin/ot"
GATEWAY = ("127.0.0.1", 15721)
# pid 后缀隔离（审查 minor 5）：全量与 live 并发跑不互踩；TOUCH 路径
# 经 OT_LIVE_TOUCH_TARGET 传给 driver（driver 侧同名 env 默认值兜底）
TOUCH_TARGET = f"/tmp/ot_live_ok_{os.getpid()}"
TAB_FILE = f"/tmp/ot_live_tab_u{os.getpid()}.txt"   # 唯一前缀 ot_live_tab_u


def _default_shell() -> str:
    return os.environ.get("SHELL", "/bin/bash")


def _is_old_bash(shell: str) -> bool:
    """bash <4（macOS 自带 3.2）：bind -x enter 回调拿不到 READLINE_LINE，
    hook 的 Enter 分类/AI 上报本就不工作（见 test_hook_classify_live 同款
    skip 理由）。driver 的 shell = 用户默认 shell，故依赖 hook 分类的用例
    在该环境整体 skip；zsh 与 bash >=4 全跑。"""
    if not shell.endswith("bash"):
        return False
    try:
        ver = subprocess.run(
            [shell, "-c", 'echo "${BASH_VERSINFO[0]}"'],
            capture_output=True, text=True, timeout=10).stdout.strip()
        return ver.isdigit() and int(ver) < 4
    except Exception:
        return False


_requires_hook_classify = pytest.mark.skipif(
    _is_old_bash(_default_shell()),
    reason="默认 shell 为 bash<4：hook Enter 分类不工作，AI 触发链用例无意义"
           "（同 test_hook_classify_live 的 skip 理由）")


def _spawn(scenario: str, timeout: float = 90.0) -> PtyApp:
    env = dict(os.environ)   # 含 conftest autouse 的 OPENTERMINAL_HOME（隔离）
    env["OT_LIVE_TOUCH_TARGET"] = TOUCH_TARGET   # driver 审批场景同路径
    env.setdefault("TERM", "xterm-256color")
    env.pop("COLUMNS", None)   # 让 rich 宽度取 pty winsize（120 列）
    env.pop("LINES", None)
    app = PtyApp(
        [sys.executable, str(DRIVER),
         "--target", "local", "--scenario", scenario],
        env=env)
    app.expect("AI 就绪", timeout=timeout)   # hook 集成成功的权威信号
    return app


def _wait_count(app: PtyApp, needle: str, n: int, timeout: float = 20.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if app.screen().count(needle) >= n:
            return
        time.sleep(0.05)
    raise AssertionError(
        f"屏上 {needle!r} 出现次数未达到 {n}（20s 内）；"
        f"最近屏文本：\n{app.tail(2000)!r}")


def _rm(path: str) -> None:
    try:
        os.remove(path)
    except FileNotFoundError:
        pass


# --- 1. 原生命令：回显 / ↑ 历史 / Tab 补全（不依赖 hook AI 分类） ---

def test_echo_command_native():
    _rm(TAB_FILE)
    pathlib.Path(TAB_FILE).write_text("tab target\n")
    app = _spawn("none")
    try:
        app.send(b"echo hi_ot_LIVE\r")
        app.expect("hi_ot_LIVE", timeout=20)

        # ↑ 历史召回 + 回车重执行：同一输出串在屏上再出现 ≥2 次
        # （召回行回显一次 + 命令输出一次）
        before = app.screen().count("hi_ot_LIVE")
        app.send(b"\x1b[A\r")
        _wait_count(app, "hi_ot_LIVE", before + 2, timeout=20)

        # Tab 补全：唯一前缀 ot_live_tab_u → 补全出完整文件名。
        # 断言验证执行效果（补全后的命令输出）而非补全回显本身：长提示符
        # （CI runner 超长主机名）下 zsh 重绘把回显行切成带 ANSI 的碎片，
        # 完整路径在裸字节流上不连续（macos CI 实录）；echo 输出是 shell
        # 单次写入、恒连续，路径完整出现 ⟸ 补全成功，不完整 ⟸ 失败。
        app.send(b"echo /tmp/ot_live_tab_u\t")
        app.send(b"\r")
        _wait_count(app, TAB_FILE, 1, timeout=20)
    finally:
        app.close()
        _rm(TAB_FILE)


# --- 2. 自然语言任务：流式 + 总结框 + 状态行无残留 ---

@_requires_hook_classify
def test_ai_task_inline_stream_and_summary():
    app = _spawn("echo")
    try:
        app.send(b"please show me hello world\r")
        app.expect("hello world", timeout=30)      # 流式 token 直写
        app.expect("总结", timeout=30)             # final/ai_card → 总结框
        # 收尾后 1.5s 内不得再有新的状态行绘制（\r\x1b[K 擦除协议）
        app.expect_absent("任务进行中", within=1.5)
    finally:
        app.close()


# --- 2b. 多行流式无阶梯 + 思考框收齐 ---


@_requires_hook_classify
def test_ai_multiline_no_staircase():
    """流式 \n 须翻 \r\n（raw 态无 ONLCR）+ 思考段走蓝色边框。

    屏字节流是原始累积（非渲染网格）：阶梯错位会留下裸 \n（"row1\nrow2"），
    修复后只应有 "row1\r\nrow2"；思考框断言顶/底收齐（╭/╰）且框内行
    落在行首（\r\n 后紧跟边框色 │）。"""
    app = _spawn("think")
    try:
        app.send(b"please think and stream a table\r")
        app.expect("row1", timeout=30)
        app.expect(re.escape("| 1 | a | b |"), timeout=30)
        app.expect("总结", timeout=30)
        raw = app.screen()
        assert "row1\r\nrow2" in raw               # 换行已翻 \r\n
        assert "row1\nrow2" not in raw.replace("\r\n", "\x00")  # 无裸 \n
        assert "💭 思考" in raw and "╰" in raw     # 思考框开且收底
        assert "\r\n\x1b[34m│" in raw              # 框内行从行首落笔
        # token 打断思考 → 关框无摘要行（摘要归 ai_collapse，同原行为）
        assert "思考 " not in raw.replace("💭 思考", "")
    finally:
        app.close()


# --- 3. ? / ! 前缀 ---

@_requires_hook_classify
def test_force_ai_prefix():
    app = _spawn("echo")
    try:
        app.send(b"?echo forced_q\r")
        app.expect("总结", timeout=30)   # ? 前缀 → 强制 AI → scripted final
    finally:
        app.close()


@_requires_hook_classify
def test_force_cmd_prefix():
    app = _spawn("none")
    try:
        app.send(b"!echo forced_c\r")
        app.expect("forced_c", timeout=20)   # ! 前缀 → 剥掉强制执行
        app.expect_absent("总结", within=1.5)   # 无总结框
    finally:
        app.close()


# --- 4. 审批 Enter 放行（决策后经 InteractiveRunner 真执行） ---

@_requires_hook_classify
def test_approval_enter_executes():
    _rm(TOUCH_TARGET)
    app = _spawn("approval")
    try:
        app.send(b"please create the marker file\r")
        app.expect("ot_live_ok", timeout=30)
        app.expect("待审批", timeout=10)
        app.send(b"\r")
        if app.expect_optional("确认执行", timeout=2.0):
            app.send(b"\r")   # 高危二段确认
        app.expect("✓ 已执行", timeout=30)   # 决策回执（driver final 文本
        # 已改为不含「已执行」的收尾语，此处命中即本地合成回执本身）
        app.expect("▶ 执行", timeout=30)     # AI 发起执行面板（ai_collapse）
        deadline = time.monotonic() + 15
        while not os.path.exists(TOUCH_TARGET):
            if time.monotonic() >= deadline:
                raise AssertionError(
                    f"{TOUCH_TARGET} 未被创建（审批放行后应经注入通道真执行）；"
                    f"屏文本：\n{app.tail(2000)!r}")
            time.sleep(0.1)
    finally:
        app.close()
        _rm(TOUCH_TARGET)


# --- 5. 审批 Backspace 拒绝 ---

@_requires_hook_classify
def test_approval_backspace_rejects():
    _rm(TOUCH_TARGET)
    app = _spawn("approval")
    try:
        app.send(b"please create the marker file\r")
        app.expect("待审批", timeout=30)
        app.send(b"\x7f")
        time.sleep(1.0)   # 决策回执窗口
        assert not os.path.exists(TOUCH_TARGET), \
            f"拒绝后 {TOUCH_TARGET} 不应存在；屏文本：\n{app.tail(2000)!r}"
        # 决策回执（spec §3.2 decide 行：✗ 已拒绝）
        app.expect("✗ 已拒绝", timeout=10)
    finally:
        app.close()
        _rm(TOUCH_TARGET)


# --- 6. 救援 y / n ---

@_requires_hook_classify
def test_rescue_y_and_n():
    app = _spawn("rescue")
    try:
        # 真失败命令触发 hook 记账 → 非零退出（非 130/143）→ rescue 事件。
        # 不用裸 `exit 3`：那会退出登录 shell（会话 EOF），sh -c 'exit 3'
        # 是同样的非零退出记账且行内含 "exit 3"。
        app.send(b"sh -c 'exit 3'\r")
        app.expect("命令失败救援", timeout=30)
        app.expect("exit 3", timeout=10)
        app.send(b"y")
        app.expect("RESCUE_ACCEPT_FINAL", timeout=30)   # AI 接手（scripted final）
        app.expect("总结", timeout=15)

        # 第二轮：n 忽略 → 回执 + 提示符可继续
        app.send(b"sh -c 'exit 4'\r")
        _wait_count(app, "命令失败救援", 2, timeout=30)
        app.send(b"n")
        receipt = app.expect_optional("已忽略", timeout=4.0)
        app.send(b"echo ok2\r")
        app.expect("ok2", timeout=20)
        assert receipt is not None, (
            "rescue 拒绝（n）后屏上无「已忽略」回执（缺陷现场：截获层发出"
            " rescue 决策后未本地合成 rescue_decide 定格行，而 rescue 面板"
            "仍留在屏上）；n 后新到屏文本：\n"
            f"{app.tail(2000)!r}")
    finally:
        app.close()


# --- 7. 任务期 Ctrl+C 中断 ---

@_requires_hook_classify
def test_ctrl_c_interrupts_task():
    app = _spawn("slow")
    try:
        app.send(b"please keep streaming for a while\r")
        app.expect("xxxxx", timeout=30)   # 流式已开始（0.2s/token）
        app.send(b"\x03")
        app.expect("已停止", timeout=15)   # 任务终止提示（error 事件）
        app.send(b"echo alive\r")
        app.expect("alive", timeout=20)   # shell 仍可交互
    finally:
        app.close()


# --- 8. 交互程序原生直通 ---

def test_interactive_program_native():
    app = _spawn("none")
    try:
        app.send(b"less /etc/hosts\r")
        app.expect("localhost", timeout=20)   # hosts 内容经 less 渲染上屏
        app.send(b"q")
        time.sleep(0.3)   # less 退出 + 提示符重画窗口
        app.expect_absent("localhost", within=1.0)   # less 退出后无残留重渲染
        app.send(b"echo after_less\r")
        app.expect("after_less", timeout=20)
    finally:
        app.close()


# --- 9. 密码提示隐藏（local 目标恒 skip） ---

@pytest.mark.skipif(True, reason=(
    "密码截获态（ask_password）只能由 SshPtySession 的认证回调触发，local "
    "目标不可达；本地 shell 里跑 ssh 是 ssh 自身的 tty 回显关闭，不经过 OT "
    "截获层。该场景归 Task 9 的 SSH 真机手动项验证。"))
def test_password_prompt_hidden():
    """local 目标无法触发 OT 密码弹窗——跳过（触发条件如上）。"""


# --- 10. 网关档：真 ot + 真模型任务 ---

def _gateway_up() -> bool:
    try:
        with socket.create_connection(GATEWAY, timeout=1.0):
            return True
    except OSError:
        return False


@pytest.mark.skipif(not _gateway_up(),
                    reason="模型网关 127.0.0.1:15721 不可达（网关档按可达性 skip）")
@pytest.mark.skipif(not os.path.exists(OT_BIN),
                    reason=f"ot 可执行不存在：{OT_BIN}")
@_requires_hook_classify
def test_gateway_real_ai_task(tmp_path):
    # 隔离 home（历史库/缓存不写真实目录），仅复制真实 .env（网关 key）
    home = tmp_path / "ot_home"
    home.mkdir()
    real_env = pathlib.Path.home() / ".openterminal" / ".env"
    if real_env.exists():
        (home / ".env").write_text(real_env.read_text(encoding="utf-8"))
    env = dict(os.environ, OPENTERMINAL_HOME=str(home))
    env.setdefault("TERM", "xterm-256color")
    env.pop("COLUMNS", None)
    env.pop("LINES", None)
    # `ot connect default`：default 目标即 local 模式，绕过菜单直进管线
    # （`ot connect local` 会被 _target_name_for 注册成 SSH 目标，不可用）
    app = PtyApp([OT_BIN, "connect", "default"], env=env)
    try:
        app.expect("AI 就绪", timeout=120)
        # 回复词不出现在输入行里：屏上 banana 的额外出现 = 模型流式正文
        # 真实到达（「流式非空」的结构断言，避开回显/状态行的干扰）
        app.send(b"reply with exactly one word: banana\r")
        app.expect("任务进行中", timeout=60)   # 状态行出现
        app.expect("总结", timeout=300)        # 真模型总结框出现
        # ≥3：输入回显(1) + hook 蓝色重绘(1) 之后必须有真流式正文(≥1)
        assert app.screen().count("banana") >= 3, (
            "流式非空断言失败：屏上 banana 未超过 回显+hook重绘 的 2 次"
            f"基线（模型流式正文未到达）；屏文本：\n{app.tail(2000)!r}")
        # 任务后原生命令直执行成功
        app.send(b"echo gw_ok\r")
        app.expect("gw_ok", timeout=30)
    finally:
        app.close()
