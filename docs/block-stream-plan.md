# 块流布局改造 · 实施计划

> 状态：Phase 1 + 2 已落地并真机验证（21/21）；Phase 3/4 待做
> 效果图：`.tmp/ui-blocks-mockup.html`（静态） / `.tmp/ui-motion-demo.html`（动画）
> 架构对比：`.tmp/grid-vs-blocks.html`

## 一、目标

卡片渲染从「贴在 xterm 网格行上的浮层」改为「流式布局里的块」。

| 效果 | 验收口径 |
|---|---|
| 保留现有观感 | 卡片 DOM 与类名不变（`.acard`/`.ablock`/`.scard`），样式表原样 |
| 排版不乱 | 卡片顶边 = 锚定块的下边界；不越块、不错序 |
| 不被遮挡 | 任意时刻卡片矩形与文本矩形不相交（`elementFromPoint` 命中测试） |
| 无大量空白 | 卡片块高度 = `scrollHeight`，卡间无垫行残留 |
| 卡片不消失 | 挂载后常驻（虚拟化则滚回必还原）；只有「完整 / 整卡移除」两种终态 |
| 终端原生 | Tab 补全、↑↓ 历史、Ctrl+R、块内划选复制、alt-screen 应用全部照旧 |
| **换壳/跳板** | 上述逐条在 `sudo su -`、`su - user`、`ssh 跳板` 后复测通过 |

最后一条是硬门槛：做不到它，前面的都不算数。

## 二、设计原则

- **P1 布局不得依赖 shell 集成**：`sudo su -` 会重置 `PS1`/`PROMPT_COMMAND`，hook 必死。布局必须在裸壳下也成立。
- **P2 标记是加速器，不是依赖**：OSC 133 在位时提精度；不在位时本地推断。有没有标记只影响「放得多准」。
- **P3 锚点是身份，不是坐标**：卡片挂 `card-2` 这个块 id，不挂「第 9 行」。

**推论**：4 条效果（不遮挡/不裁切/无大空白/不消失）是**常量**，任何时候成立；只有「卡片位置精度」是**变量**。

## 三、已定决策

| 项 | 决定 | 谁定的 |
|---|---|---|
| 滚动 | 跟着滚；用户一往上翻就停住，并出「回到底部」 | 用户 |
| 虚拟化 | 看不见的暂不画；**等用户点按钮的卡永不不画**；滚回必还原 | 我 |
| 跨卡选择 | **不允许**；卡片内文字（命令/错误正文）可单独选中复制 | 用户 |
| 降级时位置 | 卡片完整、按钮能点，只是靠上/靠下一段，**绝不插进一段中间** | 我 |
| 断线重连 | 每块有唯一 id，按 id 补，已存在的不重复 | 我 |
| 多工具并行 | 按 **AI 宣告序**排队（不是按谁先跑） | 我 |
| 改造节奏 | 三步，每步可验收、可回退 | 我 |

## 四、块流模型

```
Block = {
  id:      "card-3",        // 全会话唯一，永不改变
  kind:    "term" | "card" | "banner" | "transition",
  state:   "live" | "frozen",
  after:   "cmd-2",         // 前驱块 id ← 卡片/输出的锚点
  trigger: { type, text, at },
  payload: { … },
  conf:    0.9,             // 边界置信度
}
```

**输出归属**（已落地）：`TermBlock.after = "card-1"` → 插在 card-1 之后。并行三工具时，
out-2 插到 card-2 后面，card-3 自然下移。列表按 id 插入，不存在「抢位置」。

归属靠**执行边界括号**（`term_open`/`term_close`，来自 C/D 标记）而不是挂载时刻：
并行 tool_call 的 N 张卡在首字节输出到达前就挂完了，挂载时切块必然次次切空。
谁在跑就贴谁的卡，抢锁序与宣告序不一致也贴得对。块口径为**回显行 + 输出**，命令行
同在：回显行由 `term_open` 事件带过去（后端按 `_cur_prompt` 拼），丢了就补，
见 `block_stream.js` 的 `ensureCmdEcho`。

## 五、块边界识别

```
IDLE ─按键→ TYPING ─Enter→ SUBMITTED ─首字节→ STREAMING
  ▲                                                │
  └──────── SETTLED ←静默≥N ms─────────────────────┘
      └─ 置 SAFE_TO_CUT → 切块，开新 term 块
```

| 级别 | 依据 | 何时可用 | 精度 |
|---|---|---|---|
| L0 | OSC 133 标记 | hook 在位 | 精确 |
| L1 | 我方 `\r` + 静默 + 提示符形状 | 始终 | 较准 |
| L2 | 仅静默期 + 光标在行首 | 始终 | 粗 |
| L3 | 都不成立 | — | **不切**（默认安全态） |

**换壳/跳板**：指令是我方亲手敲进 PTY 的，100% 可靠。

```
SHELL_SWITCH_RE = /^\s*(sudo\s+)?(su(\s+-|\s+[a-z_][a-z0-9_-]*)?|login|ssh\s+|mosh\s+|exec\s+|screen\s|tmux\s)/
```

命中 → 当前块 frozen → 开 `transition` 块接住换壳输出 → 静默 + 新提示符 → 开新 `term` 块
→ **重置增强状态**（hook 视为未知），**布局状态照常继续**。

## 六、渲染拓扑

```
[ScrollContainer]              ← 唯一滚动面
 ├─ BlockView(term, frozen) → 只读 DOM
 ├─ BlockView(card)         → React DOM（现有 cards.jsx）
 ├─ BlockView(term, frozen) → 只读 DOM
 └─ BlockView(term, LIVE)   → xterm.js 实例（活动区）
```

- **活动区**是唯一 xterm，Tab/↑/Ctrl+R 全在这里 → 终端原生天然保留
- **alt-screen**（vim/top）：进 alt-buffer 时不开块、不插卡片
- **冻结时机**：`SAFE_TO_CUT` 且提示符已识别 → `serialize()` → 只读 DOM → `reset()` → 重画提示符。
  识别不确定就**不切**。

## 七、降级阶梯

```
L0 标记在位    → 卡片贴块边界，零空白
L1 prompt 识别 → 卡片贴块边界，块稍粗
L2 静默期切块  → 卡片偏上/偏下一个块
L3 切不动      → 卡片进待安置条
────────────────────────────────────────
每一级都满足：不遮挡 / 不裁切 / 无大空白 / 不消失 / 终端原生
变的只有「卡片放得多准」
```

## 八、实施步骤

### Phase 1 —— 卡片不再占终端行 ✅ 已完成并真机验证
**做什么**：`BlockStream` 数据结构 + 流式块布局；卡片从 xterm decoration 迁到块里。
**改哪里**：新增 `static/block_stream.js`；`app.js` 卡片层（`_runMountCard`/`_applyDecoration`/
`_styleHost`/`_floorRows`/`_ensurePad`/pad 记账整段退役）；`ui/src/cards.jsx` 不动。
**验收**：效果图前 5 条 + 截图对照 + `elementFromPoint` 命中测试。
**你能看到**：不遮挡、不裁切、没大空白——第一天就见效。

### Phase 2 —— 块怎么切、输出怎么认领 ✅ 已完成并真机验证（切在卡片挂载前）
**做什么**：`BlockCutter`（L1/L2）+ 冻结/只读块 + 活动区独立 + 滚动跟随策略。
**验收**：多卡片排队整齐、输出不串、Tab/↑/Ctrl+R 全测、长会话性能。

### Phase 3 —— 换壳 / 跳板机
**做什么**：`ShellSwitchDetector` + `transition` 块 + 全链路。
**验收**：`sudo su -`、`su - user`、`ssh 跳板` 后逐条复测。

### Phase 4 —— 收尾
**做什么**：L0 标记加速 + 虚拟化 + alt-screen 收尾 + 断线重连幂等。
**验收**：全量回归 + 真机驱动全绿。

## 九、退役清单（Phase 1 后可删）

这些全是「卡片占网格行」的税：

- pad 账目：`pad_ledger.js` 的 `blankRun`/`padGap`、`_ensurePad`、`_padQ`、`_padOut`
- 扣流记账：`_holdBytes`/`_releaseBytes`/`_drainHeld`/`_holdDepth`
- 夹紧/底线：`_clampCard`/`_floorRows`/`pinnedRows`/`_styleHost` 的高度策略
- 显隐阀：`_revealSlot`/`_refreshThink`/`_slotHidden`/宁藏不盖
- 漂移与搬移：`_scheduleDrift`/`_reanchor`/`_relocateToBottom`
- shell 侧 pad 通道：`_shell_pad`、`__ot_pad` 注入与净化

**保留**：shell 集成（自然语言路由/工具上报）、审批管线、`cards.jsx` 视觉。

## 十、风险与对策

| 风险 | 对策 |
|---|---|
| 流式长卡推动滚动 | 跟随滚；用户一翻就停（已定） |
| 虚拟化卸载掉未决审批卡 | 铁律：`interactive && !decided` 的块永不卸载 |
| 跨块划选 | 不做（已定）；块内选中复制正常 |
| 滚动锚定（上方插块推走内容） | `overflow-anchor` 或手工补偿，Phase 2 一并做 |
| 巨块输出撑爆 DOM | 冻结块行数上限 + 溢出折叠 |
| 输出无法归属（hook 挂） | 进「当前打开的块」= 流末尾；位置稍粗，卡片不坏 |
| 断线重连重复补块 | 按 id 幂等 |
| `tail -f` 长驻 | 块行数上限 → 自动冻结 + 开新块 |
| 提示符识别错 → 冻结切错位 | 识别不确定就不切（L3 是默认安全态） |
| 收束类丢卡（`summary_card_lost`） | 属任务生命周期，另案修，本方案不解决 |
