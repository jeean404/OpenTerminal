"""输出泵（Task 8 自 PipelineCore 原样搬入）——责任链编排。

PTY 字节块到达后的固定次序（分支顺序/判断条件/字节处理与搬移前逐字
一致，第一版逐条委托原组件）：

    字节块到达 →
      1. exec_events.strip_intr_echo()      # ^C 回显吞除
      2. auth.inspect_output()              # 密码提示符/验证窗/模态代关
      3. hook.observe_output() + note_mark  # hook 观测/shell 退出检测
      4. exec_events.on_stream_event/feed   # exec 标记流（OSC 切分）
      5. live 透传（emit_bytes + 幕帘扣留）

泵任务体 _pump_loop 挂 _pump_guard 死亡留痕（引用被 core._pump 持有，
asyncio 不报「未取回异常」——真机「终端彻底沉默」盲区）。
状态**物理存 core 实例**（P3 裁定延续：close/_switch_target/测试直读
core._pump/_sender；OutputPump.__init__ 以 hasattr 守卫补建，预置值
不覆盖），方法体经 self.core 访问，phase 只读转发 core._pump_phase。
_reap_zombie_ai（读 _ai_ping_at）与 _pump_eof 留 core（任务生命周期域）。
"""

from __future__ import annotations

import asyncio

from .messages import ServerMsg, _dbg


class OutputPump:
    def __init__(self, core) -> None:
        self.core = core
        for name, val in (
            ("_sender", None),          # 出站发送任务（attach 起，close 自然退）
            ("_pump", None),            # 输出泵任务（连接就绪起）
            ("_pump_phase", "read"),    # 排障：泵当前所处 stage（心跳打出）
        ):
            if not hasattr(core, name):
                setattr(core, name, val)

    # --- 组件公开接口 ---
    def start(self) -> None:
        """起 _pump/_sender/_heartbeat（已运行则跳过；连接后语境调用）。"""
        c = self.core
        if c._sender is None:
            c._sender = asyncio.create_task(self._sender_loop())
        if c._hb is None:
            c._hb = asyncio.create_task(self._heartbeat())
        if c._pump is None or c._pump.done():
            c._pump = asyncio.create_task(self._pump_guard())

    @property
    def phase(self) -> str:
        """泵当前所处 stage（排障心跳打出）。"""
        return self.core._pump_phase

    async def _pump_guard(self) -> None:
        """泵死亡留痕：任务引用被 self.core._pump 持有，异常永远不会被 asyncio 当作
        「未取回」打印出来——真机「终端彻底不再回显、日志一片安静」就此查无
        实据（第 3 轮复现里降级路径之后 90s 零字节的盲区）。"""
        try:
            await self._pump_loop()
        except asyncio.CancelledError:
            raise
        except BaseException:  # noqa: BLE001 - 只为留痕，原样重抛
            import traceback
            _dbg("pump died:", traceback.format_exc())
            raise
    async def _pump_loop(self) -> None:
        """PTY 泵：回退/Shell 模式纯透传；集成模式下按 OSC 标记切分——
        标记字节与需吞除的注入回显不外发，其余原样转发（唯一显示管线）。"""
        _tick = 0
        while not self.core._closed:
            try:
                data = await self.core.session._read_some(0.2)
            except asyncio.TimeoutError:
                # 心跳：读超时是稳态，每 10 次（≈2s）留一行。它把「远端真的
                # 沉默」与「泵死了/卡在处理器里」分开——心跳仍在 = 泵活着且
                # _read_some 正常返回，字节确实没来（第 3 轮真机盲区）。
                _tick += 1
                if _tick % 10 == 0:
                    _dbg("pump tick", _tick, "phase=", self.core._pump_phase)
                continue
            except (ConnectionError, EOFError):
                await self.core._pump_eof("连接已断开")
                return
            if data == b"":     # 本地 PTY 读者线程的 EOF 哨兵（如用户 exit）
                await self.core._pump_eof("会话已结束")
                return
            if not data:
                continue
            self.core._pump_phase = "body"
            _dbg("raw", len(data), repr(data[:60]))
            if self.core._cs_tail is not None:
                self.core._cs_tail.extend(data)
                if len(self.core._cs_tail) > 8192:
                    del self.core._cs_tail[:-8192]   # 只留尾部:提示匹配只需最近输出
            if self.core._intr_swallow_until:
                data = self.core.exec._strip_intr_echo(data)
                if not data:
                    _dbg("intr swallow: 整块被 ^C 回显吞除")
                    continue
            self.core.auth.inspect_output(data)
            await self.core.hook._detect_shell_exit(data)
            if not self.core._interactive or self.core._display == "ssh":
                self.core._pump_phase = "passthru"
                await self.core.emit_bytes(data)   # 回退模型 / Shell 模式：纯透传
                continue
            for ev in self.core._router.feed(data):
                self.core._pump_phase = "ev:" + str(ev[0])
                await self.core.exec.on_stream_event(ev)
            self.core._pump_phase = "read"
    async def _stop_pump(self) -> None:
        """停输出泵并等它真正退出。只 cancel 不等的话，泵可能还压在
        _read_some 上，抢走随后命令/探测的回显与哨兵字节（哨兵流被切坏
        → run 拿空输出）。"""
        if self.core._pump is not None:
            t, self.core._pump = self.core._pump, None
            t.cancel()
            try:
                await t
            except asyncio.CancelledError:
                # 外层任务在 `await t` 上被取消时，取消会传导给泵任务
                # （await task 的 waiter 就是任务本身），泵的 CancelledError
                # 会从这里冒出来——不能吞，否则外层的取消也被吞掉，任务
                # 变成杀不死的僵尸（teardown gather 挂死）
                if asyncio.current_task().cancelling() > 0:
                    raise
            except Exception:  # noqa: BLE001 - 会话关闭竞态（fd 失效等）
                pass
    async def _heartbeat(self) -> None:
        """应用层心跳：10s 一个 ping，给前端看门狗当「服务端还活着」基线。
        sender 卡死/sink 僵尸时 ping 与回显会同时断——前端据此判定连接无响应
        并重连，把「假活连接永久卡死」降级成一次秒级抖动（真机 2026-10-07）。"""
        while not self.core._closed:
            await asyncio.sleep(10)
            if self.core._closed:
                break
            self.core._emit_nowait(ServerMsg(type="ping"))
            await self.core._reap_zombie_ai()
    async def _sender_loop(self) -> None:
        while True:
            kind, payload = await self.core._outbox.get()
            sink = self.core._sink
            if sink is None:
                self.core._buffer_offline(kind, payload)
            else:
                try:
                    if kind == "bytes":
                        await sink.send_bytes(payload)
                    else:
                        await sink.send_text(payload)
                except Exception:
                    # sink 已死但 detach 尚未回来（网络刚断的那几毫秒）：帧必须
                    # 攒住，否则断线瞬间发出的收束帧就永久丢了（旧实现 continue
                    # 直接丢弃）。顺手摘掉死 sink，后续帧不再逐条撞异常。
                    if self.core._sink is sink:
                        self.core._sink = None
                    self.core._buffer_offline(kind, payload)
            # 关闭后把剩余消息发完（含 closed）再退出，避免协程泄漏。
            # 只看 _closed 不够：close 会先置 _closed 再入队 closed，若此刻
            # backlog 未排空，sender 会在 closed 入队前按 empty 提前退出
            if self.core._closed and self.core._closed_sent and self.core._outbox.empty():
                break

    # --- 主流程 ---
