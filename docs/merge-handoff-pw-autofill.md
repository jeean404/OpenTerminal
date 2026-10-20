# 合并交接：命令集密码自动填充修复（_pw_armed 三条路径）

> **本文档自包含**：合并者无需其他上下文。请完整读完再动手。

## 1. 目标

将本地工作区中 `src/openterminal/core.py` 的两处未提交修复合并到远程分支
`feat/single-pipeline`（remote: `git@github.com:JaquariusJ/OpenTerminal.git`）。

**当前本地状态**：分支 `feat/single-pipeline`，工作区有且仅有 `core.py` 的未提交改动
（+13/-2 行），无其他未提交代码。无新文件、无删除文件。

## 2. 背景：修复了什么

**症状**：连接侧边栏条目「172.25.105.150」（跳板 `pe@172.25.104.182` + 嵌套
`ssh pe@172.25.105.150` + `sudo su -`）时，嵌套 ssh 的密码提示符
`pe@172.25.105.150's password:` 出现后**不自动填充**已记住的密码（keyring 中
`pe@172.25.105.150` 已 SET）。

**根因**（两个叠加的时序/路径问题）：

1. **`_pw_armed()` 路径缺失**：命令集 `_cs_command` 直接 `send_raw` 把命令发进
   PTY，不走 shell hook 的 C/D 标记（`_on_exec_start`）开帧。`_pw_armed()` 只看
   `_exec_stack` 和 `_open_cmds`，命令集路径下两者全空 → 恒 `False` →
   `_detect_password_prompt` 的自动填充入口被拦死。

2. **`_cs_pw_pending` 置位太晚**：该标记原本在 `_cs_command` 末尾（静默期满后）
   才设置，但密码提示符在命令输出阶段就到了——`_detect_password_prompt` 处理
   提示符时 `_cs_pw_pending` 还是 `False`。

## 3. 精确改动（仅 `src/openterminal/core.py`，+13/-2）

### 改动 1：`_pw_armed()` 补第三条路径

位置：`PipelineCore._pw_armed` 方法（约 L1161）。

```diff
     def _pw_armed(self) -> bool:
-        """最内层未闭合用户命令是否 ssh/sudo 类（提示符检测的触发门槛）。"""
+        """最内层未闭合用户命令是否 ssh/sudo 类（提示符检测的触发门槛）。
+
+        三条路径覆盖三种命令执行方式：
+        ① _exec_stack——AI/探测的 EXEC 帧（C/D 标记驱动）；
+        ② _open_cmds——用户手敲命令的记账帧（C/D 标记驱动）；
+        ③ _cs_pw_pending——命令集 _cs_command 直发 PTY 的密码类命令
+          （不走 C/D 标记，前两条路都看不到；真机：跳板命令集
+          `ssh pe@目标` 后密码提示自动填充被 _pw_armed 拦死）。"""
         for frame in reversed(self._exec_stack):
             line = frame.get("line") or ""
             if line and not is_internal_line(line):
                 return _needs_password_prompt(line)
         for line in reversed(list(self._open_cmds.values())):
             return _needs_password_prompt(line)
-        return False
+        return bool(getattr(self, "_cs_pw_pending", False))
```

注意：用 `getattr(self, "_cs_pw_pending", False)` 而非直接 `self._cs_pw_pending`
——测试中 `_bare_core` 绕过 `__init__` 构造最小对象，不初始化该属性，
直接访问会 `AttributeError`。`getattr` 默认 `False` 保持既有行为。

### 改动 2：`_cs_command` 发命令前置标记

位置：`PipelineCore._cs_command` 方法（约 L2097，在 `await self.session.send_raw(...)` 之前）。

```diff
         await self._cs_wait_pw_verify()
         await self._cs_hook_gate()
         self._cs_tail = bytearray()
+        # 密码类命令：发前置标记——密码提示随输出到达时 _pw_armed 需要
+        # 已能看到它（_cs_command 尾部再置一次是给 _cs_pause_for_input 用的，
+        # 那时提示符早已被 _detect_password_prompt 处理过）
+        self._cs_pw_pending = _needs_password_prompt(cmd)
         await self.session.send_raw((cmd + "\r").encode())
```

原有的 `_cs_pw_pending = _needs_password_prompt(cmd)`（在 `_cs_command` 末尾、
静默期满后）**保留不删**——它服务 `_cs_pause_for_input` 的下一条命令门禁，
与本次新增的前置赋值是两个不同时序的消费者。

## 4. 合并步骤

### 方式 A：apply patch（推荐，改动小且精确）

```bash
# 1. 切到目标分支并拉最新
git checkout feat/single-pipeline
git pull origin feat/single-pipeline

# 2. 保存上面 §3 的 diff 为 patch 文件，然后：
git apply pw-autofill-fix.patch

# 3. 验证
python -m pytest tests/test_nested_session.py tests/test_core.py \
  tests/test_connections.py tests/test_secrets_store.py \
  tests/test_web_server.py -q

# 4. 提交
git add src/openterminal/core.py
git commit -m "fix(core): 命令集密码自动填充被 _pw_armed 拦死——补 _cs_pw_pending 路径 + 发前置位"
git push origin feat/single-pipeline
```

### 方式 B：手工编辑（如 patch 不适用）

只改 `src/openterminal/core.py`，按 §3 的两处 diff 做最小修改。不要动其他文件。

## 5. 验收标准

1. **单元测试全绿**（至少这 5 个文件）：
   `tests/test_nested_session.py`、`tests/test_core.py`、`tests/test_connections.py`、
   `tests/test_secrets_store.py`、`tests/test_web_server.py`
   ——共 100 个用例，预期全部通过。

2. **行为验证**（条件允许时）：
   - 命令集执行 `ssh pe@<目标>` 后，若 keyring 中有 `pe@<目标>` 的密码，
     终端显示「已用记住的密码自动填充 pe@<目标>」status，不再弹密码提示。
   - 用户手敲 `ssh pe@<目标>`（非命令集路径）仍正常——`_open_cmds` 路径不受影响。
   - `sudo su -` 等密码提示仍正常走手输 + 记忆询问（P1-3 机制不受影响）。

## 6. 不变量（合并时不得破坏）

- 不改 `_pw_armed` 原有的 `_exec_stack` / `_open_cmds` 判断逻辑——只在末尾追加
  `return bool(getattr(self, "_cs_pw_pending", False))`。
- 不删 `_cs_command` 末尾原有的 `_cs_pw_pending = _needs_password_prompt(cmd)`。
- 不改 `_detect_password_prompt`、`_on_nested_password_prompt`、`_load_nested_password`。
- 不改 `secrets_store.py`、`connections.py`、`web/server.py` 等其他模块。
- 密码永不落 SQLite / 日志 / transcript（既有约定，本次未触碰）。

## 7. 已知遗留（不在本次合并范围）

`bash_execute_unix_command: cannot find keymap for command`——hook 注入的
`bind -x` keymap 在某些远程 bash 环境下不完整，Enter 宏前半段报错、后半段
`accept-line` 兜底提交。这是**既有的 hook 注入问题**，与密码自动填充独立，
本次修复不涉及也不应回归它。
