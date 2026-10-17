# 交接文档：卡片层「定格一发入魂」改造（born-complete cards）

> 写给接手的 agent：本文自包含，读完即可动工。含背景根因、已定方案（用户
> 已拍板，勿再议）、当前进度、遗留 bug、剩余步骤与验证方法。
> 批准的完整计划另有存档：`~/.claude/plans/tingly-exploring-aho.md`（参考用）。
>
> **进度快照（2026-10-16）**：Phase 0–4 已全部落地，测试全绿
> （JS 157 例含新增 native_keys/badge_progress、React island 27 例、
> Python 全量）。Phase 4 改动要点：
> - `_fitNeed` 去掉 +5 裕量（need ≡ 量高+1）；`_scheduleReanchor`/`growHolds`/
>   `_releaseGrow`/`_stealBlankBelow`/`_unrevealedBelow` 全部删除
> - 新 `_scheduleDrift`：漂移感知即钉盒（pending 期**不扣流**），流底非盖帽卡
>   一次性重垫（card-drift 扣流窗，try/finally 配平）
> - `_endSweep` 改「保留夹紧」（不丢弃不留洞）；仅 pendingMount 槽走
>   `_fallbackPlain` 降级拆除；`_onBoundary` 先排水 `_cardReady`/`_mountQ`
> - Phase 3 徽标已接 progress 心跳（`_onProgress` → `_refreshThink` 拼
>   「已生成 N 字 · in X / out Y」+ 已耗秒数）
> - 目标 3（终端原生能力）新增回归：`tests/js/native_keys.test.cjs`
>   （Tab/↑↓/Ctrl+R 直通、镜像不吞键）
> - store 测试已翻到 Phase 2 命令卡契约（armed/单武装/决策守卫）
> - **构建产物已重建**（`cd web/frontend/ui && npm run build`）：`static/ui/ui.js`
>   不会自动跟 `ui/src`——改了 cards.jsx/store.js 必须重建，否则真机跑的是旧
>   岛（本次曾发现产物缺 Phase 2 的 cmdcard/command_card_waiting）
> **剩余**：Phase 5 全量场景（编辑/拒绝/始终允许/高危两步确认/双同串并行）
> 可在 verify-phase5-smoke 骨架上扩展（lib.js + serve_scripted_model 已就绪）；
> 核心冒烟已 15/15。
>
> **Phase 5 真机冒烟已通过（2026-10-16，15/15）**：`node tools/verify-web/
> verify-phase5-smoke.cjs`（真浏览器 + 本机 PowerShell PTY + 脚本化模型）。
> 覆盖：命令卡出生即定型（maxHeight 钉死+打字机揭示）→ 审批按钮盒内真可点
> （红线⑨）→ 点执行收 ✓ → 高总结卡 → 收束不丢弃 → 徽标计数 → ↑ 历史召回/
> Tab 补全原生直通 → 页面零 JS 报错。冒烟揪出并已修 3 个真 bug：
> 1. **慢 shell 探针超时**（本机 conda PowerShell 40s+）：首轮 10s 探测必败
>    → hook 不注入 → pad 熔断 → 卡片被夹紧。`_setup_interactive` 加 45s 宽限
>    重试（pipeline.py）
> 2. **审批武装竞态**：审批帧快于挂载链 → `command_card_waiting` 找不到卡 →
>    按钮永不出生转模态。双修：store `_pendingArms` 暂存受理 + `_onAiTool`
>    改 handle 先于 mount（对齐分析卡出生事务）
> 3. **armed 分支炸岛**：CommandCard 用 `<React.Fragment>` 但未 import React
>    （自动 JSX 运行时不注入）→ 一武装就 "React is not defined" 整岛空壳。
>    改 `<>` 碎片；新增 `ui/tests/cards_render.test.jsx`（renderToString
>    无 jsdom 渲染各分支，store 单测抓不到组件炸）
> 旧方案的 verify-card-dup.cjs 断言已同步命令卡语义；island 构建产物记得
> `npm run build`（本轮又踩了一次产物滞后）。
>
> **代码评审（2026-10-16）已收口**：
> - HIGH 已修：`_floorRows` 只认 `kind==="approval"` 而命令卡挂的是
>   `kind==="phase"`，且量的是 `.aphead`（命令卡按钮在卡底 `.cmdacts`）——
>   夹紧裁底正好裁按钮簇＝决策死锁。现按 `.cmdacts` 底沿量底线（≈全高），
>   救援卡仍量 `.aphead` 首行；看门狗改**持续巡检**（DOM 判「执行」按钮在
>   卡盒内；出生 grace + 失点 5 拍迟滞防 React 单帧误报）
> - MEDIUM 已修：`_ensurePad` 并发双垫（`padOut` 改**入队当刻**记账；
>   回归测试「并发 _ensurePad 不得双垫」）
> - MEDIUM 显式取舍：**中断路径** store 仍整卡移除未完毕卡（用户拍板
>   「中断零残留，含命令卡移除」）——该路径的 pad 空行留洞是接受的代价；
>   自然收束（final/task_end）才是「保留夹紧」口径
> - LOW 遗留：个别测试桩仍留 `_taskCardId`/`_scheduleReanchor` 等死字段
>   （无害，未来清理）

## 1. 背景与根因

### 症状（用户实测，长对话后必现）
1. **图一 卡片遮挡**：贴纸卡盖住下方命令输出
2. **卡片错位**：贴纸与内容/锚点漂移
3. **图二 消失留白**：卡片整卡消失，原位置留下大片空白

### 根因（分析定论，勿再走弯路）
Web 端 AI 卡片是**浮动贴纸**（React island + xterm decoration）+ **shell pad
空行预留**（往 shell 注入 `__ot_pad N` 打 N 个空行，贴纸盖在空行上）的模型。
契约是「贴纸高度 = 预留空行数」，由 blankRun/补差/夹紧/steal/reanchor/heal/
熔断一整套账目维持（`web/frontend/static/app.js` ~行 840-2050、
`pad_ledger.js`）。失步路径：

- **内容长高**（流式 token 驱动贴纸持续变高）→ 补行要走 shell 往返（百毫秒~
  秒级），窗口内贴纸高于空行 → **遮挡**
- 输出插进预留区 / hook 掉线（`su -` 换壳）/ 补行超时 → 空白 run 被吃 → 遮挡/夹紧
- zsh 重画提示符、resize 折行 → 锚点漂移 → **错位**
- 收束扫尾（`_endSweep`）把「垫不满」的卡**整卡丢弃**（用户曾要求「不显示
  半截尸块」）→ 贴纸拆了但 pad 空行是 append-only 缓冲内容回收不了 → **留洞**

**结论**：这是结构性问题——「持续同步」竞态不可能靠补丁修完（git 史上同族
补丁：`ff71cb7`/`3105c49`/`9d39c08`/`a77a524`/`cf0389d` 等，全是同一失步家族）。
曾试过「定格即落格」（卡片烧成网格文本）方案，**用户已否决**（视觉降级到
TUI 文本卡，不接受）——废弃代码存档在 `.tmp/burn-wip/`（patch + 7 文件），
**不要恢复它**，但其中的压力测试结论已并入本方案。

## 2. 已定方案（用户拍板的决策，勿再议）

**核心思想：把「持续同步」变成「一次性出生事务」。**
卡片**内容完整才挂载**（量高 → 精确垫行 → 挂载 → 高度钉死，永不长高）。
「贴纸高 = 预留行数」出生成立且永不变 → 三症状在结构上消失：
- 遮挡：贴纸永不越出预留区
- 错位：无增量重贴/偷行，锚点只随滚动（xterm 管，天然正确）
- 留白：没有半截卡可丢；中断 = 不出生 = 零残留

用户已拍板的形态约束：
1. **贴纸美卡保留**（React island + ui.css 原视觉，不接受文本卡/侧栏方案）
2. **定格一发入魂** + 挂载后**打字机效果**逐块揭示（观感买回，几何不动；
   流式期只有状态行徽标）
3. **模型接口保持流式、服务端攒流**：Web 每段只收一条完整 `ai_result` +
   1s 计数心跳（前端不攒 token 流）；CLI 逐 token 流式**不变**
4. **命令卡合并**（工具卡 + 审批卡二合一）：一卡贯穿
   宣告→(等待审批+按钮)→✓/✗；命令不再显示两遍；高危两步确认保留
5. **徽标增强**：`思考中 12s · 已生成 N 字 · in X / out Y`
6. 命令输出照旧流进网格（单管线不动）；resize 非流底卡夹紧显示
7. 中断零残留（含命令卡移除）；非中断失败冲刷 failed 段
8. 旧页部署期不做 proto 协商（接受「刷新标签页」）

### 烧写/冲刷语义（后端攒流，已定）
段缓冲在 `_live` 攒 token/think。冲刷点：
| 时点 | 动作 |
|---|---|
| `tool_start` 前 | 冲刷段（`ai_result {text, think, failed:false}`；轮内 token 全先于 tool_start，已核） |
| `final` 处 | **吞正文、留思考**——缓冲 text 就是 final 答案本体（`_final_text` 重读同一 AIMessage），再冲刷会**答案烧两遍**（分析段+总结卡同文）。think 非空冲「仅思考段」 |
| `limit`/`error`/异常 | 冲刷 `failed:true`（幂等：双空 no-op） |
| interrupt | 不冲，零残留 |
| 双空段 | 不发（纯工具轮不长空分析卡） |
| 任务收尾 | **必发 `task_end`**（旧洞：final 空文时什么都不发 → 徽标永转） |

## 3. 当前进度（工作区未提交改动）

### ✅ Phase 0 已完成（测试绿）
- `src/openterminal/policy.py`：`Policy.needs_approval(cmd, allowed)` /
  `Policy.risk(cmd)` / `BENIGN_APPROVE_REASONS`——HITL `_when`、
  `_approval_risk`、命令卡预判的**唯一谓词来源**（防漂移）
- `src/openterminal/agent/build.py`：`_when` 改调 `policy.needs_approval`
- `src/openterminal/core/pipeline.py`：`_approval_risk` 改调 `policy.risk`
- `src/openterminal/core/ai_flow.py`：`decision.allow → core.allowed.add(cmd)`
  + 剥 `allow` 键再 resume——**修死功能**：Web「始终允许」按钮此前从不被后端
  读取（等于「执行」）
- `tests/test_approval.py`：+3 测试（谓词/风险级/allow 落账）
- 验证：`pytest tests/test_approval.py tests/test_policy.py` 全绿

### ✅ Phase 1 后端已写完（代码就绪，测试待收）
- `src/openterminal/core/pipeline.py`：`PipelineCore.paced_display = False`
- `src/openterminal/web/worker.py`：`TabWorker.paced_display = True`
- `src/openterminal/core/ai_flow.py`：
  - `_SegBuffer` 类（text/think/chars/beat/runner；`take()` 空段即 no-op）
  - `_flush_seg(failed)` / `_seg_beat(force)`（1s 心跳 `progress {chars,in,out}`）
  - `_live`：paced 时 token/think 进缓冲+心跳；tool_start/limit/error/denied
    前冲刷；CLI（paced_display=False）逐 token 路径**逐字不动**
  - `_run_task`：起始建缓冲、`finally` 清缓冲（中断同口径）、异常冲 failed、
    成功路径必发 `task_end`
  - `_handle_events` 的 `final`：吞正文留思考（见 §2 表）
- 验证：语法过；受影响用例里 **`test_worker_change_model` 挂**（见 §4）。
  另两个 `test_worker_task_flow_events`/`test_worker_tool_card_events` 是
  **预期内失败**（事件契约变了，测试待改——见 §5 Phase 1 收尾）

### 其他环境状态
- Python venv：`.venv-win`（`py -3.13 -m venv` 建，依赖已装）
- 旧方案存档：`.tmp/burn-wip/`（仅参考，勿恢复）
- `test-fixes-unpushed.patch` 是用户原有文件，勿动

## 4. 遗留 bug（接手第一件事）

**`tests/test_web_worker.py::test_worker_change_model` TimeoutError**

现象：等待 sink 里的状态「已切换模型」2s 超时。`handle_client` 正常返回，
`w._model` 已更新。已查：
- 独立脚本复现**正常**（sink 里能看到 `已切换模型：claude-opus-4-6`）——
  环境差异只剩 pytest conftest 的 `OPENTERMINAL_HOME` 隔离（已带隔离复现，仍正常）
- 二分：把 Phase 1 后端三文件 `git stash` 后**仍失败**——与「Phase 0 后全量
  绿过一次」矛盾，疑似环境态/顺序依赖（曾出现两用例同跑时一挂一过的顺序效应）
- **未定论**（token 预算中断排查）

接手建议（按序试，每步都便宜）：
1. `PYTHONIOENCODING=utf-8` 下跑该用例并在 `_change_model` 后打印
   `sink.json()`（注意 Windows 控制台 cp1252 打中文会崩——必须带该环境变量）。
   看状态到底是「已切换模型」还是「**切换模型失败：…**」——后者指向
   `_build_agent_now` 抛异常（`_change_model` 的 except 分支文案不含
   「已切换模型」，谓词就永远等不到）
2. 若是「切换模型失败」：看异常。怀疑点：
   `_impl.build_agent` 桩经 `_PatchBridge`（worker）→ `_CoreBridge`（core）
   二跳落 `pipeline.build_agent`——导入顺序不同（`web.protocol` vs
   `core.messages` 先触达）时桥的 `hasattr` 转发可能没打上桩，真
   `agent.build.build_agent` 被调用（重依赖 import 同步阻塞，也解释超时）
3. 若是「已切换模型」却仍超时：查 `FakeSink.json()`（`tests/web_fakes.py:23`）
   与 `_wait_json`（`web_fakes.py:117`）的送达时序
4. 若确认与本次改动无关（git stash 全部改动后仍挂）：按环境 flake 记档跳过

同机已知 flake（**勿误判为回归**）：
- `test_worker_task_flow_events` 全量并发下偶发挂、单跑过
- `test_shell_integration.py` 里 3 个拉真 Git bash 的用例
  （`*bare_shell*`/`test_hook_unwraps_quoted_exec_body`）负载下 30s 超时、单跑过
- Git bash 偶发 `add_item errno 1` 崩溃——重试即可

## 5. 剩余工作（按阶段，含文件级步骤）

### Phase 1 收尾：前端契约翻转（与后端同 PR 落地）
后端已发 `ai_result`/`progress`/`task_end`，前端要接上；**原子落地**
（旧 app.js 对 paced worker 会永远转徽标——内网工具，接受「刷新标签页」）。

**store（`web/frontend/ui/src/store.js`）**
- 新增 `ai_result` case：一次性入完整分析段 `{type:"analysis", text, reason:
  think, done:true, failed}`；空段不入
- 删 token 批累积语义（`_flushSoon`/`flushNow`/`_dirty` 与 `ai_token`/
  `ai_think` 攒流）——对应 `ui/tests/store.test.mjs` 的 token 流/批/换装/
  trimMd 用例改写（保留 new_session/clear/rescue 壳）
- `ai_collapse` 变 no-op（trimMd 分支死）；`ai_card`/`final` 去重
  （`_lastSummaryMd`）保留

**app.js（`web/frontend/static/app.js`）**
- 新 `_onAiResult(ev)`：`feed.handle({kind:"ai_result", ...})` → `_mountCard`
  挂**内容完整**的卡（现有出生路径：settle → pad → 挂载，见 `_runMountCard`
  ~行 927-1038——出生事务的量高/垫行/挂载逻辑**可复用**，只是不再长高）
- 挂载时机：分析/总结卡从 `task_start` 挂（`_openPhaseCard`）改为
  `ai_result`/`final` 挂；删 `_onAiToken`/`_onAiThink`/`_openPhaseCard`/
  `_taskCardId`/`_trackText`（流式生命周期）
- `_onFinal`：删换装 dance（`transform`/`_capped`/`trimMd` 分发 ~行 2209-2265），
  总结卡直接 `_mountSummary` 一发（内容=final 文本，出生即完整）
- 新 `task_end` case：关徽标/停计时/扫尾（与 `_onFinal` 收尾共用，幂等）
- `ai_collapse` → no-op（事件留线，CLI 依赖）
- **打字机**：挂载后逐块揭示。md_lite.js 加 `mdLiteBlocks(src)` 导出
  （`mdLite` 内部已有 `out` 数组，`join` 前导出即可）；cards.jsx 正文按块渲染，
  每块 `style={"--i": idx}` + CSS `animation: reveal .25s both;
  animation-delay: calc(var(--i) * 60ms)`（**opacity 动画，禁 clip/max-height**
  ——高度可证稳定）；`prefers-reduced-motion` 直显；动画挂 `.ot-card-host`
  揭示后启动（`_revealSlot` 加 class），避免出生窗内播完

**测试**：`ui/tests/store.test.mjs` 改写 + 新增「挂载后高度/行不再变化」断言；
`tests/js/card_mount.test.cjs`/`phase_card.test.cjs` 改写（挂载时机变了）。
**Gate**：`node --test tests/js/*.test.cjs`、
`cd src/openterminal/web/frontend/ui && npm ci && npm test`、
`pytest tests/test_web_worker.py`（事件序两用例按新契约改断言：
`ai_result`/`task_end` 进 kind 列表、`ai_token` 不再出现）、
`tests/test_web_protocol.py::test_encode_event_kinds` 加 `ai_result`/`progress`/
`task_end`。**CLI 不回归硬线**：`tests/test_term_render.py`、
`tests/test_term_capture.py` 必须原样绿（CLI 逐 token 路径不动）。

### Phase 2：命令卡合并（工具卡+审批卡二合一）
**后端**
- `agent/runner.py` `TaskEvent(tool_start)` 加**完整 `command`**（现 `args`
  截 120 字符，命令串匹配会断——runner.py ~253）
- `_live` 的 `ai_tool start` 事件附加 `command, needs_approval, reasons, risk`
  （谓词已抽好：`core.policy.needs_approval(cmd, core.allowed)` +
  `core.policy.risk(cmd)`）
- **审批关联**：`ActionRequest`（langchain HITL）**无 tool_call id**——runner 侧
  记有序多重表 `(name, command) → deque[seq]`（同串并行命令按序消歧）；
  `_handle_events` 认领后发 `approval {id: cardId, command, reasons, risk}`
- `ai_tool` 卡 id 类型统一（现 `"tool"+seq` 字符串 vs `_cardSeq` 数字，app.js
  ~2136）

**前端（cards.jsx CommandCard = ToolCard + ApprovalCard 合并）**
```
┌──────────────────────────────┐
│ ▸ execute                      │ 出生（量高垫行，一发入魂）
│ $ rm -rf /var/log/old          │ ← 完整 command（非截断 args）
│ ⚠ 高危 · 删除文件 · 等待审批   │ ← 状态行（定高，理由槽出生即占位）
│ [执行] [修改] [拒绝]           │ ← 操作行（定高，回执行同高替换）
└──────────────────────────────┘
```
- 状态机：`执行中…` →（`needs_approval` 出生即真值则直接）`等待审批+按钮`
  →（决策）`✓已同意·执行中` → `✓完成(exit N)`/`✗失败` | `✗已拒绝`；
  **容忍审批不至**（`allowed` 只增：出生判定是过近似，中途「始终允许」命中则
  直接 ✓——合法迁移）
- **出生即定型**：状态行+操作行+理由槽全定高；高危两步确认做操作行内**浮层**
  （不长高，现 cards.jsx ~107-114 的 `apconfirm` 是长高的，要改）；回执与按钮
  簇同高（截断+title）；EditorCard 保留 portal + `.edopen` 量高豁免
  （app.js ~1312 已有）
- `showApproval`：改为 store 更新（`command_card_waiting(id,…)`），**不 mount
  不垫行**；保留 `_approvalModal` 兜底 + `_approvalGraceMs` 看门狗（防审批死锁，
  `approval_watchdog.test.cjs` 的不变量）；去重键改 `(id, command)`
  （现 `_approvalCmd` 全局串——同串并行命令会挡错）
- 决策守卫改**按卡 `decided`**（`_sendDecision` 单发守卫语义保留——
  幽灵决策是真事故，app.js ~2471-2481）；键盘 Ctrl+Enter/Ctrl+E/Ctrl+Backspace
  路由（`approvalKeys` ~2487）不变
- 中断残留策略：执行中/等待审批的命令卡**随中断移除**（今日语义保留）

**测试**：状态机单测（出生→等待→✓/✗/拒绝；approve/edit/allow 回执；
**双同串命令按序配对**；审批不至→✓）；`approval_order`/`approval_watchdog`/
`decision_settle`/`mount_mutex` 改写；`tools/verify-web/verify-card-dup.cjs`
S1 断言改（2 工具卡+2 审批卡 → 2 命令卡）。
**Gate**：`node --test tests/js/*.test.cjs` + `pytest -q`。

### Phase 3：徽标（可与 Phase 2 换序）
- 后端心跳已有（`progress {chars,in,out}`）；前端 `_refreshThink`（app.js
  ~2643）三态文案拼上 `· 已生成 N 字 · in X / out Y`（`usage` 事件到后修正为
  精确值）；`_phaseLive` 交接逻辑并入徽标模型
- **Gate**：徽标单测 + 长首轮手测（徽标每秒字数递增）

### Phase 4：长高机械拆除
**删**（app.js）：`_scheduleReanchor`/`_releaseGrow`/`growHolds`/`reanchorT`/
`+5` 裕量（`_fitNeed` 内）/`_stealBlankBelow`/`_unrevealedBelow`/长高相关
`_reanchor` 分支/`_clampCard` 流式路径。
**改**：`_watchCardResize` RO → **高度漂移报警**（夹紧到 `reserved`，或流底
一次性重垫），永不长高；`_endSweep` → 宽松「保留夹紧」（出生即完整的卡天然
过检；挂载失败走 `_fallbackPlain` 纯文本）；`_onBoundary` → **出生垫行排水**
（`_mountQ`+`_cardReady`+`_padQ` 排空再 ack `boundary_settled`——命令卡出生
垫行必须落在命令回显前，服务端 `pipeline._boundary_gate` 0.7s+pad-shield
**不动**）。
**保留（易误删）**：挂载时**空白尾复用**（app.js ~960-979，防卡缝靠它）、
`宁藏不盖`/`_slotHidden`/`_revealSlot`（出生窗）、`_cardReady`/`_mountQ` 串行、
`_padFused` 熔断、`_scheduleHeal`、`_floorRows`、`_releaseDecision` 安全排水、
`_approvalModal`、rescue 全套（出生即完整，天然合新模型）、welcome-hold 族、
ghost 占位提示（它有自己的 registerMarker/registerDecoration——「删所有
decoration」只限卡片槽机械）。
**⚠ 红线：`tests/js/hold_leak.test.cjs` 的「扣流 depth 归零」不变量必须保留
重写**（只删 grow 机制）——它是真机「打字不回显」事故的守卫，删了会静默回归。
**Gate**：hold 记账重写版 + 出生垫行精确性（pad 行数 = 量高行数）+ resize
重排用例 + `card_gap` 空白尾复用用例。

### Phase 5：真机验证
- `tools/verify-web/` 新驱动（复用 `lib.js` + `serve_scripted_model.py`；
  本地 PowerShell 会话：`config.toml` 写 `[target.x] mode = "local"` +
  `OPENTERMINAL_HOME` 隔离；`policy mode = "approve-all"` 强制出审批）
- 断言：命令卡全生命周期（auto/审批/拒绝/编辑/始终允许）、打字机、徽标计数、
  **不可变不变量（挂载后行快照 diff=空）**、图一（贴纸高 ≤ 预留行 DOM 断言）、
  图二（无 ≥6 连续无主空行）、`R8 页面无 JS 报错`
- 驱动骨架可参考 `.tmp/burn-wip/verify-burn.cjs`（旧方案的真机驱动，
  lib 用法/截图/探针可抄，断言对象不同）

## 6. 验证命令速查

```sh
# Python（venv 已建）
.venv-win/Scripts/python.exe -m pytest -q
# 环境性 flake 排除（负载下 30s 超时、单跑过）：
.venv-win/Scripts/python.exe -m pytest -q -k "not bare_shell" \
  --deselect tests/test_shell_integration.py

# JS
node --test tests/js/*.test.cjs

# React island
cd src/openterminal/web/frontend/ui && npm ci && npm test

# Windows 终端打中文必须带（否则 cp1252 崩）：
PYTHONIOENCODING=utf-8 ...
```

CLI 不回归硬线（任何阶段都必须原样绿）：`tests/test_term_render.py`、
`tests/test_term_capture.py`、`tests/live/`（13 例，本地 PTY）。

## 7. 红线清单（实现时不得违反）

1. **冲刷幂等**：`_flush_seg` 双空 no-op（limit/error 双路过）
2. **final 吞正文**：绝不把缓冲 text 与 final 同文双发（答案烧两遍）
3. **同步纪律**：`ai_result` 在事件处理路径内发出，不引入 await 缝隙插队
4. **出生即定型**：卡一旦 reveal，高度永不增长（resize 走夹紧/一次性重垫）
5. **打字机只动 opacity**（禁 clip/max-height——会与量高打架）
6. **单发决策守卫**（`_sendDecision`/按卡 `decided`）——幽灵决策回归是真事故
7. **hold 记账 depth 归零**不变量存活——「打字不回显」事故守卫
8. **CLI 逐 token 路径逐字不动**（paced_display=False 分支）
9. **审批永不静默死锁**：看门狗/模态兜底保留
10. 中断零残留；「始终允许」必须真的落 `core.allowed`
