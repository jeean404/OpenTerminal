"""连接后命令集（core/cmdset_runner.py）域测试：串行执行/密码代答/暂停恢复/回显合成/提示符身份（Task 10 分流）。"""

import asyncio
import json
import time
from types import SimpleNamespace
import openterminal.core as cmod
from openterminal.web.protocol import ClientMsg
from tests.web_fakes import (PassthroughSession, _make_worker, _sink_bytes, _wait, _wait_json)
from tests.core_fakes import FakeCore, _bare_core


def _cmdset_msgs(sink):
    return [m for m in sink.json() if m.get("type") == "cmdset"]


async def test_cmdset_serial_order_and_events(monkeypatch):
    import openterminal.web.worker as wmod
    monkeypatch.setattr(wmod, "CMDSET_ECHO_TIMEOUT", 0.05)
    monkeypatch.setattr(wmod, "CMDSET_QUIET", 0.01)
    # 两条命令都不喂回显 → 走 echo 超时 + 静默即过的快路径,断言顺序
    w, sink = await _make_worker(monkeypatch, commands=["echo one", "echo two"])
    await _wait(lambda: any(m.get("state") == "done" for m in _cmdset_msgs(sink)))
    raws = [c for c in w.session.calls if c[0] == "raw"]
    assert raws[:2] == [("raw", b"echo one\r"), ("raw", b"echo two\r")]
    running = [m for m in _cmdset_msgs(sink) if m.get("state") == "running"]
    assert running[0]["index"] == 1 and running[0]["total"] == 2
    assert running[-1]["index"] == 2


async def test_cmdset_answer_on_password_prompt(monkeypatch):
    import openterminal.shell.cmdset as cmod
    import openterminal.web.worker as wmod
    monkeypatch.setattr(wmod, "CMDSET_ECHO_TIMEOUT", 0.05)
    monkeypatch.setattr(wmod, "CMDSET_QUIET", 0.01)
    monkeypatch.setattr(wmod, "CMDSET_PROMPT_TIMEOUT", 2.0)
    monkeypatch.setattr(cmod, "load_password",
                        lambda k, u, p: "s3cret" if k == "cmdset:db01" else None)
    sess = PassthroughSession()
    w, sink = await _make_worker(monkeypatch, session=sess,
                                 commands=["ssh root@db01", "> @db01"])
    # 慢网络:提示晚到——先只喂回显,静默窗口过后再喂密码提示,仍须应答
    await asyncio.sleep(0.02)
    sess.push(b"ssh root@db01\r\n")
    await asyncio.sleep(0.15)
    sess.push(b"root@db01's password: ")
    await _wait(lambda: ("raw", b"s3cret\r") in sess.calls, timeout=5)
    msgs = await _wait_json(sink, lambda m: any(
        x.get("type") == "cmdset" and x.get("state") == "done" for x in m))


async def test_cmdset_answer_first_time_asks_and_remembers(monkeypatch):
    import openterminal.shell.cmdset as cmod
    import openterminal.web.worker as wmod
    from openterminal.web.protocol import ClientMsg
    monkeypatch.setattr(wmod, "CMDSET_ECHO_TIMEOUT", 0.05)
    monkeypatch.setattr(wmod, "CMDSET_QUIET", 0.01)
    monkeypatch.setattr(wmod, "CMDSET_PROMPT_TIMEOUT", 2.0)
    monkeypatch.setattr(cmod, "load_password", lambda k, u, p: None)  # 密钥库没有
    stored = {}
    monkeypatch.setattr(wmod, "store_password",
                        lambda k, u, p, pw: stored.__setitem__(k, pw) or True)
    sess = PassthroughSession()
    w, sink = await _make_worker(monkeypatch, session=sess,
                                 commands=["ssh db01", "> @db01"])
    # 密钥库缺失 → 弹窗询问(带 cmdset 类别)
    msgs = await _wait_json(sink, lambda m: any(
        x.get("type") == "ask_password" and x.get("auth_kind") == "cmdset"
        for x in m))
    # 模拟用户在弹窗输入(经 auth cmdset 分支回填)
    await w.handle_client(ClientMsg(type="auth", auth_kind="cmdset",
                                    text="typed-pw"))
    await _wait(lambda: stored.get("cmdset:db01") == "typed-pw", timeout=2)
    # 提示出现后,本次会话用刚输入的密码自动应答
    await asyncio.sleep(0.05)
    sess.push(b"db01's password: ")
    await _wait(lambda: ("raw", b"typed-pw\r") in sess.calls, timeout=5)


async def test_cmdset_answer_empty_submit_skips(monkeypatch):
    import openterminal.shell.cmdset as cmod
    import openterminal.web.worker as wmod
    from openterminal.web.protocol import ClientMsg
    monkeypatch.setattr(wmod, "CMDSET_ECHO_TIMEOUT", 0.05)
    monkeypatch.setattr(wmod, "CMDSET_QUIET", 0.01)
    monkeypatch.setattr(wmod, "CMDSET_PROMPT_TIMEOUT", 0.3)
    monkeypatch.setattr(cmod, "load_password", lambda k, u, p: None)
    w, sink = await _make_worker(
        monkeypatch, commands=["ssh db01", "> @nope", "echo ok"])
    await _wait_json(sink, lambda m: any(
        x.get("type") == "ask_password" for x in m))
    await w.handle_client(ClientMsg(type="auth", auth_kind="cmdset", text=""))
    msgs = await _wait_json(sink, lambda m: any(
        "已跳过自动应答" in x.get("text", "") for x in m))
    # 空提交:跳过该应答行,后续命令照常执行
    await _wait(lambda: ("raw", b"echo ok\r") in w.session.calls)


async def test_cmdset_answer_prompt_timeout_skips(monkeypatch):
    import openterminal.shell.cmdset as cmod
    import openterminal.web.worker as wmod
    monkeypatch.setattr(wmod, "CMDSET_ECHO_TIMEOUT", 0.05)
    monkeypatch.setattr(wmod, "CMDSET_QUIET", 0.01)
    monkeypatch.setattr(wmod, "CMDSET_PROMPT_TIMEOUT", 0.2)
    monkeypatch.setattr(cmod, "load_password",
                        lambda k, u, p: "s3cret" if k == "cmdset:db01" else None)
    w, sink = await _make_worker(monkeypatch, commands=["ssh db01", "> @db01"])
    msgs = await _wait_json(sink, lambda m: any(
        "未检测到交互提示" in x.get("text", "") for x in m))
    await _wait(lambda: any(m.get("state") == "done" for m in _cmdset_msgs(sink)))
    # 明文/引用都不该被盲目发出
    assert not any(c[1] == b"s3cret\r" for c in w.session.calls if c[0] == "raw")


async def test_cmdset_comments_and_blank_skipped(monkeypatch):
    import openterminal.web.worker as wmod
    monkeypatch.setattr(wmod, "CMDSET_ECHO_TIMEOUT", 0.05)
    monkeypatch.setattr(wmod, "CMDSET_QUIET", 0.01)
    w, sink = await _make_worker(
        monkeypatch, commands=["# 注释", "", "echo real"])
    await _wait(lambda: any(m.get("state") == "done" for m in _cmdset_msgs(sink)))
    raws = [c for c in w.session.calls if c[0] == "raw"]
    assert raws == [("raw", b"echo real\r")]
    assert _cmdset_msgs(sink)[0]["total"] == 1


async def test_cmdset_answer_prompt_with_echo_fast_network(monkeypatch):
    # 快网络:密码提示随命令回显同批到达(命令阶段内)——不得因缓冲重置
    # 而丢弃,应答仍须发出(C1:旧实现在命令阶段结束清空 tail)
    import openterminal.shell.cmdset as cmod
    import openterminal.web.worker as wmod
    monkeypatch.setattr(wmod, "CMDSET_ECHO_TIMEOUT", 0.5)
    monkeypatch.setattr(wmod, "CMDSET_QUIET", 0.05)
    monkeypatch.setattr(wmod, "CMDSET_PROMPT_TIMEOUT", 1.0)
    monkeypatch.setattr(cmod, "load_password",
                        lambda k, u, p: "s3cret" if k == "cmdset:db01" else None)
    sess = PassthroughSession()
    w, sink = await _make_worker(monkeypatch, session=sess,
                                 commands=["ssh db01", "> @db01"])
    await asyncio.sleep(0.05)          # runner 已进入命令行阶段、开始等回显
    sess.push(b"ssh db01\r\npassword: ")   # 回显与提示同批到达
    await _wait(lambda: ("raw", b"s3cret\r") in sess.calls, timeout=3)
    msgs = await _wait_json(sink, lambda m: any(
        x.get("type") == "cmdset" and x.get("state") == "done" for x in m))


async def test_cmdset_reconnect_cancels_previous_runner(monkeypatch):
    # 重连时必须先取消在跑的旧 runner:否则双 runner 交错写 PTY、抢 _pws 队列
    import openterminal.web.worker as wmod
    w, sink = await _make_worker(monkeypatch)   # 无 commands:不自动启动
    w._target = SimpleNamespace(commands=["echo x"])
    w._shell_kind = None        # 历史注入跳过(种类未知)
    w._b64flag = "-d"
    old = asyncio.create_task(w.cs._run_command_set())
    w._cs_task = old
    await w._on_session_reconnect()
    await asyncio.sleep(0.05)
    assert old.cancelled(), "旧 runner 未被取消(默认 2s 回显窗内必未自然结束)"


async def test_cmdset_pause_on_unanswered_prompt_resumes_after_input(monkeypatch):
    # 无应答行 + 终端停在密码提示 → 暂停等用户;提示消失且静默后自动继续
    import openterminal.web.worker as wmod
    monkeypatch.setattr(wmod, "CMDSET_ECHO_TIMEOUT", 0.3)
    monkeypatch.setattr(wmod, "CMDSET_QUIET", 0.02)
    monkeypatch.setattr(wmod, "CMDSET_RESUME_QUIET", 0.3)
    sess = PassthroughSession()
    w, sink = await _make_worker(monkeypatch, session=sess,
                                 commands=["sudo su -", "cd /tmp"])
    await asyncio.sleep(0.05)
    sess.push(b"sudo su -\r\n[sudo] password for xiaojian: ")
    # 暂停事件出现,且 cd /tmp 不被抢跑塞进密码提示
    msgs = await _wait_json(sink, lambda m: any(
        x.get("type") == "cmdset" and x.get("state") == "paused" for x in m),
        timeout=3)
    await asyncio.sleep(0.2)
    assert ("raw", b"cd /tmp\r") not in sess.calls
    # 模拟用户在终端输完密码(sudo 通过,提示消失,回到 root 提示符)
    sess.push(b"\r\n[root@VM-0-11-centos ~]# ")
    await _wait(lambda: ("raw", b"cd /tmp\r") in sess.calls, timeout=5)


async def test_cmdset_resume_button_forces_continue(monkeypatch):
    # 「继续」按钮(cmdset_resume)在提示仍在时也能强制放行
    import openterminal.web.worker as wmod
    from openterminal.web.protocol import ClientMsg
    monkeypatch.setattr(wmod, "CMDSET_ECHO_TIMEOUT", 0.3)
    monkeypatch.setattr(wmod, "CMDSET_QUIET", 0.02)
    monkeypatch.setattr(wmod, "CMDSET_RESUME_QUIET", 5.0)
    sess = PassthroughSession()
    w, sink = await _make_worker(monkeypatch, session=sess,
                                 commands=["sudo su -", "cd /tmp"])
    await asyncio.sleep(0.05)
    sess.push(b"sudo su -\r\n[sudo] password for xiaojian: ")
    await _wait_json(sink, lambda m: any(
        x.get("type") == "cmdset" and x.get("state") == "paused" for x in m),
        timeout=3)
    await w.handle_client(ClientMsg(type="cmdset_resume"))
    await _wait(lambda: ("raw", b"cd /tmp\r") in sess.calls, timeout=3)


async def test_cmdset_secret_answer_skips_confirm_prompt(monkeypatch):
    # @引用(密码)不得应答 yes/no 类确认提示:那类提示回显输入,密码会
    # 明文漏进终端(真机:跳转时 host key 确认先弹,密码被打进该提示)
    import openterminal.shell.cmdset as cmod
    import openterminal.web.worker as wmod
    monkeypatch.setattr(wmod, "CMDSET_ECHO_TIMEOUT", 0.05)
    monkeypatch.setattr(wmod, "CMDSET_QUIET", 0.01)
    monkeypatch.setattr(wmod, "CMDSET_PROMPT_TIMEOUT", 2.0)
    monkeypatch.setattr(cmod, "load_password",
                        lambda k, u, p: "s3cret" if k == "cmdset:db01" else None)
    sess = PassthroughSession()
    w, sink = await _make_worker(monkeypatch, session=sess,
                                 commands=["ssh db01", "> @db01"])
    await asyncio.sleep(0.05)
    sess.push(b"Are you sure you want to continue connecting (yes/no)? ")
    await asyncio.sleep(0.5)
    # 密码不该被打进确认提示(那里回显,会明文泄漏)
    assert not any(c[1] == b"s3cret\r" for c in sess.calls if c[0] == "raw")
    # 随后真正的密码提示出现 → 应答正常发出
    sess.push(b"db01's password: ")
    await _wait(lambda: ("raw", b"s3cret\r") in sess.calls, timeout=5)


async def test_cmdset_bare_crlf_after_password_does_not_unleash_next_command(monkeypatch):
    # 回归(2026-10-07 真机):ssh/sudo 读完密码先回一个裸 CRLF——提示文本没了,
    # 但 auth 还没出结果、TTY 仍关回显。旧收束条件是「提示消失+静默」,下一条
    # 就射进这个无回显窗口:被执行却一条回显都没有(界面只显示第 1 条命令,
    # 还要按 Enter 才刷新状态)。收束信号必须是 shell 提示符回来。
    import openterminal.web.worker as wmod
    monkeypatch.setattr(wmod, "CMDSET_ECHO_TIMEOUT", 0.2)
    monkeypatch.setattr(wmod, "CMDSET_QUIET", 0.02)
    monkeypatch.setattr(wmod, "CMDSET_PROMPT_TIMEOUT", 5.0)
    monkeypatch.setattr(wmod, "CMDSET_RESUME_QUIET", 0.05)   # 旧放行窗:压到极短
    sess = PassthroughSession()
    w, sink = await _make_worker(monkeypatch, session=sess,
                                 commands=["ssh web02", "sudo su -"])
    await asyncio.sleep(0.05)
    sess.push(b"ssh web02\r\n")
    await asyncio.sleep(0.05)
    sess.push(b"web02's password: ")
    await _wait_json(sink, lambda m: any(
        x.get("type") == "cmdset" and x.get("state") == "paused" for x in m),
        timeout=3)
    assert ("raw", b"sudo su -\r") not in sess.calls
    # 用户在终端输完密码 → ssh 吐一个裸 CRLF(提示正则不再匹配,但 shell
    # 提示符还没回来)
    sess.push(b"\r\n")
    await asyncio.sleep(0.6)                 # 远超旧 RESUME_QUIET 放行窗
    assert ("raw", b"sudo su -\r") not in sess.calls, \
        "密码刚提交(裸 CRLF)就抢跑注入下一条——射进无回显窗口"
    # 登录成功、新 shell 提示符回来:此刻才允许发下一条
    sess.push(b"Last login: Wed Oct  7 15:27:35 2026\r\n[web02@web02 ~]$ ")
    await _wait(lambda: ("raw", b"sudo su -\r") in sess.calls, timeout=5)


async def test_cmdset_full_set_shows_every_command(monkeypatch):
    # 真机用例复刻:连接后命令 `ssh …` / `sudo su -` / `cd /root` 三条都要上屏、
    # 都要真发出;每条只在上一条的交互提示解决完(见到 shell 提示符)后才发。
    import openterminal.web.worker as wmod
    monkeypatch.setattr(wmod, "CMDSET_ECHO_TIMEOUT", 0.25)
    monkeypatch.setattr(wmod, "CMDSET_QUIET", 0.02)
    monkeypatch.setattr(wmod, "CMDSET_PROMPT_TIMEOUT", 5.0)
    sess = PassthroughSession()
    w, sink = await _make_worker(monkeypatch, session=sess,
                                 commands=["ssh web02", "sudo su -", "cd /root"])
    await asyncio.sleep(0.05)
    # ① ssh:回显 + 密码提示 → 暂停等输入
    sess.push(b"ssh web02\r\n")
    await asyncio.sleep(0.05)
    sess.push(b"web02's password: ")
    await _wait_json(sink, lambda m: any(
        x.get("type") == "cmdset" and x.get("state") == "paused" for x in m),
        timeout=3)
    sess.push(b"\r\n")                       # 密码提交(裸 CRLF)
    await asyncio.sleep(0.3)
    assert ("raw", b"sudo su -\r") not in sess.calls
    sess.push(b"Last login: Wed Oct  7 15:27:35 2026\r\n[web02@web02 ~]$ ")
    await _wait(lambda: ("raw", b"sudo su -\r") in sess.calls, timeout=5)
    # ② sudo su -:又弹密码提示 → 再暂停,cd /root 不得抢跑
    sess.push(b"sudo su -\r\n[sudo] password for web02: ")
    await _wait(lambda: ("raw", b"cd /root\r") not in sess.calls, timeout=1)
    await asyncio.sleep(0.3)
    assert ("raw", b"cd /root\r") not in sess.calls
    sess.push(b"\r\n")
    await asyncio.sleep(0.3)
    sess.push(b"[root@web02 ~]# ")
    await _wait(lambda: ("raw", b"cd /root\r") in sess.calls, timeout=5)
    # 三条命令的执行记录都要上屏(回显或补画),否则用户只看得到第 1 条
    await _wait(lambda: all(x in _sink_bytes(sink)
                            for x in (b"ssh web02", b"sudo su -", b"cd /root")),
                timeout=3)


async def test_cmdset_synthesizes_missing_echo(monkeypatch):
    # TTY 关回显时命令一条回显都没有(真机「只显示第 1 条命令的执行记录」):
    # 回显等不到就补画命令行,至少让用户看得到这条执行了什么。
    import openterminal.web.worker as wmod
    monkeypatch.setattr(wmod, "CMDSET_ECHO_TIMEOUT", 0.1)
    monkeypatch.setattr(wmod, "CMDSET_QUIET", 0.02)
    w, sink = await _make_worker(monkeypatch, commands=["cd /root"])
    await asyncio.wait_for(w.connected.wait(), timeout=2)
    await _wait(lambda: ("raw", b"cd /root\r") in w.session.calls, timeout=3)
    await _wait(lambda: b"cd /root" in _sink_bytes(sink), timeout=3)


async def test_cmdset_running_carries_cmd_and_blanks_answers(monkeypatch):
    # 状态栏要说清在跑哪条(只报 1/3 计数看不出第 2、3 条执行了没有);
    # 应答行必须传空串,防密码原文泄进状态栏。
    import openterminal.web.worker as wmod
    monkeypatch.setattr(wmod, "CMDSET_ECHO_TIMEOUT", 0.05)
    monkeypatch.setattr(wmod, "CMDSET_QUIET", 0.01)
    monkeypatch.setattr(wmod, "CMDSET_PROMPT_TIMEOUT", 0.3)
    w, sink = await _make_worker(monkeypatch,
                                 commands=["echo one", "> s3cret-pw"])
    await _wait_json(sink, lambda m: any(
        x.get("type") == "cmdset" and x.get("state") == "done" for x in m),
        timeout=3)
    running = [m for m in _cmdset_msgs(sink) if m.get("state") == "running"]
    assert running[0].get("cmd") == "echo one"
    # 应答行不带内容(空字段被 encode_server 丢弃):状态栏只显示计数
    assert not running[1].get("cmd")
    assert "s3cret-pw" not in json.dumps(sink.json(), ensure_ascii=False)


async def test_cmdset_wrong_password_keeps_paused(monkeypatch):
    # 输错密码 → 提示重现,必须保持暂停,不能把下一条命令射进去当密码吃掉
    import openterminal.web.worker as wmod
    monkeypatch.setattr(wmod, "CMDSET_ECHO_TIMEOUT", 0.2)
    monkeypatch.setattr(wmod, "CMDSET_QUIET", 0.02)
    monkeypatch.setattr(wmod, "CMDSET_PROMPT_TIMEOUT", 5.0)
    sess = PassthroughSession()
    w, sink = await _make_worker(monkeypatch, session=sess,
                                 commands=["ssh web02", "sudo su -"])
    await asyncio.sleep(0.05)
    sess.push(b"ssh web02\r\n")
    await asyncio.sleep(0.05)
    sess.push(b"web02's password: ")
    await _wait_json(sink, lambda m: any(
        x.get("type") == "cmdset" and x.get("state") == "paused" for x in m),
        timeout=3)
    sess.push(b"\r\nPermission denied, please try again.\r\nweb02's password: ")
    await asyncio.sleep(0.5)
    assert ("raw", b"sudo su -\r") not in sess.calls, \
        "密码错(提示重现)仍抢跑注入下一条"


async def test_cmdset_shell_prompt_with_ansi_still_unblocks(monkeypatch):
    # 提示符重绘/PSReadLine 上色会在行尾留转义序列：不剥 ANSI 就判不出
    # 「shell 提示符回来了」，命令集每条白等 CMDSET_PROMPT_TIMEOUT 才放行
    # （真机浏览器复现：提示符 3.1s 回来，第 2 条 13.2s 才发出去）。
    import openterminal.web.worker as wmod
    monkeypatch.setattr(wmod, "CMDSET_ECHO_TIMEOUT", 0.2)
    monkeypatch.setattr(wmod, "CMDSET_QUIET", 0.02)
    monkeypatch.setattr(wmod, "CMDSET_PROMPT_TIMEOUT", 5.0)
    sess = PassthroughSession()
    w, sink = await _make_worker(monkeypatch, session=sess,
                                 commands=["ssh web02", "sudo su -"])
    await asyncio.sleep(0.05)
    sess.push(b"ssh web02\r\n")
    await asyncio.sleep(0.05)
    sess.push(b"web02's password: ")
    await _wait_json(sink, lambda m: any(
        x.get("type") == "cmdset" and x.get("state") == "paused" for x in m),
        timeout=3)
    t0 = time.monotonic()
    # 裸 CRLF + 带转义序列的提示符（标题/光标显隐/颜色复位）
    sess.push(b"\r\n\x1b]0;web02: ~\x07\x1b[?25h[web02@web02 ~]$ \x1b[0m")
    await _wait(lambda: ("raw", b"sudo su -\r") in sess.calls, timeout=3)
    elapsed = time.monotonic() - t0
    assert elapsed < 2.0, f"被转义序列卡住: {elapsed:.2f}s 后才发下一条"


def test_cs_prompt_identity_falls_back_to_router_prompt():
    """尾窗全空时退回路由捕获的提示符——否则基线永远种不下。

    真机 2026-10-08：命令集第一条命令时尾窗还是空的（连接后没有任何泵输出
    进尾窗），只认尾窗 → ident None → 基线不记账；第二条命令时 base is None
    → 换壳判定被短路（changed=False）→ sudo su - 打进裸壳，回显白色不青。
    """
    c = _bare_core(_cs_tail=None, _cur_prompt="[ubuntu@VM-0-5-ubuntu ~]$ ")
    assert c.cs._cs_prompt_identity() == "ubuntu@VM-0-5-ubuntu"
    c2 = _bare_core(_cs_tail=bytearray(), _cur_prompt="[ubuntu@VM-0-5-ubuntu ~]$ ")
    assert c2.cs._cs_prompt_identity() == "ubuntu@VM-0-5-ubuntu", "空尾窗同样要退回"


def test_cs_prompt_identity_prefers_tail_over_router_prompt():
    """尾窗有内容就以末个非空行为准（比 _cur_prompt 新鲜）。"""
    tail = ("[xiaojian@VM-0-11-centos ~]$ " + chr(13) + chr(10)).encode()
    c = _bare_core(_cs_tail=bytearray(tail),
                   _cur_prompt="[ubuntu@VM-0-5-ubuntu ~]$ ")
    assert c.cs._cs_prompt_identity() == "xiaojian@VM-0-11-centos"


def test_cs_prompt_identity_no_fallback_when_tail_has_output():
    """末个非空行是输出文本（Last login）时返回 None，不退回 _cur_prompt。

    _cur_prompt 只在装了 hook 的壳里更新：刚跳进裸壳时它还是外层壳的身份，
    拿它记账会把换壳判成同壳。None 不改基线，下一次门禁仍判得出换壳。
    """
    tail = ("[ubuntu@VM-0-5-ubuntu ~]$ " + chr(13) + chr(10)
            + "Last login: Thu Oct  8 23:12:52 2026" + chr(13) + chr(10)).encode()
    c = _bare_core(_cs_tail=bytearray(tail),
                   _cur_prompt="[ubuntu@VM-0-5-ubuntu ~]$ ")
    assert c.cs._cs_prompt_identity() is None


def test_cmdset_runner_owns_state():
    from openterminal.core.cmdset_runner import CmdsetRunner
    core = FakeCore()
    CmdsetRunner(core)
    for attr in ("_cs_tail", "_cs_pw_pending", "_cs_prompt_id",
                 "_cs_task", "_cs_resume"):
        assert hasattr(core, attr), attr


def test_cmdset_constants_live_in_runner_module():
    from openterminal.core import cmdset_runner as cr
    assert cr.CMDSET_ECHO_TIMEOUT > 0 and cr.CMDSET_PROMPT_TIMEOUT > 0
    assert cr.CMDSET_QUIET > 0 and cr.CMDSET_HOOK_WAIT > 0
    assert cr._CMDSET_PROMPT_RE is not None and cr._CS_PROMPT_ID_RE is not None
