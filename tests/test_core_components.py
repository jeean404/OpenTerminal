"""core/ 组件独立构造与纯逻辑回归（Task 10 按域拆分前统一在此）。"""
import pytest

from openterminal.core.nested_ssh import NestedSshTracker


class FakeCore:
    """最小鸭子：NestedSshTracker 经 core 读跨域状态。"""
    _open_cmds: dict = {}
    _open_cmd_at: dict = {}
    _last_mark_at: float = 0.0
    _target_host: str = ""


def test_tracker_constructs_standalone():
    t = NestedSshTracker(FakeCore())
    assert t is not None


def test_parse_ssh_cmd_target_host_user_port():
    line = "ssh wujian@1.2.3.4 -p 2222"
    host, user, port = NestedSshTracker.parse_ssh_cmd_target(line)
    assert (host, user, port) == ("1.2.3.4", "wujian", 2222)


def test_parse_ssh_cmd_target_non_ssh_is_none():
    assert NestedSshTracker.parse_ssh_cmd_target("sudo systemctl restart x") is None


def test_parse_ssh_cmd_target_scp_remote_path():
    line = "scp dist.tar.gz wujian@1.2.3.4:/tmp/"
    host, user, port = NestedSshTracker.parse_ssh_cmd_target(line)
    assert (host, user, port) == ("1.2.3.4", "wujian", None)


def test_nested_target_reads_innermost_open_cmds():
    core = FakeCore()
    core._open_cmds = {1: "ssh jump@10.0.0.1", 2: "sudo su -"}
    t = NestedSshTracker(core)
    # 最内层是 sudo（非 ssh 族）→ 不解析，绝不兜底到外层帧
    assert t.nested_ssh_target() == (None, None, None)


def test_ssh_frame_host_skips_non_ssh_frames():
    core = FakeCore()
    core._open_cmds = {1: "ssh wujian@1.2.3.4", 2: "sudo su -"}
    t = NestedSshTracker(core)
    # sudo 凭据键跳过非 ssh 帧向外找最近 ssh 帧（P1-3）
    assert t.ssh_frame_host() == "1.2.3.4"
    assert t.sudo_pw_key() == ("1.2.3.4", "sudo", None)


def test_authflow_owns_full_state():
    from openterminal.core.auth import AuthFlow
    core = FakeCore()
    AuthFlow(core)
    for attr in ("_pw_cancelled", "_pw_tail", "_pw_prompt_seen",
                 "_nested_pw_attempts", "_nested_pw_ctx", "_pw_verifying",
                 "_pw_verify_at", "_pw_verify_timer", "_pw_hold",
                 "_pw_hold_timer", "_pw_at_end", "_pw_modal_open",
                 "_pw_dismiss_timer", "_pw_capture_key", "_pw_typed",
                 "_pw_remember_candidate", "_pw_remember_pending",
                 "_pw_result_from"):
        assert hasattr(core, attr), attr


def test_authflow_preserves_presets():
    from openterminal.core.auth import AuthFlow
    core = FakeCore()
    core._pw_tail = bytearray(b"[sudo] password: ")
    AuthFlow(core)
    # hasattr 守卫：裸构造测试在 core 上预置的值不得被初始化覆盖
    assert bytes(core._pw_tail) == b"[sudo] password: "


def test_authflow_armed_false_when_no_prompt():
    from openterminal.core.auth import AuthFlow
    core = FakeCore()
    core._exec_stack = []
    core._open_cmds = {}
    core._cs_pw_pending = False
    assert AuthFlow(core).armed is False


def test_core_lazy_auth_property():
    """PipelineCore.auth 惰性属性：裸构造实例首次访问即建 AuthFlow，
    且同一实例复用（状态归属唯一）。"""
    from openterminal._core_impl import PipelineCore
    core = PipelineCore.__new__(PipelineCore)
    a = core.auth
    assert a is core.auth
