// 诊断：4 张工具卡只显示一条命令的执行结果（2026-10-18 真机截图）。
//
// 拓扑：docker ot-repro（ubuntu@127.0.0.1:2222，bash）+ 脚本化模型
// （serve_scripted_model.py 场景「四条」：一轮并行 4 个 execute——
// free -h / df -h / uptime / nproc，与截图同名同序）。
// 其余全真实：core 单管线、HITL 审批、WS、块流布局、PTY。
//
// 抓的是**落点**：块流里每个块的 kind/文本，与活动 xterm 的文本——
// 三条命令的输出到底是没到、被冻进文本块、还是整段堆在活动终端里。
//
// 用法: node tools/verify-web/diag-parallel-outputs.cjs [port] [--keep]
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const { spawn, spawnSync } = require("node:child_process");
const lib = require("./lib");

const PORT = Number(process.argv[2] || 8261);
const KEEP = process.argv.includes("--keep");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const HOME = path.join(lib.OUT, "par4-home");
const TARGET = "repro";
const SSH_PORT = 2222;
const PW = { ubuntu: "ub123456" };
// 截图同款四条；全部进 auto_extra 以免审批插进来搅乱时序（审批是另一个变量）
const CMDS = ["free -h", "df -h", "uptime", "nproc"];

function pythonExe() {
  for (const c of [
    path.join(lib.REPO, ".venv-win", "Scripts", "python.exe"),
    path.join(lib.REPO, ".venv", "Scripts", "python.exe"),
  ]) if (fs.existsSync(c)) return c;
  throw new Error("no python found");
}

function prepareHome() {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(path.join(HOME, "config.toml"), [
    "# diag-parallel-outputs 专用（隔离 OPENTERMINAL_HOME）",
    "[model]",
    'provider = "anthropic"',
    'base_url = "http://127.0.0.1:15721"',
    'model = "claude-sonnet-4-6"',
    'api_key_env = "ANTHROPIC_API_KEY"',
    "",
    "[policy]",
    'mode = "tiered"',
    "auto_extra = [" + CMDS.map(c => JSON.stringify(c)).join(", ") + "]",
    "",
    "[web]",
    'host = "127.0.0.1"',
    `port = ${PORT}`,
    "",
  ].join("\n"), "utf8");
  const r = spawnSync(pythonExe(), [path.join(lib.REPO, "tools", "verify-web",
    "fixtures", "seed-saved-conn.py")], {
    cwd: lib.REPO,
    env: {
      ...process.env, OPENTERMINAL_HOME: HOME, PYTHONIOENCODING: "utf-8",
      OT_SEED_NAME: TARGET, OT_SEED_HOST: "127.0.0.1",
      OT_SEED_PORT: String(SSH_PORT), OT_SEED_USER: "ubuntu",
      OT_SEED_COMMANDS: "",
    },
    encoding: "utf8",
  });
  const out = ((r.stdout || "") + (r.stderr || "")).trim();
  if (r.status !== 0 || out.indexOf(TARGET) === -1) {
    throw new Error("seed connections.db 失败: " + out);
  }
}

async function startServer() {
  const base = `http://127.0.0.1:${PORT}`;
  try { if ((await fetch(base + "/")).ok) throw new Error("端口 " + PORT + " 被占用"); }
  catch (e) { if (/被占用/.test(String(e))) throw e; }
  const logFd = fs.openSync(path.join(lib.OUT, `server-${PORT}.log`), "w");
  const server = spawn(pythonExe(),
    [path.join(__dirname, "serve_scripted_model.py"), "--port", String(PORT), "--no-open"],
    {
      cwd: lib.REPO, stdio: ["ignore", logFd, logFd],
      env: {
        ...process.env, OPENTERMINAL_HOME: HOME,
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "par4-key",
        OT_WEB_DEBUG: "1",
        PYTHON_KEYRING_BACKEND: "keyring.backends.null.Keyring",
        PYTHONIOENCODING: "utf-8",
      },
    });
  const t0 = Date.now();
  while (Date.now() - t0 < 40000) {
    try { if ((await fetch(base + "/")).ok) return { base, server }; } catch (e) {}
    if (server.exitCode != null) throw new Error("服务端提前退出 code=" + server.exitCode);
    await sleep(400);
  }
  throw new Error("服务端 40s 未就绪");
}

// ---- WS 事件录帧：真正的时间序真相 ----
const wsEvents = [];
function hookWs(page) {
  page.on("websocket", ws => {
    ws.on("framereceived", f => {
      let m = null;
      try { m = JSON.parse(String(f.payload)); } catch (e) { return; }
      if (!m) return;
      const t = Date.now();
      if (m.type === "event" && m.event && m.event.kind) {
        const e = m.event;
        if (e.kind === "ai_token" || e.kind === "ai_think") return;
        wsEvents.push({
          t,
          kind: e.kind,
          phase: e.phase || "",
          id: e.id == null ? "" : e.id,
          name: e.name || "",
          cmd: String(e.command || e.args || e.text || "").slice(0, 40),
        });
      } else {
        wsEvents.push({ t, kind: "ws:" + m.type, cmd: String(m.text || "").slice(0, 40) });
      }
    });
  });
}

// ---- 落点探针：块流每块 + 活动 xterm ----
const dumpLayout = page => page.evaluate(() => {
  const blocks = Array.from(document.querySelectorAll(".ot-blk")).map(el => {
    const body = el.querySelector(".ot-blk-body");
    return {
      kind: el.dataset.kind || "",
      id: el.dataset.blockId || "",
      h: Math.round(el.getBoundingClientRect().height),
      text: ((body ? body.innerText : el.innerText) || "").replace(/\s+/g, " ").trim(),
      full: ((body ? body.innerText : el.innerText) || "").trim(),
    };
  });
  const host = document.querySelector('.ot-blocks');
  return {
    blocks,
    blocksHtmlLen: host ? host.innerHTML.length : -1,
    blocksChildCount: host ? host.children.length : -1,
  };
});

function fmtDump(d) {
  const lines = [];
  lines.push(`块容器 children=${d.blocksChildCount} htmlLen=${d.blocksHtmlLen}`);
  if (!d.blocks.length) lines.push("  (块流为空)");
  d.blocks.forEach((b, i) => {
    lines.push(`  [${i}] ${b.kind}#${b.id} h=${b.h} :: ${b.text.slice(0, 110) || "(空)"}`);
    if (b.kind !== "card") {
      // 文本块打全文：四条命令的输出到底落进去几条，是本案的判据
      for (const ln of (b.full || "").split("\n")) {
        if (ln.trim()) lines.push(`        | ${ln}`);
      }
    }
  });
  return lines.join("\n");
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(lib.OUT, `par4-${name}.png`), fullPage: false });
  console.log("  [截图] par4-" + name + ".png");
}

async function clickTerm(page, tries = 6) {
  for (let i = 0; i < tries; i++) {
    try { await page.locator(".term").click({ timeout: 3000, force: true }); await sleep(120); return true; }
    catch (e) {}
    await sleep(300);
  }
  return false;
}

async function waitNoModal(page, timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (!(await page.evaluate(() => !!document.querySelector("#modal-root .modal")))) return true;
    await sleep(250);
  }
  return false;
}

async function waitReady(page, timeout = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const ok = await page.evaluate(() => {
      const g = id => { const el = document.querySelector(`[id^="${id}-"]`); return el ? (el.hidden ? "hidden" : "shown") : "missing"; };
      return g("conn") !== "shown" && g("connov") !== "shown"
        && !!((document.querySelector('[id^="status-"]') || {}).innerText || "").trim();
    });
    if (ok) return true;
    await sleep(400);
  }
  return false;
}

// ---- 会话代答（WS ask_password + 模态），绝不按终端文本猜提示 ----
let pwPending = false, pwSeenAt = 0;
function hookPw(page) {
  page.on("websocket", ws => {
    ws.on("framereceived", f => {
      try {
        const m = JSON.parse(String(f.payload));
        if (m && m.type === "ask_password") { pwPending = true; pwSeenAt = Date.now(); }
        if (m && (m.type === "ready" || m.type === "closed")) pwPending = false;
      } catch (e) {}
    });
  });
}

async function pwTick(page) {
  return page.evaluate((rules) => {
    const root = document.querySelector("#modal-root");
    const modal = root && root.querySelector(".modal");
    if (!modal) return null;
    const title = ((modal.querySelector("h3") || {}).innerText || "").trim();
    const body = (modal.innerText || "").replace(/\s+/g, " ");
    const btn = re => Array.from(root.querySelectorAll(".modal-btns button")).find(b => re.test(b.innerText || ""));
    if (/记住/.test(title) && /密码/.test(title)) { const b = btn(/不记住|不记|拒绝|取消/); if (b) { b.click(); return "remember:no"; } return null; }
    if (/主机密钥|host key/i.test(title)) { const b = btn(/信任|确定/); if (b) { b.click(); return "hostkey:trust"; } return null; }
    if (/密码|令牌|password|token/i.test(title)) {
      const v = document.getElementById("modal-value");
      let pw = rules.ubuntu;
      for (const u of Object.keys(rules)) if (body.indexOf(u) !== -1) { pw = rules[u]; break; }
      if (v) v.value = pw;
      const rem = document.getElementById("modal-remember");
      if (rem) rem.checked = false;
      const b = btn(/确定/);
      if (b) { b.click(); return "pw"; }
    }
    return null;
  }, PW);
}

async function pwTermTick(page) {
  if (!pwPending || Date.now() - pwSeenAt < 600) return null;
  if (!(await clickTerm(page))) return null;
  await page.keyboard.type(PW.ubuntu, { delay: 15 });
  await page.keyboard.press("Enter");
  pwPending = false;
  return "termpw";
}

async function main() {
  prepareHome();
  const { base, server } = await startServer();
  const browser = await lib.launch();
  const { page, errors } = await lib.openTab(browser, base);
  hookWs(page);
  hookPw(page);

  let butlerStop = false;
  (async () => {
    let cool = 0;
    while (!butlerStop) {
      try {
        if (Date.now() > cool) {
          const act = (await pwTick(page)) || (await pwTermTick(page));
          if (act) { console.log("  [butler] " + act); cool = Date.now() + 800; }
        }
      } catch (e) {}
      await sleep(300);
    }
  })();

  console.log("== 连接 " + TARGET + " ==");
  await lib.pickTarget(page, TARGET);
  await waitNoModal(page);
  await waitReady(page);
  await sleep(1200);
  await shot(page, "connected");

  await page.evaluate(() => { globalThis.__otPlaced = []; });
  await page.evaluate(() => { globalThis.__otProbe = []; });
  console.log("== 发起自然语言：四条 ==");
  if (!(await clickTerm(page))) throw new Error("点不到终端");
  await page.keyboard.type("四条", { delay: 45 });
  await sleep(400);
  await page.keyboard.press("Enter");

  // 等到四张命令卡都落定 + 总结卡出现（任务收尾）
  const t0 = Date.now();
  let lastDump = null;
  while (Date.now() - t0 < 60000) {
    lastDump = await dumpLayout(page);
    const cards = lastDump.blocks.filter(b => b.kind === "card").length;
    const summary = await page.evaluate(() =>
      Array.from(document.querySelectorAll(".scard")).map(x => (x.innerText || "").slice(0, 60)));
    if (cards >= 4 && summary.length) break;
    await sleep(400);
  }
  await sleep(1500);   // 让最后的输出落定

  const dump = await dumpLayout(page);
  const termText = await lib.snapshot(page);

  console.log("\n== 落点 dump ==");
  console.log(fmtDump(dump));
  console.log("\n== 活动 xterm 文本 ==");
  console.log(termText.split("\n").map(l => "  | " + l).join("\n") || "  (空)");

  console.log("\n== WS 事件时间序（相对首条） ==");
  const t1 = wsEvents.length ? wsEvents[0].t : 0;
  for (const e of wsEvents) {
    console.log(`  +${String(e.t - t1).padStart(5)}ms  ${e.kind}${e.phase ? ":" + e.phase : ""}` +
      `${e.id !== "" ? "#" + e.id : ""} ${e.name ? e.name + " " : ""}${e.cmd}`);
  }

  const probe = await page.evaluate(() => globalThis.__otProbe || []);
  console.log("\n== term_open 时的缓冲尾部 ==");
  for (const p of probe) console.log("  cmd=" + JSON.stringify(p.cmd) + " tail=" + JSON.stringify(p.tail) + " -> echo=" + JSON.stringify(p.echo));

  await shot(page, "final");
  if (errors.length) {
    console.log("\n== 页面报错 ==");
    for (const e of errors) console.log("  " + e);
  }

  butlerStop = true;
  if (!KEEP) {
    await browser.close();
    try { server.kill(); } catch (e) {}
    if (!KEEP) fs.rmSync(HOME, { recursive: true, force: true });
  } else {
    console.log("\n[keep] 服务端留着：" + base);
  }
}

main().catch(e => { console.error("FATAL", e); process.exit(1); });
