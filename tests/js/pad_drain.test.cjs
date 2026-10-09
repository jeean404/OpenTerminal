// 嵌套扣流下的 pad 落账回归（真机「分析卡底部切 ---」「命令卡只剩两行」根因）：
// _settleCard/_mountCard/_scheduleReanchor 在外层扣着字节流，_ensurePad 内层的
// _releaseBytes 只把计数减一层——pad 打出的空行仍卡在 _holdBuf 里没进 xterm 缓冲。
// 旧实现落账前只 _flushWrites（空串回调），数到的还是旧缓冲，于是判「还缺行」→
// 夹紧钉死；随后下层卡一锚定，本卡永久盖帽，那几行空白再也补不回来。
// 修法：落账前 _drainHeld()——把已扣字节灌进终端并等解析完，扣流本身照旧生效
// （PTY 顺序即真相：空行必在其后到达的输出之前，提前灌入不会错位）。
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const {
  rowsForPx, blankRun, padGap,
} = require("../../src/openterminal/web/frontend/static/pad_ledger.js");

const APP = path.join(__dirname, "..", "..", "src", "openterminal",
  "web", "frontend", "static", "app.js");

function loadSessionClass() {
  const src = fs.readFileSync(APP, "utf8");
  const fakeDoc = {
    createElement: () => ({style: {}, classList: {add() {}, remove() {}}}),
    addEventListener() {},
    getElementById: () => ({onclick: null, addEventListener() {}, value: ""}),
    querySelectorAll: () => [],
    head: {appendChild() {}},
    body: {classList: {toggle() {}}},
  };
  const factory = new Function(
    "window", "document", "sessionStorage", "fetch", "performance", "mdLite",
    "rowsForPx", "blankRun", "padGap",
    src + "\n;return Session;");
  return factory(
    {addEventListener() {}}, fakeDoc,
    {getItem: () => null, setItem() {}, removeItem() {}},
    () => new Promise(() => {}),
    {now: () => 0},
    s => s,
    rowsForPx, blankRun, padGap);
}

// 假 xterm：write 入队、setTimeout(0) 批量解析后按序回调——异步语义与真 xterm
// 一致，_flushWrites 的空串回调因此排在已入队字节之后（正是真机的时序）。
function makeFakeTerm(lines, cursor) {
  const state = {lines: lines.slice(), cursor};
  const queue = [];
  let pump = null;
  const parse = s => {
    for (const ch of s) {
      if (ch === "\n") {
        state.cursor++;
        while (state.lines.length <= state.cursor) state.lines.push("");
      } else {
        state.lines[state.cursor] = (state.lines[state.cursor] || "") + ch;
      }
    }
  };
  const term = {
    rows: 24, cols: 80,
    write(data, cb) {
      queue.push({
        s: typeof data === "string" ? data : new TextDecoder().decode(data), cb,
      });
      if (pump) return;
      pump = setTimeout(() => {
        pump = null;
        for (const it of queue.splice(0, queue.length)) {
          parse(it.s);
          if (it.cb) it.cb();
        }
      }, 0);
    },
    buffer: {active: null, normal: null},
  };
  const buf = {
    get length() { return state.lines.length; },
    getLine(i) {
      if (i < 0 || i >= state.lines.length) return undefined;
      const t = state.lines[i];
      return {translateToString: () => t};
    },
    get baseY() { return state.cursor; },
    cursorY: 0,
    get viewportY() { return Math.max(0, state.cursor - term.rows + 1); },
  };
  term.buffer.active = buf;
  term.buffer.normal = buf;
  return {term, state};
}

// 只够跑 pad 账目的会话：扣流/落账/盖帽判定全用真实现，worker 打成
// 「收到 pad 请求就往 PTY 流里打空行、随后应答」（应答先于字节解析到达）
function makePadSession(lines, cursor) {
  const Session = loadSessionClass();
  const s = Object.create(Session.prototype);
  const {term, state} = makeFakeTerm(lines, cursor);
  s._dead = false;
  s.term = term;
  s._slots = new Map();
  s._holdDepth = 0;
  s._holdBuf = [];
  s._holdTags = [];
  s._lastByteAt = 0;
  s._welcomeHold = null;
  s._padFused = false;
  s._padFailStreak = 0;
  s._padQ = Promise.resolve();
  s._scheduleHeal = () => {};
  s.sent = [];
  s.sendJson = msg => {
    s.sent.push(msg);
    if (msg.type !== "pad") return;
    s._ingestBytes(new TextEncoder().encode("\n".repeat(msg.pad)));
    s._onPadded();
  };
  return {s, state};
}

const tick = () => new Promise(r => setTimeout(r, 0));

test("_drainHeld：灌掉已扣字节，但扣流照旧（后续字节继续入队）", async () => {
  // 行 0 是提示符，行 1..5 空白，光标在 6
  const {s, state} = makePadSession(["[root@h ~]#", "", "", "", "", ""], 6);
  s._holdBytes("outer");
  s._ingestBytes(new TextEncoder().encode("\n\n"));
  assert.strictEqual(state.cursor, 6, "扣流中字节不得落屏");
  await s._drainHeld();
  assert.strictEqual(state.cursor, 8, "已扣字节应灌进缓冲（否则账目数不到）");
  assert.strictEqual(s._holdDepth, 1, "灌字节不得顺手解除扣流");
  s._ingestBytes(new TextEncoder().encode("\n"));
  assert.strictEqual(state.cursor, 8, "扣流仍生效：新字节继续入队");
  s._releaseBytes();
  await tick(); await tick();
  assert.strictEqual(state.cursor, 9, "放行后剩余字节照常落屏");
});

test("外层扣流下 _ensurePad 落账数得到刚垫的空行：不误夹紧、不钉死", async () => {
  const {s} = makePadSession(["[root@h ~]#", "", "", "", "", ""], 6);
  const slot = {
    id: 1, marker: {line: 1, onDispose() {}}, host: null,
    reserved: 0, need: 8, rows: 7, clamped: false, pinnedRows: null,
  };
  s._slots.set(1, slot);
  assert.strictEqual(s._blankSpan(slot), 5, "起手：marker 下 5 行连续空白");
  s._holdBytes("card-settle");        // 结账/挂载的外层临界区
  try {
    await s._ensurePad(slot);
  } finally {
    s._releaseBytes();
  }
  assert.deepStrictEqual(s.sent.map(m => m.pad), [3], "只补真缺口 3 行");
  assert.strictEqual(slot.reserved, 8, "落账应数到刚垫的空白（旧实现停在 5）");
  assert.strictEqual(slot.clamped, false, "垫满了不得误夹紧");
  assert.strictEqual(slot.pinnedRows, null, "不得钉死截断");
});

test("垫满后再跑一轮：缺口 0 不再打 pad（垫过不能回吐，多垫就是卡间空白）", async () => {
  const {s} = makePadSession(["[root@h ~]#", "", "", "", "", ""], 6);
  const slot = {
    id: 1, marker: {line: 1, onDispose() {}}, host: null,
    reserved: 0, need: 8, rows: 7, clamped: false, pinnedRows: null,
  };
  s._slots.set(1, slot);
  s._holdBytes("card-settle");
  try {
    await s._ensurePad(slot);
    await s._ensurePad(slot);
  } finally {
    s._releaseBytes();
  }
  assert.deepStrictEqual(s.sent.map(m => m.pad), [3], "第二轮缺口 0，不得再垫");
  assert.strictEqual(slot.clamped, false);
});

test("被盖帽的卡（下方已有输出）不补差，只按已垫高度夹紧", async () => {
  // 行 1..2 空白，行 3 是命令输出：连续空白断在 3，pad 再也垫不进本区
  const {s} = makePadSession(["[root@h ~]#", "", "", "total 12", ""], 8);
  const slot = {
    id: 1, marker: {line: 1, onDispose() {}}, host: null,
    reserved: 0, need: 8, rows: 7, clamped: false, pinnedRows: null,
  };
  s._slots.set(1, slot);
  assert.strictEqual(s._capped(slot), true, "下方有输出即盖帽");
  s._holdBytes("card-settle");
  try {
    await s._ensurePad(slot);
  } finally {
    s._releaseBytes();
  }
  assert.deepStrictEqual(s.sent, [], "盖帽卡不得再发 pad（垫在流底只会拉大空白）");
  assert.strictEqual(slot.clamped, true, "宁矮不盖：夹紧截断");
});

test("自愈：盖帽但钉死的卡仍要重锚（下层卡占位落地后解钉），只是不再发 pad", async () => {
  const {s} = makePadSession(["[root@h ~]#", "", "", "total 12", ""], 8);
  const pinned = {
    id: 1, marker: {line: 1, onDispose() {}}, host: null,
    reserved: 2, need: 8, rows: 7, clamped: true, pinnedRows: 2,
  };
  const loose = {
    id: 2, marker: {line: 1, onDispose() {}}, host: null,
    reserved: 2, need: 8, rows: 7, clamped: false, pinnedRows: null,
  };
  s._slots.set(1, pinned);
  s._slots.set(2, loose);
  const healed = [];
  const padded = [];
  s._reanchor = slot => healed.push(slot.id);
  s._ensurePad = async slot => { padded.push(slot.id); };
  s._healAll();
  await tick(); await tick(); await tick();
  assert.deepStrictEqual(padded, [], "盖帽卡垫不进差，不该再发 pad");
  assert.deepStrictEqual(healed, [1],
    "钉死的盖帽卡要重锚解钉（否则永久停在半截高度）；未钉死的跳过");
});

test("谎报型死通道：ack 到了但空白没长——连败 2 次熔断，不再发 pad（提示符墙根因）", async () => {
  // su - 换壳后嵌套壳标记照发、hook 函数全空：后端把 __ot_pad 敲进裸壳只换来
  // command not found + 新提示符而 padded 照发——超时熔断永远够不着，pad 请求
  // 循环把提示符敲成横排墙（真机 101.33 su - 后截图）。修法：ack 后对账空白，
  // 一行没长同计入连败，2 次熔断走既有的宁截断不空转。
  const {s} = makePadSession(["[root@h ~]#", "", "", "", "", ""], 6);
  s.sendJson = msg => {          // 谎报壳：应答照发、空行永不落地
    s.sent.push(msg);
    // 微任务里应答：真 ack 与 _padWait 武装（new Promise 执行器同步赋值）
    // 的先后即此序；同步应答会在武装前到达、被错过（真机 ack 不会）
    if (msg.type === "pad") queueMicrotask(() => s._onPadded());
  };
  s.setStatus = () => {};
  const slot = {
    id: 1, marker: {line: 1, onDispose() {}}, host: null,
    reserved: 0, need: 8, rows: 7, clamped: false, pinnedRows: null,
  };
  s._slots.set(1, slot);
  s._holdBytes("card-settle");
  try {
    await s._ensurePad(slot);    // 第 1 轮：缺口 3，ack 了但空白没长 → 连败 1
  } finally {
    s._releaseBytes();
  }
  assert.strictEqual(s._padFused, false, "单次对不上账不成局");
  assert.strictEqual(slot.clamped, true, "空白没长，落账仍按缺口夹紧");
  slot.need = 10;                // 卡长高再结账：连败 2 → 熔断
  s._holdBytes("card-settle");
  try {
    await s._ensurePad(slot);
  } finally {
    s._releaseBytes();
  }
  assert.strictEqual(s._padFused, true, "连续两轮空白没长：熔断");
  assert.deepStrictEqual(s.sent.map(m => m.pad), [3, 5], "熔断前只发两轮");
  s.sent.length = 0;
  s._holdBytes("card-settle");
  try { await s._ensurePad(slot); } finally { s._releaseBytes(); }
  assert.deepStrictEqual(s.sent, [], "熔断后 _ensurePad 直接返回，不再发请求");
});

test("deferred ack（重注入在途窗口）：空白没长不计熔断连败，不误熔断", async () => {
  // 慢链路重注入 1-4s，窗口内连续 pad 都 ack 了但空白没长——deferred 标记
  // 让前端不计连败；通道痊愈后下一轮 pad 自会补齐
  const {s} = makePadSession(["[root@h ~]#", "", "", "", "", ""], 6);
  s.sendJson = msg => {
    s.sent.push(msg);
    if (msg.type === "pad") queueMicrotask(() => s._onPadded({deferred: true}));
  };
  s.setStatus = () => {};
  const slot = {
    id: 1, marker: {line: 1, onDispose() {}}, host: null,
    reserved: 0, need: 8, rows: 7, clamped: false, pinnedRows: null,
  };
  s._slots.set(1, slot);
  s._holdBytes("card-settle");
  try {
    await s._ensurePad(slot);
    await s._ensurePad(slot);    // 两轮都 deferred：不得熔断
  } finally {
    s._releaseBytes();
  }
  assert.strictEqual(s._padFused, false, "deferred ack 不计连败");
  assert.deepStrictEqual(s.sent.map(m => m.pad), [3, 3], "窗口内仍照常请求");
  // 窗口后通道痊愈：真垫行落地（healthy 路径）→ 连败清零、缺口补满
  s.sendJson = msg => {
    s.sent.push(msg);
    if (msg.type === "pad") {
      s._ingestBytes(new TextEncoder().encode("\n".repeat(msg.pad)));
      queueMicrotask(() => s._onPadded({deferred: false}));
    }
  };
  s._holdBytes("card-settle");
  try {
    await s._ensurePad(slot);
  } finally {
    s._releaseBytes();
  }
  assert.strictEqual(slot.reserved, 8, "痊愈后垫满：reserved 达到 need");
  // clamped 的解除归 _reanchor（reserved ≥ rows 即解钉重贴，见 _reanchor
  // 的解夹紧分支；「自愈」用例已覆盖该契约）——_ensurePad 只管垫满
});
