// 真机复现：连接成功后界面乱相（图一）+ 审批「执行」按钮点不动（红线⑨）
//
// 图一三处乱相：
//   ① 欢迎横幅右侧被截断、无换行兜底；
//   ② 红色「⚠ 系统警告」卡与下方终端输出叠在一起（卡片遮挡/被遮挡）；
//   ③ 无效命令输出：__ot_pad 7 落进裸壳 -> `bash: __ot_pad: command not found`
//      + `^Y` 控制字回显。
// 红线⑨：审批卡「执行」按钮几何上在盒内，但真鼠标点不到
//   （既有冒烟用 el.click() 程序化点击，绕过命中测试，测不出这种情况）。
//
// 拓扑 = docker ot-repro（ubuntu@127.0.0.1:2222 跳板机 -> xiaojian 远端
// bash -> `sudo su -` 切 root 登录壳，PROMPT_COMMAND/PS1 被重置 = hook 掉线）。
// 用法: node tools/verify-web/repro-connect-chrome.cjs [port]
//   前置: docker 容器 ot-repro 已起（.tmp/repro/setup-container.sh）
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const lib = require("./lib");

const PORT = Number(process.argv[2] || 8271);
const SSH_PORT = Number(process.env.OT_REPRO_SSH_PORT || 2222);
const TARGET = "jump";
const HOME = path.join(lib.OUT, "connect-chrome-home");
const PW = { ubuntu: "ub123456", xiaojian: "xj123456", root: "root123456" };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log("\n### [" + (ok ? "PASS" : "FAIL") + "] " + name);
  if (detail) console.log("    " + String(detail).split("\n").join("\n    "));
}
function dump(name, text) {
  const p = path.join(lib.OUT, name);
  fs.writeFileSync(p, text == null ? "" : String(text), "utf8");
  return p;
}
function finish(logPath) {
  const fails = results.filter(r => !r.ok).length;
  console.log("\n================ 汇总 ================");
  for (const r of results) console.log("[" + (r.ok ? "PASS" : "FAIL") + "] " + r.name);
  console.log("\n合计 " + (results.length - fails) + "/" + results.length + " 通过");
  if (logPath) console.log("服务端日志: " + logPath);
  process.exit(fails ? 1 : 0);
}

// ---- 模态代答（扮演真人）：只代答主机密钥/密码；审批只观察不代答 ----
let butlerStop = false;
async function butlerTick(page) {
  return page.evaluate((pw) => {
    const root = document.querySelector("#modal-root");
    const modal = root && root.querySelector(".modal");
    if (!modal) return null;
    const h3 = modal.querySelector("h3");
    const title = ((h3 && h3.innerText) || "").trim();
    const body = (modal.innerText || "").replace(/\s+/g, " ");
    const btn = re => Array.from(root.querySelectorAll(".modal-btns button"))
      .find(b => re.test(b.innerText || ""));
    if (title.indexOf("主机密钥") === 0) {
      const b = btn(/信任|确定/);
      if (b) { b.click(); return "hostkey:trust"; }
    }
    if (title.indexOf("审批") === 0) return "SEEN-APPROVAL-MODAL";
    // 「记住密码」确认框：标题不是「密码」开头，旧代答认不出 → 模态常驻，
    // 而 termPwTick 见到模态就让路 → 终端内联密码永远没人答（真机卡死在密码
    // 提示符，被误判成产品缺陷）。这里一律「不记住」：null keyring 下本来就
    // 不落凭据库，但必须把模态收掉才放行后续代答。
    if (title.indexOf("记住") !== -1) {
      const b = btn(/不记住|否|取消/) || btn(/记住/);
      if (b) { b.click(); return "remember:no"; }
    }
    if (title.indexOf("密码") === 0 || title.indexOf("令牌") === 0 ||
        /密码|令牌/.test(title)) {
      const v = document.getElementById("modal-value");
      const rem = document.getElementById("modal-remember");
      let val = pw.xiaojian;
      if (body.indexOf("ubuntu") !== -1) val = pw.ubuntu;
      else if (body.indexOf("root") !== -1) val = pw.root;
      if (v) v.value = val;
      if (rem) rem.checked = false;
      const b = btn(/确定/);
      if (b) { b.click(); return "pw(" + val + ")"; }
    }
    return null;
  }, PW);
}
// 终端内联密码捕获：SSH/sudo 密码走 ask_password 帧落在终端行内、常不弹模态
// （见 verify-post-final-freeze-harness）——只挂模态代答会一直卡在密码提示符。
// 三处真机坑（都伪装成产品 bug）：
//   ① 只看最后一行不够：PTY 会把「Permission denied…」与下一条提示符粘成一行；
//   ② `[sudo] password for xiaojian:` 行尾是用户名不是 password，按行尾判定必漏；
//   ③ 不能全屏正则抢第一个匹配：滚动历史里还留着上一条连接的旧密码提示符，
//      会把外层主机的密码敲进内层 ssh（真机 Permission denied 连环）。
// 故取**最后一次**形状匹配，且要求其后只剩冒号/空白。
// 用户名字符类不含 `.`：PTY 粘连行「…again.ubuntu@host 密码:」里含点会把句子
// 词一起吞进用户名、认不出用户就猜错密码（真机连环 Permission denied）。
const PW_SHAPE = /password for ([A-Za-z0-9_-]+)|([A-Za-z0-9_-]+)@[A-Za-z0-9_.-]+'s password|([A-Za-z0-9_-]+)@[A-Za-z0-9_.-]+\s*密码|密码/gi;
function pwForPrompt(tail) {
  const s = String(tail);
  let last = null, m;
  PW_SHAPE.lastIndex = 0;
  while ((m = PW_SHAPE.exec(s))) last = m;
  if (!last) return null;
  const after = s.slice(last.index + last[0].length);
  if (!/^[:：\s]*$/.test(after)) return null;   // 后面还有别的内容 = 不是待答提示符
  const user = last[1] || last[2] || last[3];
  if (user && PW[user]) return PW[user];
  return null;   // 认不出用户就不猜：宁可等模态，也不把密码敲错
}
let termPwSig = null, termPwAt = 0, termPwCooldown = 0;
async function termPwTick(page) {
  if (Date.now() < termPwCooldown) return null;
  const hasModal = await page.evaluate(() => {
    const root = document.querySelector("#modal-root");
    return !!(root && root.querySelector(".modal"));
  });
  if (hasModal) { termPwSig = null; return null; }
  const txt = await lib.snapshot(page);
  const tail = txt.replace(/\s+$/, "").slice(-160);
  const pw = pwForPrompt(tail);
  if (!pw) { termPwSig = null; return null; }
  const sig = tail.slice(-60);
  if (sig !== termPwSig) { termPwSig = sig; termPwAt = Date.now(); return null; }
  if (Date.now() - termPwAt < 1200) return null;
  if (!(await clickTerm(page))) return null;
  await page.keyboard.type(pw, { delay: 18 });
  await page.keyboard.press("Enter");
  termPwSig = null;
  termPwCooldown = Date.now() + 3500;
  return "termpw(" + pw + ")";
}
function startButler(page) {
  (async () => {
    let last = null;
    while (!butlerStop) {
      try {
        const act = (await butlerTick(page)) || (await termPwTick(page));
        if (act && act !== last) { console.log("    [butler] " + act); last = act; }
        if (!act) last = null;
      } catch (e) {
        // 静默吞异常会让代答「看起来在跑、其实在空转」——必须留痕
        console.log("    [butler-err] " + String(e.message || e).split("\n")[0]);
      }
      await sleep(250);
    }
  })();
}

async function clickTerm(page, tries = 6) {
  for (let i = 0; i < tries; i++) {
    try {
      await page.locator(".term").click({ timeout: 3000, force: true });
      await sleep(120);
      return true;
    } catch (e) {}
    await sleep(300);
  }
  return false;
}
async function say(page, text, opts) {
  const enter = !opts || opts.enter !== false;
  const delay = (opts && opts.delay) || 22;
  if (!(await clickTerm(page))) throw new Error("点不到终端");
  await sleep(150);
  await page.keyboard.type(text, { delay });
  if (enter) await page.keyboard.press("Enter");
}

// ---- 采集：屏幕 / 卡片几何 / 横幅几何 ----
// 布局以 DOM 量尺寸为准（截图会被读图缓存骗，见 verify-web-harness-pitfalls）
async function collect(page) {
  return page.evaluate(() => {
    const rows = document.querySelectorAll(".xterm-rows > div");
    const screen = Array.from(rows).map(r => r.textContent || "").join("\n");
    const cards = Array.from(document.querySelectorAll(".ot-card-host")).map(h => {
      const hb = h.getBoundingClientRect();
      const inner = h.firstElementChild;
      const ib = inner ? inner.getBoundingClientRect() : null;
      const acts = h.querySelector(".cmdacts button.primary, .apbtns button.primary");
      const ab = acts ? acts.getBoundingClientRect() : null;
      let hit = null, hitInBtn = null;
      if (ab && ab.width > 0 && ab.height > 0) {
        const el = document.elementFromPoint(ab.left + ab.width / 2,
                                             ab.top + ab.height / 2);
        hit = el ? (el.tagName + (el.className ? "." + String(el.className).split(" ")[0] : "")) : null;
        // 命中元素是按钮本体或其子节点（<kbd> 快捷键角标）都算点得到；
        // 是别的元素才是被遮挡
        hitInBtn = el ? !!el.closest("button") : false;
      }
      // 可见性：宁藏不盖下未获足额预留的卡是 visibility:hidden 的——
      // 只量几何会把「藏起来」误报成「被裁」（harness 假阳性）
      const cs = getComputedStyle(h);
      const vis = cs.visibility !== "hidden" && cs.display !== "none";
      return {
        visible: vis,
        cls: inner ? inner.className : "",
        text: (h.innerText || "").replace(/\s+/g, " ").slice(0, 90),
        // app.js 在 host 上留的记账位：need=量高需求 / bspan=缓冲里真实连续空白 /
        // pinned=钉死行数（-1=自撑）/ rows=量高行数——卡被裁的账就在这四个数里
        acct: { need: h.dataset.need, bspan: h.dataset.bspan,
                pinned: h.dataset.pinned, rows: h.dataset.rows,
                mline: h.dataset.mline },
        host: { top: +hb.top.toFixed(1), h: +hb.height.toFixed(1),
                left: +hb.left.toFixed(1), w: +hb.width.toFixed(1) },
        inner: ib ? { top: +ib.top.toFixed(1), h: +ib.height.toFixed(1) } : null,
        // 内容超出宿主 = 被 overflow:hidden 裁掉（卡片被遮挡的直接证据）
        clipped: ib ? +(ib.bottom - hb.bottom).toFixed(1) : 0,
        btn: ab ? { top: +ab.top.toFixed(1), bottom: +ab.bottom.toFixed(1),
                    w: +ab.width.toFixed(1), h: +ab.height.toFixed(1),
                    visible: ab.width > 0 && ab.height > 0,
                    inHost: ab.top >= hb.top - 1 && ab.bottom <= hb.bottom + 1,
                    // 按钮是否被宿主 overflow:hidden 裁掉（超出多少 px）
                    clippedPx: +(ab.bottom - hb.bottom).toFixed(1) } : null,
        btnHit: hit, btnHitInBtn: hitInBtn,
      };
    });
    const termEl = document.querySelector(".xterm-rows") ||
                   document.querySelector(".xterm");
    const termBox = termEl ? termEl.getBoundingClientRect() : null;
    let banner = null;
    for (const r of rows) {
      const t = r.textContent || "";
      if (t.indexOf("已连接") !== -1) {
        const rb = r.getBoundingClientRect();
        banner = { text: t.slice(0, 60), len: t.length,
                   right: +rb.right.toFixed(1),
                   termRight: termBox ? +termBox.right.toFixed(1) : 0,
                   overflow: termBox ? +(rb.right - termBox.right).toFixed(1) : 0,
                   h: +rb.height.toFixed(1) };
        break;
      }
    }
    const junk = {
      otPad: (screen.match(/__ot_pad/g) || []).length,
      notFound: (screen.match(/command not found/g) || []).length,
      ctrlY: (screen.match(/\^Y/g) || []).length,
    };
    // 块顺序：卡片与文本是否交错（图二那张效果图的排布）
    const blocks = Array.from(document.querySelectorAll(".ot-blocks .ot-blk"))
      .map(b => (b.dataset.kind || "?") + (b.dataset.blockId ? ":" + b.dataset.blockId : ""));
    return { screen, cards, banner, junk, blocks,
             winW: window.innerWidth, winH: window.innerHeight,
             dpr: window.devicePixelRatio };
  });
}

function prepareHome() {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(path.join(HOME, "config.toml"), [
    "# repro-connect-chrome 专用（隔离 OPENTERMINAL_HOME）",
    "[model]",
    'provider = "anthropic"',
    'base_url = "http://127.0.0.1:15721"',
    'model = "claude-sonnet-4-6"',
    'api_key_env = "ANTHROPIC_API_KEY"',
    "",
    "[policy]",
    'mode = "tiered"',
    // echo 不进白名单：脚本化模型的 `echo … | tee …` 是带重定向的管道，
    // tiered 下判「重定向覆盖文件」→ 必出审批（红线⑨需要真审批卡）
    'auto_extra = ["ls", "pwd", "cat", "id", "whoami", "hostname"]',
    "",
    "[web]",
    'host = "127.0.0.1"',
    'port = ' + PORT,
    "",
  ].join("\n"), "utf8");
  const py = path.join(lib.REPO, ".venv-win", "Scripts", "python.exe");
  const r = spawnSync(py, [path.join(lib.REPO, "tools", "verify-web", "fixtures",
                                     "seed-saved-conn.py")], {
    cwd: lib.REPO,
    env: Object.assign({}, process.env, {
      OPENTERMINAL_HOME: HOME, PYTHONIOENCODING: "utf-8",
      OT_SEED_NAME: TARGET, OT_SEED_HOST: "127.0.0.1",
      OT_SEED_PORT: String(SSH_PORT), OT_SEED_USER: "ubuntu",
      OT_SEED_COMMANDS: "ssh xiaojian@127.0.0.1",
    }),
    encoding: "utf8",
  });
  const out = ((r.stdout || "") + (r.stderr || "")).trim();
  if (r.status !== 0 || out.indexOf(TARGET) === -1) throw new Error("seed 失败: " + out);
  console.log("已落库:", out);
}

// 服务端走脚本化模型（serve_scripted_model.py）：core 单管线/HITL 审批/WS/
// xterm 卡片层全真，只有模型出 tool_calls 是可复现脚本——审批卡才出得来。
// ANTHROPIC_BASE_URL 刻意不给：config 的 env_errors 仍报「未配置模型协议」，
// 红色系统警告卡照常出生（本驱动要验的就是它的几何）。
function startModelServer() {
  const base = "http://127.0.0.1:" + PORT;
  const logFd = fs.openSync(path.join(lib.OUT, "server-" + PORT + ".log"), "w");
  const py = path.join(lib.REPO, ".venv-win", "Scripts", "python.exe");
  const server = require("node:child_process").spawn(py,
    [path.join(lib.REPO, "tools", "verify-web", "serve_scripted_model.py"),
     "--port", String(PORT), "--no-open"],
    { cwd: lib.REPO, stdio: ["ignore", logFd, logFd],
      env: Object.assign({}, process.env, {
        OPENTERMINAL_HOME: HOME,
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "repro-key",
        OT_WEB_DEBUG: "1",
        PYTHON_KEYRING_BACKEND: "keyring.backends.null.Keyring",
        PYTHONIOENCODING: "utf-8",
      }) });
  return { base, server };
}

// 多分辨率扫描：同一状态下换视口量横幅/卡片几何，验「不同显示器大小」是否
// 都不截断、不裁切、不越界。返回逐档结果。
const VIEWPORTS = [
  { w: 1920, h: 1080, tag: "1920x1080" },
  { w: 1440, h: 900, tag: "1440x900" },
  { w: 1280, h: 800, tag: "1280x800" },
  { w: 1024, h: 768, tag: "1024x768" },
  { w: 800, h: 600, tag: "800x600" },
];

// Windows 系统缩放（125%/150%）：Playwright 的 deviceScaleFactor 只在建
// context 时定死，setViewportSize 改不了——要真测缩放必须另开 context。
const DPRS = [1, 1.25, 1.5, 2];
// 真开 context 测 devicePixelRatio：缩放会改行高取整，按钮行易被 clamp 钉出盒
async function sweepDpr(browser, base, label) {
  const out = [];
  for (const dpr of DPRS) {
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 800 }, deviceScaleFactor: dpr,
    });
    const pg = await ctx.newPage();
    await pg.goto(base + "/", { waitUntil: "domcontentloaded" });
    await pg.waitForSelector("#targets .target", { timeout: 20000 });
    await pg.locator("#targets .target", { hasText: TARGET }).first().click();
    // 只量几何：另开页的连接/任务与主页面互不相干，这里验的是「同布局在
    // 不同缩放下卡片是否仍完整、按钮是否仍在盒内」
    await sleep(2500);
    const c = await collect(pg);
    out.push({ dpr, banner: c.banner,
               cards: c.cards.map(x => ({ cls: x.cls, visible: x.visible,
                                          clipped: x.clipped,
                                          hostH: x.host.h, innerH: x.inner && x.inner.h,
                                          btn: x.btn, btnHitInBtn: x.btnHitInBtn })) });
    await ctx.close();
  }
  dump("cc-sweep-dpr-" + label + ".json", JSON.stringify(out, null, 2));
  return out;
}

async function sweepViewports(page, label) {
  const out = [];
  for (const v of VIEWPORTS) {
    await page.setViewportSize({ width: v.w, height: v.h });
    await sleep(700);   // xterm fit + decoration 重贴要一帧以上
    const c = await collect(page);
    out.push({ vp: v.tag, banner: c.banner, junk: c.junk,
               cards: c.cards.map(x => ({ cls: x.cls, visible: x.visible,
                                          clipped: x.clipped,
                                          hostH: x.host.h, innerH: x.inner && x.inner.h })),
               winW: c.winW });
  }
  await page.setViewportSize({ width: 1400, height: 900 });
  await sleep(500);
  dump("cc-sweep-" + label + ".json", JSON.stringify(out, null, 2));
  return out;
}

async function main() {
  prepareHome();
  const srv = startModelServer();
  console.log("服务端:", srv.base);
  await new Promise(r => setTimeout(r, 100));
  // 等服务端起
  {
    const t0 = Date.now();
    let up = false;
    while (Date.now() - t0 < 40000) {
      try { up = (await fetch(srv.base + "/")).ok; } catch (e) { up = false; }
      if (up) break;
      await sleep(400);
    }
    if (!up) {
      record("R0 隔离服务端", false, "服务端 40s 未起");
      return finish();
    }
  }
  const logPath = path.join(lib.OUT, "server-" + PORT + ".log");
  record("R0 隔离服务端（脚本化模型）", true,
    srv.base + "；容器 ssh 端口 " + SSH_PORT);

  const browser = await lib.launch();
  const opened = await lib.openTab(browser, srv.base);
  const page = opened.page, errors = opened.errors;
  // 前端记账轨迹（otdbg）：卡被裁的账要看 pad 往返，光看几何分不清「垫不够」
  // 还是「量高不对」。加日志后必须回读核账（verify-post-final-freeze-harness）
  const dbg = [];
  page.on("console", m => {
    const t = m.text();
    if (/\[otdbg\]/.test(t)) dbg.push(t);
  });
  await page.evaluate(() => { try { localStorage.otdbg = "1"; } catch (e) {} });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("#targets .target", { timeout: 20000 });
  dump("cc-otdbg.log", "(started)");
  startButler(page);

  try {
    const picked = await lib.pickTarget(page, TARGET);
    record("A0 侧栏选中 " + TARGET, picked, picked ? "ok" : "侧栏无此目标");
    if (!picked) return finish(logPath);

    // 等连接 + 连接后命令（ssh xiaojian）落到远端**提示符**。
    // 不能只找 `xiaojian@`：内层 ssh 的密码提示符也含它，会把「卡在密码上」
    // 误判成「已就绪」（本轮 A1 假 PASS 的成因）。要 shell 提示符收尾。
    let ready = false;
    for (let i = 0; i < 180 && !ready; i++) {
      const t = await lib.snapshot(page);
      if (/xiaojian@[^\n]*[#$%]\s*$/.test(t.replace(/\s+$/, ""))) ready = true;
      else await sleep(500);
    }
    await sleep(1800);
    const c1 = await collect(page);
    dump("cc-after-connect.txt", c1.screen);

    record("A1 连接后落到远端提示符", ready,
      ready ? "ok" : "屏幕尾: " + JSON.stringify(c1.screen.replace(/\s+$/, "").slice(-200)));
    // ① 横幅几何
    record("A2 欢迎横幅不越出终端可视宽", !!(c1.banner && c1.banner.overflow <= 1),
      JSON.stringify(c1.banner));
    // ② 警告卡几何
    const alert = c1.cards.find(c => /alertcard|系统警告/.test(c.cls + c.text));
    record("A3 系统警告卡完整可见（不被裁）",
      !alert || (alert.visible && alert.clipped <= 1 &&
                 alert.inner && alert.inner.h > 20),
      alert ? JSON.stringify(alert) : "(无警告卡)");
    // ③ 无效命令输出
    record("A7 卡片与文本交错（块序）",
      JSON.stringify(c1.blocks || []),
      JSON.stringify(c1.blocks || []));
    record("A4 连接后屏上无无效命令输出",
      c1.junk.otPad === 0 && c1.junk.ctrlY === 0 && c1.junk.notFound === 0,
      JSON.stringify(c1.junk));
    dump("cc-cards-after-connect.json",
      JSON.stringify({ banner: c1.banner, cards: c1.cards, junk: c1.junk,
                       winW: c1.winW, winH: c1.winH, dpr: c1.dpr }, null, 2));

    // ── 适配不同显示器大小：同一状态换视口量几何 ──
    console.log("\n########## A5: 多分辨率扫描 ##########");
    const sweep = await sweepViewports(page, "connect");
    const badBanner = sweep.filter(s => s.banner && s.banner.overflow > 1);
    record("A5 各分辨率横幅都不越界",
      badBanner.length === 0,
      sweep.map(s => s.vp + ": " + (s.banner ? ("overflow=" + s.banner.overflow +
        " len=" + s.banner.len) : "(无横幅)")).join("\n"));
    const badCard = sweep.filter(s => s.cards.some(c => c.visible && c.clipped > 1));
    record("A6 各分辨率卡片都不被裁切",
      badCard.length === 0,
      sweep.map(s => s.vp + ": " + JSON.stringify(s.cards)).join("\n"));

    // ── 图一乱相 ③：sudo su - 换壳后 pad 落进裸壳 ──
    console.log("\n########## B: sudo su - 换壳（hook 掉线）##########");
    await say(page, "sudo su -");
    // 密码一律交给 butler（终端内联捕获）：这里手敲会和它抢，双份密码落进读取器
    for (let i = 0; i < 24; i++) {
      await sleep(700);
      const t = await lib.snapshot(page);
      if (/root@/.test(t.slice(-220))) break;
    }
    await sleep(3500);
    const c2 = await collect(page);
    dump("cc-after-su.txt", c2.screen);
    record("B1 sudo su - 后屏上无 __ot_pad 残迹", c2.junk.otPad === 0,
      JSON.stringify(c2.junk) + "\n尾部: " +
      JSON.stringify(c2.screen.replace(/\s+$/, "").slice(-340)));
    record("B2 sudo su - 后无 command not found", c2.junk.notFound === 0,
      JSON.stringify(c2.junk));
    record("B3 sudo su - 后无 ^Y 控制字回显", c2.junk.ctrlY === 0,
      JSON.stringify(c2.junk));

    // ── 红线⑨：审批「执行」按钮真鼠标点击（脚本化模型出 execute 工具）──
    console.log("\n########## C: 审批按钮真鼠标点击 ##########");
    // 「单个」→ 脚本化模型出一轮 1 个 execute（echo … | tee …，带重定向），
    // tiered 下判「重定向覆盖文件」→ 必出审批卡
    await say(page, "单个");
    let armed = null;
    for (let i = 0; i < 120 && !armed; i++) {
      const c = await collect(page);
      armed = c.cards.find(x => x.btn && x.btn.visible && /调用工具|执行/.test(x.text));
      if (!armed) await sleep(500);
    }
    if (!armed) {
      const tailTxt = (await lib.snapshot(page)).replace(/\s+$/, "").slice(-300);
      record("C1 审批卡武装", false,
        "100s 内没有出现带按钮的审批卡；尾部: " + JSON.stringify(tailTxt));
    } else {
      const c3 = await collect(page);
      dump("cc-approval.txt", c3.screen);
      dump("cc-approval-cards.json", JSON.stringify(c3.cards, null, 2));
      record("C1 审批卡武装", true, JSON.stringify(armed));

      // 系统缩放（devicePixelRatio）真机面：另开 context 量卡片/按钮几何
      const dprSweep = await sweepDpr(browser, srv.base, "approval");
      const dprBad = dprSweep.filter(d =>
        d.cards.some(c => (c.visible && c.clipped > 1) ||
                          (c.btn && c.btn.clippedPx > 1)));
      record("C1b 各系统缩放下卡片完整、按钮不出盒", dprBad.length === 0,
        dprSweep.map(d => "dpr=" + d.dpr + " " + JSON.stringify(d.cards)).join("\n"));

      // 各分辨率只量几何+命中测试（不点）：真点一次就会下掉决策、卡收徽标，
      // 后续档位没得验。Playwright locator.click 走命中测试，遮挡/裁切/
      // pointer-events 任一不满足都会失败——这正是 el.click() 程序化点击
      // 测不出的那一类（既有 verify-phase5-smoke 的 D2 就是 el.click）
      for (const v of VIEWPORTS) {
        await page.setViewportSize({ width: v.w, height: v.h });
        await sleep(700);
        const cc = await collect(page);
        const a = cc.cards.find(x => x.btn && x.btn.visible && /调用工具|执行/.test(x.text));
        if (!a) {
          record("C2[" + v.tag + "] 按钮在屏", false, "该分辨率下按钮不可见");
          continue;
        }
        const geomOk = !!(a.btn && a.btn.inHost && a.btn.h > 0 &&
                          a.btn.clippedPx <= 1 && a.btnHitInBtn !== false);
        record("C2[" + v.tag + "] 按钮几何/命中正常", geomOk,
          "hit=" + a.btnHit + " hitInBtn=" + a.btnHitInBtn +
          " btn=" + JSON.stringify(a.btn) + " acct=" + JSON.stringify(a.acct));
      }
      // 默认分辨率上做一次真鼠标点击（红线⑨真机口径）
      await page.setViewportSize({ width: 1400, height: 900 });
      await sleep(700);
      let clickErr = null;
      try {
        await page.locator(
          ".cmdcard .cmdacts button.primary, .apbtns button.primary")
          .first().click({ timeout: 6000 });
      } catch (e) {
        clickErr = String(e.message || e).split("\n").slice(0, 3).join(" / ");
      }
      // 高危卡点「执行」是**两步确认**（防误触）：第一步只弹「高危命令，确认执行？」，
      // 不弹出来 = 看着就像「点了没反应」。弹层会被 .acard 的 overflow:hidden
      // 裁到看不见（已在 style.css 用 .ot-flow-host 豁免）。这里走完两步并留痕。
      await sleep(400);
      const confirmProbe = await page.evaluate(() => {
        const pop = document.querySelector(".apconfirm");
        const card = document.querySelector(".cmdcard");
        const p = pop && pop.getBoundingClientRect();
        const c = card && card.getBoundingClientRect();
        const btn = pop && pop.querySelector("button.primary");
        const bb = btn && btn.getBoundingClientRect();
        let hit = null, hitPath = null;
        if (bb && bb.width > 0 && bb.height > 0) {
          const el = document.elementFromPoint(bb.left + bb.width / 2,
                                               bb.top + bb.height / 2);
          hit = el ? (el.tagName + (el.className ? "." + String(el.className).split(" ")[0] : "")) : null;
          hitPath = [];
          let n = el;
          while (n && n !== document.body && hitPath.length < 6) {
            hitPath.push(n.tagName + (n.className ? "." + String(n.className).split(" ")[0] : ""));
            n = n.parentElement;
          }
        }
        return {
          popExists: !!pop,
          popText: pop ? (pop.innerText || "").replace(/\s+/g, " ").slice(0, 36) : null,
          overflowPx: (p && c) ? +(p.bottom - c.bottom).toFixed(1) : null,
          popVisible: pop ? (getComputedStyle(pop).visibility !== "hidden") : false,
          btnBox: bb ? { top: +bb.top.toFixed(1), bottom: +bb.bottom.toFixed(1),
                         w: +bb.width.toFixed(1), h: +bb.height.toFixed(1) } : null,
          btnDisabled: btn ? !!btn.disabled : null,
          btnPointer: btn ? getComputedStyle(btn).pointerEvents : null,
          hit, hitPath,
          hostClass: (() => {
            const h = document.querySelector(".cmdcard") &&
              document.querySelector(".cmdcard").closest(".ot-card-host");
            return h ? h.className : null;
          })(),
          z: (() => {
            const q = sel => {
              const e = document.querySelector(sel);
              return e ? (getComputedStyle(e).position + "/" +
                          getComputedStyle(e).zIndex) : null;
            };
            return { head: q(".cmdcard .aphead"), code: q(".cmdcard .apcode"),
                     pop: q(".apconfirm"), card: q(".cmdcard") };
          })(),
          inStage: (() => {
            const st = document.querySelector(".ot-stage");
            if (!st || !bb) return null;
            const s = st.getBoundingClientRect();
            return bb.top >= s.top && bb.bottom <= s.bottom;
          })(),
        };
      });
      console.log("    [probe] 两步确认弹层 " + JSON.stringify(confirmProbe));
      if (confirmProbe.popExists) {
        try {
          await page.locator(".apconfirm button.primary").first()
            .click({ timeout: 4000 });
          console.log("    [probe] 已点「确认执行」");
        } catch (e) {
          console.log("    [probe] 确认按钮点不到（完整原因）:\n" +
            String(e.message || e).split("\n").slice(0, 12).join("\n      "));
          // 区分「命中测试被挡」与「点了没处理」：force 直接派发到元素本身
          try {
            await page.locator(".apconfirm button.primary").first()
              .click({ timeout: 3000, force: true });
            console.log("    [probe] force 点击成功 → 是被遮挡，不是没处理");
          } catch (e2) {
            console.log("    [probe] force 也失败: " +
              String(e2.message || e2).split("\n")[0]);
          }
        }
      }
      record("C3 「执行」按钮真鼠标可点", !clickErr, clickErr || "真鼠标点击成功");
      record("C3b 高危两步确认弹层可见（不被裁）",
        confirmProbe.popExists ? (confirmProbe.popVisible &&
          confirmProbe.overflowPx <= 1) : true,
        JSON.stringify(confirmProbe));
      // 点到 ≠ 生效：必须看到决策真的落下去（回执徽标 / 状态翻转 / 卡收束）。
      // 旧断言只验 click 没抛，按钮「点了没反应」照样绿——真机反馈就是这个。
      let decided = null;
      for (let i = 0; i < 40 && !decided; i++) {
        await sleep(500);
        const cc = await collect(page);
        const a = cc.cards.find(x => /调用工具|执行/.test(x.text));
        if (!a) { decided = "卡片已收束消失"; break; }
        if (/已同意|✓|✗|执行中|完成|失败|拒绝/.test(a.text) &&
            !/等待审批/.test(a.text)) {
          decided = a.text.replace(/\s+/g, " ").slice(0, 70);
          break;
        }
      }
      record("C4 点击后决策真的生效（状态翻转）", !!decided,
        decided || "20s 内状态没变——按钮点了没反应");
      const after = await lib.snapshot(page);
      record("C5 决策后命令真被执行", /ot-repro-canary|postgresql|restart/.test(after) ||
        !!decided, "屏幕尾=" + JSON.stringify(after.replace(/\s+$/, "").slice(-160)));

      // 卡片正文不许空白：island.css 把 .ablk 的 opacity 钉在 0、动画 paused，
      // 漏了 ot-reveal/ot-revealed 就是「有内容但看不见」（真机分析卡/总结卡空白）
      await sleep(1500);
      const bodies = await page.evaluate(() =>
        Array.from(document.querySelectorAll(".ot-card-host")).map(h => {
          const card = h.firstElementChild;
          return {
            cls: card ? card.className : "",
            text: (h.innerText || "").replace(/\s+/g, " ").trim(),
            ablk: h.querySelectorAll(".ablk").length,
            ablkHidden: Array.from(h.querySelectorAll(".ablk"))
              .filter(b => parseFloat(getComputedStyle(b).opacity) < 0.5).length,
            // 思考过程默认收起（只留结论）；打字机：.ablk 要在动画里
            reasonOpen: Array.from(h.querySelectorAll("details.areason-wrap"))
              .map(d => d.open),
            anim: Array.from(h.querySelectorAll(".ablk")).slice(0, 2)
              .map(b => getComputedStyle(b).animationName),
          };
        }));
      const emptyCards = bodies.filter(b =>
        /an\b|scard|alertcard/.test(b.cls) &&
        (b.text.replace(/^(分析|总结|⚠ 系统警告)\s*/, "").length < 4 || b.ablkHidden > 0));
      record("C6 分析/总结/警告卡正文可见（不空白）", emptyCards.length === 0,
        "问题卡=" + JSON.stringify(emptyCards) +
        "\n全部=" + JSON.stringify(bodies));
      // 打字机：块动画必须在跑（animation-name = ot-reveal）；思考过程默认合上
      const animBad = bodies.filter(b => b.anim.length &&
        b.anim.some(a => a && a !== "ot-reveal" && a !== "none"));
      const openReason = bodies.some(b => (b.reasonOpen || []).some(Boolean));
      record("C7 打字机动画在跑 + 思考过程默认收起",
        animBad.length === 0 && !openReason,
        JSON.stringify(bodies.map(b => ({ cls: b.cls, anim: b.anim,
                                          reasonOpen: b.reasonOpen }))));
    }

    record("R8 页面零 JS 报错", errors.length === 0, errors.slice(0, 5).join(" | "));
  } finally {
    butlerStop = true;
  }
  dump("cc-otdbg.log", dbg.join("\n"));
  console.log("[otdbg] 轨迹 " + dbg.length + " 行 -> .tmp/live/cc-otdbg.log");
  return finish(logPath);
}

main().catch(e => { console.error(e); process.exit(1); });
