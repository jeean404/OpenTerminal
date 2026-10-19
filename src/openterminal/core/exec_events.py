"""执行上下文与标记流（Task 4 自 PipelineCore 原样搬入）。

OSC 133 标记流状态机（A/B/C/D/report）、EXEC 帧栈、幕帘、pad 注入、
^C 回显吞除、工具卡 id 记账——泵责任链的「exec 标记流」段与注入器。
状态**物理存 core 实例**（P3 裁定延续：pump/AI 流/命令集与测试直读
core._exec_* 等；ExecEvents.__init__ 以 hasattr 守卫补建，预置值不覆
盖），方法体经 self.core 读写。

组件公开接口：on_stream_event / on_exec_start / on_exec_end /
feed_output（标记流与文本路径）、shell_pad（卡片占位注入）、
strip_intr_echo（^C 回显吞除）、open_cmds（用户命令帧记账，只读）。
InteractiveRunner（core.messages）经 core._exec_future/_exec_buf 与本
组件共享执行通道状态——物理位置在 core，两边同径访问。
"""

from __future__ import annotations

import asyncio
import time
from collections import deque

from .messages import ServerMsg, _dbg, _ansi_free
from ..shell.integration import is_internal_line
from ..session.base import CommandResult


def _strip_pad_echo(seg: str) -> str:
    """滤掉 ``__ot_pad`` 注入自身的回显行（含裸壳的 command not found）。

    hook 在位时它清掉自己的回显，用户看不到；hook 刚掉线（``su -`` 换壳）时
    ``_hook_ok`` 仍是陈旧真值，注入落进裸壳，回显 / ``^Y`` / ``bash: __ot_pad:
    command not found`` 全部外显 = 真机图一的「无效命令输出」。

    只滤这三样，**hook 打出的 N 个空行必须原样放行**——那是垫行本体，吞了
    blankSpan 就永远数不满、卡被夹紧截断。整行丢弃（不是就地删词）：
    ``-bash: __ot_pad: command not found`` 只删 token 会留下残句。
    """
    if not seg:
        return seg
    out = []
    for ln in seg.splitlines(keepends=True):
        if "__ot_pad" in ln:
            continue                      # 注入行回显 / 其 command not found
        ln = ln.replace("\x19", "").replace("^Y", "")
        if ln.strip() or ln:
            out.append(ln)                # 空白行（垫行）与正文都放行
    return "".join(out)


class ExecEvents:
    def __init__(self, core) -> None:
        self.core = core
        for name, val in (
            ("_cur_prompt", ""),        # 最近一次 B 标记捕获的提示符纯文本
            ("_pending_report", None),  # C 标记前最近的行报告 (inst, kind, line)
            ("_open_cmds", {}),         # 用户命令记账 inst -> line（退出码）
            ("_open_cmd_at", {}),       # 用户命令帧开帧时刻（内层 ssh 提示符活性判定）
            ("_exec_stack", []),        # 执行上下文栈：agent/probe/silent
            ("_hidden_exec", False),    # 隐藏探测在途（ctx=probe，输出只捕获不转发）
            ("_exec_buf", bytearray()), # AI 工具命令输出捕获
            ("_exec_truncated", False),
            ("_suppress_live", False),  # 注入窗口吞 live 字节（注入行回显不外显）
            ("_suppressed_echo", False),  # 窗口内吞过回显：exec 开始时补 \r\n 收束行
            ("_suppressed_tail", ""),     # 窗内吞掉的末尾残段（= shell 新画的提示符）
            ("_repaint_text", None),      # 窗口收束后补画的 NL 行（蓝 33）
            ("_pending_agent_cmds", deque()),  # 已登记未执行的 AI 工具命令
            ("_agent_open_cmd", None),  # 已开 ai_collapse、尚未收束的命令
            ("_task_cmd_started", False),  # 本任务是否已发 ai_collapse（首个工具命令）
            ("_tool_card_seq", 0),      # 工具卡 id 全会话唯一（前端 slot/feed 按 id 迁移）
            ("_tool_idx_map", {}),      # runner 局部 index → 全局卡 id
            ("_intr_swallow_until", 0.0),  # ^C 回显吞除窗口（跨块悬置）
            ("_intr_pending", b""),        # 悬置的块尾 "^"（等跨块 C）
            ("_user_out", bytearray()),  # 当前用户命令输出捕获（救援上下文）
            ("_curtain", False),        # 提示符幕帘：任务期扣住提示符重绘字节
            ("_curtain_parts", []),     # 扣住的 live 文本（按序）
            ("_curtain_at", 0.0),       # 关帘时刻（防呆：超时自动放行）
            ("_pad_reinject_at", 0.0),  # _shell_pad hook 补注入节流阀（monotonic）
            ("_reinject_pending", False),  # 任务起跑重注入在途（pad 路径免重试）
            ("_pad_task", None),        # 在途 pad 打字任务（门闩排序用）
            ("_pad_inflight", False),   # pad 行已敲进 PTY、回显未消化（指纹扫描窗）
            ("_pad_echo_carry", ""),   # pad 回显净化的半行暂存（分片切开时防漏滤）
            ("_pad_prompt_timeout", 2.0),  # pad 每块等提示符重画的上限
        ):
            if not hasattr(core, name):
                setattr(core, name, val)

    def _install_curtain_gate(self) -> None:
        """把 session.send_raw 包上开帘闸：任务幕帘关着时，任何 PTY 写入
        （命令/pad/口令/镜像注入，含 runner 直写）先放行扣住的字节再写入——
        字节序不变，唯一的可见性变化是提示符段整体后移。实例属性遮蔽方法，
        对持有同一 session 的 runner/backend 全部生效。"""
        if self.core.session is None:
            return
        raw_send = self.core.session.send_raw

        async def _gated(data: bytes, _raw=raw_send):
            # 注入抑制窗内绝不开帘：帘一开就把窗内吞掉的提示符段成排漏
            # 出去，一片接一片落在上一提示符的光标列上（横排提示符墙，
            # 真机截图）。窗末由 _resync_after_suppress 统一对齐。
            if self.core._curtain and not self.core._suppress_live:
                await self._curtain_open()
            await _raw(data)

        try:
            self.core.session.send_raw = _gated   # type: ignore[method-assign]
        except Exception:                    # noqa: BLE001 - 只读会话对象则退化为无幕帘
            pass

    async def _curtain_open(self) -> None:
        """开帘：把扣住的 live 文本按原序放行（无扣留则空操作）。"""
        if not self.core._curtain:
            return
        self.core._curtain = False
        parts, self.core._curtain_parts = self.core._curtain_parts, []
        if parts:
            await self.core.emit_bytes("".join(parts).encode("utf-8", "replace"))

    def _curtain_close(self) -> None:
        if self.core._ai_task is None:
            return
        self.core._curtain = True
        self.core._curtain_parts = []
        self.core._curtain_at = time.monotonic()

    async def _shell_pad(self, rows: int, mirror: str | None = None) -> None:
        """注入 ``__ot_pad N``：hook 打印 N 个空行并清掉自身回显。
        等提示符重画完成（空行已落终端缓冲）再应答前端挂卡。
        与 InteractiveRunner 注入共用 _runner_lock：两者都往 PTY 输入
        缓冲送 \x15…\r 注入序列，交错会污染彼此的半行收纳。
        单次注入限 50 行（hook 的 seq 上限），超高分块循环打满——
        总结卡可达上百行占位，截断会让卡片悬在缓冲区外盖住提示符。

        hook 在位时半行保护走 shell 侧存档/接回原语（^U 存 __ot_saved、^Y
        接回，空行零副作用，任务期打字与注入交错也能原样接回）。hook 不在位
        （su - 换壳探测失败等）直接 ack 返回：没有 __ot_pad 通道，旧降级往
        提示符敲 ``__ot_pad N`` 只会连环 command not found + 提示符连排，
        前置 \x15 还连环吞用户输入（真机「打字不显示」根因之一）。宁藏不盖：
        不垫空行，卡由显隐/夹紧逻辑兜底。"""
        _dbg("shell_pad enter rows=", rows, "interactive=", self.core._interactive)
        async with self.core._runner_lock:
            _dbg("shell_pad locked")
            if self.core.hook._hook_ok():
                self.core._hook_seen = True
            elif (self.core._hook_seen and
                    time.monotonic() - self.core._pad_reinject_at > 60
                    and not self.core._reinject_pending):
                # hook 中途掉线（su -/exec/脚本重置 PROMPT_COMMAND）时 pad 会
                # 秒应答零空行＝卡出生即夹紧截断（真机「总结卡底部被切」）。
                # 任务起手已补注入一次，这里做 60s 节流的兜底重试：能救回就
                # 照正常路径垫行，救不回再走宁藏不盖的降级。_hook_seen 门卫：
                # 从未在位＝结构上不可集成（非掉线），不空转注入。
                # _reinject_pending：任务起跑的重注入已在途（外部触发链任务
                # 必有）——pad 在它后面排队会让降级提交的分析卡迟到整段重注入
                # （真机 Enter→卡 2.5s 根因），此时立即 ack，卡由显隐/夹紧兜底
                self.core._pad_reinject_at = time.monotonic()
                try:
                    # 已持 _runner_lock：走无锁实现（经 _ensure_integrated
                    # 取锁会重入死锁）
                    await self.core.hook._ensure_integrated_locked()
                except Exception:  # noqa: BLE001 - 补注入失败不碍降级
                    pass
                if self.core.hook._hook_ok():
                    self.core._hook_seen = True
            if not self.core.hook._hook_ok() or self.core._reinject_pending:
                # 两类都不往壳里敲 pad：①hook 不在位（判死/探测失败）——敲
                # 进去必撞裸壳；②任务起跑的重注入在途（外部触发链必有，至
                # _run_task 重注入落地才清位）——窗口内壳还没痊愈，敲进去
                # 就是真机残迹「__ot_pad: command not found + 提示符粘连」。
                # deferred 告诉前端这次「空白没长」是窗口内暂时现象，不计
                # 熔断连败（慢链路重注入 1-4s，连续 ack 不增长会误熔断）；
                # 痊愈后下一轮 pad 自会补齐。
                # **只有永久死通道才不带 deferred**：`_hook_gone`（探测判死 /
                # 回显指纹判死）＝这条 pad 通道确实没了，前端照常计数熔断、
                # 停掉空转重试。其余都是暂时垫不进——最典型的是**连接期
                # hook 尚未注入**（`_last_mark_at` 还是 0、`_hook_ok` 假），
                # 旧实现按 `_reinject_pending` 单独判 deferred，把这一类报成
                # 非 deferred，前端连吃两次空应答就 `_fusePads()` 把 pad 通道
                # 永久焊死：此后每张卡都垫不满、全被夹紧成只剩卡头的细条
                # （真机图一「⚠ 系统警告只剩标题」的上游根因）。
                _dbg("shell_pad ack-only pending=", self.core._reinject_pending,
                     "gone=", self.core._hook_gone)
                await self.core.emit_msg(ServerMsg(
                    type="event", event={"kind": "padded", "rows": rows,
                                         "deferred": self.core._reinject_pending
                                         or not self.core._hook_gone}))
                return
            remaining = max(1, rows)
            first = True
            hook = self.core.hook._hook_ok()
            # 指纹扫描窗：pad 行已敲进 PTY，回显若带「__ot_pad: command not
            # found」即壳里没有 hook 函数（_hook_ok 标记流假阳性，su - 换壳
            # 主因），泵侧当场置 _hook_gone——本循环下一轮条件即断，不再把
            # 后续块敲进裸壳连环刷 command not found + 新提示符（提示符墙）
            self.core._pad_inflight = True
            try:
                while remaining > 0 and not self.core._hook_gone:
                    n = min(50, remaining)
                    remaining -= n
                    self.core._ev_prompt.clear()
                    if hook or mirror is None or (first and mirror):
                        await self.core.session.send_raw(b"\x15")   # 收纳用户半行输入
                    # mirror == ""（hook 不在位）：半行为空，不收纳（\x15 会误杀
                    # 历史召回等残影）
                    await self.core.session.send_raw(f"__ot_pad {n}\r".encode())
                    if hook:
                        # 接回存档半行：shell 侧 ^Y 原语（存档非空才接回）
                        await self.core.session.send_raw(b"\x19")
                    first = False
                    # hook 不在位时不补 \x19（原生 yank 会把 kill ring 里刚提交
                    # 的自然语言行复活回提示符行，此后每块 pad 再 kill 再 yank，
                    # 死循环挂在输入行上——降级走 mirror 原样重打）
                    try:
                        await asyncio.wait_for(self.core._ev_prompt.wait(),
                                               self.core._pad_prompt_timeout)
                    except asyncio.TimeoutError:
                        pass
                if not hook and mirror:
                    # 复原收纳的半行：等价用户原样敲入（不发 \r，不触发执行）
                    await self.core.session.send_raw(mirror.encode())
            finally:
                self.core._pad_inflight = False
                # 残留半行是回显尾巴，随窗口收束丢弃（不留到下一轮 pad）
                self.core._pad_echo_carry = ""
        await self.core.emit_msg(ServerMsg(
            type="event", event={"kind": "padded", "rows": rows}))

    def _reinject_inst_base(self) -> int:
        """换壳重注入的实例号基址：每次重注入分配一个新的大号段。

        嵌套 shell（su - / ssh 跳板机）里的 hook 实例号从基址起算，与外层
        会话的帧号空间完全隔离——外层 hook 的用户命令帧（如第一条 `ssh
        跳板机` = inst 1）在嵌套会话存续期间始终开着，若嵌套 hook 也从 1
        起算，首个工具命令的 C/D 标记就会撞掉外层帧（误触救援、_hook_gone
        提前复位）。setup 连接注入仍从 1 起（彼时无任何帧，计数器即本会话）。"""
        self.core._reinject_seq = getattr(self.core, "_reinject_seq", 0) + 1
        return 100000 * self.core._reinject_seq

    def _arm_intr_swallow(self) -> None:
        self.core._intr_swallow_until = time.monotonic() + 1.0
        self.core._intr_pending = b""

    def _strip_intr_echo(self, data: bytes) -> bytes:
        """吞掉自动 \x03 后 readline 回显的 "^C" 两字节（真机 bash 讨中断时
        在用户已回显的半行尾补打 ^C——用户视角的「奇怪符号+c」）。

        只吞这两字节：随后的 \r\n 与提示符重画照常透传，光标被 \r\n 重新
        锚定，无失步。"^" 可跨块到达：悬置到下一块，非 C 开头或窗口过期
        时原样放回（不丢用户内容的字面 ^）。"""
        now = time.monotonic()
        if now >= self.core._intr_swallow_until:
            self.core._intr_swallow_until = 0.0
            pending, self.core._intr_pending = self.core._intr_pending, b""
            return pending + data
        if self.core._intr_pending:
            self.core._intr_pending = b""
            if data[:1] == b"C":
                self.core._intr_swallow_until = 0.0
                data = data[1:]
            else:
                return b"^" + data   # ^ 后面不是 C：非回显，原样放回
        idx = data.find(b"^C")
        if idx != -1:
            self.core._intr_swallow_until = 0.0
            return data[:idx] + data[idx + 2:]
        if data.endswith(b"^"):
            self.core._intr_pending = b"^"
            return data[:-1]
        return data


    async def _proactive_reinject(self) -> None:
        """嵌套 ssh 登录成功后后台补注入：把首条自然语言的探测+分片注入成本
        摊进登录后的空闲期（真机「等几秒才出分析卡」根因之一）。幂等：已在
        位的 hook 只重定义同名函数；与 submit 降级路径并发时由 _runner_lock
        串行。失败静默——首条 submit 仍会走降级自愈。

        空闲门闩：_ensure_integrated 前置 \\x15 会收纳半行——用户登录后已在
        目标提示符敲字时主动注入会销毁其输入。settle 后确认无 live 字节
        （readline 回显 = 半行在场的凭据）才动手。"""
        if not self.core._interactive or self.core.session is None or self.core._closed:
            return
        if self.core._cs_tail is not None:
            return   # 命令集在跑:它逐条过 _cs_hook_gate,主动注入只会并发
        await asyncio.sleep(0.6)
        if time.monotonic() - self.core._last_live_at < 0.4:
            return   # 目标提示符上有回显（用户敲字中）：放弃主动注入
        try:
            await self.core.hook._ensure_integrated()
        except Exception:  # noqa: BLE001 - 主动注入失败不阻断，submit 降级自愈
            pass

    async def _on_stream_event(self, ev: tuple) -> None:
        kind = ev[0]
        _dbg("ev", kind, "sup=", self.core._suppress_live,
             (ev[1][:60] if isinstance(ev[1], str) else ev[1:])
             if kind in ("live", "exec", "prompt") else ev[1:])
        if kind == "live":
            self.core._ev_stream.set()   # 回显到达：重注入分片的逐片应答凭据
            self.core.hook._note_hook_text()
            if self.core._pad_inflight and "__ot_pad: command not found" in ev[1]:
                # pad 行敲进了没有 hook 函数的壳：su - 换壳后嵌套壳的 PS1/
                # PROMPT_COMMAND 照发 OSC 标记，_hook_ok 靠标记流假阳性，
                # pad 循环于是把 __ot_pad 连环敲进裸壳 = 连环 command not
                # found + 新提示符（抑制窗吞掉回显与 \r\n，新提示符块在窗
                # 外迟到，落在上一条提示符的光标列上）= 横排提示符墙（真机
                # 101.33 su - 后截图）。当场判死：后续 pad 走 ack-only，健康
                # 路径转降级；重注入成功/嵌套壳退出照既有语义复位
                self.core._hook_gone = True
                _dbg("pad fingerprint: hook 函数不在位，判死转 ack-only")
            if self.core._pad_inflight:
                # 注入自身回显净化（见 _strip_pad_echo）：hook 掉线后注入落进
                # 裸壳时 `__ot_pad N` / `^Y` / `command not found` 不许外显。
                # 半行 carry：回显常被分片切开（`__ot_pad ` 与 `7\r\n` 两块），
                # 按块独立过滤会漏掉尾巴上的孤立 `7`。
                carry = getattr(self.core, "_pad_echo_carry", "")
                seg = _strip_pad_echo(carry + ev[1])
                keep = ""
                nl = max(seg.rfind("\n"), seg.rfind("\r"))
                if nl >= 0:
                    keep, seg = seg[nl + 1:], seg[: nl + 1]
                else:
                    keep, seg = seg, ""
                self.core._pad_echo_carry = keep
                ev = (ev[0], seg)
                if not seg:
                    return
            if self.core._probe_buf is not None:
                # live 的 ev[1] 是 str（本分支末尾 emit 前也要 .encode），
                # bytearray.extend(str) 抛 TypeError 当场打死泵任务；而任务
                # 引用被 self.core._pump 持有，asyncio 连「未取回异常」都不打印
                # ——真机表现为终端彻底沉默（无回显、无输出、无 closed 帧）。
                # 触发条件恰是裸壳：探测行的回显是纯文本 → 走 live（集成壳
                # 里走 silent exec 帧，所以这条路径平时无声无息）。
                self.core._probe_buf.extend(ev[1].encode("utf-8", "replace"))
            if self.core._suppress_live:
                # 注入窗内一律吞（§5.5）：注入行回显与 shell 提示符重绘都
                # 不外显。判定顺序必须先于 _curtain——窗内 prompt_start 会
                # 关帘，提示符段若进帘，下一次 send_raw（闸）就把它成排放
                # 行 = 横排提示符墙。提示符文本另记在 _suppressed_tail：窗
                # 末按 shell 真实状态重画（有没有 OSC 标记都成立）。
                self.core._suppressed_echo = True
                _seg = _ansi_free(ev[1])
                _nl = max(_seg.rfind('\n'), _seg.rfind('\r'))
                self.core._suppressed_tail = _seg[_nl + 1:] if _nl >= 0 \
                    else self.core._suppressed_tail + _seg
            elif self.core._curtain:
                # 幕帘扣留：live 文本（提示符段及后续杂散回显）按序暂存，
                # 下一次注入（闸）或任务收尾才放行
                self.core._curtain_parts.append(ev[1])
                if time.monotonic() - self.core._curtain_at > 600.0:
                    await self._curtain_open()   # 防呆：扣满 10 分钟强制放行
            else:
                self.core._last_live_at = time.monotonic()
                await self.core.emit_bytes(ev[1].encode("utf-8", "replace"))
        elif kind == "exec":
            self.core._ev_stream.set()
            self.core.hook._note_hook_text()
            if self.core._probe_buf is not None:
                self.core._probe_buf.extend(ev[1].encode("utf-8", "replace"))
            await self._on_exec_text(ev[1])
        elif kind == "prompt_start":
            self.core._ev_prompt.set()   # 模式切换等提示符重画
            self.core.hook._note_hook_mark()
            # 任务运行期关帘：这段提示符重绘扣住不发——前端流式卡期间底部
            # 不出现空提示符（用户诉求：对话完全结束才显示命令提示符）
            self._curtain_close()
        elif kind == "prompt":
            self.core._cur_prompt = ev[1]
            self.core.hook._note_hook_mark()
        elif kind == "report":
            self.core.hook._note_hook_mark()
            inst, k, line = ev[1], ev[2], ev[3]
            if k == "AI":
                # 外部触发链健康路径：本行是补发 \r 后 hook 的原地蓝色重绘上报
                # ——上报即任务触发（与英文自然语言同一条 proven 路径）。
                # _suppress_ai_report：兜底已按同文启动任务，迟到上报吞掉防双跑
                if self.core._suppress_ai_report is not None and \
                        line.strip() == self.core._suppress_ai_report:
                    self.core._suppress_ai_report = None
                else:
                    if self.core._hook_report_pending is not None and \
                            line.strip() == self.core._hook_report_pending:
                        self.core._hook_report_pending = None
                    # hooked=True：hook 上报即 hook 在位的凭据，任务启动
                    # 跳过重注入——其吞窗口会吃掉在途的蓝色重绘字节
                    # （真机「提交行消失」根因：stty 快照后重绘慢几 ms 落进窗口）
                    await self.core.ai._on_ai_line(line, hooked=True)
            else:
                # hook 把这行分类成了命令（CMD/EXEC）并会就地执行：清掉等 AI
                # 上报的兜底挂起，否则 _submit_fallback 会在 1.2s 后对同一行
                # \x03 + 重注入 + 强起 AI 任务（真机：hook 已报 command not
                # found，随后 ^C 残行 + 提示符连排）
                if self.core._hook_report_pending is not None and \
                        line.strip() == self.core._hook_report_pending:
                    self.core._hook_report_pending = None
                self.core._pending_report = (inst, k, line)
        elif kind == "exec_start":
            self.core.hook._note_hook_mark()
            await self._on_exec_start(ev[1])
        elif kind == "exec_end":
            self.core.hook._note_hook_mark()
            await self._on_exec_end(ev[1], ev[2], ev[3])

    async def _on_exec_start(self, inst: int) -> None:
        """C 标记：AI/探测/静默注入开帧；用户命令不进栈，仅记账。"""
        rep = self.core._pending_report
        self.core._pending_report = None
        kind, line = (rep[1], rep[2]) if rep else ("", "")
        if kind != "EXEC":
            if is_internal_line(line):
                # 注入分片装配 / eval 解包：静默开帧。两条症状的共同来源——
                # ①每片 __ot_run 的 C 标记各补一个 \r\n → 任务启动连打空行；
                # ②重注入 export -f 报错走无帧 exec 直通前端。internal 行不补
                # 收束换行、输出全吞（__ot_exec__ 恒走 EXEC 分支，不受影响）
                top = self.core._exec_stack[-1] if self.core._exec_stack else None
                if top is not None and top.get("inj"):
                    # 注入行串行执行：上一条内部行的 D 丢了（换壳 / 分片被打断）
                    # 就别让它压在栈里——inj 帧泄漏 = 此后所有 exec 字节被当静默
                    # 输出吞掉（真机：命令输出与提示符全不上屏，只剩 live 回显）
                    _dbg("exec_start: 丢弃未闭合注入帧", top["inst"], "->", inst)
                    self.core._exec_stack.pop()
                self.core._exec_stack.append(
                    {"ctx": "silent", "line": line, "inst": inst, "inj": True})
                return
            # 用户命令（CMD 报告或无报告）：显示全靠 PTY 原样字节，这里只
            # 记账（transcript 在 exec_end 带退出码记一次，避免重复）
            self.core._open_cmds[inst] = line
            self.core._open_cmd_at[inst] = time.monotonic()
            self.core._nested_pw_attempts = 0   # 新命令帧：嵌套密码自动填充资格重置
            self.core._user_out = bytearray()   # 救援上下文从本条命令输出起算
            if line:
                self.core._record_history("user", line)
            await self._close_suppressed_line()
            return
        if self.core._hidden_exec:
            ctx = "probe"
        else:
            ctx = "agent" if self.core._exec_future is not None else "silent"
        _dbg("exec_start inst=", inst, "ctx=", ctx, "line=", line[:60],
             "fut=", self.core._exec_future is not None)
        self.core._exec_stack.append({"ctx": ctx, "line": line, "inst": inst})
        await self._close_suppressed_line()
        if ctx == "agent":
            # AI 工具命令真正开始执行：此刻登记命令与首个收束事件——保证
            # ai_collapse 与输出按真实执行顺序交错（多命令并发发起时同理）
            #
            # 命令身份以 **C 标记上报的 line 为准**，登记队列只兜底：并行
            # tool_call 时 on_start 全部先到（登记序 = 宣告序），真实执行序却是
            # InteractiveRunner._runner_lock 的抢锁序，两者会错位——盲目 popleft
            # 会把 ai_collapse / 输出归属记到别的命令头上（真机「四张卡一条
            # 输出」同族）。命中队列里的同名登记就地销账，否则退化取队首。
            # 命令身份取**登记串**（= 卡片上那条 $ 命令），上报串只用来认领
            # 「这是哪一条」：并行 tool_call 时 on_start 全部先到（登记序 =
            # 宣告序），真实执行序却是抢锁序，盲目取队首会把归属记到别的命令
            # 头上（真机「四张卡只看得见一条输出」同族）。上报串是包装行而
            # 对不上登记时退回队首——认不出就不改判，只保证不空转。
            if line in self.core._pending_agent_cmds:
                self.core._pending_agent_cmds.remove(line)
                cmd = line
            elif self.core._pending_agent_cmds:
                cmd = self.core._pending_agent_cmds.popleft()
            else:
                cmd = line
            self.core._agent_open_cmd = cmd
            self.core._record_history("agent", cmd)
            self.core._exec_stack[-1]["cmd"] = cmd
            # 输出归属括号（开）：前端据此把这条命令的输出切块挂到它的卡下。
            # execute 工具本就依赖 hook 通道（_hook_channel_ready 挂了直接
            # CHANNEL_DEAD_MSG），所以 C/D 标记在 execute 期间必然在位——
            # 不违反 P1「布局不得依赖 shell 集成」。
            # 回显行一并带过去：它由 hook 画成 `提示符 + 空格 + 命令`，随后
            # Readline 一句「上移一格+擦行」会随机啃掉它。让前端去读 xterm 缓冲
            # 是竞态（write 异步解析），这里按 `_cur_prompt`（B 标记捕获）拼出来
            # 是确定的，前端丢没丢都能补上。
            echo = ""
            if self.core._cur_prompt and cmd:
                echo = self.core._cur_prompt.rstrip() + " " + cmd
            await self.core.emit_msg(ServerMsg(
                type="event",
                event={"kind": "term_open", "command": cmd, "echo": echo}))
            if not self.core._task_cmd_started:
                self.core._task_cmd_started = True
                await self.core.emit_msg(ServerMsg(
                    type="event",
                    event={"kind": "ai_collapse", "command": cmd}))

    @staticmethod
    def _disp_width(s: str) -> int:
        """终端显示列宽：CJK/全角按 2 列（与 hook __ot_repaint 同式：
        字符数 + UTF-8 额外字节/2）。"""
        by = len(s.encode("utf-8", "replace"))
        return len(s) + (by - len(s)) // 2

    async def _repaint_line(self, text: str | None, echoed: bool = True) -> None:
        """降级/直通路径补画 hook 的 __ot_repaint "$t" 33 观感。

        hook 不在位时重绘不会自己发生（函数已随 su - 丢掉），由 worker 侧
        画同样的三段：提示符原样保留 + 蓝 38;5;33 原文 + 换行。提示符不必
        在 worker 侧重建 [u@h cwd]#——光标退回半行行首（提示符右侧 N 显示
        列处）再清到行尾即可，屏幕上那个提示符就是 shell 自己画的。

        两种落笔法，按手头有没有提示符原文分：
        - 有（抑制窗里捕获到 shell 刚画的提示符段）：整行重建，与
          __ot_repaint 逐字同形，长行折行也对；
        - 没有：光标退回已回显原文的行首，**只清到行尾**（\x1b[K，不是
          \x1b[2K——后者会把提示符一并擦掉），屏幕上 shell 自己画的提示
          符原样保留。echoed=False（typed=False 回放 / 兜底 ^C 后的新提示
          符行）时该行本就只有提示符，直接在行尾接上原文。
        """
        tail, self.core._suppressed_tail = self.core._suppressed_tail, ''
        self.core._suppressed_echo = False
        if not text:
            return
        body = "\x1b[38;5;33m" + text + "\x1b[0m\n"
        if tail:
            seq = "\r\x1b[2K" + tail + body
        elif echoed:
            back = self._disp_width(text)
            seq = (f"\x1b[{back}D" if back else "") + "\x1b[K" + body
        else:
            seq = "\x1b[K" + body
        await self.core.emit_bytes(seq.encode("utf-8", "replace"))

    async def _resync_after_suppress(self) -> None:
        """注入抑制窗收束：把 xterm 的光标与行内容对齐回 shell 真实状态。

        窗内吞掉的字节（注入行回显 + 换行 + shell 新画的提示符）在 xterm
        上等于什么都没发生，光标还停在开窗前那行的行尾——后续字节直接放
        行会落在那个列上叠成横排提示符墙。窗末 \r+清行回到行首，重画被
        吞掉的提示符段；幕帘关着就并进扣留（任务期不冒空提示符，收尾才
        放行），与 hook 在位时「重绘行 + 空提示符被幕帘扣住」的观感一致。
        """
        tail, self.core._suppressed_tail = self.core._suppressed_tail, ''
        repaint, self.core._repaint_text = self.core._repaint_text, None
        swallowed, self.core._suppressed_echo = self.core._suppressed_echo, False
        if repaint is not None:
            await self._repaint_line(repaint, echoed=True)
            return
        if not swallowed:
            return
        chunk = "\r\x1b[2K" + (tail or self.core._cur_prompt)
        if self.core._curtain:
            self.core._curtain_parts.append(chunk)
        else:
            await self.core.emit_bytes(chunk.encode("utf-8", "replace"))

    async def _close_suppressed_line(self) -> None:
        """注入窗口吞过回显时补一个换行收束提示符行（§5.5）：前端看不到
        被吞的注入行，不补换行的话命令输出会接在提示符同一行。"""
        if self.core._suppressed_echo:
            self.core._suppressed_echo = False
            await self.core.emit_bytes(b"\r\n")

    async def _on_exec_text(self, text: str) -> None:
        frame = self.core._exec_stack[-1] if self.core._exec_stack else None
        ctx = frame["ctx"] if frame else None
        if ctx in ("agent", "probe"):
            # 捕获进 _exec_buf：exec_end 用它组装 run() 的返回值
            raw = text.encode("utf-8", "replace")
            limit = self.core.cfg.shell.max_output_bytes
            if len(self.core._exec_buf) < limit:
                room = limit - len(self.core._exec_buf)
                self.core._exec_buf.extend(raw[:room])
                if len(raw) > room:
                    self.core._exec_truncated = True
            else:
                self.core._exec_truncated = True
            if ctx == "agent":
                await self.core.emit_bytes(raw)   # 输出直写主 xterm（§5.3）
            # probe：只捕获不转发（隐藏探测无前端副作用）
        elif ctx == "silent":
            pass    # 模式开关注入：吞掉（无显示）
        else:
            # 用户命令输出（无帧）：直通前端；抑制窗口内（su - 后重注入、C 帧
            # 未闭）这段 exec 字节是分片回显/eval 杂行——base64 墙，一并吞掉
            if self.core._suppress_live:
                return
            # 救援上下文：尾部截断保留（4KB 足够 AI 判定失败原因）
            self.core._user_out.extend(text.encode("utf-8", "replace"))
            if len(self.core._user_out) > 8192:
                del self.core._user_out[: len(self.core._user_out) - 4096]
            await self.core.emit_bytes(text.encode("utf-8", "replace"))

    async def _on_exec_end(self, inst: int, ec, cwd) -> None:
        _dbg("exec_end inst=", inst, "ec=", ec, "stack=",
             [(f["ctx"], f["inst"]) for f in self.core._exec_stack])
        self.core._ev_exec_end.set()
        if cwd and self.core._runner is not None:
            self.core._runner.cwd = cwd
        if inst in self.core._open_cmds:
            line = self.core._open_cmds.pop(inst)
            self.core._open_cmd_at.pop(inst, None)
            if line:
                self.core.transcript.append("direct", command=line, exit_code=ec)
            if not self.core._open_cmds:
                # 嵌套 shell（su - 等）退出：外层 hook 的标记/函数从未丢过，
                # 复位换壳判定，健康路径/pad 恢复
                self.core._hook_gone = False
                self.core._hook_stale = False
            await self.core.ai._maybe_rescue(line, ec)
        if not self.core._exec_stack:
            return    # 孤儿 D：无帧的执行周期，忽略
        top = self.core._exec_stack[-1]
        if inst != top["inst"]:
            if top.get("inj"):
                # 注入 eval 行的 C 标记带旧实例号、它自己的 D 带新实例号（eval
                # 刚把 __ot_i 改写成新基址）。按「旧实例的 D」一律忽略，这个
                # silent 帧就永不闭合，此后每条 exec 字节都被当静默帧输出吞掉
                # ——真机表现：命令集/换壳后密码提示、Last login、提示符全不
                # 上屏，只剩 live 回显；缺了 exec 里的换行，后续重绘还会把
                # 历史逐条砸在同一行上（屏幕塌成两三行）。跨实例收束这一帧。
                self.core._exec_stack.pop()
                _dbg("exec_end: 跨实例收束注入帧", top["inst"], "->", inst)
            return    # 旧实例的 D：忽略（注入帧已跨实例收束）
        frame = self.core._exec_stack.pop()
        if frame["ctx"] in ("agent", "probe"):
            fut = self.core._exec_future
            if fut is not None and not fut.done():
                fut.set_result(CommandResult(
                    output=bytes(self.core._exec_buf).decode("utf-8", "replace"),
                    exit_code=ec if ec is not None else 0,
                    truncated=self.core._exec_truncated,
                    cwd=cwd or (self.core._runner.cwd if self.core._runner else "")))
            # 立即恢复 live：D 之后的提示符重画字节不能被抑制窗口吞掉
            self.core._suppress_live = False
            self.core._suppressed_echo = False
            self.core._suppressed_tail = ""
            if frame["ctx"] == "agent":
                # 输出归属括号（闭）：这条命令的输出到此为止，前端据此切块归位
                await self.core.emit_msg(ServerMsg(
                    type="event",
                    event={"kind": "term_close",
                           "command": frame.get("cmd") or frame.get("line") or ""}))
                if self.core._agent_open_cmd is not None:
                    self.core._agent_open_cmd = None   # 输出块已自然收束于主 xterm

    # --- 失败救援（reactive）---

    # --- 组件公开接口绑定 ---
    feed_output = _on_exec_text
    on_stream_event = _on_stream_event
    on_exec_start = _on_exec_start
    on_exec_end = _on_exec_end
    shell_pad = _shell_pad
    strip_intr_echo = _strip_intr_echo

    @property
    def open_cmds(self) -> dict[int, str]:
        """用户命令帧记账（NestedSshTracker 等经 core._open_cmds 读）。"""
        return self.core._open_cmds
