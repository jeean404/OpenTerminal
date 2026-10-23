"""AI 行处理与任务（Task 7 自 PipelineCore 原样搬入）。

自然语言入口（start_ai / on_ai_line / on_frontend_line）、任务执行
（run_task / _ai_flow）、斜杠命令（handle_slash）、失败救援决策、
兜底上报、模型与显示切换——AI 栈装配（agent 会话/预热）也在本组件。
状态**物理存 core 实例**（P3 裁定延续：pump/close/_switch_target 与
测试直读 core._ai_task/_display 等；_display 读点 _switch_target/
_pump_loop 留 core，故 _display 一并留 core，本组件经 core 读写；
AiFlow.__init__ 以 hasattr 守卫补建，预置值不覆盖），方法体经
self.core 访问；实例 __getattr__ 转发未知属性到 core（简报直读形态）。

补丁缝：build_agent / build_chat_model / SUBMIT_FALLBACK_DELAY 经
_impl 运行期解析——tests 从 web.worker 经双跳补丁桥落到 _core_impl
dict，裸读模块全局会漏补丁（auth/store_password 缝先例）。
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import replace

from . import pipeline as _impl
from .messages import ServerMsg, _dbg
from ..shell.integration import toggle_line


class _SegBuffer:
    """paced 段缓冲：Web 模式下 token/think 攒到段边界一次性下发（ai_result）。

    前端不攒 token 流（浏览器零压力）；段边界 = tool_start（轮内文本先于
    tool_start 全部到达）/ final（吞正文留思考）/ 失败路径（冲 failed 段）/
    中断（不冲，零残留）。双空段不发（纯工具轮不长空分析卡）。
    """

    __slots__ = ("text", "think", "chars", "beat", "runner")

    def __init__(self) -> None:
        self.text = ""
        self.think = ""
        self.chars = 0      # 累计字数（跨段，徽标显示用）
        self.beat = 0.0     # 上次心跳时刻（monotonic）
        self.runner = None  # TaskRunner（心跳读 token 计数）

    def add(self, text: str, think: str) -> None:
        self.text += text
        self.think += think
        self.chars += len(text) + len(think)

    def take(self) -> tuple[str, str]:
        text, think = self.text, self.think
        self.text = ""
        self.think = ""
        return text, think


class AiFlow:
    def __init__(self, core) -> None:
        self.core = core
        for name, val in (
            ("_ai_task", None),         # 在跑的 AI 任务（None = 空闲）
            ("_ai_ping_at", 0.0),       # AI 任务最近一次有产出（僵尸判据）
            ("_ai_queue", []),          # AI 忙时排队 (line, hooked)
            ("_suppress_ai_report", None),  # 兜底已启动后迟到的重复上报
            ("_fallback_task", None),   # _submit_fallback 句柄（测试/关闭可取消）
            ("_rescue_open", False),    # 救援卡待决策（最多一张，防连败刷屏）
            ("_rescue_ctx", None),      # (line, ec, output)：决策时的任务上下文
            ("_runner", None),          # InteractiveRunner（探测就绪后建）
            ("_runner_lock", None),     # runner 换壳串行锁（下两行修正为 Lock）
            ("_display", "agent"),      # agent = hook 集成 / ssh = 纯透传
        ):
            if not hasattr(core, name):
                setattr(core, name, val)
        if not hasattr(core, "_runner_lock") or core._runner_lock is None:
            core._runner_lock = asyncio.Lock()

    def _agent_session(self):
        """agent 工具执行用的会话：交互式 = InteractiveRunner（同 PTY 注入），
        否则原始 session（哨兵批处理，仅记账，无 AI 输入通道）。"""
        return self.core._runner if self.core._interactive else self.core.session
    def _build_agent_now(self, tools: list | None = None) -> None:
        """立即构建/重建 agent。AI 栈经 _impl._load_agent_stack 惰性载入模块级名字
        （deepagents/langchain 约 4s 导入由此与启动路径解耦）；测试 monkeypatch
        的 _impl.build_agent 桩在此生效（非 None 即跳过真导入）。"""
        _impl._load_agent_stack()
        # 远端目标（SSH/嵌套 ssh）的 session.cwd 是远端路径，不能当本机文件根
        target = getattr(self.core, "_target", None)
        remote = bool(target is not None and target.mode != "local")
        self.core.agent, self.core.allowed, self.core.backend = _impl.build_agent(
            self.core.profile, self._agent_session(), self.core.cfg, self.core.policy,
            model=_impl.build_chat_model(self.core._model),
            remote_target=remote,
            tools=tools or [])

    async def _gather_tools(self) -> list:
        """启用中的 MCP 工具。拉不到就当没有——绝不挡住 agent 构建。"""
        try:
            from ..agent.mcp import gather_mcp_tools
            return await gather_mcp_tools()
        except Exception:  # noqa: BLE001 - 工具是加分项，不是前置条件
            return []

    async def _rebuild_agent(self) -> None:
        """重建 agent 并刷新 MCP 工具（换模型 / 换系统方言 / 改工具开关）。"""
        tools = await self._gather_tools()
        await asyncio.to_thread(self._build_agent_now, tools)

    async def _ensure_agent(self) -> None:
        """首个 AI 任务时构建 agent，已建则复用。self.core.agent/backend 从 None
        变就绪的唯一入口（建连不再预建）。"""
        if self.core.agent is None:
            await self._rebuild_agent()
    async def _prewarm_agent(self) -> None:
        """后台预热 AI 栈导入（只导入不构建：构建依赖 profile/model，留主
        线程）。建连完成即跑，首条自然语言的 task_start 不再等秒级 import；
        失败静默——首任务回退按需导入。"""
        def _import_stack() -> None:
            _impl._load_agent_stack()
            from .. import agent  # noqa: F401 - 预导入模块本体，_run_task
            # 调用点 `from ..agent.runner import TaskRunner` 命中 sys.modules 零成本
        try:
            await asyncio.to_thread(_import_stack)
        except Exception:  # noqa: BLE001 - 预热失败不阻断，首任务按需导入
            pass

    # --- 命令历史长期记忆（SQLite）---
    def _start_ai(self, line: str, hooked: bool = False) -> None:
        self.core._ai_ping_at = time.monotonic()   # 僵尸回收基准：任务起点即有锚
        # 任务起跑未走 hook 上报（外部触发链）→ _run_task 必有重注入在途：
        # _shell_pad 的 60s 节流补注入对本次任务冗余（pad ack 不必等它）
        self.core._reinject_pending = not hooked
        self.core._ai_task = asyncio.create_task(self._ai_flow(line, hooked))
    async def _ai_flow(self, line: str, hooked: bool = False) -> None:
        try:
            if line.startswith("/"):
                if await self._handle_slash(line.strip()):
                    return
                # 未知斜杠命令（/clearn 打错字、无 +x 的 /x.sh）：不静默吞——
                # 落回正常任务（与 CLI 语义一致：未知 / 交 LLM 判定），否则
                # hook 蓝色重绘后用户零反馈（真机：以为终端卡死）
            text = line.lstrip("?").strip() or line
            await self._run_task(text, hooked)
        except asyncio.CancelledError:
            # 用户中止（Ctrl+C/⏹）语义发 interrupt（不是 error）：前端按
            # 「中止」收束——流式未渲染完毕的卡整卡移除，不留下半截卡
            await self.core.emit_msg(ServerMsg(
                type="event", event={"kind": "interrupt", "text": "已停止"}))
        except Exception as e:  # noqa: BLE001 - 兜底：前端靠 error 停表收卡片
            await self.core.emit_msg(ServerMsg(
                type="event", event={"kind": "error",
                                     "text": f"处理失败：{type(e).__name__}: {e}"}))
        finally:
            _dbg("ai_flow finally")
            self.core._ai_task = None
            self.core._reinject_pending = False
            try:
                await self.core.exec._curtain_open()   # 任务收尾：扣住的提示符放行
                _dbg("curtain opened")
            except Exception:                # noqa: BLE001 - 收尾放行不能盖错误
                pass
            if self.core._ai_queue and not self.core._closed:
                _q = self.core._ai_queue.pop(0)
                self._start_ai(_q[0], _q[1] if len(_q) > 1 else False)
            _dbg("ai_flow done")

    # --- Agent/Shell 显示模式切换 ---
    async def _on_ai_line(self, line: str, hooked: bool = False) -> None:
        if self.core._ai_task is not None:
            self.core._ai_queue.append((line, hooked))   # 忙：排队，结束后依序回放
            return
        self._start_ai(line, hooked)
    async def _on_frontend_line(self, text: str, dirty: bool = False,
                                typed: bool = True) -> None:
        """外部触发链：前端在 agent 模式拦下的整行。

        健康路径（hook 在位 + shell 空闲在提示符）：补发回车——hook 的 AI 分支
        原地把默认色回显重画为「提示符+蓝色文本」（§5.6 Workbench 观感：用户
        输入蓝、工具命令青），再以 6337 AI 上报触发任务（自然语言不入 shell
        历史——↑/↓ 只召回历史命令；上报即
        启动，与英文自然语言同一条 proven 路径，无 \x03 残行）。hook 在位时
        shell BUFFER 即真相：镜像 dirty（被无法镜像的转义/控制键清过，如历史
        召回）也走健康路径，只是不挂兜底——镜像文本与 hook 上报必不相等，
        挂了会在 1.2s 后按残镜像误起任务（真机「帮我把ll设置为"ls -al"的别名」
        行内方向键编辑后 AI 只收到光标后尾巴的根因之一）。
        「shell 空闲」由 _open_cmds 空判定：用户命令执行帧开着（前台占用，典型
        su - 整段会话——其 C 帧不闭合还会让 _hook_ok 的时间戳比较永久误判在位）
        时 readline 不在读行，补发的 \r 只落进命令 stdin，hook 永不重绘/上报。

        降级路径（hook 标记绝迹 = su - 重置）：任务先行——task_start→分析卡
        毫秒级出场（文字由卡的 text 承接，与直通修复同形态）；清场（\x15 可见
        地收掉已回显半行 + ^C 把 shell 从可能的前台命令里要回提示符）放后台
        且持 _runner_lock，_run_task 里 if not hooked 的 _ensure_integrated
        等锁串行在其后完成重注入（su - 后下一条自然语言即恢复健康路径）。
        旧序先擦行再同步重注入 4-6s 才见蓝行/起任务——用户对着空行干等光标
        闪几秒（真机根因，已废）。前一任务在跑时只排队、不发任何终端字节
        （擦行/^C/重注入都会与在跑任务的工具注入赛跑）。
        typed=False（验证窗口 hold 输入的回放）：字符当时被 hold、不在 shell
        buffer——健康路径补发整行+回车，降级路径跳过清场（无半行回显可丢）。
        验证窗口（_pw_verifying）内整行与按键一并 hold（见 _begin_pw_verify），
        验证结束由 _flush_pw_hold 依序释放。"""
        if self.core.session is None:
            return
        t = text.strip()
        _dbg("submit text=", repr(t[:60]), "dirty=", dirty,
             "exec_busy=", self.core._exec_future is not None,
             "open_cmds=", len(self.core._open_cmds))
        if self.core._pw_verifying:
            # 验证窗口：抢跑的整行 hold 住——补发的 \r 会落进 ssh 输入队列
            # 成一次空密码尝试（真机连排 Permission denied 根因）
            if t and _impl._looks_ai(t):
                self.core._pw_hold.append(("submit", t, dirty))
            else:
                self.core._pw_hold.append(("raw", b"\r"))
            return
        if not t or self.core._exec_future is not None or not _impl._looks_ai(t):
            await self.core.session.send_raw(b"\r")
            # 命令行回车同样要验活：承接它的若不是集成壳（嵌套 shell 被 TMOUT
            # 收走后落回的裸壳），下一条自然语言的健康路径 \r 就会把整行当命令
            # 执行。工具命令在途不武装——那段的标记由 agent 帧负责。
            if t and self.core._exec_future is None and self.core.hook._hook_ok():
                self.core.hook._arm_hook_watch()
            return
        if self.core._pw_prompt_seen:
            # 密码提示符在前台（ssh/sudo 讨密码）：绝不能拦成自然语言——
            # 否则密码行被当任务挂起，\r 被 ^C/重注入链吞掉，登录失败。
            # 字符已原样透传（echo 关闭），这里只补发回车提交密码；
            # CJK/IME 整行路径的回车同时冻结手输捕获的候选（P1-3）。
            self.core.auth._pw_capture_submit()
            await self.core.session.send_raw(b"\r")
            return
        if self.core._interactive and self.core.hook._hook_ok() and (
                not self.core._open_cmds or self.core._inner_ssh_prompt_live()):
            await self.core.session.send_raw(b"\r" if typed else (t + "\r").encode())
            # 兜底只保本次任务不悬空；看门狗保的是**下一条**：hook 其实不在位时
            # 置 _hook_stale，后续提交不再重复把整行自然语言送进裸壳
            self.core.hook._arm_hook_watch()
            if not dirty:
                self.core._hook_report_pending = t
                self.core._fallback_task = asyncio.create_task(self._submit_fallback(t))
            return
        if not self.core._interactive:
            # 纯终端直通（hook 注入失败/不可集成）：清缓冲与起任务并行。
            # 旧序先 \x15+^C+0.52s 再起任务——用户已回显的整行当场被擦掉，
            # 文字只能等分析卡渲染 task_start 的 text 才重现，净空白 1-2s
            # （真机「Enter 后空白然后才显示文字」根因）。task_start→分析卡
            # 不依赖终端状态，先起；^C 引发的提示符重绘由幕帘扣住（_ai_task
            # 已同步置位，prompt_start 关帘），任务收尾才放行，不会写进卡的
            # 预留空白区。清缓冲只须赶在首个工具命令注入（模型思考秒级）
            # 之前——直通工具走哨兵批（_agent_session 返回裸 session），
            # 残留半行会拼进注入命令。
            if typed:
                if self.core._ai_task is not None:
                    # 前一任务在跑：清缓冲须同步完成再排队（后台跑会与
                    # 在跑任务的下一发工具注入赛跑）
                    await self._passthrough_reset(t)
                else:
                    asyncio.create_task(self._passthrough_reset(t))
            else:
                # 回放行（验证窗口 hold 过）：没有半行可擦，但蓝行仍要补画
                await self.core.exec._repaint_line(t, echoed=False)
            await self._on_ai_line(t)
            return
        # 降级路径（hook 标记绝迹 = su - 重置等）：任务先行——task_start→分析卡
        # 毫秒级出场，文字由卡的 text 承载（与直通修复同形态）。旧序先**可见地**
        # 擦掉已回显半行，再同步重注入（探测 + 27 分片 ≈ 4-6s）成功才重发蓝行/
        # 失败才起任务——用户对着空行干看光标闪几秒（真机「Enter 后光标闪几秒
        # 才见字和卡」根因）。清场（\x15 收残行 + ^C 救回提示符）放后台且持
        # _runner_lock：_run_task 里 if not hooked 的 _ensure_integrated 等锁
        # 串行在其后——探测行必须敲在干净提示符上，且重注入与工具命令注入
        # （InteractiveRunner 同锁）互斥，无赛跑窗口。
        if self.core._ai_task is not None:
            # 前一任务在跑：只排队，不发任何终端字节——此刻擦行/^C/重注入
            # 都会与在跑任务的工具注入赛跑。回放行的重注入由 _run_task
            # 既有逻辑（not hooked 分支）兜住
            await self._on_ai_line(t)
            return
        if typed:
            asyncio.create_task(self._degraded_reset(t))
        else:
            # 回放行（验证窗口 hold 过）：没有半行可擦，但蓝行仍要补画
            await self.core.exec._repaint_line(t, echoed=False)
        await self._on_ai_line(t)
    async def _degraded_reset(self, text: str | None = None) -> None:
        """降级提交的后台清场：\x15 收掉已回显半行 + ^C 把 shell 从可能的
        前台命令里要回提示符（su - 重置是主因）。持 _runner_lock：与任务内
        _ensure_integrated（探测行须敲在干净提示符上）和工具命令注入互斥。
        镜像 dirty 也照发 \x15——降级不再重发整行，不存在「保留残行等重发」
        的语义，宁可多擦（残半行会拼进工具命令）；擦掉的画面由分析卡的 text
        承接（卡先于清理完成出现）。"""
        if self.core.session is None:
            return
        try:
            async with self.core._runner_lock:
                # 清场全程开抑制窗：\x15 的擦行回显、^C 回显、bash 补画的
                # 新提示符全吞（否则 ^C 与提示符先到、NL 原文后补画就叠在
                # 它们上面 = 又一层错位）。窗末统一按 hook 观感补画蓝行。
                self.core._suppress_live = True
                self.core._suppressed_tail = ""
                try:
                    _dbg("dg-reset: send \\x15")
                    await self.core.session.send_raw(b"\x15")
                    await asyncio.sleep(0.12)
                    self.core.exec._arm_intr_swallow()   # bash 会在半行尾回显 "^C"：吞掉这两字节
                    _dbg("dg-reset: send \\x03")
                    await self.core.session.send_raw(b"\x03")
                    # readline 的 SIGINT 恢复窗口（^C 回显 + 退格重画）会丢弃期间
                    # 到达的输入：紧贴 ^C 写分片会丢 chunk0 头部（真机实测：解码
                    # 脚本缺字节、注释行断成命令报 "对策: …: command not found"；
                    # settle 0.4s 后消失）。^C 回显由 _strip_intr_echo 精确吞除
                    await asyncio.sleep(0.4)   # settle 躲开 SIGINT 恢复窗口
                    _dbg("dg-reset: done")
                finally:
                    self.core._suppress_live = False
                    await self.core.exec._repaint_line(text)
        except Exception as e:  # noqa: BLE001 - 清理失败不追责：任务已起跑
            _dbg("dg-reset: exc", repr(e))
    async def _passthrough_reset(self, text: str | None = None) -> None:
        """直通模式的行缓冲后台清理：\x15 收掉已回显/残存半行 + ^C 把 shell
        从可能的前台命令里要回提示符，语义与降级路径的清场相同但不挡任务
        起跑。镜像 dirty 也照发 \x15——直通不重发整行，不存在「保留残行等
        重发」的语义，宁可多擦（残半行会拼进工具命令）；擦掉的画面由分析卡
        的 text 承接（卡先于清理完成出现）。"""
        if self.core.session is None:
            return
        try:
            # 与降级路径同形：清场全程抑制，窗末补画蓝行（否则半行被擦掉后
            # 用户自然语言在屏上完全不可见，只能等分析卡的 text 才重现）
            self.core._suppress_live = True
            self.core._suppressed_tail = ""
            try:
                _dbg("pt-reset: send \\x15")
                await self.core.session.send_raw(b"\x15")
                await asyncio.sleep(0.12)
                self.core.exec._arm_intr_swallow()   # bash 会在半行尾回显 "^C"：吞掉这两字节
                _dbg("pt-reset: send \\x03")
                await self.core.session.send_raw(b"\x03")
                await asyncio.sleep(0.4)   # settle 躲开 SIGINT 恢复窗口（同降级路径）
                _dbg("pt-reset: done")
            finally:
                self.core._suppress_live = False
                await self.core.exec._repaint_line(text)
        except Exception as e:  # noqa: BLE001 - 清理失败不追责：任务已起跑
            _dbg("pt-reset: exc", repr(e))

    # --- hook 集成/验活过渡委托（实现已拆 core/hook_gate.py；src 内部
    # 已直呼 self.core.hook.*，委托仅供 tests/ 与 core 子组件旧名过渡，Task 9 随
    # _core_impl 删除）---
    async def _maybe_rescue(self, line: str, ec) -> None:
        """用户命令非零退出 → 挂一张救援卡（一键交 AI 判定原意/修复）。

        分类启发式判 CMD 就直接执行（零延迟、对真命令零误伤），失败即信号
        （market 先例：Copilot 终端建议 / JetBrains 内联修复 / thefuck）。
        手动卡而非自动起任务：grep 无匹配（exit 1）、测试挂掉这类「正常失败」
        不能被劫持进 AI。130/143 = 用户自己 Ctrl+C/kill，不是失败。
        """
        if (not self.core._interactive or not isinstance(ec, int) or ec == 0
                or ec in (130, 143)
                or self.core._ai_task is not None      # AI 在跑：用户侧命令不掺和
                or self.core._rescue_open              # 已有待决策救援卡：不刷屏
                or self.core._exec_future is not None  # runner 占用（理论不可达，双保险）
                or self.core._suppress_live            # 注入窗口内的杂行不是用户命令
                or not line.strip()):
            return
        self.core._rescue_open = True
        out = bytes(self.core._user_out[-2048:]).decode("utf-8", "replace").strip()
        self.core._rescue_ctx = (line, ec, out)
        await self.core.emit_msg(ServerMsg(type="event", event={
            "kind": "rescue", "line": line, "ec": ec, "output": out}))
    async def _on_rescue_decision(self, accept: bool) -> None:
        """救援卡决策：accept → 以失败上下文起 AI 任务（自然语言优先解读）。"""
        if not self.core._rescue_open:
            return
        self.core._rescue_open = False
        ctx, self.core._rescue_ctx = self.core._rescue_ctx, None
        if not accept or ctx is None:
            return
        line, ec, out = ctx
        prompt = (
            f"我在终端里输入了「{line}」并回车，它被当作命令执行但失败了"
            f"（退出码 {ec}）。\n"
            + (f"命令输出：\n{out}\n" if out else "（无输出）\n")
            + "\n请判断我的真实意图：如果我想输入的是自然语言请求，直接完成它；"
              "如果是命令写错了（拼写/参数/路径），修正后用 execute 工具执行并"
              "给我结果。")
        # hooked=True：这条 CMD 上报+C/D 帧刚走通，hook 在位是既成事实，
        # 重注入的吞窗口只会白吃在途字节
        await self._on_ai_line(prompt, hooked=True)

    # --- AI 行（自然语言，经 hook AI 报告进入）---
    async def _submit_fallback(self, t: str) -> None:
        """健康路径兜底：补发 \\r 后 hook AI 上报迟迟未到（重置误判/路由丢报）
        → 中断残行改走外部启动，保证任务不悬空。迟到的同文上报由
        _suppress_ai_report 吞掉，不会双跑。"""
        await asyncio.sleep(_impl.SUBMIT_FALLBACK_DELAY)
        if self.core._closed or self.core._hook_report_pending != t:
            return
        self.core._hook_report_pending = None
        self.core._suppress_ai_report = t
        if self.core.session is not None:
            self.core.exec._arm_intr_swallow()   # 同降级路径：吞 ^C 回显残迹
            await self.core.session.send_raw(b"\x03")
            # 同降级路径：settle 躲开 SIGINT 恢复窗口的输入丢弃；不吞 ^C 回显
            # （吞掉会使前端光标失步，重发回显拼在旧行后）
            await asyncio.sleep(0.4)
            # ^C 已可见地收掉残行并补画了新提示符：行上只剩提示符，按
            # echoed=False 接上蓝行即可（与 hook 的 __ot_repaint 同观感）
            await self.core.exec._repaint_line(t, echoed=False)
        await self._on_ai_line(t)
    async def _handle_slash(self, line: str) -> bool:
        """斜杠命令处理；返回 True 表示已消费（经 hook AI 报告进入）。"""
        if line == "/help":
            await self.core.emit_msg(ServerMsg(
                type="status",
                text="/target 切换主机  /clear 清屏新任务  /model 查看模型"
                     "  /system 手动设系统方言  /exit 关闭会话"))
            return True
        if line == "/model":
            await self.core.emit_msg(ServerMsg(
                type="status",
                text=f"{self.core.cfg.model.model} @ {self.core.cfg.model.base_url}"))
            return True
        if line == "/exit":
            await self.core.close()
            return True
        if line == "/clear":
            self.core._reset_context()
            await self.core.emit_msg(ServerMsg(
                type="status", text="已开启新任务。"))
            # 通知前端清掉本会话的全部 AI 卡片
            await self.core.emit_msg(ServerMsg(
                type="event", event={"kind": "session_cleared"}))
            # 清屏交原生：Ctrl+L 让 shell 清屏重画提示符（历史进 scrollback）
            if self.core.session is not None and self.core._interactive:
                await self.core.session.send_raw(b"\x0c")
            return True
        if line.startswith("/target"):
            await self.core._switch_target(line)
            return True
        if line.startswith("/system"):
            await self.core._manual_system(line)
            return True
        return False
    def _flush_seg(self, failed: bool = False) -> None:
        """paced 段冲刷：一次性 ai_result。双空 no-op（幂等——limit/error 会
        被 _live 与 _handle_events 双路过，第二发自然空转）。"""
        seg = getattr(self, "_seg", None)
        if seg is None:
            return
        text, think = seg.take()
        if not text and not think:
            return
        self.core._emit_nowait(ServerMsg(
            type="event",
            event={"kind": "ai_result", "text": text, "think": think,
                   "failed": failed}))

    def _seg_beat(self, force: bool = False) -> None:
        """徽标心跳（1s 节流）：累计字数 + token 计数（runner 逐调用更新）。"""
        seg = getattr(self, "_seg", None)
        if seg is None or not self.core.paced_display:
            return
        now = time.monotonic()
        if not force and now - seg.beat < 1.0:
            return
        seg.beat = now
        r = seg.runner
        self.core._emit_nowait(ServerMsg(
            type="event", event={
                "kind": "progress", "chars": seg.chars,
                "tokens_in": ((r.input_tokens or r.est_input_tokens) if r else 0),
                "tokens_out": ((r.output_tokens or r.est_output_tokens) if r else 0)}))

    async def _run_task(self, text: str, hooked: bool = False) -> None:
        self.core.transcript.append("user", text=text)
        self.core._task_cmd_started = False
        self.core._tool_idx_map = {}   # 跨任务残留的局部 index 映射作废（序号不回绕）
        # paced 段缓冲（Web 一次性落格用；CLI paced_display=False 不进缓冲）。
        # 任务级 finally 清空：中断取消同样收口，残段不得泄进下个排队任务
        self._seg = _SegBuffer()
        # task_start 先于 AI 栈导入/重注入：首任务 deepagents/langchain 秒级
        # 导入与换壳重注入不得挡在分析卡出场前（真机「输完自然语言等几秒
        # 才出卡」根因）；构建失败照发 error 事件，卡片原地定格为已中止
        _dbg("task_start emit", repr(text[:40]))
        await self.core.emit_msg(ServerMsg(
            type="event", event={"kind": "task_start", "text": text}))
        try:
            # 首任务 AI 栈导入（deepagents/langchain 秒级）是**同步阻塞**——
            # 事件循环整个冻住：实测 sleep(0.12) 被拖成 8.9s，task_start 虽已
            # emit 却同样迟到 9s 才达前端（分析卡/思考徽标一起迟到）。放线程
            # 池跑构建，循环不被挡：task_start 毫秒级达前端，卡即出
            await self._ensure_agent()
        except Exception as e:  # noqa: BLE001 - 构建失败发 error 事件让前端收尾
            await self.core.emit_msg(ServerMsg(
                type="event", event={"kind": "error",
                                     "text": f"AI 初始化失败：{type(e).__name__}: {e}"}))
            return
        # hook 上报触发的任务不重注入：上报即在位凭据，而注入吞窗口会吃掉
        # 在途蓝色重绘字节（真机「提交行消失」）；外部启动（无上报）才需要
        if not hooked:
            await self.core.hook._ensure_integrated()   # su - 等 login shell 重置后先重注入
            self.core._reinject_pending = False   # 在途重注入已落定：pad 恢复 60s 兜底
        presenter = _impl.CorePresenter(self)
        self.core.backend.on_start = presenter.on_start
        self.core.backend.on_output = None   # 输出由 exec 状态机直写主 xterm
        self.core.backend.on_finish = presenter.on_finish
        self.core.backend.on_boundary = self.core._boundary_gate

        def _live(ev) -> None:
            self.core._ai_ping_at = time.monotonic()   # 事件产出 = 任务在世，僵尸判据刷新
            if ev.kind == "token":
                if self.core.paced_display:
                    # 段攒流：不逐 token 下发（浏览器零压力），段边界一次性落格
                    self._seg.add(ev.text, "")
                    self._seg_beat()
                else:
                    self.core._emit_nowait(ServerMsg(
                        type="event",
                        event={"kind": "ai_token", "text": ev.text}))
            elif ev.kind == "think":
                if self.core.paced_display:
                    self._seg.add("", ev.text)
                    self._seg_beat()
                else:
                    self.core._emit_nowait(ServerMsg(
                        type="event",
                        event={"kind": "ai_think", "text": ev.text}))
            elif ev.kind == "denied":
                self._flush_seg()
                self.core._emit_nowait(ServerMsg(
                    type="event", event={"kind": "denied", "text": ev.text}))
            elif ev.kind == "tool_start":
                # 段边界：先落格（轮内 token 全部先于 tool_start），再宣告工具
                self._flush_seg()
                # 阶段边界先定格当前分析卡（工具卡挂流底，之后模型输出开新卡，
                # 叙事节奏与分析卡→命令→分析卡一致）；再挂工具调用小卡。
                # 工具执行期无 PTY 输出，不需要 boundary 门闩。execute 也发卡
                #（远程目标上模型几乎只走 execute），但不再补 ai_collapse：
                # 命令定格走 boundary 门闩既有路径，双发会把 CLI 的执行面板打两遍
                self.core._tool_card_seq += 1
                self.core._tool_idx_map[ev.index] = self.core._tool_card_seq
                if ev.name != "execute":
                    self.core._emit_nowait(ServerMsg(
                        type="event", event={"kind": "ai_collapse"}))
                self.core._emit_nowait(ServerMsg(
                    type="event",
                    event={"kind": "ai_tool", "phase": "start",
                           "id": self.core._tool_card_seq,
                           "name": ev.name, "args": ev.text,
                           # 命令卡出生预判（谓词单源 Policy）：needs_approval
                           # 为真前端直接摆「等待审批」按钮簇；容忍审批不至
                           #（allowed 只增，中途命中直通）——tool_end 直通 ✓ 合法迁移
                           "command": ev.command,
                           "needs_approval": bool(ev.command) and
                               self.core.policy.needs_approval(
                                   ev.command, self.core.allowed),
                           "reasons": self.core.policy.classify(
                               ev.command).reasons if ev.command else [],
                           "risk": self.core.policy.risk(ev.command)
                               if ev.command else ""}))
            elif ev.kind == "tool_end":
                gid = self.core._tool_idx_map.pop(ev.index, None)
                if gid is not None:
                    self.core._emit_nowait(ServerMsg(
                        type="event",
                        event={"kind": "ai_tool", "phase": "end", "id": gid,
                               "failed": ev.failed}))
            elif ev.kind == "limit":
                self._flush_seg(failed=True)
                self.core._emit_nowait(ServerMsg(
                    type="event", event={"kind": "limit", "text": ev.text}))
            elif ev.kind == "error":
                self._flush_seg(failed=True)
                self.core._emit_nowait(ServerMsg(
                    type="event", event={"kind": "error", "text": ev.text}))

        # 调用点取 TaskRunner：预热已导入 agent 模块（sys.modules 命中零
        # 成本）；测试桩打 amod.TaskRunner，缓存进 core 会跨测试串味
        from ..agent.runner import TaskRunner
        runner = TaskRunner(
            self.core.agent, f"{self.core.tab_id}#c{self.core._ctx_epoch}",
            max_tool_turns=self.core.cfg.shell.max_tool_turns,
            on_event=_live,
        )
        self._seg.runner = runner   # 心跳读 token 计数
        try:
            events = await runner.run(text)
            await self._handle_events(runner, events)
        except Exception as e:  # noqa: BLE001 - 任务异常发 error 事件让前端收尾
            # 不能只靠 _run 兜底的 status——前端靠 error/final 停计时、收卡片
            self._flush_seg(failed=True)   # 残段落格标失败（非中断留痕）
            await self.core.emit_msg(ServerMsg(
                type="event", event={"kind": "error",
                                     "text": f"任务失败：{type(e).__name__}: {e}"}))
            return
        finally:
            _dbg("run_task finally")
            self._seg = _SegBuffer()   # 清缓冲：中断取消同口径，残段不泄进下个任务
            self.core.backend.on_output = None
            self.core.backend.on_start = None
            self.core.backend.on_finish = None
            self.core.backend.on_boundary = None
        # 收尾保证：final 空文（纯工具任务）也要关徽标/停计时/扫尾——
        # 旧实现该路径什么都不发，徽标永转。CLI 忽略未知事件，Web 幂等收尾
        _dbg("task_end emit")
        await self.core.emit_msg(ServerMsg(
            type="event", event={"kind": "task_end"}))
        _dbg("task_end emitted")
        # 累计会话 token 用量并上报前端状态栏。口径：真实 usage_metadata
        # 优先；网关不回传时用 tiktoken 估算（token_est），前端以 ≈ 标注
        task_in = runner.input_tokens or runner.est_input_tokens
        task_out = runner.output_tokens or runner.est_output_tokens
        if task_in or task_out:
            self.core._tokens_in += task_in
            self.core._tokens_out += task_out
            await self.core.emit_msg(ServerMsg(
                type="usage", tokens_in=self.core._tokens_in,
                tokens_out=self.core._tokens_out,
                estimated=not (runner.input_tokens or runner.output_tokens)))
    async def _change_model(self, model_id: str) -> None:
        """运行时切换模型：记录新 ModelConfig；agent 已建则重建（保留 profile/session）。"""
        if not model_id or model_id == self.core._model.model:
            return
        self.core._model = replace(self.core._model, model=model_id)
        if self.core.agent is None:
            # 尚未构建 agent（还没发起过 AI 任务）——只记录模型，_ensure_agent 会用它
            await self.core.emit_msg(ServerMsg(
                type="status", text=f"已切换模型：{model_id}"))
            return
        try:
            await self._rebuild_agent()
            await self.core.emit_msg(ServerMsg(
                type="status", text=f"已切换模型：{model_id}"))
        except Exception as e:  # noqa: BLE001 - 切换失败提示，不影响会话
            await self.core.emit_msg(ServerMsg(
                type="status", text=f"切换模型失败：{type(e).__name__}: {e}"))
    async def _handle_events(self, runner, events) -> None:
        while True:
            for ev in events:
                if ev.kind == "tool_call":
                    self.core.transcript.append("tool_call", command=ev.command)
                elif ev.kind == "tool_start" and ev.name != "execute":
                    # execute 已由 tool_call 记账，不重复落 transcript
                    self.core.transcript.append(
                        "tool_call",
                        command=ev.name + (f" {ev.text}" if ev.text else ""))
                elif ev.kind == "denied":
                    self.core.transcript.append("denied", text=ev.text)
                elif ev.kind in ("limit", "error"):
                    return
                elif ev.kind == "final":
                    self.core.transcript.append("final", text=ev.text)
                    # 吞正文留思考：缓冲 text 就是 final 答案本体（_final_text
                    # 重读同一 AIMessage），再冲刷就是分析段+总结卡同文烧两遍。
                    # 思考文本不丢：非空冲「仅思考段」。
                    seg = getattr(self, "_seg", None)
                    if seg is not None:
                        think = seg.think
                        seg.text = ""
                        seg.think = ""
                        if think.strip():
                            self.core._emit_nowait(ServerMsg(
                                type="event", event={
                                    "kind": "ai_result", "text": "",
                                    "think": think, "failed": False}))
                    await self.core.emit_msg(ServerMsg(
                        type="event",
                        event={"kind": "final", "text": ev.text}))
                    # final 总结 markdown → 前端挂总结装饰卡（§5.3）
                    await self.core.emit_msg(ServerMsg(
                        type="event",
                        event={"kind": "ai_card", "markdown": ev.text}))
            if runner.interrupt_payload is None:
                return
            requests = runner.interrupt_payload["action_requests"]
            if len(requests) > 1:
                await self.core.emit_msg(ServerMsg(
                    type="status", text=f"模型一轮发起 {len(requests)} 个命令，请逐个确认"))
            decisions: list[dict] = []
            for req in requests:
                command = req.get("args", {}).get("command", "")
                name = req.get("name") or "execute"
                # 认领工具卡（ActionRequest 无 tool_call id）：按 (name, command)
                # 有序消歧，审批事件带卡 id，按钮摆进同一张命令卡（二合一）
                seq = runner.claim_seq(name, command)
                card_id = (self.core._tool_idx_map.get(seq, 0)
                           if seq is not None else 0)
                description = req.get("description") or "高危命令需要审批"
                self.core.transcript.append("approval", command=command)
                decision = await self.core.ask_approval(
                    command, description, self.core._target_host,
                    self.core._approval_risk(command), id=card_id)
                if isinstance(decision, dict) and decision.get("allow"):
                    # 「始终允许」入会话免审集：同令后续直通（_when 同源谓词）。
                    # 旧实现从不读 allow 字段——按钮等于「执行」（假功能修复）。
                    self.core.allowed.add(command)
                    decision = {k: v for k, v in decision.items() if k != "allow"}
                decisions.append(decision)
            events = await runner.resume(decisions)
    async def _switch_display(self, mode: str) -> None:
        _dbg("switch_display", mode, "cur=", self.core._display,
             "stack=", [(f["ctx"], f["inst"]) for f in self.core._exec_stack],
             "ai=", self.core._ai_task is not None)
        if mode not in ("ssh", "agent"):
            return
        if not self.core._interactive:
            self.core._display = mode
            return
        if mode == self.core._display:
            return
        if mode == "ssh":
            # 先停 AI 并等其工具执行收尾：开关行与 runner 的 \x15/注入
            # 序列交错会污染 PTY 输入缓冲（开关不生效）
            t = self.core._ai_task
            await self._maybe_cancel_ai()
            if t is not None:
                try:
                    await asyncio.wait_for(asyncio.shield(t), 3)
                except Exception:  # noqa: BLE001 - 取消/超时都继续
                    pass
            if not await self._wait_exec_idle(5):
                await self.core.emit_msg(ServerMsg(
                    type="status",
                    text="AI 命令执行中，退出后再切 Shell 模式。"))
                return
            # su - / sudo su - / 嵌套 shell 会把 hook 集成整个丢掉:此时
            # toggle 的 __ot_exec__ 变普通命令执行(command not found),
            # 确认标记永不回来 → 下面死等 5s 才清屏(真机「切 Shell 没反应」)。
            # 先补注入(幂等,healthy shell 只重定义同名函数)再开关注入。
            await self.core.hook._ensure_integrated()
            self.core._ev_exec_end.clear()
            self.core._suppress_live = True   # 开关注入行的回显吞掉（§5.5）
            try:
                await self.core.session.send_raw(toggle_line(self.core._shell_kind, False))
                try:
                    await asyncio.wait_for(self.core._ev_exec_end.wait(), 5)
                except asyncio.TimeoutError:
                    pass    # 开关未确认也切显示（hook off 失败时字节仍原样透传）
            finally:
                self.core._suppress_live = False
                self.core._suppressed_echo = False
                self.core._suppressed_tail = ""
            self.core._display = "ssh"
            await self.core.session.send_raw(b"\x0c")   # 清屏重画，纯透传从干净屏开始
        else:
            self.core._display = "agent"
            self.core._router.reset()
            self.core._ev_prompt.clear()
            # Shell 模式期间 pump 纯透传不产生标记事件，时间戳已失效；重置为
            # 保守态（标记绝迹）——首个自然语言提交走降级路径重注入确认 hook
            self.core._last_mark_at = 0.0
            self.core._hook_stale = False
            self.core.hook._cancel_hook_watch()
            self.core._last_live_at = time.monotonic()
            self.core._suppress_live = True
            try:
                await self.core.session.send_raw(toggle_line(self.core._shell_kind, True))
                try:
                    await asyncio.wait_for(self.core._ev_prompt.wait(), 5)
                except asyncio.TimeoutError:
                    pass
            finally:
                self.core._suppress_live = False
                self.core._suppressed_echo = False
                self.core._suppressed_tail = ""
            await self.core.session.send_raw(b"\x0c")   # hook 已回 agent：清屏重画
    async def _maybe_cancel_ai(self) -> None:
        """Ctrl+C/⏹：AI 任务在跑且 shell 空闲（无打开的执行）→ 取消任务。
        有执行打开时不取消——\\x03 会直达 PTY 中断正在跑的命令。"""
        if self._ai_cancellable():
            self.core._ai_queue.clear()
            self.core._ai_task.cancel()
    def _ai_cancellable(self) -> bool:
        return self.core._ai_task is not None and not self.core._exec_stack
    async def _wait_exec_idle(self, timeout: float) -> bool:
        """等待 shell 空闲（无打开的执行上下文）。"""
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        while self.core._exec_stack:
            if loop.time() >= deadline:
                return False
            await asyncio.sleep(0.05)
        return True

    # --- 组件公开接口绑定 ---
    start_ai = _start_ai
    on_ai_line = _on_ai_line
    on_frontend_line = _on_frontend_line
    handle_slash = _handle_slash
    run_task = _run_task
    maybe_rescue = _maybe_rescue
    switch_display = _switch_display
    change_model = _change_model

    def __getattr__(self, name):
        """状态物理存 core（P3）：未知属性转发 core（_ai_task/_display 等）。"""
        return getattr(self.core, name)
