// 取证：总结卡渲染完毕后「命令行卡顿几秒 / 打字不回显、几秒后才回显」。
// 真机拓扑 = docker ot-repro（ubuntu@127.0.0.1:2222 bash）+ 脚本化模型
// （core/HITL/WS/xterm/PTY 全真实），场景「总结」出一张 24 行表格的高总结卡。
//
// 三路时钟对齐（全部 page 内 performance.now()）：
//   wsIn  — WS 帧到达（后端是否还在发）
//   write — term.write（字节有没有落进 xterm）
//   raf   — requestAnimationFrame 心跳（主线程有没有被堵）
// 一比就能定性：
//   帧到、write 迟 → 前端扣流（_holdBytes）；帧不来 → 后端停；
//   raf 断流       → 主线程被同步渲染堵死。
// 另测按键 → 回显上屏时延（用户真实体感）。
// 用法: node tools/verify-web/diag-post-final-freeze.cjs [port] [--keep]
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const { spawn, spawnSync } = require("node:child_process");
const lib = require("./lib");

const PORT = Number(process.argv[2] || 8307);
const KEEP = process.argv.includes("--keep");
// --real 走 15721 网关真模型（流式分片真实，总结卡时序与用户现场一致）；
// 默认走 serve_scripted_model.py（模型边界可复现）
const REAL = process.argv.includes("--real");
const QUESTION = process.env.OT_FREEZE_Q ||
  (REAL ? "查看当前目录和系统信息，然后用中文总结一下"
        : "总结");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const say = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const HOME = path.join(lib.OUT, "freeze-home");
const TARGET = "repro";
const SSH_PORT = 2222;
const PW = { ubuntu: "ub123456" };

function pythonExe() {
  for (const c of [
    path.join(lib.REPO, ".venv-win", "Scripts", "python.exe"),
    path.join(lib.REPO, ".venv", "Scripts", "python.exe"),
  ]) if (fs.existsSync(c)) return c;
  throw new Error("no python found");
}

function prepareHome() {
  if (!KEEP) fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(path.join(HOME, "config.toml"), [
    "# diag-post-final-freeze 专用（隔离 OPENTERMINAL_HOME）",
    "[model]",
    'provider = "anthropic"',
    'base_url = "http://127.0.0.1:15721"',
    'model = "claude-sonnet-4-6"',
    'api_key_env = "ANTHROPIC_API_KEY"',
    "",
    "[policy]",
    'mode = "tiered"',
    'auto_extra = ["echo", "ls", "pwd", "cat", "id", "whoami", "hostname", "uname", "df"]',
    "",
    "[web]",
    'host = "127.0.0.1"',
    "port = " + PORT,
    "",
  ].join("\n"), "utf8");
  const r = spawnSync(pythonExe(), [path.join(lib.REPO, "tools", "verify-web",
    "fixtures", "seed-saved-conn.py")], {
    cwd: lib.REPO,
    env: Object.assign({}, process.env, {
      OPENTERMINAL_HOME: HOME, PYTHONIOENCODING: "utf-8",
      OT_SEED_NAME: TARGET, OT_SEED_HOST: "127.0.0.1",
      OT_SEED_PORT: String(SSH_PORT), OT_SEED_USER: "ubuntu",
      OT_SEED_COMMANDS: "",
    }),
    encoding: "utf8",
  });
  const out = ((r.stdout || "") + (r.stderr || "")).trim();
  if (r.status !== 0 || out.indexOf(TARGET) === -1)
    throw new Error("seed connections.db 失败: " + out);
  say("已落库:", out);
}

async function startServer() {
  const base = "http://127.0.0.1:" + PORT;
  let up = false;
  try { up = (await fetch(base + "/")).ok; } catch (e) { up = false; }
  if (up) throw new Error("端口 " + PORT + " 已占用；换端口重试");
  const logFd = fs.openSync(path.join(lib.OUT, "server-" + PORT + ".log"), "w");
  const env = Object.assign({}, process.env, {
    OPENTERMINAL_HOME: HOME,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "freeze-key",
    OT_WEB_DEBUG: "1",
    PYTHON_KEYRING_BACKEND: "keyring.backends.null.Keyring",
    PYTHONIOENCODING: "utf-8",
  });
  const args = REAL
    ? ["-m", "openterminal.app", "web", "--port", String(PORT), "--no-open"]
    : [path.join(__dirname, "serve_scripted_model.py"),
       "--port", String(PORT), "--no-open"];
  const server = spawn(pythonExe(), args,
    { cwd: lib.REPO, stdio: ["ignore", logFd, logFd], env });
  const t0 = Date.now();
  while (Date.now() - t0 < 40000) {
    try { if ((await fetch(base + "/")).ok) return { base: base, server: server }; } catch (e) {}
    if (server.exitCode != null) throw new Error("服务端提前退出 code=" + server.exitCode);
    await sleep(400);
  }
  throw new Error("服务端 40s 未就绪");
}

// ---- page 内仪表：WS / write / raf 三路时钟 ----
function initProbe() {
  try { localStorage.setItem("otdbg", "1"); } catch (e) { /* 隐私模式 */ }
  const P = window.__probe = {
    wsIn: [], wsOut: [], writes: [], raf: [], err: [],
    armed: null, armedAt: 0, armedSeen: null,
  };
  const guard = (name, fn) => {
    try { fn(); } catch (e) { P.err.push(name + ": " + (e && e.message)); }
  };
  guard("ws", () => {
    const OW = window.WebSocket;
    window.WebSocket = function (...a) {
      const ws = new OW(...a);
      ws.addEventListener("message", ev => {
        if (typeof ev.data === "string") {
          let k = "text";
          try {
            const m = JSON.parse(ev.data);
            if (m && m.type) k = m.type + (m.event && m.event.kind ? ":" + m.event.kind : "");
          } catch (e) { /* 非 JSON */ }
          P.wsIn.push({ t: performance.now(), k: k, n: ev.data.length, s: ev.data.slice(0, 160) });
        } else if (ev.data instanceof Blob) {
          P.wsIn.push({ t: performance.now(), k: "blob", n: ev.data.size });
        } else if (ev.data instanceof ArrayBuffer) {
          P.wsIn.push({ t: performance.now(), k: "bin", n: ev.data.byteLength });
        }
      });
      const os = ws.send.bind(ws);
      ws.send = d => {
        if (typeof d === "string") P.wsOut.push({ t: performance.now(), s: d.slice(0, 200) });
        os(d);
      };
      return ws;
    };
  });
  guard("term", () => {
    // addInitScript 早于 xterm.js 执行，此刻 window.Terminal 还是 undefined：
    // 用 defineProperty 接住它被赋值的那一刻再包一层（直接赋值会把 xterm 覆盖掉
    // 成「未定义构造器」，终端整个建不起来 —— 踩过）
    let rawT = null, wrapT = null;
    Object.defineProperty(window, "Terminal", {
      configurable: true,
      get() {
        if (rawT && !wrapT) {
          const OT = rawT;
          wrapT = function (...a) {
            const t = new OT(...a);
            const ow = t.write.bind(t);
            t.write = (data, cb) => {
              const n = typeof data === "string" ? data.length : ((data && data.length) || 0);
              if (n) P.writes.push({ t: performance.now(), n: n });
              return ow(data, cb);
            };
            return t;
          };
          wrapT.prototype = OT.prototype;
          try { Object.assign(wrapT, OT); } catch (e) { /* 只读导出跳过 */ }
        }
        return wrapT || rawT;
      },
      set(v) { rawT = v; wrapT = null; },
    });
  });
  guard("raf", () => {
    const tick = () => {
      P.raf.push(performance.now());
      if (P.raf.length > 5000) P.raf.splice(0, P.raf.length - 5000);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  guard("mo", () => {
    const mo = new MutationObserver(() => {
      if (P.armed == null || P.armedSeen != null) return;
      const el = document.querySelector(".xterm-rows");
      if (el && (el.textContent || "").indexOf(P.armed) !== -1) P.armedSeen = performance.now();
    });
    const startObs = () => {
      const el = document.querySelector(".xterm-rows");
      if (el) mo.observe(el, { subtree: true, childList: true, characterData: true });
      else setTimeout(startObs, 200);
    };
    startObs();
    window.__probe.arm = ch => { P.armed = ch; P.armedAt = performance.now(); P.armedSeen = null; };
    window.__probe.disarm = () => { P.armed = null; };
  });
  P.take = () => ({ ch: P.armed, at: P.armedAt, seen: P.armedSeen });
  P.dump = () => ({ wsIn: P.wsIn, wsOut: P.wsOut, writes: P.writes, raf: P.raf, err: P.err });
}

async function clickTerm(page) {
  for (let i = 0; i < 6; i++) {
    try { await page.locator(".term").click({ timeout: 3000, force: true }); await sleep(120); return true; }
    catch (e) { /* retry */ }
    await sleep(300);
  }
  return false;
}

// 只认 WS ask_password 帧 + 模态标题（绝不按终端行尾猜密码）
async function pwTick(page) {
  return page.evaluate((rules) => {
    const root = document.querySelector("#modal-root");
    const modal = root && root.querySelector(".modal");
    if (!modal) return null;
    const title = ((modal.querySelector("h3") || {}).innerText || "").trim();
    const body = (modal.innerText || "").replace(/\s+/g, " ");
    const btn = re => Array.from(root.querySelectorAll(".modal-btns button"))
      .find(b => re.test(b.innerText || ""));
    if (/记住/.test(title) && /密码/.test(title)) {
      const b = btn(/不记住|不记|拒绝|取消/);
      if (b) { b.click(); return "remember:no"; }
      return null;
    }
    if (/主机密钥|host key/i.test(title)) {
      const b = btn(/信任|确定/);
      if (b) { b.click(); return "hostkey:trust"; }
      return null;
    }
    if (/密码|令牌|password|token/i.test(title)) {
      const v = document.getElementById("modal-value");
      let pw = rules.ubuntu;
      for (const u of Object.keys(rules)) if (body.indexOf(u) !== -1) { pw = rules[u]; break; }
      if (v) v.value = pw;
      const rem = document.getElementById("modal-remember");
      if (rem) rem.checked = false;
      const b = btn(/确定/);
      if (b) { b.click(); return "pw:" + pw; }
    }
    return null;
  }, PW);
}

// WS 帧录：ask_password 是终端内联捕获（无模态），必须按帧驱动代答
let pwPending = false, pwSeenAt = 0;
function hookWs(page) {
  page.on("websocket", ws => {
    ws.on("framereceived", f => {
      try {
        const m = JSON.parse(String(f.payload));
        if (m && m.type === "ask_password") { pwPending = true; pwSeenAt = Date.now(); }
        else if (m && (m.type === "ready" || m.type === "closed")) pwPending = false;
        else if (m && m.type === "event" && m.event && m.event.kind === "final")
          global.finalAt = Date.now();
      } catch (e) { /* 二进制帧 */ }
    });
  });
}

// WS ask_password → 终端内联捕获期敲密码（客户端捕获吃键，发 auth JSON）
async function pwTermTick(page) {
  if (!pwPending || Date.now() - pwSeenAt < 600) return null;
  if (!(await clickTerm(page))) return null;
  await page.keyboard.type(PW.ubuntu, { delay: 15 });
  await page.keyboard.press("Enter");
  pwPending = false;
  return "termpw";
}

let butlerStop = false;
function startButler(page) {
  (async () => {
    let cool = 0;
    while (!butlerStop) {
      try {
        if (Date.now() > cool) {
          const act = (await pwTick(page)) || (await pwTermTick(page));
          if (act) { say("    [butler]", act); cool = Date.now() + 800; }
        }
      } catch (e) { /* 页面导航/关闭 */ }
      await sleep(250);
    }
  })();
}

async function waitNoModal(page, timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const has = await page.evaluate(() => !!document.querySelector("#modal-root .modal"));
    if (!has) return true;
    await sleep(250);
  }
  return false;
}

async function waitReady(page, timeout = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const ok = await page.evaluate(() => {
      const g = id => {
        const el = document.querySelector('[id^="' + id + '-"]');
        return el ? (el.hidden ? "hidden" : "shown") : "missing";
      };
      const st = document.querySelector('[id^="status-"]');
      return g("conn") !== "shown" && g("connov") !== "shown"
        && !!((st && st.innerText) || "").trim();
    });
    if (ok) return true;
    await sleep(400);
  }
  return false;
}

async function typeLine(page, text) {
  for (let i = 0; i < 20 && pwPending; i++) await sleep(250);   // 等代答落地
  if (!(await waitNoModal(page))) throw new Error("模态未退场，输入会丢失");
  if (!(await clickTerm(page))) throw new Error("点不到终端");
  await sleep(150);
  await page.keyboard.type(text, { delay: 45 });
  const t0 = Date.now();
  while (Date.now() - t0 < 4000) {
    const txt = await termText(page);   // lib.snapshot 在本机 xterm 版本下读不到行
    if (txt.indexOf(text) !== -1) break;
    await sleep(150);
  }
  await sleep(350);
  await page.keyboard.press("Enter");
}

// 审批放行：点「确认执行 / 执行 / 同意」，直到本轮无未决卡
async function approveAll(page, timeout = 30000) {
  const acts = [];
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const a = await page.evaluate(() => {
      const txt = x => (x.innerText || "").replace(/\s+/g, "");
      const heads = Array.from(document.querySelectorAll(".acard.aprobe:not(.tcard)"))
        .filter(c => /\u662f\u5426\u540c\u610f/.test((c.querySelector(".aphead") || {}).innerText || ""))
        .filter(c => !c.querySelector(".apstate"));
      const head = heads[0];
      if (!head) return "none";
      const btns = Array.from(head.querySelectorAll("button"));
      const b = btns.find(x => /^\u786e\u8ba4\u6267\u884c$/.test(txt(x)))
              || btns.find(x => /^(\u6267\u884c|\u4fdd\u5b58\u5e76\u6267\u884c|\u540c\u610f|\u6279\u51c6)$/.test(txt(x)))
              || btns.find(x => /\u6267\u884c|\u540c\u610f|\u6279\u51c6/.test(txt(x))
                            && !/\u59cb\u7ec8|\u6c38\u4e45|\u53d6\u6d88|\u4fee\u6539|\u62d2\u7edd/.test(txt(x)));
      if (!b) return "no-btn";
      b.click();
      return "click:" + txt(b);
    });
    if (a !== "none") { acts.push(a); say("    [approve]", a); await sleep(500); continue; }
    await sleep(300);
  }
  return acts;
}

// 按键 → 回显上屏时延（page 内 performance.now()，无 IPC 抖动）。
// 哨兵必须是屏上不可能先在的串：单个大写字母会撞已有文本（测出假 TIMEOUT/
// 假 17ms —— 踩过），这里用 z<序号>y 三字符。
async function echoLatency(page, token, label) {
  await page.evaluate(c => window.__probe.arm(c), token);
  await page.keyboard.type(token, { delay: 2 });
  let r = null;
  for (let w = 0; w < 300; w++) {
    r = await page.evaluate(() => window.__probe.take());
    if (r && r.seen != null) break;
    await sleep(5);
  }
  const lat = r && r.seen != null ? Math.round(r.seen - r.at) : null;
  say("    [回显] " + label + " " + token + " -> " +
      (lat == null ? "TIMEOUT(3s 未上屏)" : lat + "ms"));
  await page.evaluate(() => window.__probe.disarm());
  return lat;
}

// 全程回显探针：每 tick 打一个唯一哨兵，记录「按下 → 上屏」时延。
// 只在总结卡出现后才量会漏掉挂载/补差那段冻结窗（.scard 轮询本身就有 200ms
// 滞后，且卡可能先隐藏后露出），所以从提交前就一直跑。
function startEchoProbe(page, out, interval = 250) {
  let stop = false, n = 0;
  const loop = (async () => {
    while (!stop) {
      const token = "q" + (n++ % 100) + "k";
      const t0 = Date.now();
      // final 之前不打字：哨兵会拼进输入行、干扰卡锚定，也会污染任务文本。
      // final 一到立刻开密采——用户口径的「总结卡渲染完毕后卡顿」就在这段。
      if (!global.finalAt) { await sleep(interval); continue; }
      // 模态在场时打字会被模态吃掉（审批/密码），跳过这一拍
      const modal = await page.evaluate(() => !!document.querySelector("#modal-root .modal"));
      if (modal) { await sleep(interval); continue; }
      await page.evaluate(c => window.__probe.arm(c), token);
      await page.keyboard.type(token, { delay: 1 });
      let seen = null;
      for (let w = 0; w < 60; w++) {
        const r = await page.evaluate(() => window.__probe.take());
        if (r && r.seen != null) { seen = r.seen - r.at; break; }
        await sleep(25);
      }
      out.push({ t: t0, token: token, lat: seen == null ? null : Math.round(seen) });
      await page.evaluate(() => window.__probe.disarm());
      await sleep(interval);
    }
  })();
  return {
    stop: async () => { stop = true; await loop.catch(() => {}); },
  };
}

function analyze(dump) {
  const writes = dump.writes, wsIn = dump.wsIn, raf = dump.raf;
  let maxRafGap = 0, maxRafAt = 0;
  for (let i = 1; i < raf.length; i++) {
    const g = raf[i] - raf[i - 1];
    if (g > maxRafGap) { maxRafGap = g; maxRafAt = raf[i]; }
  }
  const bin = wsIn.filter(x => x.k === "blob" || x.k === "bin" || x.k === "text");
  const lag = [];
  let wi = 0;
  for (const f of bin) {
    while (wi < writes.length && writes[wi].t < f.t) wi++;
    if (wi < writes.length) lag.push({ frame: f.t, write: writes[wi].t, k: f.k, gap: writes[wi].t - f.t });
  }
  lag.sort((a, b) => b.gap - a.gap);
  return {
    maxRafGap: maxRafGap, maxRafAt: maxRafAt,
    top: lag.slice(0, 6),
    writeCount: writes.length, frameCount: wsIn.length,
  };
}

// xterm 行文本：直接读 .xterm-rows 整体（lib.snapshot 的行选择器在本机 xterm
// 版本下取不到子行，整屏读回来是空的 —— 踩过）
function termText(page) {
  return page.evaluate(() => {
    const t = document.querySelector(".xterm-rows");
    return t ? (t.textContent || "") : "";
  });
}

async function dumpFail(page) {
  try {
    console.error("---- terminal tail ----");
    console.error((await termText(page)).slice(-500));
    console.error("---- probe ----");
    console.error(JSON.stringify(await page.evaluate(() => {
      const d = window.__probe && window.__probe.dump ? window.__probe.dump() : null;
      return d ? { err: d.err, wsIn: d.wsIn.slice(-12), wsOut: d.wsOut.slice(-8) } : "no probe";
    }), null, 1));
    const lg = global.__logs || [];
    fs.writeFileSync(path.join(lib.OUT, "freeze-logs.json"), JSON.stringify(lg, null, 1));
    console.error("---- otdbg 全程（" + lg.length + " 条，已存 freeze-logs.json）----");
    for (const l of lg) {
      const m = l.text.match(/\[otdbg\] ([0-9.]+)/);
      if (m) console.error("   t=" + m[1], l.text.replace(/^\[otdbg\] [0-9.]+ /, ""));
      else if (l.lv !== "log") console.error("   [" + l.lv + "]", l.text.slice(0, 160));
    }
    await page.screenshot({ path: path.join(lib.OUT, "freeze-fail.png") });
    console.error("shot: freeze-fail.png");
  } catch (e) { console.error("dump failed", e); }
}

async function main() {
  prepareHome();
  const started = await startServer();
  say("服务端:", started.base);
  const browser = await lib.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  global.__page = page;
  await page.addInitScript(initProbe);
  const logs = [];
  global.__logs = logs;
  page.on("console", m => {
    const t = m.text();
    // 只留仪表与异常：[ot onData] 逐键刷屏，会把 otdbg 时间线冲掉
    if (t.indexOf("[otdbg]") === -1 && m.type() === "log") return;
    logs.push({ t: Date.now(), lv: m.type(), text: t.slice(0, 300) });
  });
  page.on("pageerror", e => logs.push({ t: Date.now(), lv: "pageerror", text: e.message }));
  startButler(page);
  hookWs(page);
  await page.goto(started.base + "/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#targets .target", { timeout: 20000 });
  await lib.pickTarget(page, TARGET);
  const ready = await waitReady(page, 45000);
  say(ready ? "连接就绪" : "连接未就绪（继续尝试）");
  await sleep(800);
  if (!ready) await dumpFail(page);

  say(">> 提交自然语言「" + QUESTION + "」");
  await typeLine(page, QUESTION);
  // 提交后立刻开全程回显探针（提交前开会把哨兵拼进同一输入行，任务文本被污染）
  const echoSeries = [];
  const probe = startEchoProbe(page, echoSeries, 180);
  setTimeout(() => approveAll(page, 60000).catch(() => {}), 2500);   // 后台放行审批
  let scardAt = 0;
  const t1 = Date.now();
  let lastCard = "";
  while (Date.now() - t1 < 150000) {
    const st = await page.evaluate(() => ({
      s: document.querySelectorAll(".scard").length,
      a: document.querySelectorAll(".acard").length,
      t: document.querySelectorAll(".tcard").length,
      slotTxt: (document.querySelector(".scard") || {}).innerText || "",
    }));
    const sig = st.s + "/" + st.a + "/" + st.t;
    if (sig !== lastCard) {
      lastCard = sig;
      say("    [卡] +" + Math.round(Date.now() - t1) + "ms scard=" + st.s +
          " acard=" + st.a + " tcard=" + st.t +
          (st.slotTxt ? " | " + st.slotTxt.replace(/\s+/g, " ").slice(0, 40) : ""));
    }
    if (st.s > 0) { scardAt = Date.now(); break; }
    await sleep(200);
  }
  if (!scardAt) { await dumpFail(page); throw new Error("总结卡 150s 未出现"); }
  say("✓ 总结卡已渲染");
  await page.screenshot({ path: path.join(lib.OUT, "freeze-scard-" + PORT + ".png") });
  const probeBase = await page.evaluate(() => performance.now());
  say("   探针基准 performance.now() =", Math.round(probeBase));
  // 总结卡之后再跑 6s（用户口径的「卡顿几秒」窗口）
  await sleep(10000);
  await probe.stop();
  await page.screenshot({ path: path.join(lib.OUT, "freeze-after-" + PORT + ".png") });
  const lats = echoSeries.map(x => x.lat);

  const dump = await page.evaluate(() => window.__probe.dump());
  const an = analyze(dump);
  say("================ 分析 ================");
  say("probe err:", (dump.err || []).join(" | ") || "无");
  say("WS 帧", an.frameCount, "term.write", an.writeCount);
  say("主线程 raf 最大断流:", Math.round(an.maxRafGap), "ms @", Math.round(an.maxRafAt));
  say("帧到 -> write 最大滞后 Top:");
  for (const l of an.top)
    say("   gap=" + Math.round(l.gap) + "ms  frame@" + Math.round(l.frame) +
        "  write@" + Math.round(l.write) + "  " + l.k);
  say("---- 回显时延时序（t=Node 时刻, lat=按下→上屏 ms）----");
  for (const e of echoSeries)
    say("   " + new Date(e.t).toISOString().slice(11, 23) + "  " + e.token +
        "  " + (e.lat == null ? "TIMEOUT" : e.lat + "ms"));
  say("回显时延序列:", lats.map(x => x == null ? "TO" : x + "ms").join(", "));
  say("---- pad 往返（wsOut type:pad / wsIn padded）----");
  for (const f of dump.wsIn.concat(dump.wsOut).sort((a, b) => a.t - b.t)) {
    const s = f.s || "";
    if (s.indexOf("pad") !== -1 || String(f.k || "").indexOf("pad") !== -1)
      say("   @" + Math.round(f.t), f.k, s.slice(0, 90));
  }
  say("---- hold/pad 仪表（otdbg，全程）----");
  for (const l of logs) {
    if (l.text.indexOf("[otdbg]") === -1) continue;
    const m = l.text.match(/\[otdbg\] ([0-9.]+)/);
    say("   t=" + (m ? m[1] : "?"), l.text.replace(/^\[otdbg\] [0-9.]+ /, "").slice(0, 150));
  }
  say("---- 卡片存续 ----");
  say("  ", JSON.stringify(await page.evaluate(() => ({
    scard: document.querySelectorAll(".scard").length,
    acard: document.querySelectorAll(".acard").length,
    tcard: document.querySelectorAll(".tcard").length,
  }))));

  fs.writeFileSync(path.join(lib.OUT, "freeze-dump-" + PORT + ".json"),
    JSON.stringify({ dump: dump, logs: logs }, null, 1));
  fs.writeFileSync(path.join(lib.OUT, "freeze-logs.json"), JSON.stringify(logs, null, 1));
  say("转储:", path.join(lib.OUT, "freeze-dump-" + PORT + ".json"));
  await page.screenshot({ path: path.join(lib.OUT, "freeze-" + PORT + ".png") });

  butlerStop = true;
  await browser.close();
  if (started.server) started.server.kill();
  process.exit(0);
}

main().catch(async e => {
  console.error(e);
  if (global.__page) await dumpFail(global.__page);
  process.exit(1);
});
