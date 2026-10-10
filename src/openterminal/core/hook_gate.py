"""hook 集成与验活（Task 5 自 PipelineCore 原样搬入）。

shell 族探测与分片重注入（su - / login shell 重置后自愈）、能力探测、
hook 在位判定、回车看门狗验活、登出特征识别（TMOUT/exit/logout）与
死壳处置——自然语言健康路径的门禁与活性凭据都在本组件。
状态**物理存 core 实例**（P3 裁定延续：pump/命令集/InteractiveRunner
与测试直读 core._hook_* 等；HookGate.__init__ 以 hasattr 守卫补建，
预置值不覆盖），方法体经 self.core 读写。

组件公开接口：ensure_integrated / probe_shell_kind（重注入与探测）、
hook_ok（在位门禁）、note_mark / note_text（标记流活性凭据）、
observe_output（登出特征识别，泵责任链调用）、drain_quiet（静默排水）。
InteractiveRunner（core.messages）经 core._shell_kind/_b64flag/_hook_seen
与本组件共享探测结论——物理位置在 core，两边同径访问。
"""

from __future__ import annotations

import asyncio
import re
import time

from .. import _core_impl as _impl
from .messages import CHANNEL_DEAD_EC, CommandResult, ServerMsg, _dbg
from ..shell_integration import (history_quiet_line, injection_lines,
                                 is_internal_line, parse_probe, probe_command)


# shell 自行退出的文字特征（bash TMOUT 自动登出 / ssh 客户端断链）。
# 认「视觉行」而不是字节行：真机告别语紧跟提示符重画落进流里，前缀是
# ESC[?2004l + CR + BEL，字节行首锚点跨不过那个 CR，一律漏检（真机审批期
# TMOUT 后 __ot_pad 连环 command not found 的根因）。故先按 CR/LF 切出视觉
# 行、剥掉转义与控制符，再整行全文匹配——告别语前只允许一段提示符宽度的
# 普通字符（bash 是紧贴已打出的提示符写的），后面只许空白；命令输出里恰好
# 含这些词的长行（grep 日志、带时间戳的行）撑不进这个宽度或后面还拖着正文，
# 不误判。裸 logout 只在挂起窗口认（见 _shell_exit_window）。
# （模块后段另有一个喂 str 的 _ANSI_RE，字节流这里必须另起名字，否则被覆盖）
_EXIT_ANSI_RE = re.compile(
    rb"\x1b\[[0-9;?]*[ -/]*[@-~]"               # CSI：颜色/光标/模式
    rb"|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)"      # OSC：标题 / 133 标记
    rb"|\x1b[@-_]"                               # 其余单字符转义
)
_EXIT_CTRL_RE = re.compile(rb"[\x00-\x1f\x7f]")
#: 强特征：任意提示符位置都认（空闲提示符上的 TMOUT 最常见），但整行须是
#: 「≤48 字符前缀 + 告别语 + 行尾空白」这一形状
_SHELL_EXIT_RULES = (
    (re.compile(rb".{0,48}timed out waiting for input: auto-logout\s*",
                re.IGNORECASE), "timed out waiting for input: auto-logout"),
    (re.compile(rb"Connection to .*?\b(?:closed|dropped)\b.*",
                re.IGNORECASE), "Connection closed"),
)
#: 弱特征：整行就是一个裸 logout——仅审批挂起窗口认
_SHELL_EXIT_WEAK_RULES = (
    (re.compile(rb"logout\s*", re.IGNORECASE), "logout"),
)
# 回车看门狗时限：健康路径补发 \r 后，集成壳必在 PROMPT_COMMAND 里回 OSC 标记
# （133;D + 133;A/B）。到点只收到纯文本、一个标记都没有 = 承接这个回车的根本
# 不是集成壳（嵌套 shell 被 TMOUT/exit 收走后落回的裸壳）——此时健康路径的裸
# \r 会把整行自然语言交给它当命令执行（真机 -bash: 执行: command not found）
_HOOK_LIVENESS = 1.0


class HookGate:
    def __init__(self, core) -> None:
        self.core = core
        for name, val in (
            ("_interactive", False),    # hook 集成就绪；False = 纯终端直通
            ("_shell_kind", None),      # bash | zsh | powershell（探测结论）
            ("_b64flag", "-d"),
            # _hook_gone：_ensure_integrated 探测不到可集成的 shell（bash 3.2 /
            # 其他族 / 前台占用）——标记流不足以证明 hook 在位，pad/健康路径/
            # 兜底按 hook 不在位降级。嵌套 shell 退出（_open_cmds 清空）复位。
            ("_hook_gone", False),
            # _hook_stale：带 hook 的 shell 整体消失（TMOUT/exit/logout，bash
            # 不发告别标记）。由回车看门狗置位；任一 OSC 标记到达即撤销（外层
            # 集成壳重新画出提示符 = 自愈），重注入落地亦作废。
            ("_hook_stale", False),
            ("_hook_seen", False),      # hook 曾在位（掉线才补注入）
            ("_hook_watch", None),      # 回车看门狗任务（_HOOK_LIVENESS）
            ("_hook_watch_text", False),  # 看门狗窗口内收到过纯文本
            ("_probe_buf", None),       # 探测行输出收集（bytearray | None）
            ("_last_mark_at", 0.0),     # 最近一次 OSC 标记事件（A/B/D/report）
            ("_last_live_at", 0.0),     # 最近一次未被吞除的纯文本输出
            ("_exit_tail", bytearray()),  # 登出特征滚动窗（_detect_shell_exit）
            ("_hook_report_pending", None),  # 补发 \r 后等待 AI 上报的行
        ):
            if not hasattr(core, name):
                setattr(core, name, val)

    async def _ensure_integrated(self) -> bool:
        """su - / sudo su - 等 login shell 会重置 PROMPT_COMMAND、函数与 Enter
        绑定，丢掉 OSC 133:D 提示符标记与 __ot_exec__/__ot_pad 通道，导致自然语言
        任务挂起。任务启动前重发分片注入脚本：幂等（healthy shell 只重定义同名函数/
        重设同款提示符，无副作用；su - 后则恢复全部集成）。回显经 _suppress_live 吞掉，
        等 OSC:D 提示符标记确认注入落地。

        注入前先探测提示符后面的真实 shell 族（su - 换壳）：外层会话的
        _shell_kind 是连接时探测的（如 zsh），而 macOS root = /bin/sh =
        bash 3.2——把 zsh 脚本打进 bash 定义不出任何函数，且 zsh 版 PS1 在
        bash 里照样发 OSC 133 标记，_hook_ok 由此假阳性（真机 su - 后
        __ot_pad 连环 command not found、自然语言整行被 root shell 当命令
        执行、\x15 连环吞输入）。探测不到可集成 shell 时置 _hook_gone 转
        降级，本次任务外部启动。"""
        if not self.core._interactive or self.core.session is None:
            return False
        async with self.core._runner_lock:
            return await self._ensure_integrated_locked()

    async def _ensure_integrated_locked(self) -> bool:
        """重注入本体：调用方必须已持有 _runner_lock。

        拆出来是因为 InteractiveRunner.run（P0-1 门禁）与 _shell_pad 的 60s
        兜底补注入自己就持着这把锁，再经 _ensure_integrated 取一次就是重入
        死锁（asyncio.Lock 不可重入）——旧代码 _shell_pad 那条路径正踩着。
        """
        self.core._ev_prompt.clear()
        self.core._suppress_live = True
        self.core._suppressed_tail = ""
        try:
            # 前置 \x15 收纳半行但不补 \x19 恢复：任务启动即丢弃该半行
            #（若 yank 回 kill ring 里的旧文本，会在提示符行复活污染输入）。
            # 探测行必须敲在干净提示符上——半行没清，探测行会拼在用户
            # 已敲文本后面整行执行。
            await self.core.session.send_raw(b"\x15")
            if self.core._shell_kind != "powershell":
                # 静默窗口先行：hook 不在位（su - 换壳）时探测行/分片行
                # 靠前导空格 + ignorespace 原生跳过入史；hook 在位时本行
                # 被 widget 按内部行（__ot_hc= 前缀）静默处理
                await self.core.session.send_raw(history_quiet_line())
            shell, flag = await self._probe_shell_kind()
            if shell is None:
                if not self.core._hook_gone and not self.core._hook_stale:
                    # 首次判定不可集成：明确告知前端，别让每个任务静默失败。
                    # _hook_stale（壳已自行退出）时不发：根因已由
                    # _note_shell_dead 报过，再发一句「bash 3.2 / 前台占用」
                    # 是互相打架的误导
                    await self.core.emit_msg(ServerMsg(
                        type="status",
                        text="当前 shell 无法集成（bash 3.2 等旧壳 / 前台占用），"
                             "AI 工具执行不可用；请换可集成的 shell 后重试"))
                self.core._hook_gone = True
                return False
            self.core._hook_gone = False
            self.core._hook_stale = False   # 重注入落地：陈旧判定作废
            self._cancel_hook_watch()
            if shell != self.core._shell_kind:
                self.core._shell_kind = shell
                self.core._b64flag = flag
            for _ci, line in enumerate(
                    injection_lines(self.core._shell_kind,
                                    self.core.exec._reinject_inst_base(),
                                    self.core._b64flag)):
                self.core._ev_stream.clear()
                await self.core.session.send_raw(line)
                # 逐片等本片回显到达再发下一片：固定短间隔会让分片堆进
                # shell 执行间隙的 canonical 缓冲（4096 溢出丢块，真机实测
                # 0.03s 间隔 md5 不复现）。回显即 readline 已读入本片的凭据；
                # 回显绝迹（裸模式残影）时退回实测安全的 0.12s 间隔。
                # 嵌套 ssh 隧道（跳板机）里 ZLE 对赋值行不回显——回显等待
                # 总是超时、分片全速连发被 ssh 通道合并成大包，远端 pty
                # 输入队列溢出**静默丢字节**，恰好丢掉末行 eval → 注入整链
                # 无声失败。因此无条件再垫 0.04s 最小间隔，保证远端逐片
                # 消化、批次不合并。
                try:
                    await asyncio.wait_for(self.core._ev_stream.wait(), 0.12)
                except asyncio.TimeoutError:
                    pass
                await asyncio.sleep(0.04)
            try:
                await asyncio.wait_for(self.core._ev_prompt.wait(), 2.0)
                # zsh POSTEDIT 重绘可能落在 A 标记之后：抑制窗口多留 80ms
                # 把它一并吞掉，否则每任务注入的重绘行泄漏进主屏（§5.5）
                await asyncio.sleep(0.08)
                return True
            except asyncio.TimeoutError:
                return False
        finally:
            self.core._suppress_live = False
            await self.core.exec._resync_after_suppress()

    async def _probe_shell_kind(self) -> tuple[str | None, str]:
        """在当前提示符敲一行能力探测，识别 su - / 嵌套 shell 后的真实 shell 族。

        复用 probe_command + parse_probe（bash>=4 门槛与 base64 参数判定与
        连接时探测同一套）；行首加 ``_ot_inj=`` 前缀使 is_internal_line 成立
        ——hook 恰好在位时该行按内部行静默记账，不入历史、不占用户命令帧；
        再加一个前导空格——hook 不在位时靠 _ensure_integrated 先发的静默行
        （ignorespace/hist_ignore_space）原生跳过入史。
        输出经 _probe_buf 收集（_on_stream_event 的 live/exec 分支塞入），
        回显与输出由调用方持有的 _suppress_live 窗口吞掉，不外显。

        返回 (shell|None, b64flag)：超时 / 无标记（前台占用吃掉探测行、
        其他 shell 族、bash 3.2）→ (None, "-d")。Windows 无 su - 语义，
        维持连接时探测的原判。"""
        if self.core.session is None:
            return None, "-d"
        if self.core.profile is not None and self.core.profile.os_family == "windows":
            return self.core._shell_kind, self.core._b64flag
        self.core._probe_buf = bytearray()
        try:
            await self.core.session.send_raw(
                (' _ot_inj=""; ' + probe_command(self.core.profile.os_family)
                 ).encode() + b"\r")
            deadline = time.monotonic() + _impl._PROBE_TIMEOUT
            while time.monotonic() < deadline:
                shell, flag = parse_probe(
                    self.core._probe_buf.decode("utf-8", "replace"))
                if shell is not None:
                    return shell, flag
                await asyncio.sleep(0.05)
            return None, "-d"
        finally:
            self.core._probe_buf = None

    async def _drain_quiet(self, quiet: float = 0.12,
                           router: "StreamRouter | None" = None,
                           raw_sink: "Callable[[bytes], None] | None" = None
                           ) -> str | None:
        """排空输出直到静默；喂 router 时返回其间出现的提示符（无则 None）。

        setup 注入期专用：泵未启动，必须主动读，否则 zle 回显塞满输出队列
        会导致 shell 停读输入、写入端 EAGAIN 自旋死锁（Task 注入排障结论）。
        raw_sink：原始字节旁路（PS2 续行指纹扫描等），不影响 router 解析。
        """
        prompt = None
        while True:
            try:
                chunk = await self.core.session._read_some(quiet)
            except asyncio.TimeoutError:
                return prompt
            except (ConnectionError, EOFError):
                return prompt
            if not chunk:
                return prompt
            _dbg("drain raw=", repr(chunk[:60]))
            if raw_sink is not None:
                raw_sink(chunk)
            if router is not None:
                for ev in router.feed(chunk):
                    if ev[0] == "prompt" and prompt is None:
                        prompt = ev[1]

    def _hook_ok(self) -> bool:
        """hook 在位判定：本会话见过 OSC 标记，且探测未判定「换了壳」。

        旧口径「标记时间戳不落后于纯文本」会把**按键回显**（纯文本）误判成
        标记绝迹：用户只要敲过字，live 必然新于最后一次提示符标记，健康路径
        永久退化——\\x03 + 整行重发，且 suppress 窗口吞掉 ^C 后的提示符重画
        使前端光标与 PTY 失步，重发回显拼在首段回显后（真机「同一行输入重复
        两遍」根因）。su - 等重置发生在用户命令帧内（_open_cmds 开着），已由
        空闲门闩覆盖；帧闭合后外层 hook 仍在、标记恢复。

        但仅凭标记流也不够：su - 换壳后注入的外族 PS1 照样发标记而函数全空
        （真机 zsh PS1 落进 bash 3.2），故 _ensure_integrated 探测失败置
        _hook_gone 转假；嵌套 shell 退出（_open_cmds 清空）复位，外层 hook
        的标记与函数从未丢过，自然恢复在位。

        _hook_stale 补的是第三类：**带 hook 的 shell 自己没了**。root 空闲
        TMOUT 自动登出、exit、logout 都不发任何标记，_hook_gone 的两个入口全
        够不着，而死壳留下的 _last_mark_at 会让 _inner_ssh_prompt_live 继续
        放行健康路径——补发的 \r 把自然语言整行送进落回来的裸壳执行（真机
        跳板机 → xiaojian → sudo su - root → TMOUT 掉回 → 再 sudo su - 后
        「输入自然语言就不行了」= -bash: 执行: command not found）。
        由回车看门狗置位，任一标记到达即撤销。"""
        return (self.core._interactive and not self.core._hook_gone
                and not self.core._hook_stale and self.core._last_mark_at > 0)

    # --- 回车看门狗：健康路径的「hook 还在不在」验活 -----------------------

    def _note_hook_mark(self) -> None:
        """任一 OSC 标记到达：集成壳就在当前提示符上活着。

        既是 _inner_ssh_prompt_live 的时间戳凭据，也是陈旧判定的撤销凭据——
        外层集成壳重新画出提示符（嵌套裸壳退出后落回来）即自愈，健康路径
        立刻恢复，不必白付一次探测 + 分片重注入。"""
        self.core._last_mark_at = time.monotonic()
        self.core._hook_stale = False
        self._cancel_hook_watch()

    def _note_hook_text(self) -> None:
        """纯文本（无标记）到达：看门狗窗口内记一笔「壳有响应」。

        只有文本、没有标记才判陈旧——一个标记都没有且毫无输出（链路卡死）时
        不作结论，交给既有的超时/断线机制。"""
        if self.core._hook_watch is not None:
            self.core._hook_watch_text = True

    def _arm_hook_watch(self) -> None:
        """健康路径补发回车后武装看门狗。

        集成壳的回车必有回响：PROMPT_COMMAND 发 133;D，提示符重画发 133;A/B。
        _HOOK_LIVENESS 内只收到纯文本 = 承接回车的不是集成壳，转降级（下一条
        自然语言走探测 + 重注入，而不是把整行交给裸壳执行）。误判自愈：真正的
        标记一到即撤销；期间最多多付一次幂等重注入。"""
        if self.core._display == "ssh":
            # Shell 模式 pump 纯透传，标记根本不进路由器：无从验活，不作结论
            return
        self._cancel_hook_watch()
        self.core._hook_watch_text = False
        self.core._hook_watch = asyncio.create_task(self._hook_liveness())

    def _cancel_hook_watch(self) -> None:
        t = self.core._hook_watch
        if t is not None:
            self.core._hook_watch = None
            t.cancel()

    async def _hook_liveness(self) -> None:
        me = asyncio.current_task()
        try:
            await asyncio.sleep(_HOOK_LIVENESS)
        finally:
            # 只清自己的把手：撤销后紧接着重新武装时，新任务不得被旧任务的
            # finally 抹掉（否则看门狗失控、再也撤不掉）
            if self.core._hook_watch is me:
                self.core._hook_watch = None
        if self.core._closed or not self.core._hook_watch_text:
            return
        _dbg("hook stale: 回车后只有文本没有标记 → 转降级")
        self.core._hook_stale = True

    # --- shell 自行退出感知（TMOUT 自动登出 / logout / 断链）--------------

    async def _detect_shell_exit(self, data: bytes) -> None:
        """在输出字节流里认 shell 自行退出的文字特征。

        bash 退出不发任何 OSC 标记，_hook_gone 的两个入口与回车看门狗都够
        不着（见 _hook_ok 注释的「第三类」）；而 TMOUT 最常命中在**审批等待
        期**——那段 core 对 PTY 零字节发送，看门狗根本无从武装。故只能在字节
        流里认文字，匹配口径见 _match_shell_exit。
        """
        self.core._exit_tail.extend(data)
        if len(self.core._exit_tail) > 4096:
            del self.core._exit_tail[:-2048]
        why = self._match_shell_exit(bytes(self.core._exit_tail))
        if why is None:
            return
        self.core._exit_tail.clear()
        await self._note_shell_dead(why)

    def _match_shell_exit(self, tail: bytes) -> str | None:
        """在滚动窗里认 shell 告别语，回命中片段；没命中回 None。

        视觉行＝按 CR / LF 断开（CR 重画、提示符转义都并进同一行），剥掉转义
        与控制符后**整行**全文匹配。两重收敛防误判：告别语前只允许一段提示符
        宽度的普通字符、后面只许空白；裸 logout 只在审批挂起窗口认。只翻窗尾
        几行：命中即清窗处置，再往前翻只会翻出早已处置过（或与本次无关）的
        旧行。
        """
        lines = [x for x in re.split(rb"[\r\n]", tail) if x.strip()]
        for line in lines[-8:]:
            plain = _EXIT_CTRL_RE.sub(b"", _EXIT_ANSI_RE.sub(b"", line))
            for pat, label in _SHELL_EXIT_RULES:
                if pat.fullmatch(plain):
                    return plain.decode("utf-8", "replace")[:80] or label
            if self._shell_exit_window():
                for pat, label in _SHELL_EXIT_WEAK_RULES:
                    if pat.fullmatch(plain):
                        return label
        return None

    def _shell_exit_window(self) -> bool:
        """退出特征的弱匹配窗口：审批挂起。

        审批等待期 core 对 PTY 零字节发送、没有命令输出在途，行首 logout
        只可能是 shell 自己的告别；窗口外认了会把 history/ps/grep 输出里
        恰好成行的 logout 误判成壳死了。强特征（TMOUT 告别语 / ssh 断链）
        贴行首且专用，不受此窗口限制——空闲提示符上的 TMOUT 最常见，而那段
        既不在审批挂起也不在执行等待。"""
        return self.core._pending_approval is not None

    async def _note_shell_dead(self, why: str) -> None:
        """壳已死：作废 hook 活凭据，立刻解阻塞在途工具执行。

        后续提交与工具注入经 _hook_ok 转假走门禁/降级（P0-1、P1-4），不再把
        工具注入行、Ctrl+C、__ot_pad 注进落回来的裸壳。任一 OSC 标记到达即由
        _note_hook_mark 撤销陈旧判定（外层集成壳重画提示符＝自愈）。
        """
        if not self.core._interactive:
            return
        first = not self.core._hook_stale
        self.core._hook_stale = True       # _hook_ok 转假：注入/健康路径全降级
        self.core._last_mark_at = 0.0      # 死壳留下的旧时间戳不得再当活凭据
        self._cancel_hook_watch()
        fut = self.core._exec_future
        if fut is not None and not fut.done():
            # 明确错误立即收束，不等超时打 ^C（那也是落进裸壳的垃圾）
            fut.set_result(CommandResult(
                output=f"[ot] 远端 shell 已退出（{why}），命令未执行；"
                       f"请重新登录后重试",
                exit_code=CHANNEL_DEAD_EC, truncated=False, cwd=""))
        if first:
            await self.core.emit_msg(ServerMsg(
                type="status",
                text=f"远端 shell 已退出（{why}）：AI 工具执行不可用，"
                     f"请重新登录后重试"))

    # --- 组件公开接口绑定 ---
    ensure_integrated = _ensure_integrated
    ensure_integrated_locked = _ensure_integrated_locked
    probe_shell_kind = _probe_shell_kind
    hook_ok = _hook_ok
    note_mark = _note_hook_mark
    note_text = _note_hook_text
    observe_output = _detect_shell_exit

    @property
    def shell_kind(self) -> str | None:
        """探测出的 shell 族（InteractiveRunner 经 core._shell_kind 读）。"""
        return self.core._shell_kind

    @property
    def b64flag(self) -> str:
        """base64 解码旗标（InteractiveRunner 经 core._b64flag 读）。"""
        return self.core._b64flag
