"""Windows ConPTY 本地会话：纯逻辑测试全平台跑，真实会话仅 win32。"""

import sys

import pytest

# WinPtySession 顶层 import 是安全的（pywinpty 在 start() 内延迟导入），
# 但 POSIX 上没有意义，真机测试只该在 win32 跑。
if sys.platform != "win32":
    pytest.skip("ConPTY 会话仅支持 Windows", allow_module_level=True)

from openterminal.local_win import WinPtySession
from openterminal.shell_session import slice_capture


# --- 纯逻辑：PowerShell 哨兵包装与 POSIX 切片器兼容（不碰真 ConPTY）---


def test_wrap_is_single_line():
    s = WinPtySession()
    wrapped = s._wrap("echo hi\nGet-ChildItem")
    assert "\n" not in wrapped.rstrip("\n")  # 只有结尾的提交键
    assert wrapped.endswith("\r")  # PSReadLine 只认 \r 为 Enter（LF 是续行）


def test_wrap_emits_sentinels_powershell_syntax():
    s = WinPtySession()
    wrapped = s._wrap("echo hi")
    assert "Write-Output '__OT_BEGIN__'" in wrapped
    # 先清 $LASTEXITCODE：原生命令码只在非空时取，cmdlet 用 $? 兜底
    assert wrapped.startswith("$LASTEXITCODE = $null;")
    assert "if ($null -eq $LASTEXITCODE)" in wrapped
    assert "(Get-Location).Path" in wrapped
    # 正常路径的 END 一定输出（Ctrl-C 中断是唯一例外）
    assert "try { echo hi } finally {" in wrapped


def test_wrap_passthrough_powershell_sentinel():
    # 直通包装 PowerShell 版：随机 marker + $LASTEXITCODE（空则 0），\r 结尾
    s = WinPtySession()
    w = s._wrap_passthrough("powershell", "__OTRAWcafe1234")
    assert w.endswith("\r")
    assert w.startswith("powershell ; Write-Output ('__OTRAWcafe1234_' + ")
    assert "$LASTEXITCODE" in w and "__OT_BEGIN__" not in w
    assert "\n" not in w[:-1]


def test_wrap_end_marker_slice_compatible():
    # 用 PowerShell 语义模拟 END 行，POSIX 切片器必须能切出 code/cwd
    s = WinPtySession()
    wrapped = s._wrap("echo hi")
    # 手工按 PS 求值结果拼 END 行：__OT_END__0__C:\work__
    stream = (b"__OT_BEGIN__\r\nhi\r\n"
              b"__OT_END__0__C:\\work__\r\n")
    assert slice_capture(stream) == ("hi", 0, "C:\\work")
    assert "$otc" in wrapped  # 保底：wrap 里确实带了退出码捕获


# --- 真实 ConPTY 会话 ---


@pytest.fixture
async def session():
    s = WinPtySession()
    await s.start()
    try:
        yield s
    finally:
        await s.close()


async def test_simple_run(session):
    r = await session.run("Write-Output hello")
    assert r.exit_code == 0
    assert "hello" in r.output


async def test_persistent_state_cd(session):
    r1 = await session.run("Set-Location $env:TEMP")
    assert r1.exit_code == 0
    r2 = await session.run("Get-Location")
    assert r2.cwd and "Temp" in r2.cwd


async def test_failure_exit_code(session):
    r = await session.run("Get-ChildItem Z:\\no\\such\\dir_xyz")
    assert r.exit_code != 0


async def test_cmdlet_failure_exit_code(session):
    # 回归：cmdlet 失败不设 $LASTEXITCODE，$? 兜底为 1 的路径
    r = await session.run("Write-Error boom-xyz; if ($?) { }")
    assert r.exit_code != 0


async def test_native_command_failure(session):
    r = await session.run("cmd /c exit 3")
    assert r.exit_code == 3


async def test_timeout_interrupts_and_recovers(session):
    # 超时后有两条都合法的路径（取决于 ConPTY 对 Ctrl-C 的实际响应）：
    #   a) 中断成功且探针确认 shell 存活 → 124/130，会话状态（cwd）保留
    #   b) 中断未生效、探针超时 → 自动重启会话，reconnected=True
    # 共同契约：下一条命令立即可用。
    await session.run("Set-Location $env:TEMP")
    r = await session.run("Start-Sleep -Seconds 30", timeout=2)
    if r.reconnected:
        assert r.exit_code == 1 and "重连" in r.output
    else:
        assert r.exit_code in (124, 130)
    r2 = await session.run("Write-Output recovered")
    assert r2.exit_code == 0 and "recovered" in r2.output
    if not r.reconnected:
        assert "Temp" in r2.cwd  # 中断路径下会话状态不被冲掉


async def test_on_output_streams(session):
    chunks: list[str] = []
    await session.run("Write-Output a; Write-Output b; Write-Output c",
                      on_output=chunks.append)
    assert "".join(chunks).count("\n") >= 2


async def test_concurrent_runs_are_serialized(session):
    import asyncio

    r1, r2 = await asyncio.gather(
        session.run("Write-Output concurrent-one"),
        session.run("Start-Sleep -Milliseconds 300; Write-Output concurrent-two"),
    )
    assert r1.exit_code == 0 and "concurrent-one" in r1.output
    assert "concurrent-two" not in r1.output
    assert r2.exit_code == 0 and "concurrent-two" in r2.output
    assert "concurrent-one" not in r2.output
