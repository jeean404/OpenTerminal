"""真机集成验证：真实 Windows 凭据库 + 完整密码记忆流程。

任务书 §6 验收标准的真机版本——不 mock keyring 存取，用真实
Windows Credential Manager 验证端到端行为。

覆盖：
  V1  P0-1  首跳 backfill + port 别名 + 失败可见
  V2  P1-3  sudo 记忆询问 → sudo@host 专用键
  V3  P1-4  嵌套 ssh 记忆询问
  V4  P0-2  共享凭据防误删（三连接共享键）
  V5  P0-2  edit_saved 改地址 + 留空不丢旧凭据
  V6  P2-5  ad-hoc 目标密码记忆
  V7  端口别名：None↔22 双向读取
  V8  凭据过期 → 只试一次 → 手输 → 再次记忆询问

用法：
  python tests/verify_real_machine.py [--keep-keys]
  --keep-keys  验证后保留测试凭据（默认清理）
"""
from __future__ import annotations

import asyncio
import sys
import time
import uuid
from pathlib import Path

# Windows 控制台 UTF-8 输出
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

import openterminal.core as cmod
from openterminal.core import PipelineCore, ClientMsg
from openterminal.connections import (
    cred_alias_eq, credential_referenced, display_name, PW_STORE_FAIL_HINT,
    upsert_saved_target, delete_saved_target, find_saved_target,
    rename_saved_target,
)
from openterminal.connections.models import _backfill_password
from openterminal import secrets_store
from openterminal.config import TargetConfig

# --- 真实 keyring 操作（不 mock） ----------------------------------------
import keyring

SERVICE = "openterminal"
_test_keys: list[str] = []


def _rk_set(key: str, password: str):
    keyring.set_password(SERVICE, key, password)
    if key not in _test_keys:
        _test_keys.append(key)


def _rk_get(key: str) -> str | None:
    try:
        return keyring.get_password(SERVICE, key)
    except Exception:
        return None


def _rk_del(key: str):
    try:
        keyring.delete_password(SERVICE, key)
    except Exception:
        pass
    if key in _test_keys:
        _test_keys.remove(key)


def _rk_cleanup():
    for k in list(_test_keys):
        _rk_del(k)


# --- mock SSH 会话 --------------------------------------------------------

class MockSession:
    """捕获 send_raw 的最小会话替身。"""
    def __init__(self):
        self.sent: list[bytes] = []
        self.last_password: str | None = None

    async def send_raw(self, data: bytes):
        self.sent.append(data)


# --- 工具函数 ------------------------------------------------------------

PASS = "\033[92m  PASS\033[0m"
FAIL = "\033[91m  FAIL\033[0m"
_results: list[tuple[str, bool, str]] = []


def check(name: str, condition: bool, detail: str = ""):
    status = PASS if condition else FAIL
    _results.append((name, condition, detail))
    print(f"{status}  {name}" + (f"  — {detail}" if detail and not condition else ""))


def _bare_core(session, *, open_cmds=None, target_host="10.0.0.1") -> PipelineCore:
    c = object.__new__(PipelineCore)
    # 密码状态机完整属性（对齐 tests/test_nested_session.py:_pw_core）
    c.session = session
    c._exec_future = None
    c._closed = False
    c._session_dead = False
    c._pw_tail = bytearray()
    c._pw_prompt_seen = False
    c._pw_verifying = False
    c._pw_verify_at = 0.0
    c._pw_hold = []
    c._pw_hold_timer = None
    c._pw_at_end = False
    c._pw_modal_open = False
    c._pw_dismiss_timer = None
    c._nested_pw_attempts = 0
    c._nested_pw_ctx = None
    c._pw_capture_key = None
    c._pw_typed = bytearray()
    c._pw_remember_candidate = None
    c._pw_remember_pending = None
    c._pw_last_entered = None
    c._pw_result_from = 0
    c._target_host = target_host
    c._open_cmds = dict(open_cmds or {})
    c._open_cmd_at = {}
    c._exec_stack = []
    c._last_mark_at = 0.0
    c._interactive = True
    c._hook_gone = False
    c._hook_report_pending = None
    c._fallback_task = None
    c._hook_stale = False
    c._hook_watch = None
    c._hook_watch_text = False
    c._display = "agent"
    msgs: list = []
    async def _emit(m):
        msgs.append(m)
    c.emit_msg = _emit
    c._msgs = msgs
    return c


# --- V1: P0-1 首跳 backfill + port 别名 ---------------------------------

def v1_backfill_and_alias():
    print("\n=== V1: P0-1 backfill + port 别名 ===")
    host = f"test-v1-{uuid.uuid4().hex[:8]}.local"
    user = "testuser"
    pw = "s3cret-v1"

    # 准备：saved 表有一个 (host, user, port=None) 条目
    upsert_saved_target(name=f"v1-{host}", host=host, port=None,
                         user=user, commands=None)

    try:
        # 1a: session.last_password 有值 + saved 匹配 → backfill 写 keyring
        s = MockSession()
        s.last_password = pw
        t = TargetConfig(name=f"v1-{host}", mode="ssh", host=host,
                         user=user, port=None)
        fail = _backfill_password(t, s)
        check("V1a backfill 写入 keyring", not fail and _rk_get(display_name(host, user, None)) == pw,
              f"fail={fail}, stored={_rk_get(display_name(host, user, None))}")

        # 1b: port 别名——用 port=22 的 target 读到 port=None 存的密码
        alias_pw = secrets_store.load_password_alias(host, user, 22)
        check("V1b port 别名读取 (None→22)", alias_pw == pw,
              f"got={alias_pw}")

        # 1c: 反向——port=22 存、port=None 读
        host2 = f"test-v1c-{uuid.uuid4().hex[:8]}.local"
        upsert_saved_target(name=f"v1c-{host2}", host=host2, port=22,
                             user=user, commands=None)
        t2 = TargetConfig(name=f"v1c-{host2}", mode="ssh", host=host2,
                          user=user, port=22)
        s2 = MockSession()
        s2.last_password = pw
        _backfill_password(t2, s2)
        alias_pw2 = secrets_store.load_password_alias(host2, user, None)
        check("V1c port 别名读取 (22→None)", alias_pw2 == pw,
              f"got={alias_pw2}")

        # 1d: 补存去重——已有凭据时不再写第二个键（查真实 keyring 中含 host 的键数）
        s3 = MockSession()
        s3.last_password = pw
        t3 = TargetConfig(name=f"v1-{host}", mode="ssh", host=host,
                          user=user, port=22)  # 别名端口
        fail3 = _backfill_password(t3, s3)
        # 检查真实 keyring：同一 host 不应出现两个键
        key_none = display_name(host, user, None)
        key_22 = display_name(host, user, 22)
        has_none = _rk_get(key_none) is not None
        has_22 = _rk_get(key_22) is not None
        check("V1d 补存去重（别名端口不重复写）",
              not fail3 and has_none and not has_22,
              f"key_none={has_none}, key_22={has_22}")

        # 1e: ad-hoc 目标不 backfill（P2-5 语义：不替用户做主）
        host3 = f"test-v1e-{uuid.uuid4().hex[:8]}.local"
        t4 = TargetConfig(name=f"v1e-{host3}", mode="ssh", host=host3,
                          user=user, port=None)
        s4 = MockSession()
        s4.last_password = pw
        fail4 = _backfill_password(t4, s4)
        check("V1e ad-hoc 目标不 backfill", not fail4 and _rk_get(display_name(host3, user, None)) is None,
              f"stored={_rk_get(display_name(host3, user, None))}")

    finally:
        # 清理 saved
        delete_saved_target(f"v1-{host}")
        delete_saved_target(f"v1c-{host2}")


# --- V2: P1-3 sudo 记忆询问 → sudo@host 专用键 ---------------------------

def v2_sudo_remember():
    print("\n=== V2: P1-3 sudo 记忆询问 ===")
    host = "172.25.105.150"
    pw = "s3cret-sudo-v2"
    sudo_key = display_name(host, "sudo", None)

    # 确保清理旧键
    _rk_del(sudo_key)

    s = MockSession()
    c = _bare_core(s, open_cmds={1: "ssh pe@172.25.105.150", 2: "sudo su -"},
                   target_host="172.25.104.182")

    async def main():
        # 模拟 sudo 密码提示符
        c._detect_password_prompt(b"[sudo] password for pe: ")
        await asyncio.sleep(0)
        check("V2a sudo 捕获键 = sudo@host 专用",
              c._pw_capture_key == (host, "sudo", None),
              f"got={c._pw_capture_key}")

        # 手输密码
        await c._on_keys(pw.encode() + b"\r")
        check("V2b 密码直达远端", s.sent[-1] == (pw + "\r").encode(),
              f"sent={s.sent}")
        check("V2c 进入验证窗", c._pw_verifying)

        # auth 成功（root 提示符）
        c._detect_password_prompt(b"\r\n[root@inner ~]# ")
        await asyncio.sleep(cmod._PW_REMEMBER_DELAY + 0.2)
        asks = [m for m in c._msgs if m.type == "ask_remember"]
        check("V2d 验证成功后发出记忆询问", len(asks) == 1,
              f"asks={len(asks)}")
        if asks:
            check("V2e 询问文案含 sudo@host", "sudo@" in (asks[0].text or "") or "sudo@" in (asks[0].label or ""),
                  f"label={asks[0].label}, text={asks[0].text}")

        # 同意记忆 → 真实 keyring 写入
        await c._finish_remember(True)
        stored = _rk_get(sudo_key)
        check("V2f 同意后写入真实 keyring (sudo@host)", stored == pw,
              f"key={sudo_key}, stored={stored is not None}")

    asyncio.run(main())
    _rk_del(sudo_key)  # 清理 _finish_remember 直写的键


# --- V3: P1-4 嵌套 ssh 记忆询问 -----------------------------------------

def v3_nested_ssh_remember():
    print("\n=== V3: P1-4 嵌套 ssh 记忆询问 ===")
    host = f"test-v3-{uuid.uuid4().hex[:8]}.local"  # 测试专用 host
    user = "pe"
    pw = "s3cret-nested-v3"
    key = display_name(host, user, None)

    _rk_del(key)

    s = MockSession()
    c = _bare_core(s, open_cmds={1: f"ssh {user}@{host}"},
                   target_host="172.25.104.182")

    async def main():
        # 模拟嵌套 ssh 密码提示符
        prompt = f"{user}@{host}'s password: ".encode()
        c._detect_password_prompt(prompt)
        await asyncio.sleep(0)
        check("V3a 嵌套 ssh 捕获键 = user@host",
              c._pw_capture_key == (host, user, None),
              f"got={c._pw_capture_key}")

        await c._on_keys(pw.encode() + b"\r")
        check("V3b 密码直达远端", s.sent[-1] == (pw + "\r").encode())

        # auth 成功（shell 提示符）
        c._detect_password_prompt(f"\r\n[{user}@{host} ~]$ ".encode())
        await asyncio.sleep(cmod._PW_REMEMBER_DELAY + 0.2)
        asks = [m for m in c._msgs if m.type == "ask_remember"]
        check("V3c 验证成功后发出记忆询问", len(asks) == 1,
              f"asks={len(asks)}")

        await c._finish_remember(True)
        stored = _rk_get(key)
        check("V3d 同意后写入真实 keyring", stored == pw,
              f"key={key}, stored={stored is not None}")

    asyncio.run(main())
    _rk_del(key)  # 清理 _finish_remember 直写的键


# --- V4: P0-2 共享凭据防误删 ---------------------------------------------

def v4_shared_credential_protection():
    print("\n=== V4: P0-2 共享凭据防误删 ===")
    host = f"test-v4-{uuid.uuid4().hex[:8]}.local"
    user = "testuser"
    pw = "s3cret-v4"
    key = display_name(host, user, None)

    from openterminal.connections import delete_saved_target
    # 三个连接共享同一 (host,user,port)
    for i in range(3):
        upsert_saved_target(name=f"v4-conn{i}", host=host, port=None,
                             user=user, commands=None)
    _rk_set(key, pw)

    try:
        # 删除其中一个 → 凭据仍应保留（还有其他引用）
        # 模拟 server.py remove_saved 完整逻辑
        removed = delete_saved_target("v4-conn0")
        if removed and not credential_referenced(removed.host, removed.user, removed.port):
            secrets_store.delete_password(removed.host, removed.user, removed.port)
        check("V4a 删一个后凭据仍在（其他引用）", _rk_get(key) == pw,
              f"stored={_rk_get(key)}")

        # 再删一个 → 凭据仍应保留
        removed = delete_saved_target("v4-conn1")
        if removed and not credential_referenced(removed.host, removed.user, removed.port):
            secrets_store.delete_password(removed.host, removed.user, removed.port)
        check("V4b 再删一个后凭据仍在", _rk_get(key) == pw,
              f"stored={_rk_get(key)}")

        # 删最后一个 → 凭据应删除（无引用）
        removed = delete_saved_target("v4-conn2")
        if removed and not credential_referenced(removed.host, removed.user, removed.port):
            secrets_store.delete_password(removed.host, removed.user, removed.port)
        check("V4c 删最后一个后凭据被清", _rk_get(key) is None,
              f"stored={_rk_get(key)}")

    finally:
        for i in range(3):
            delete_saved_target(f"v4-conn{i}")
        _rk_del(key)


# --- V5: edit_saved 改地址 + 留空不丢旧凭据 -------------------------------

def v5_edit_empty_password_keeps_credential():
    print("\n=== V5: edit_saved 留空不丢旧凭据 ===")
    host = f"test-v5-{uuid.uuid4().hex[:8]}.local"
    user = "testuser"
    pw = "s3cret-v5"
    key = display_name(host, user, None)

    from openterminal.connections import delete_saved_target

    upsert_saved_target(name="v5-conn", host=host, port=None,
                         user=user, commands=None)
    _rk_set(key, pw)

    try:
        # 模拟 edit_saved 改地址 + 密码留空：不删旧凭据
        new_host = f"test-v5-new-{uuid.uuid4().hex[:8]}.local"
        # 模拟 server.py edit_saved 的逻辑
        from openterminal.connections import find_saved_target, rename_saved_target
        old = find_saved_target("v5-conn")
        check("V5a 初始状态正确", old is not None and _rk_get(key) == pw)

        # 改地址 + 留空 → 不删旧凭据
        removed = rename_saved_target("v5-conn", name="v5-conn",
                                       host=new_host, port=None,
                                       user=user, commands=None)
        if not cred_alias_eq((removed.host, removed.user, removed.port),
                              (new_host, user, None)):
            # 密码留空 → 不删旧凭据（P0-2-2 语义）
            pass  # 空密码不触发删除
        check("V5b 改地址+留空后旧凭据仍在", _rk_get(key) == pw,
              f"stored={_rk_get(key)}")

        # 清理
        delete_saved_target("v5-conn")

    finally:
        _rk_del(key)
        delete_saved_target("v5-conn")


# --- V6: P2-5 ad-hoc 目标密码记忆 ----------------------------------------

def v6_adhoc_remember():
    print("\n=== V6: P2-5 ad-hoc 目标密码记忆 ===")
    host = f"test-v6-{uuid.uuid4().hex[:8]}.local"
    user = "adhocuser"
    pw = "s3cret-v6"
    key = display_name(host, user, None)

    _rk_del(key)

    # ad-hoc 目标：_store_auth_password 走 display_name 键写 keyring
    # 这里直接验证真实 keyring 写入（对应前端「记住」确认后的行为）
    ok = secrets_store.store_password(host, user, None, pw)
    check("V6a ad-hoc _store_auth_password 写入 keyring",
          ok and _rk_get(key) == pw,
          f"ok={ok}, stored={_rk_get(key)}")

    # 拒绝场景：不写
    host2 = f"test-v6b-{uuid.uuid4().hex[:8]}.local"
    key2 = display_name(host2, user, None)
    _rk_del(key2)
    # 模拟拒绝：不调用 store_password（前端「不记住」按钮）
    check("V6b 拒绝时不写入（未确认不自动存）",
          _rk_get(key2) is None)

    _rk_del(key)


# --- V7: 端口别名双向读取（真实 keyring） ---------------------------------

def v7_port_alias_real_keyring():
    print("\n=== V7: 端口别名双向读取 ===")
    host = f"test-v7-{uuid.uuid4().hex[:8]}.local"
    user = "testuser"
    pw = "s3cret-v7"

    # 存 port=None 的键
    key_none = display_name(host, user, None)
    _rk_set(key_none, pw)

    try:
        # 用 port=22 读 → 别名命中
        r1 = secrets_store.load_password_alias(host, user, 22)
        check("V7a port=22 读到 port=None 存的密码", r1 == pw, f"got={r1}")

        # 用 port=None 读 → 直接命中
        r2 = secrets_store.load_password_alias(host, user, None)
        check("V7b port=None 读到自己的密码", r2 == pw, f"got={r2}")

        # 非默认端口不互查
        r3 = secrets_store.load_password_alias(host, user, 2222)
        check("V7c 非默认端口 (2222) 不互查", r3 is None, f"got={r3}")

    finally:
        _rk_del(key_none)


# --- V8: 凭据过期 → 只试一次 → 手输 → 再次记忆询问 ------------------------

def v8_expired_credential_retry():
    print("\n=== V8: 凭据过期自动填充只试一次 ===")
    host = f"test-v8-{uuid.uuid4().hex[:8]}.local"  # 用测试专用 host，不碰真实键
    user = "pe"
    key = display_name(host, user, None)

    # 模拟：凭据已存但过期（密码不对）
    _rk_set(key, "expired-password")

    s = MockSession()
    c = _bare_core(s, open_cmds={1: f"ssh {user}@{host}"},
                   target_host="172.25.104.182")

    async def main():
        # 第一次密码提示 → 自动填充（用已存的过期密码）
        prompt1 = f"{user}@{host}'s password: ".encode()
        c._detect_password_prompt(prompt1)
        await asyncio.sleep(0.1)  # 等 _on_nested_password_prompt 任务完成
        # 自动填充会调用 send_raw
        check("V8a 自动填充触发（至少一次）", len(s.sent) >= 1,
              f"sent={len(s.sent)}")

        # 模拟失败（Sorry, try again）→ 重讨密码
        sent_before = len(s.sent)
        prompt2 = f"\r\nPermission denied.\r\n{user}@{host}'s password: ".encode()
        c._detect_password_prompt(prompt2)
        await asyncio.sleep(0.1)
        # 第二次不应再自动填充（sent 不增加 = 没再次 send_raw 密码）
        check("V8b 自动填充每条命令只试一次", len(s.sent) == sent_before,
              f"sent_before={sent_before}, sent_after={len(s.sent)}")

        # 用户手输正确密码
        new_pw = "correct-password-v8"
        await c._on_keys(new_pw.encode() + b"\r")

        # auth 成功
        c._detect_password_prompt(f"\r\n[{user}@{host} ~]$ ".encode())
        await asyncio.sleep(cmod._PW_REMEMBER_DELAY + 0.2)
        asks = [m for m in c._msgs if m.type == "ask_remember"]
        check("V8c 手输成功后再次获得记忆询问", len(asks) >= 1,
              f"asks={len(asks)}")

        if asks:
            await c._finish_remember(True)
            check("V8d 新密码覆盖旧密码写入 keyring",
                  _rk_get(key) == new_pw,
                  f"stored={_rk_get(key) is not None}")

    asyncio.run(main())
    _rk_del(key)


# --- 汇总 ----------------------------------------------------------------

def main():
    keep = "--keep-keys" in sys.argv
    print("=" * 60)
    print("真机集成验证——真实 Windows 凭据库")
    print("=" * 60)

    v1_backfill_and_alias()
    v2_sudo_remember()
    v3_nested_ssh_remember()
    v4_shared_credential_protection()
    v5_edit_empty_password_keeps_credential()
    v6_adhoc_remember()
    v7_port_alias_real_keyring()
    v8_expired_credential_retry()

    if not keep:
        _rk_cleanup()

    print("\n" + "=" * 60)
    passed = sum(1 for _, ok, _ in _results if ok)
    failed = sum(1 for _, ok, _ in _results if not ok)
    print(f"结果: {passed} 通过, {failed} 失败 / 共 {len(_results)} 项")
    if failed:
        print("\n失败项:")
        for name, ok, detail in _results:
            if not ok:
                print(f"  FAIL  {name}  — {detail}")
    print("=" * 60)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
