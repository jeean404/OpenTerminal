# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec：ot 可执行（macOS / Windows，Release 附件用）。

打包模式由环境变量 OT_BUNDLE_MODE 选择：
- onedir（默认，Release 用）——资源摊在 dist/ot/ 目录，启动不解包，
  冷启动 ≈ 原生导入（~3s）。分发为 .tar.gz / .zip，用户解压后把 ot
  放进 PATH。
- onefile——单文件 dist/ot，每次运行把整包解到临时目录再删，实测冷启动
  ~28s（解包 I/O + macOS 逐个扫描解出的 dylib）。对反复调用的 CLI 不可接受，
  仅留作「就要一个文件」的场景。

数据面（Path(__file__) 相对定位的资源，两种模式都必须原样打进包）：
- openterminal/web/frontend —— `ot web` 静态资源（server.py 以
  Path(__file__)/frontend 定位；React island 构建产物 static/ui/ 已提交）；
- openterminal/skills —— 内置 Agent Skills 的 SKILL.md（与 pyproject
  package-data 同源）。

入口：packaging/ot_entry.py——app.py 全是相对 import，不能直接当脚本分析。

hiddenimports：运行时动态 import、PyInstaller 静态分析看不见的三类：
- uvicorn 的 loop/protocol 组件（按字符串参数动态选择实现）；
- keyring 的平台后端（运行时按平台枚举加载）；
- langchain 系延迟导入（deepagents → langchain-anthropic → langchain-core，
  init_chat_model 按模型名动态挑 Provider 类）。
缺失的 hiddenimport 只记 warning 不致命（跨平台列表按并集写）。
"""

import os

_mode = os.environ.get("OT_BUNDLE_MODE", "onedir").lower()
if _mode not in ("onedir", "onefile"):
    raise SystemExit(f"OT_BUNDLE_MODE 只能是 onedir/onefile，收到 {_mode!r}")

a = Analysis(
    ["packaging/ot_entry.py"],
    pathex=["src"],
    binaries=[],
    datas=[
        ("src/openterminal/web/frontend", "openterminal/web/frontend"),
        ("src/openterminal/skills", "openterminal/skills"),
    ],
    hiddenimports=[
        # --- uvicorn（run_web 启动组件动态装配）---
        "uvicorn.logging",
        "uvicorn.loops", "uvicorn.loops.auto", "uvicorn.loops.asyncio",
        "uvicorn.protocols", "uvicorn.protocols.http",
        "uvicorn.protocols.http.auto", "uvicorn.protocols.http.h11_impl",
        "uvicorn.protocols.websockets", "uvicorn.protocols.websockets.auto",
        "uvicorn.protocols.websockets.wsproto_impl",
        "uvicorn.protocols.websockets.websockets_impl",
        "uvicorn.lifespan", "uvicorn.lifespan.on", "uvicorn.lifespan.off",
        "uvicorn.middleware", "uvicorn.middleware.message_logger",
        # --- keyring 平台后端（macOS Keychain / Windows 凭据管理器 /
        #     Linux Secret Service——按并集写，运行时各取所需）---
        "keyring.backends.macOS",
        "keyring.backends.Windows",
        "keyring.backends.SecretService",
        "keyring.backends.kwallet",
        "keyring.backends.chainer",
        # --- AI 栈延迟导入 ---
        "deepagents",
        "langchain_anthropic",
        "langchain_anthropic.chat_models",
        "langchain_core",
        # provider=openai 分支（agent.py build_chat_model 函数内惰性导入，
        # 静态分析看不见）；tiktoken_ext.openai_public 是 tiktoken 按编码名
        # 懒加载的插件模块，漏了会在首次分词时 ModuleNotFoundError
        "langchain_openai",
        "langchain_openai.chat_models",
        "openai",
        "tiktoken",
        "tiktoken_ext",
        "tiktoken_ext.openai_public",
        # --- SOCKS 代理传输层（httpx 按需构造）---
        "socksio",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)

pyz = PYZ(a.pure)

_common = dict(
    name="ot",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

if _mode == "onefile":
    # 单文件：二进制/数据全部内联进 EXE
    exe = EXE(pyz, a.scripts, a.binaries, a.datas, [], **_common)
else:
    # onedir：EXE 只含引导 + 纯 Python，二进制/数据交给 COLLECT 摊进目录
    exe = EXE(pyz, a.scripts, [], exclude_binaries=True, **_common)
    coll = COLLECT(
        exe,
        a.binaries,
        a.datas,
        name="ot",
        strip=False,
        upx=False,
        console=True,
    )
