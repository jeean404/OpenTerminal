"""连接后命令集（Task 6 自 PipelineCore 原样搬入）。

连接就绪/重连后按目标配置免交互串行执行命令集：输出尾窗判定、
静默窗、交互提示应答（密码/确认/verify code）、提示符身份核对、
hook 门禁等待、「继续」按钮强制放行。状态**物理存 core 实例**
（P3 裁定延续：pump/feed_msg/close 直读 core._cs_*；CmdsetRunner
__init__ 以 hasattr 守卫补建，预置值不覆盖），方法体经 self.core 读写。

CMDSET_* 时限常量物理在本模块；运行期经 _impl.CMDSET_* 解析——
tests 从 web.worker 经双跳补丁桥落到 _core_impl dict，裸读模块全局
会漏补丁（auth/_PROBE_TIMEOUT 缝先例）；正则常量无补丁方，裸读。
"""

from __future__ import annotations

import asyncio
import re
import time

from .. import _core_impl as _impl
from .. import cmdset
from ..shell_session import _needs_password_prompt
from .messages import PasswordCancelled, ServerMsg, _ANSI_RE, _dbg


# --- 连接后命令集时序(模块级便于测试 monkeypatch 调小)---
CMDSET_ECHO_TIMEOUT = 2.0     # 等命令回显封顶(秒)
CMDSET_QUIET = 0.3            # 输出静默判定窗口(秒)
CMDSET_PROMPT_TIMEOUT = 10.0  # 等交互提示封顶(秒);超时跳过该应答行
CMDSET_RESUME_QUIET = 1.2     # 暂停等输入:提示消失后再静默此时长才继续(秒)
# 静默≠跑完:ssh/sudo 类握手期会静默数秒才吐交互提示(password:),静默判定把
# 这段空档当「命令跑完」,下一条命令就抢跑进它的 stdin。密码类命令静默后按
# CMDSET_PROMPT_TIMEOUT 继续观察:见交互提示即停下等应答、见新 shell 提示符
# 即判定跑完,两者都到才放行。非密码类命令不观察(不引入额外延迟)。
_CMDSET_PROMPT_RE = re.compile(
    r"(password|passphrase|密码|口令)\s*[:：]\s*$|\[sudo\]|yes/no|verification code",
    re.IGNORECASE)
# 密码类与确认类提示分开:@引用是密码,只能应答密码类——确认类(yes/no)
# 会回显输入,密码打上去就明文漏进终端(真机:跳转时 host key 确认先弹)。
# 明文应答(如 yes/y)两类都应答。
_CMDSET_SECRET_RE = re.compile(
    r"(password|passphrase|密码|口令)\s*[:：]\s*$|\[sudo\]", re.IGNORECASE)
_CMDSET_CONFIRM_RE = re.compile(r"yes/no|verification code", re.IGNORECASE)
# 新 shell 提示符 = 命令真跑完(含嵌套 ssh/su - 登录后的新提示符)。
# 密码类提示不以 $/#/%/> 结尾,故与 _CMDSET_PROMPT_RE 互斥,不会互相误判。
_CMDSET_DONE_RE = re.compile(r"[$#%>]\s*$")
# 提示符身份(user@host):换壳(sudo su - / 嵌套 ssh 登录)的唯一廉价凭据。
# 命令集凭它决定发下一条前要不要先补注入——hook 标记是全会话新鲜度,
# 分不清标记来自哪个壳(su - 后外层标记仍新鲜 → _hook_ok 假阳性)。
_CS_PROMPT_ID_RE = re.compile(
    r"^[\[({]?\s*([A-Za-z0-9._-]+)@([A-Za-z0-9._-]+)")
CMDSET_HOOK_WAIT = 20.0     # 等他人补注入窗口关闭的封顶(秒)


class CmdsetRunner:
    def __init__(self, core) -> None:
        self.core = core
        for name, val in (
            ("_cs_tail", None),        # 命令集监听的输出滚动缓冲（bytearray|None）
            ("_cs_pw_pending", False),  # 上一条命令是密码类:发下条前先确认未停在提示
            ("_cs_prompt_id", None),   # 上一条命令落点提示符的 user@host
            ("_cs_task", None),        # 命令集 runner 任务
            ("_cs_resume", None),      # 「继续」按钮强制放行事件（core 预建优先）
        ):
            if not hasattr(core, name):
                setattr(core, name, val)
        if not hasattr(core, "_cs_resume") or core._cs_resume is None:
            core._cs_resume = asyncio.Event()

    def _spawn_cmdset(self) -> None:
        # 重复触发(重连/就绪)先取消在跑的旧 runner:否则双 runner 交错写
        # PTY、同抢 _pws 队列(密码会随机路由给其中一个等待者)
        if self.core._cs_task is not None and not self.core._cs_task.done():
            self.core._cs_task.cancel()
        self.core._cs_task = asyncio.create_task(self._run_command_set())

    # --- 连接后命令集(spec 2026-09-24):免交互串行执行 ---
    def _cs_text(self) -> str:
        """尾窗文本(剥 ANSI / 归一换行)——只喂正则判定,不用于显示。

        不剥就判不出 shell 提示符回来了:PowerShell/ConPTY 的提示符后面跟着
        光标显隐、颜色复位等转义序列,行尾判提示符的正则永远匹配不上,命令集每条
        都要白等 _impl.CMDSET_PROMPT_TIMEOUT 才放行(真机浏览器复现:提示符 3.1s
        就回来了,第 2 条命令 13.2s 才发出去;真机「要按 Enter 才刷新状态」
        的迟滞感同源)。回显判定同理:PSReadLine 会把命令分词上色。
        """
        raw = bytes(self.core._cs_tail or b"").decode("utf-8", "replace")
        return _ANSI_RE.sub("", raw).replace("\r\n", "\n").replace("\r", "\n")

    def _cs_lastline(self) -> str:
        return self._cs_text().rsplit("\n", 1)[-1]

    async def _cs_pause_for_input(self) -> None:
        """命令执行后终端停在交互提示、又没有应答行接管 → 暂停等用户输入。

        用户直接在终端输(密码不回显),见到 shell 提示符后自动继续;前端
        「继续」按钮(cmdset_resume)随时强制放行。输错密码导致提示重现时
        保持暂停。

        收束信号只能是 shell 提示符,不能是「提示文本消失了」——ssh/sudo
        读完密码先回一个裸 CRLF(尾行空、提示正则不匹配),auth 还没出结果、
        TTY 仍关回显,此刻放行下一条命令就射进无回显窗口:字符进 tty 排队、
        登录后被执行,但一条回显都没有(真机:sudo su - / cd /root 从没上屏,
        界面要按 Enter 才见到提示符)。
        """
        if self.core._cs_pw_pending:
            await self._cs_watch_prompt()
            self.core._cs_pw_pending = False
        if not _CMDSET_PROMPT_RE.search(self._cs_lastline()):
            return
        self.core._cs_resume.clear()
        paused = False
        gone_at = None
        while not self.core._closed:
            line = self._cs_lastline()
            if _CMDSET_PROMPT_RE.search(line):
                gone_at = None
                if not paused:
                    paused = True
                    await self.core.emit_msg(ServerMsg(
                        type="cmdset", state="paused"))
                try:
                    await asyncio.wait_for(self.core._cs_resume.wait(), 0.2)
                    return                    # 提示未消失也放行:用户明示继续
                except asyncio.TimeoutError:
                    pass
                continue
            if _CMDSET_DONE_RE.search(line):
                return                        # shell 提示符回来:命令真跑完
            if gone_at is None:
                gone_at = time.monotonic()
            try:
                await asyncio.wait_for(self.core._cs_resume.wait(), 0.1)
                return                        # 用户点继续:强制放行
            except asyncio.TimeoutError:
                pass
            if time.monotonic() - gone_at > _impl.CMDSET_PROMPT_TIMEOUT:
                return                        # 超时兜底:不再卡住命令集

    async def _run_command_set(self) -> None:
        lines = [l for l in (self.core._target.commands if self.core._target else [])
                 if l.strip() and not l.lstrip().startswith("#")]
        total = len(lines)
        try:
            for i, line in enumerate(lines, 1):
                if self.core._closed:
                    return
                await self.core.emit_msg(ServerMsg(
                    type="cmdset", state="running", index=i, total=total,
                    cmd="" if line.lstrip().startswith(">")
                         else line.strip()))
                if line.lstrip().startswith(">"):
                    await self._cs_answer(line.strip()[1:].strip())
                else:
                    await self._cs_pause_for_input()
                    await self._cs_command(line.strip())
            # 末条命令可能停在交互提示上(如最后一条是 ssh):先按待输入暂停,
            # 否则状态栏报「完成」而终端还卡在密码提示
            await self._cs_pause_for_input()
            await self.core.emit_msg(ServerMsg(
                type="cmdset", state="done", index=total, total=total))
        except asyncio.CancelledError:
            raise
        except ConnectionError:
            return  # 弹窗等待期间连接关闭:静默退出,close 流程已接管
        finally:
            self.core._cs_tail = None   # runner 退出即停缓冲(pump 钩子归零)
            self.core._cs_pw_pending = False

    async def _cs_command(self, cmd: str) -> None:
        """命令行:写入 PTY,等回显再等输出静默(自回显起封顶 ECHO_TIMEOUT)。

        不在结束时清 tail:密码提示常与命令回显同批到达(快网络),
        后续应答行要能继承这段输出继续匹配。

        发命令前先过 _cs_hook_gate:换壳后不补注入就把命令打进裸壳,
        回显没有青色重绘(hook 不在位);补注入窗口与发送并发则更糟——
        窗口吞掉命令回显与新壳提示符(真机:sudo su - / cd /tmp / root
        提示符全不上屏、光标悬空),分片还会被换壳拆进两个壳装配错乱。
        """
        await self._cs_wait_pw_verify()
        await self._cs_hook_gate()
        self.core._cs_tail = bytearray()
        # 密码类命令：发前置标记——密码提示随输出到达时 _pw_armed 需要
        # 已能看到它（_cs_command 尾部再置一次是给 _cs_pause_for_input 用的，
        # 那时提示符早已被 _detect_password_prompt 处理过）
        self.core._cs_pw_pending = _needs_password_prompt(cmd)
        await self.core.session.send_raw((cmd + "\r").encode())
        deadline = time.monotonic() + _impl.CMDSET_ECHO_TIMEOUT
        while time.monotonic() < deadline and cmd not in self._cs_text():
            await asyncio.sleep(0.02)
        if cmd not in self._cs_text() and not self.core._cs_tail:
            await self.core.emit_bytes(cmd.encode() + bytes([13, 10]))
        quiet_deadline = time.monotonic() + _impl.CMDSET_ECHO_TIMEOUT
        last = -1
        while time.monotonic() < quiet_deadline:
            if len(self.core._cs_tail) != last:
                last = len(self.core._cs_tail)
                await asyncio.sleep(_impl.CMDSET_QUIET)   # 有新字节:再等一个静默窗
            else:
                break                               # 静默期满:命令可能跑完
        # 静默≠跑完:记下这条是不是密码类,交给 _cs_pause_for_input 在发下一条
        # 前确认它没停在交互提示上(见 _cs_watch_prompt)
        self.core._cs_pw_pending = _needs_password_prompt(cmd)

    async def _cs_wait_pw_verify(self) -> None:
        """密码验证窗内不注入命令:TTY 关着回显,射进去的命令被执行却不上屏。

        与用户按键(_on_keys)同一道闸,只是这里等而不是排队——命令集是自动
        推进的,排进 _pw_hold 会和「先看提示再发」的时序打架。
        """
        deadline = time.monotonic() + _impl._PW_VERIFY_TIMEOUT
        while self.core._pw_verifying and not self.core._closed:
            if time.monotonic() > deadline:
                return
            await asyncio.sleep(0.05)

    def _cs_prompt_identity(self) -> str | None:
        """当前壳身份 user@host：尾窗末个非空行优先，尾窗全空退回 _cur_prompt。

        必须是「末个非空行」而不是 rsplit 出来的末行：ssh / su 登录后的提示符
        块常以 CR 或括号粘贴模式转义收尾再补换行，归一化后末行是空串 → 身份
        判不出 → 门禁按「同壳」放行，下一条命令打进裸壳（真机 2026-10-08：
        sudo su - 回显白色、无青色重绘）。只认末个非空行、不向上多扫：再往上
        就是上一个壳的提示符，拿它记账会把换壳判成没换。
        """
        for line in reversed(self._cs_text().split("\n")):
            if not line.strip():
                continue
            m = _CS_PROMPT_ID_RE.match(line.strip())
            return f"{m.group(1)}@{m.group(2)}" if m else None
        # 尾窗一个非空行都没有（命令集第一条：连接后还没有泵输出进尾窗）→ 退回
        # 路由最近一次 B 标记捕获的提示符。否则基线永远种不下：第二条命令时
        # base is None → ubuntu→xiaojian 的换壳判不出来 → sudo su - 打进裸壳、
        # 回显白色不青（真机 2026-10-08 run4：ident= None base= None）。
        # 只在尾窗全空时退回：末个非空行是输出文本（Last login 等）时宁返回
        # None——_cur_prompt 只在装了 hook 的壳里更新，拿它记账会把「刚跳进
        # 裸壳」判成同壳；None 不改基线，下一次门禁仍判得出换壳。
        m = _CS_PROMPT_ID_RE.match(self.core._cur_prompt.strip())
        return f"{m.group(1)}@{m.group(2)}" if m else None

    async def _cs_hook_gate(self) -> None:
        """命令集逐条前置门禁:注入在飞等窗口关;换壳/缺 hook 先补注入。

        补注入的 _suppress_live 窗口吞窗口内全部泵输出——与命令集并发时
        正好吞掉命令回显与新壳提示符(真机 2026-10-08:sudo su - 之后整屏
        冻结、光标悬在旧提示符);分片飞行途中换壳(su -)还会把 base64 装配
        拆进两个壳 → eval 语法错误 → hook 永远装不进嵌套壳(命令行不青)。
        串行化后两症同解:窗口在飞只等不发;提示符身份变了先注入完再发,
        嵌套壳 thereby 拿到 hook,回显青色重绘与提示符落屏都恢复。
        """
        deadline = time.monotonic() + _impl.CMDSET_HOOK_WAIT
        while self.core._suppress_live and not self.core._closed:
            if time.monotonic() > deadline:
                return          # 注入卡死:不再等,命令照发(宁显不青不吞屏)
            await asyncio.sleep(0.05)
        if self.core._closed:
            return
        ident = self._cs_prompt_identity()
        base = self.core._cs_prompt_id
        if ident is not None:
            self.core._cs_prompt_id = ident
        # 首条命令没有基线可比（base is None）：不算换壳。setup 注入刚落地就
        # 再注一遍＝白等 2~4s，还把实例号推进新号段（外层帧号空间白白作废）
        changed = base is not None and ident is not None and ident != base
        _dbg("cs gate: ident=", ident, "base=", base, "changed=", changed,
             "hook_ok=", self.core.hook._hook_ok(), "hook_gone=", self.core._hook_gone,
             "lastline=", repr(self._cs_lastline()[-40:]))
        if not changed and (self.core.hook._hook_ok() or self.core._hook_gone):
            return              # 同壳且 hook 在位(或结构性不可集成)
        try:
            await self.core.hook._ensure_integrated()
        except Exception:  # noqa: BLE001 - 注入失败不阻断命令集
            return

    async def _cs_watch_prompt(self) -> None:
        """上一条是密码类命令时,发下一条前先确认它没停在交互提示上。

        ssh/sudo 类握手期会静默数秒才吐 password:,静默判定把这段空档当成
        「命令跑完」,下一条命令就抢跑进它的 stdin 被当下一条密码吃掉(真机:
        ssh 该阻塞等密码,sudo su - / cd /root 却已回显,登录后又排队执行)。

        见交互提示即返回(交 _cs_pause_for_input 暂停等应答);见新 shell 提示符
        = 命令已结束(含 ssh/su - 登录后的新提示符)立即返回,零额外延迟。
        """
        if not self.core._cs_tail:
            return                        # 无输出证据可判:不做无谓等待
        deadline = time.monotonic() + _impl.CMDSET_PROMPT_TIMEOUT
        while time.monotonic() < deadline:
            line = self._cs_lastline()
            if _CMDSET_PROMPT_RE.search(line):
                return                    # 交互提示在前台:停下等应答
            if _CMDSET_DONE_RE.search(line):
                return                    # 新 shell 提示符:命令已结束
            await asyncio.sleep(0.05)

    async def _cs_answer(self, ref: str) -> None:
        """应答行:等密码类提示出现后自动输入;10s 等不到则跳过(容错)。

        @引用在密钥库缺失时首次学习:弹窗询问一次(必定记住,存
        cmdset:<引用名>),本次立即用,之后连接自动取。
        """
        if ref.startswith("@"):
            name = ref[1:].strip()
            answer = cmdset.resolve_answer(name)
            pat = _CMDSET_SECRET_RE   # 密码应答只认密码类提示(确认类会回显)
            if answer is None:
                answer = await self.core.auth.ask_password(
                    f"命令集：{name} 的密码（记住后下次自动填充）",
                    auth_kind="cmdset")
                if not answer:      # 用户空提交:放弃该应答行
                    await self.core.emit_msg(ServerMsg(
                        type="status",
                        text=f"命令集：@{name} 未输入密码，已跳过自动应答"))
                    return
                _impl.store_password(f"cmdset:{name}", None, None, answer)
        else:
            answer = ref
            pat = _CMDSET_PROMPT_RE
        if self.core._cs_tail is None:
            # 命令集以应答行开头(前面没有命令阶段)才新建缓冲;否则继承
            # 命令阶段的输出——提示很可能已在那里等着
            self.core._cs_tail = bytearray()
        try:
            deadline = time.monotonic() + _impl.CMDSET_PROMPT_TIMEOUT
            while time.monotonic() < deadline:
                if self.core._closed:
                    return
                if pat.search(self._cs_text()):
                    await self.core.session.send_raw((answer + "\r").encode())
                    # 应答是静默的(密码不回显):旧提示符还挂在尾窗里,尾窗
                    # 重置成「应答之后的输出」,下一条才判得出 shell 提示符
                    # 何时回来;并记账发下一条前先等它回来,否则抢跑进仍在关
                    # 回显的 auth 窗口(真机:sudo su - / cd /root 不上屏)
                    self.core._cs_tail = bytearray()
                    self.core._cs_pw_pending = True
                    await asyncio.sleep(_impl.CMDSET_QUIET)   # 密码不回显,静默即稳
                    return
                await asyncio.sleep(0.05)
            await self.core.emit_msg(ServerMsg(
                type="status", text="命令集：未检测到交互提示，已跳过自动应答"))
        finally:
            # 不在这清 _cs_tail:应答后下一条要靠它判 shell 提示符何时回来,
            # 清掉就无证据、_cs_watch_prompt 直接放行→抢跑进无回显窗口。
            # 归零由 _cs_command 开头与 runner 退出时的 finally 负责。
            pass

    # --- 组件公开接口绑定 ---
    spawn = _spawn_cmdset
