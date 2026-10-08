"""往隔离 OPENTERMINAL_HOME 的 connections.db 里落一条「记住的连接」。

侧栏列表来自 build_target_list() → load_saved_targets() → connections.db，
config.toml 里的 [target.*] 不会出现在侧栏，所以真机复现脚本必须走这里。

env:
  OT_SEED_NAME / OT_SEED_HOST / OT_SEED_PORT / OT_SEED_USER
  OT_SEED_COMMANDS  连接后命令，用 "|" 分隔
"""
import os

from openterminal import connections

port = os.environ.get("OT_SEED_PORT") or None
cmds = [c for c in (os.environ.get("OT_SEED_COMMANDS") or "").split("|") if c]
connections.upsert_saved_target(
    name=os.environ["OT_SEED_NAME"],
    host=os.environ["OT_SEED_HOST"],
    port=int(port) if port else None,
    user=os.environ.get("OT_SEED_USER") or None,
    commands="\n".join(cmds),
)
print("seeded:", [t.name for t in connections.load_saved_targets()])
