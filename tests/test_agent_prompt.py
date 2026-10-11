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
    from openterminal.agent.prompt import build_system_prompt
    out = build_system_prompt(_P())
    assert "小节标题" in out
    assert "##" in out


def test_system_prompt_states_local_file_root():
    """本机文件根必须写进提示词：模型报不出真实路径，「下载到本机」就交不了货。"""
    from openterminal.agent.prompt import build_system_prompt
    out = build_system_prompt(_P(), r"C:\Users\me")
    assert "本机文件根目录" in out and r"C:\Users\me" in out
    assert "下载到本机" in out and "/Downloads/" in out
    assert "真实绝对路径" in out


def test_system_prompt_without_root_still_describes_virtual_paths():
    from openterminal.agent.prompt import build_system_prompt
    out = build_system_prompt(_P())
    assert "虚拟路径" in out and "本机" in out
