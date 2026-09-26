"""系统提示词约定：总结小节标题用 ## 开头（对齐前端 .mh 排版）。"""


class _P:  # 只提供 build_system_prompt 需要的字段
    host = "h"
    distro = "d"
    os_family = "f"
    version = "v"
    kernel = "k"
    pkg_manager = "apt"
    service_mgr = "systemd"
    shell = "bash"
    tools = {"curl"}


def test_system_prompt_uses_section_title_convention():
    from openterminal.agent import build_system_prompt
    out = build_system_prompt(_P())
    assert "小节标题" in out
    assert "##" in out
