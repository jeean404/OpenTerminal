"""密码全链路状态机（Task 3 自 PipelineCore 原样搬入）。

密码提示符检测 → 模态代关 → 验证窗 hold/释放 → 手输捕获 →「记住」询问
→ 凭据库写入，整条链的判定与定时器都在本组件。状态**物理存 core 实例**
（P3 裁定：pump/命令集/_on_keys 直读 core._pw_*，_bare_core 测试在 core
上预置状态；AuthFlow.__init__ 以 hasattr 守卫补建，预置值不覆盖），
方法体经 self.core 读写。monkeypatch 缝隙（store_password/load_password/
别名读取）经 _impl 模块属性运行期解析——对 openterminal.core 的补丁经
补丁桥落到 _core_impl，这里调用时才取值。

组件公开接口：inspect_output（泵责任链②）、feed_input（按键 hold/捕获）、
armed（提示符触发门槛）、ask_password / store_auth_password（认证回调）。
"""

from __future__ import annotations

import asyncio
import re
import time

from .. import _core_impl as _impl
from ..shell_integration import is_internal_line
from ..shell_session import _PASSWORD_PROMPT_RE, _needs_password_prompt
from .messages import PasswordCancelled, ServerMsg, _dbg


class AuthFlow:
    def __init__(self, core) -> None:
        self.core = core
        # 嵌套密码提示符状态机：ssh/sudo/scp/rsync 在 PTY 前台讨密码时
        # （典型：预置命令 `ssh 跳板机` 后的登录），①自然语言拦截链必须
        # 透传回车（密码被误判成自然语言 = 登录被 ^C 掉）；②可弹模态收
        # 密码并按目标主机写入凭据库，下次自动填充
        for name, val in (
            ("_pw_cancelled", False),      # 内联密码输入的 Ctrl+C 标记
            ("_pw_last_entered", None),    # 内联手输密码留档（password auth）
            ("_pw_tail", bytearray()),     # 输出滚动尾窗（提示符匹配）
            ("_pw_prompt_seen", False),    # 尾窗以密码提示符结尾（已触发应答）
            ("_nested_pw_attempts", 0),    # 当前嵌套命令已应答次数（0 允许自动填充）
            ("_nested_pw_ctx", None),      # 当前应答的凭据键 (host, user, port)
            ("_pw_verifying", False),      # 验证窗口：密码已打进 PTY、结果未到
            ("_pw_verify_at", 0.0),
            ("_pw_verify_timer", None),    # 验证窗口强制到期(不依赖输出驱动)
            ("_pw_hold", []),              # hold 项 ("raw", bytes)/("submit", t, dirty)
            ("_pw_hold_timer", None),      # hold 释放防抖任务（_PW_HOLD_RELEASE）
            ("_pw_at_end", False),         # 上一 pump 块尾窗是否以密码提示符结尾
            ("_pw_modal_open", False),     # 嵌套密码模态在屏等应答
            ("_pw_dismiss_timer", None),   # 模态代关防抖任务（_PW_MODAL_DISMISS）
            ("_pw_capture_key", None),     # 手输捕获的凭据键（sudo@<主机> 专用键）
            ("_pw_typed", bytearray()),    # 捕获中的密码字节（回车即冻结）
            ("_pw_remember_candidate", None),  # 已提交待验证的 (键, 密码)
            ("_pw_remember_pending", None),    # 验证成功待用户应答的 (键, 密码)
            ("_pw_result_from", 0),        # 验证窗起点在 _pw_tail 的偏移
        ):
            if not hasattr(core, name):
                setattr(core, name, val)

    # --- 责任链入口 ---

    def inspect_output(self, data: bytes) -> bytes:
        """泵责任链阶段②入口：检测提示符/模态代关/验证窗判定。
        只观测不改字节，透传返回。"""
        self._detect_password_prompt(data)
        return data

    def feed_input(self, data: bytes) -> bool:
        """键盘字节经手输密码旁路留档；验证窗内且非捕获态时 hold 抢跑输入。

        返回 True 表示本字节已被拦（core._on_keys 不再透传 PTY）。
        capturing 必须取**进块前**快照：块内回车会冻结候选并开启验证窗，
        若按事后状态判 hold，密码自己就被 hold 住发不出去。"""
        capturing = self.core._pw_capture_key is not None
        self._pw_typed_capture(data)
        if self.core._pw_verifying and not capturing:
            # 验证窗口（密码已提交、auth 结果未到）：按键 hold，验证结束
            # 依序释放——否则落进 ssh 输入队列被当下一条密码吃掉（真机
            # 「模态刚关抢跑的命令连排 Permission denied」根因）。
            # 例外：密码提示符又在前台（错密重讨、捕获已武装）——按键
            # 是给提示符的应答，hold 会让重试到超时才迟到远端
            self.core._pw_hold.append(("raw", data))
            return True
        return False

    def _detect_password_prompt(self, data: bytes) -> None:
        """在输出滚动尾窗上做密码提示符检测（每 pump 块一次）。

        触发条件足够收敛，避免命令输出里的字面 "password:" 误触：
        ① 尾窗**结尾**（±4 字符容差）命中 _PASSWORD_PROMPT_RE——讨密码时
        提示符就是屏幕上最后的东西；提示符被后续输出冲走即重新武装；
        ② 当前最内层未闭合的用户命令帧是 ssh/sudo/scp/rsync 类（
        _needs_password_prompt）——grep 密码文件等输出再像也不触发。
        上升沿触发一次应答：优先凭据库自动填充（每条命令只试一次），
        失败或无凭据弹 ask_password 模态。结尾判定取**最后一个**匹配：
        首次应答后旧提示符仍躺在尾窗里，search 首匹配会让 at_end 恒 False
        ——ssh 输错重讨（deny+prompt 常被隧道合包成一块）时上升沿永不复现、
        模态不再弹（真机根因）。模态在屏等应答期间尾窗不再以提示符结尾
        （提示符被终端手输消费）时防抖代关陈旧模态（_pw_dismiss_release）。"""
        self.core._pw_tail.extend(data)
        if len(self.core._pw_tail) > 4096:
            del self.core._pw_tail[:-2048]
        tail = bytes(self.core._pw_tail)
        last = None
        for m in _PASSWORD_PROMPT_RE.finditer(tail):
            last = m
        at_end = last is not None and last.end() >= len(tail) - 4
        self.core._pw_at_end = at_end
        if self.core._pw_modal_open:
            if at_end:
                self._cancel_pw_dismiss()   # 重讨：模态仍有用，保住
            else:
                self._schedule_pw_dismiss()
        if self.core._pw_hold:
            if at_end:
                self._cancel_pw_hold_release()   # 重新讨密码：继续 hold
            else:
                self._schedule_pw_hold_release()
        if self.core._pw_verifying and (
                not at_end
                or time.monotonic() - self.core._pw_verify_at > _impl._PW_VERIFY_TIMEOUT):
            self._end_pw_verify()   # auth 结果已出（或超时）：不再 hold 新输入
            if not at_end:
                self._pw_auth_result()   # 成败分流：验证通过才排「记住」询问
            if not at_end and self.core.nested.innermost_ssh_frame() is not None:
                # 嵌套 ssh 登录成功：后台主动注入 hook——首条自然语言到达时
                # hook 已在位走健康路径，免当场探测+分片注入的秒级代价
                asyncio.get_running_loop().create_task(self.core._proactive_reinject())
        if not at_end:
            self.core._pw_prompt_seen = False
            if self.core._pw_capture_key is not None:
                # 提示符被冲走/中止（Ctrl+C 等）：半截口令作废不进库
                self.core._pw_capture_key = None
                self.core._pw_typed = bytearray()
            return
        if self.core._pw_prompt_seen or self.core.session is None:
            return
        if not self.armed:
            return
        self.core._pw_prompt_seen = True
        asyncio.get_running_loop().create_task(self._on_nested_password_prompt())

    # --- 验证窗口输入 hold 与释放 ---

    def _begin_pw_verify(self) -> None:
        """密码打进 PTY：进入验证窗口（_on_keys/_on_frontend_line 开始 hold）。

        同时复位 _pw_prompt_seen：本提示符已应答，ssh 重讨时上升沿必须复现
        模态（否则 deny+prompt 合包到达时会被 seen 闸挡住）。"""
        self.core._pw_prompt_seen = False
        self.core._pw_verifying = True
        self.core._pw_verify_at = time.monotonic()
        self.core._pw_result_from = len(self.core._pw_tail)   # 失败指纹的查询起点
        self._schedule_pw_verify_expiry()

    def _end_pw_verify(self) -> None:
        """退出验证窗口并撤销强制到期定时器。"""
        self.core._pw_verifying = False
        t = getattr(self.core, "_pw_verify_timer", None)
        if t is not None:
            t.cancel()
            self.core._pw_verify_timer = None

    def _schedule_pw_verify_expiry(self) -> None:
        t = getattr(self.core, "_pw_verify_timer", None)
        if t is not None:
            t.cancel()
        self.core._pw_verify_timer = asyncio.get_running_loop().create_task(
            self._pw_verify_expiry())

    async def _pw_verify_expiry(self) -> None:
        """验证窗口强制到期：输出驱动的超时判定在 shell 无输出时永远跑不到
        （_detect_password_prompt 只在 pump 收到字节时被调用），验证窗口就此
        永久开启、前端输入被永久 hold（真机「终端命令行无法输入任何文字」）。
        这里用独立定时器兜底：到点即放行，已 hold 的输入依序释放。"""
        try:
            await asyncio.sleep(_impl._PW_VERIFY_TIMEOUT)
        except asyncio.CancelledError:
            raise
        finally:
            self.core._pw_verify_timer = None
        if not self.core._pw_verifying:
            return
        self.core._pw_verifying = False
        self.core._pw_remember_candidate = None   # 未见 auth 结果：不算验证通过
        _dbg("pw verify expiry -> release hold", len(self.core._pw_hold))
        if self.core._pw_hold:
            self._schedule_pw_hold_release()

    def _schedule_pw_hold_release(self) -> None:
        if self.core._pw_hold_timer is None:
            self.core._pw_hold_timer = asyncio.get_running_loop().create_task(
                self._pw_hold_release())

    def _cancel_pw_hold_release(self) -> None:
        if self.core._pw_hold_timer is not None:
            self.core._pw_hold_timer.cancel()
            self.core._pw_hold_timer = None

    async def _pw_hold_release(self) -> None:
        """hold 释放防抖：不以提示符结尾的 auth 结果输出（登录成功 / ssh 退出）
        稍等才释放——隧道合包可能把 deny 与重讨提示符拆成两块到达，即放会
        把抢跑命令打进新密码位。"""
        try:
            await asyncio.sleep(_impl._PW_HOLD_RELEASE)
        except asyncio.CancelledError:
            raise
        finally:
            self.core._pw_hold_timer = None
        if not self.core._pw_hold or self.core._pw_at_end:
            return
        await self._flush_pw_hold()

    async def _flush_pw_hold(self) -> None:
        """验证结束：按原序释放 hold 的输入——抢跑命令落在登录后的 shell 上
        （用户预期「连接后命令」）；自然语言行按「尚未键入」重走 submit 链
        （字符当时被 hold，不在 shell buffer 里）。"""
        hold, self.core._pw_hold = self.core._pw_hold, []
        for item in hold:
            if self.core.session is None:
                return
            if item[0] == "raw":
                await self.core.session.send_raw(item[1])
            else:
                await self.core._on_frontend_line(item[1], item[2], typed=False)

    # --- 陈旧密码模态代关 ---

    def _schedule_pw_dismiss(self) -> None:
        if self.core._pw_dismiss_timer is None:
            self.core._pw_dismiss_timer = asyncio.get_running_loop().create_task(
                self._pw_dismiss_release())

    def _cancel_pw_dismiss(self) -> None:
        if self.core._pw_dismiss_timer is not None:
            self.core._pw_dismiss_timer.cancel()
            self.core._pw_dismiss_timer = None

    async def _pw_dismiss_release(self) -> None:
        """模态代关防抖：密码提示符被终端手输消费（登录横幅/目标提示符把提示
        符冲出尾窗结尾）时模态没有自己的关闭路径——不代关则用户登录成功后
        仍面对讨密码的陈旧模态（真机：ssh 早已成功、模态悬在 root 提示符上）。
        防抖一拍：期间重讨（at_end 回 True）取消代关、模态继续等应答。"""
        try:
            await asyncio.sleep(_impl._PW_MODAL_DISMISS)
        except asyncio.CancelledError:
            raise
        finally:
            self.core._pw_dismiss_timer = None
        if not self.core._pw_modal_open or self.core._pw_at_end or self.core._closed:
            return
        self.core._pw_modal_open = False
        await self.core.emit_msg(ServerMsg(type="ask_password_dismiss"))

    def _pw_prompt_host(self) -> tuple[str | None, str | None]:
        """从尾窗的密码提示符行里提取 OpenSSH 自带的 user@host。

        OpenSSH 两种提示格式：``(user@host) Password:``（新版）与
        ``user@host's password:``（旧版）。提示符自带主机 = 凭据归属的
        最强凭据（sudo 在嵌套会话内讨密码时不会错用外层 ssh 主机的
        凭据）；无主机信息返回 (None, None)。"""
        m = re.search(
            rb"\(([^()\r\n@]+)@([^()\r\n@]+)\)\s*password"
            rb"|([^\s@)\r\n]+)@([^\s@)\r\n']+)'s password",
            bytes(self.core._pw_tail), re.IGNORECASE)
        if m is None:
            return None, None
        user = (m.group(1) or m.group(3) or b"").decode("utf-8", "replace")
        host = (m.group(2) or m.group(4) or b"").decode("utf-8", "replace")
        return (host or None), (user or None)

    @property
    def armed(self) -> bool:
        """最内层未闭合用户命令是否 ssh/sudo 类（提示符检测的触发门槛）。

        三条路径覆盖三种命令执行方式：
        ① _exec_stack——AI/探测的 EXEC 帧（C/D 标记驱动）；
        ② _open_cmds——用户手敲命令的记账帧（C/D 标记驱动）；
        ③ _cs_pw_pending——命令集 _cs_command 直发 PTY 的密码类命令
          （不走 C/D 标记，前两条路都看不到；真机：跳板命令集
          `ssh pe@目标` 后密码提示自动填充被 _pw_armed 拦死）。"""
        for frame in reversed(self.core._exec_stack):
            line = frame.get("line") or ""
            if line and not is_internal_line(line):
                return _needs_password_prompt(line)
        for line in reversed(list(self.core._open_cmds.values())):
            return _needs_password_prompt(line)
        return bool(getattr(self.core, "_cs_pw_pending", False))

    @staticmethod
    def _load_nested_password(host: str, user: str | None,
                              port: int | None) -> str | None:
        """嵌套凭据读取：无端口与 ssh 默认端口 22 视同同一键。

        凭据键 display_name 在端口非空时附 :port——记住的连接档案流按
        target.port=22 存 ``user@host:22``，嵌套 ssh 命令无 -p 解析出
        port=None 查 ``user@host``：同一密码两个键、自动填充永远 miss
        （真机：档案登录成功过、嵌套 ssh 仍弹窗重讨）。两键互为别名，
        已落在任一键下的旧条目都读得到。规范实现在
        secrets_store.load_password_alias（首跳 _connect 共用）。"""
        return _impl.load_password_alias(host, user, port)

    async def _on_nested_password_prompt(self) -> None:
        """密码提示符上升沿：凭据库自动填充一次，否则交给终端手输。

        凭据键优先取提示符自带的 user@host（_pw_prompt_host，归属最强）；
        提示符无主机信息时回退最内层 ssh 帧解析（_nested_ssh_target）；
        双双落空 = sudo/su 类无主机提示符 → sudo@<主机> 专用键
        （_sudo_pw_key，P1-3）。自动填充每条命令只试一次：密码错误时 ssh
        会重新讨，第二次起不再静默代答，避免凭据过期时连环静默失败。
        **无凭据不弹模态**——提示符本来就在终端里（真实 ssh/sudo 行为），
        用户直接手输；旧实现弹窗代答，手输消费提示符后模态被防抖代关，
        表现为弹框一闪而过（真机 2026-10-08）。手输的密码经捕获留档
        （_arm_typed_capture），验证成功后弹一次「记住」询问（P1-3/P1-4）。"""
        if self.core._closed or self.core.session is None:
            return
        attempt = self.core._nested_pw_attempts
        self.core._nested_pw_attempts += 1
        host, user, port = (None, None, None)
        phost, puser = self._pw_prompt_host()
        if phost is not None:
            host, user = phost, puser
            thost, tuser, tport = self.core.nested.nested_ssh_target()
            if thost == host:   # 提示符主机与命令一致：补全端口
                port, user = tport, (tuser or user)
        else:
            host, user, port = self.core.nested.nested_ssh_target()
        key = (host, user, port) if host is not None else self.core.nested.sudo_pw_key()
        self.core._nested_pw_ctx = key
        if key is not None and key[0] and attempt == 0:
            pw = self._load_nested_password(key[0], key[1], key[2])
            if pw:
                await self.core.session.send_raw(pw.encode() + b"\r")
                self._begin_pw_verify()
                self.core._pw_remember_candidate = None   # 凭据库已有，无需询问
                await self.core.emit_msg(ServerMsg(
                    type="status",
                    text=f"已用记住的密码自动填充 {_impl.display_name(*key)}"))
                return
        # 无凭据/自动填充未命中：武装手输捕获——用户在终端手输密码（提示符
        # 已可见），验证成功后询问一次「记住」（P1-3 sudo/su 键 + P1-4 嵌套
        # ssh 键）。模态代答路径（_on_nested_password）保留但不再触发。
        self._arm_typed_capture(key)

    async def _on_nested_password(self, pw: str, remember: bool) -> None:
        """模态提交的嵌套密码：整行打进 PTY（远端 echo 关闭，不回显）。"""
        self.core._pw_modal_open = False
        self._cancel_pw_dismiss()
        # 模态接管：手输捕获与旧候选作废（密码来源是弹窗，记忆只走勾选）
        self.core._pw_capture_key = None
        self.core._pw_typed = bytearray()
        self.core._pw_remember_candidate = None
        if self.core.session is not None and pw:
            await self.core.session.send_raw(pw.encode() + b"\r")
            self._begin_pw_verify()
        if remember:
            host, user, port = self.core._nested_pw_ctx or (None, None, None)
            if host is not None:
                try:
                    _impl.store_password(host, user, port, pw)
                except Exception:
                    pass    # 凭据库缺席不阻断本次登录

    # --- 手输密码捕获与「记住」询问（P1-3/P1-4）---

    def _arm_typed_capture(self, key) -> None:
        """无凭据/填充未命中：武装手输捕获——用户在终端打出的密码留档候选。

        key=None（「记住」没有可靠的键）不捕获不询问。重新武装时旧候选
        作废：错密/中途放弃的密码不进库（只落本次验证通过的）。"""
        self.core._pw_typed = bytearray()
        self.core._pw_remember_candidate = None
        self.core._pw_capture_key = key

    def _pw_typed_capture(self, data: bytes) -> None:
        """手输密码旁路留档（前端 _pwFeed 同规则的后端版）：只记录，按键
        照常走原路（透传/hold）——提示符在终端里，密码必须照达远端。

        可打印字节进缓冲；退格删末字符（按 UTF-8 字符）；ESC 序列整体
        跳过（方向键等不是口令）；\\r/\\n 冻结候选并进验证窗口。"""
        if self.core._pw_capture_key is None:
            return
        buf = self.core._pw_typed
        i = 0
        while i < len(data):
            b = data[i]
            if b in (0x0D, 0x0A):
                self._pw_capture_submit()
                return   # 回车后的字节不属于本次口令（粘贴尾巴丢弃）
            if b == 0x1B:
                # CSI（ESC [ … 终字节）/ SS3（ESC O x）整体跳过
                if i + 1 < len(data) and data[i + 1] in (ord("["), ord("O")):
                    i += 2
                    while i < len(data) and not 0x40 <= data[i] <= 0x7E:
                        i += 1
                    i += 1
                else:
                    i += 2
                continue
            if b in (0x7F, 0x08):
                while buf:
                    c = buf.pop()
                    if (c & 0xC0) != 0x80:
                        break   # 删掉末字符（含其 UTF-8 续字节）
                i += 1
                continue
            if b >= 0x20:
                buf.append(b)
            i += 1

    def _pw_capture_submit(self) -> None:
        """捕获的密码随回车提交：冻结候选并进验证窗口（等 auth 结果）。

        与模态路径 _on_nested_password 同语义：提交即 hold 抢跑输入、
        复位提示符 seen 让重讨上升沿复现。空密码不设候选（远端自会
        拒绝/放行），但同样进验证窗。"""
        key, self.core._pw_capture_key = self.core._pw_capture_key, None
        if key is None:
            return
        typed, self.core._pw_typed = self.core._pw_typed, bytearray()
        self._begin_pw_verify()
        if typed:
            self.core._pw_remember_candidate = (
                key, bytes(typed).decode("utf-8", "replace"))

    def _pw_result_tail(self) -> bytes:
        """本次验证窗起点之后的输出——失败指纹的查询范围（上一轮错密的
        deny 还留在尾窗里，全窗扫会把重试成功误判成失败）。"""
        return bytes(self.core._pw_tail[self.core._pw_result_from:])

    def _pw_auth_result(self) -> None:
        """验证窗口以 auth 结果输出收束（not at_end）：成败分流。

        失败（deny 指纹）错密不进库也不问；成功把候选排进「记住」询问
        （防抖 _impl._PW_REMEMBER_DELAY——等迟到的 deny/重讨落地再问，「只落
        本次验证通过的密码」）。"""
        cand = self.core._pw_remember_candidate
        if cand is None:
            return
        if _impl._PW_AUTH_FAIL_RE.search(self._pw_result_tail()):
            self.core._pw_remember_candidate = None
            return
        asyncio.get_running_loop().create_task(self._pw_remember_offer(cand))

    async def _pw_remember_offer(self, cand) -> None:
        """验证成功后的轻量「记住」询问（防抖一拍）。应答经
        remember_yes/remember_no → _finish_remember；文案对齐 ready 后的
        「记住密码」确认框。"""
        await asyncio.sleep(_impl._PW_REMEMBER_DELAY)
        if self.core._closed or self.core._pw_remember_candidate is not cand:
            return   # 新一轮输入/候选已接管
        self.core._pw_remember_candidate = None
        if self.core._pw_at_end or _impl._PW_AUTH_FAIL_RE.search(self._pw_result_tail()):
            return   # 重讨提示又回屏/迟到失败指纹：错密不进库
        self.core._pw_remember_pending = cand
        key, _pw = cand
        disp = _impl.display_name(*key)
        text = (f"密码验证通过（{disp}）。记住该密码？下次自动填充"
                if key[1] == "sudo" else
                f"已成功登录 {disp}。记住该密码？下次自动填充")
        await self.core.emit_msg(ServerMsg(
            type="ask_remember", label=disp,
            text=text + "（写入系统凭据库，不落数据库）"))

    async def _finish_remember(self, store: bool) -> None:
        """「记住」询问应答：同意写 keyring（失败可见），拒绝只清档不写。"""
        pending, self.core._pw_remember_pending = self.core._pw_remember_pending, None
        if not store or pending is None:
            return
        (host, user, port), pw = pending
        if not _impl.store_password(host, user, port, pw):
            await self.core.emit_msg(ServerMsg(
                type="status", text=_impl.PW_STORE_FAIL_HINT))

    async def ask_password(self, label: str, auth_kind: str = "") -> str:
        await self.core.emit_msg(ServerMsg(
            type="ask_password", label=label, auth_kind=auth_kind))
        val = await self.core._pws.get()
        if val is None:
            if getattr(self.core, "_pw_cancelled", False):
                self.core._pw_cancelled = False
                raise PasswordCancelled()
            raise ConnectionError("连接已关闭")
        return val

    def store_auth_password(self, password: str) -> bool:
        """认证弹窗勾选「记住」→ 密码写入 keyring（与重连时 load_password 同一键）。

        键 = 目标的 display_name 三元组——ad-hoc 临时目标（
        _resolve_target_name 重建）同样按它落键（P2-5：确认后写 keyring，
        未确认不写由 ready 后确认框把关）。返回是否落库成功：凭据库不可用
        返回 False，由调用方给可见提示（「以为记住了其实没记住」不再静默）。
        """
        target = self.core.cfg.targets.get(self.core.target_name, self.core.cfg.targets["default"])
        if target.mode != "ssh" or not target.host:
            return True   # 无键可写（local 等）：不算失败
        try:
            return bool(_impl.store_password(target.host, target.user, target.port,
                                       password))
        except Exception:  # noqa: BLE001 - 记住失败不阻断本次连接（密码已进 _pws 继续认证）
            return False
