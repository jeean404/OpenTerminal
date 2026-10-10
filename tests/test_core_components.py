"""core/ 组件独立构造与纯逻辑回归（Task 10 按域拆分前统一在此）。"""
import pytest

from openterminal.core.nested_ssh import NestedSshTracker


class FakeCore:
    """最小鸭子：NestedSshTracker 经 core 读跨域状态。"""
    _open_cmds: dict = {}
    _open_cmd_at: dict = {}
    _last_mark_at: float = 0.0
    _target_host: str = ""
    _pending_approval = None   # _shell_exit_window 弱匹配窗口判据


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
    from openterminal.core.pipeline import PipelineCore
    core = PipelineCore.__new__(PipelineCore)
    a = core.auth
    assert a is core.auth


def test_execevents_owns_state():
    from openterminal.core.exec_events import ExecEvents
    core = FakeCore()
    ExecEvents(core)
    for attr in ("_open_cmds", "_open_cmd_at", "_exec_stack", "_exec_buf",
                 "_suppress_live", "_curtain", "_curtain_parts",
                 "_tool_card_seq", "_tool_idx_map", "_intr_swallow_until",
                 "_intr_pending", "_user_out", "_pad_inflight"):
        assert hasattr(core, attr), attr


def test_execevents_preserves_presets():
    from openterminal.core.exec_events import ExecEvents
    core = FakeCore()
    core._open_cmds = {1: "ssh wujian@1.2.3.4"}
    ExecEvents(core)
    # hasattr 守卫：裸构造测试在 core 上预置的值不得被初始化覆盖
    assert core._open_cmds == {1: "ssh wujian@1.2.3.4"}


def test_strip_intr_echo_passthrough_normal():
    from openterminal.core.exec_events import ExecEvents
    e = ExecEvents(FakeCore())
    assert e.strip_intr_echo(b"ls\r\n$ ") == b"ls\r\n$ "  # 正常字节原样透传


def test_core_lazy_exec_property():
    from openterminal.core.pipeline import PipelineCore
    core = PipelineCore.__new__(PipelineCore)
    assert core.exec is core.exec


def test_hookgate_owns_state():
    from openterminal.core.hook_gate import HookGate
    core = FakeCore()
    HookGate(core)
    for attr in ("_interactive", "_shell_kind", "_b64flag", "_hook_gone",
                 "_hook_stale", "_hook_seen", "_hook_watch", "_hook_watch_text",
                 "_probe_buf", "_last_mark_at", "_last_live_at", "_exit_tail",
                 "_hook_report_pending"):
        assert hasattr(core, attr), attr


def test_hookgate_preserves_presets():
    from openterminal.core.hook_gate import HookGate
    core = FakeCore()
    core._exit_tail = bytearray(b"logout")
    core._shell_kind = "bash"
    HookGate(core)
    # hasattr 守卫：裸构造测试在 core 上预置的值不得被初始化覆盖
    assert bytes(core._exit_tail) == b"logout"
    assert core._shell_kind == "bash"


def test_hookgate_initial_state():
    from openterminal.core.hook_gate import HookGate
    h = HookGate(FakeCore())
    assert h.hook_ok() is False          # 未集成时 hook 不在位
    assert h.shell_kind is None


def test_hookgate_exit_tail_matches_tmout_logout():
    from openterminal.core.hook_gate import HookGate
    h = HookGate(FakeCore())
    # 强特征：TMOUT 自动登出（任意提示符位置都认）
    assert "auto-logout" in h._match_shell_exit(
        b"root@x:~# timed out waiting for input: auto-logout\r\n")
    # 弱特征：裸 logout 只在审批挂起窗口认
    assert h._match_shell_exit(b"logout\r\n") is None
    h.core._pending_approval = object()
    assert h._match_shell_exit(b"logout\r\n") == "logout"


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


def test_aiflow_owns_state():
    from openterminal.core.ai_flow import AiFlow
    a = AiFlow(FakeCore())
    for attr in ("_ai_task", "_ai_ping_at", "_ai_queue", "_rescue_open",
                 "_rescue_ctx", "_fallback_task", "_suppress_ai_report"):
        assert hasattr(a, attr), attr


def test_core_lazy_ai_property():
    from openterminal.core.pipeline import PipelineCore
    core = PipelineCore.__new__(PipelineCore)
    assert core.ai is core.ai


def test_outputpump_owns_state():
    from openterminal.core.pump import OutputPump
    p = OutputPump(FakeCore())
    assert p.phase == "read"   # core.py:560 初始值


def test_core_lazy_pump_property():
    from openterminal.core.pipeline import PipelineCore
    core = PipelineCore.__new__(PipelineCore)
    assert core.pump is core.pump
