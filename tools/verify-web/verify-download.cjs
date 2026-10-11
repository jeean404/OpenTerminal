// 真机浏览器验证：「把远端 /tmp/smoke_print.sh 下载到我本机」write_file ×失败 修复。
// 拓扑：docker ot-repro（ubuntu@127.0.0.1:2222）+ 连接命令 cd /tmp（远端 cwd=/tmp，
// 与现场一致）；脚本化模型（serve_scripted_model.py「下载」场景：先 execute 再
// write_file）或 --real 走 15721 网关真模型。web worker / InteractiveRunner / WS /
// 卡片层全真实。
// 断言：
//   A write_file 工具卡收徽标为完成（不是 ×失败）
//   B WS ai_tool end 无 failed
//   C 文件落到本机 <home>/Downloads/smoke_print.sh（USERPROFILE 隔离，不碰真主目录）
//   D 屏上不出现 outside root
// 用法: node tools/verify-web/verify-download.cjs [port] [--real]
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const { spawn, spawnSync } = require("node:child_process");
const lib = require("./lib");

const PORT = Number(process.argv[2] || 8261);
const REAL = process.argv.includes("--real");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const HOME = path.join(lib.OUT, "dl-home");
const TARGET = "repro";
const PW = { ubuntu: "ub123456" };
const NL = "把/tmp/smoke_print.sh下载到我本机";

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`\n### [${ok ? "PASS" : "FAIL"}] ${name}`);
  if (detail) console.log("    " + String(detail).split("\n").join("\n    "));
}
function finish() {
  const fails = results.filter(r => !r.ok).length;
  console.log("\n================ 汇总 ================");
  for (const r of results) console.log(`[${r.ok ? "PASS" : "FAIL"}] ${r.name}`);
  console.log(`\n合计 ${results.length - fails}/${results.length} 通过`);
  process.exit(fails ? 1 : 0);
}

function pythonExe() {
  for (const c of [
    path.join(lib.REPO, ".venv-win", "Scripts", "python.exe"),
    path.join(lib.REPO, ".venv", "Scripts", "python.exe"),
  ]) if (fs.existsSync(c)) return c;
  throw new Error("no python found");
}

function dockerExec(cmd) {
  const r = spawnSync("docker", ["exec", "ot-repro", "bash", "-c", cmd],
    { encoding: "utf8" });
  return ((r.stdout || "") + (r.stderr || "")).trim();
}

function prepareHome() {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(path.join(HOME, "Downloads"), { recursive: true });
  fs.writeFileSync(path.join(HOME, "config.toml"), [
    "# verify-download 专用（隔离 OPENTERMINAL_HOME / USERPROFILE）",
    "[model]",
    'provider = "anthropic"',
    'base_url = "http://127.0.0.1:15721"',
    'model = "claude-sonnet-4-6"',
    'api_key_env = "ANTHROPIC_API_KEY"',
    "",
    "[policy]",
    'mode = "tiered"',
    'auto_extra = ["echo", "ls", "pwd", "cat", "id", "whoami", "hostname"]',
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
      OT_SEED_PORT: "2222", OT_SEED_USER: "ubuntu",
      OT_SEED_COMMANDS: "cd /tmp",      // 远端 cwd=/tmp：现场同款文件根污染源
    },
    encoding: "utf8",
  });
  const out = ((r.stdout || "") + (r.stderr || "")).trim();
  if (r.status !== 0 || out.indexOf(TARGET) === -1) {
    throw new Error("seed connections.db 失败: " + out);
  }
  console.log("已落库 saved connection:", out);
}

async function startServer() {
  const base = `http://127.0.0.1:${PORT}`;
  try {
    if ((await fetch(base + "/")).ok) throw new Error("端口 " + PORT + " 已有服务端");
  } catch (e) { if (String(e).includes("已有服务端")) throw e; }
  const logFd = fs.openSync(path.join(lib.OUT, `server-dl-${PORT}.log`), "w");
  const env = {
    ...process.env,
    OPENTERMINAL_HOME: HOME,
    USERPROFILE: HOME,        // Path.home() 落这里：不往真主目录写测试文件
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "dl-key",
    OT_WEB_DEBUG: "1",
    PYTHON_KEYRING_BACKEND: "keyring.backends.null.Keyring",
    PYTHONIOENCODING: "utf-8",
  };
  const exe = pythonExe();
  const args = REAL
    ? ["-m", "openterminal.app", "web", "--port", String(PORT), "--no-open"]
    : [path.join(__dirname, "serve_scripted_model.py"),
       "--port", String(PORT), "--no-open"];
  const server = spawn(exe, args, {
    cwd: lib.REPO, stdio: ["ignore", logFd, logFd], env,
  });
  const t0 = Date.now();
  while (Date.now() - t0 < 40000) {
    try { if ((await fetch(base + "/")).ok) return { base, server }; } catch (e) {}
    if (server.exitCode != null) throw new Error("服务端提前退出 code=" + server.exitCode);
    await sleep(400);
  }
  throw new Error("服务端 40s 未就绪");
}

// ---- WS 事件录帧 ----
const wsEvents = [];
let pwPending = false, pwSeenAt = 0;
function hookWs(page) {
  page.on("websocket", ws => {
    ws.on("framereceived", f => {
      try {
        const m = JSON.parse(String(f.payload));
        if (!m) return;
        if (m.type === "event" && m.event && m.event.kind) {
          wsEvents.push({ t: Date.now(), m: { type: m.event.kind, ...m.event } });
        } else if (m.type === "ask_password") {
          pwPending = true; pwSeenAt = Date.now();
        } else if (m.type === "ready" || m.type === "closed") {
          pwPending = false;
        }
      } catch (e) { /* 非 JSON 帧（PTY 二进制）*/ }
    });
  });
}

// ---- 会话代答（只认模态，不按终端行尾正则猜）----
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

let butlerStop = false;
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

// WS ask_password → 终端内联捕获期敲密码（客户端捕获吃键，发 auth JSON）
async function pwTermTick(page) {
  if (!pwPending || Date.now() - pwSeenAt < 600) return null;
  if (!(await clickTerm(page))) return null;
  await page.keyboard.type(PW.ubuntu, { delay: 15 });
  await page.keyboard.press("Enter");
  pwPending = false;
  return "termpw:" + PW.ubuntu;
}

function startButler(page) {
  (async () => {
    let cool = 0;
    while (!butlerStop) {
      try {
        if (Date.now() > cool) {
          const act = (await pwTick(page)) || (await pwTermTick(page));
          if (act) { console.log("    [butler] " + act); cool = Date.now() + 800; }
        }
      } catch (e) { /* 页面导航/关闭 */ }
      await sleep(300);
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

async function waitReady(page, timeout = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const ok = await page.evaluate(() => {
      const g = id => {
        const el = document.querySelector(`[id^="${id}-"]`);
        return el ? (el.hidden ? "hidden" : "shown") : "missing";
      };
      return g("conn") !== "shown" && g("connov") !== "shown"
        && !!((document.querySelector('[id^="status-"]') || {}).innerText || "").trim();
    });
    if (ok) return true;
    await sleep(400);
  }
  return false;
}

async function say(page, text) {
  if (!(await waitNoModal(page))) throw new Error("模态未退场，输入会丢失");
  for (let attempt = 0; attempt < 3; attempt++) {
    await clickTerm(page);
    await sleep(150);
    if (attempt) {
      // 上一次行文本不齐（CJK 打字/回显截断）：清行重打，绝不提交半截行——
      // 半截行进模型会让脚本化场景按关键词匹配不上（踩过）
      await page.keyboard.press("Control+U");
      await sleep(200);
    }
    await page.keyboard.type(text, { delay: attempt ? 70 : 45 });
    const t0 = Date.now();
    let ok = false;
    while (Date.now() - t0 < 3000) {
      const txt = await lib.snapshot(page);
      if (txt.includes(text)) { ok = true; break; }
      await sleep(150);
    }
    if (ok) {
      await sleep(350);
      await page.keyboard.press("Enter");
      return;
    }
    console.log("    [say] 行文本不齐，重打（第 " + (attempt + 1) + " 次）");
  }
  throw new Error("输入行文本始终不齐：" + text);
}

const probe = page => page.evaluate(() => {
  const tools = Array.from(document.querySelectorAll(".tcard")).map(x => ({
    text: (x.innerText || "").replace(/\s+/g, " ").slice(0, 160),
    args: ((x.querySelector(".apcode") || {}).innerText || "").replace(/\s+/g, " ").trim(),
    badge: ((x.querySelector(".apstate") || {}).innerText || "").replace(/\s+/g, " ").trim(),
  }));
  return {
    tools,
    screen: "",
    summary: Array.from(document.querySelectorAll(".scard"))
      .map(x => (x.innerText || "").replace(/\s+/g, " ").slice(0, 200)),
  };
});

async function waitFor(page, fn, timeout) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    last = await fn();
    if (last && last.ok) return { ok: true, waited: Date.now() - t0, ...last };
    await sleep(300);
  }
  return { ok: false, waited: Date.now() - t0, last };
}

async function main() {
  const seeded = dockerExec("printf '#!/bin/bash\\n# 测试脚本：打印 opentrimnal\\n\\necho \"opentrimnal\"\\n' > /tmp/smoke_print.sh && chmod +x /tmp/smoke_print.sh && ls -la /tmp/smoke_print.sh");
  console.log("远端样本:", seeded);

  prepareHome();
  const { base, server } = await startServer();
  console.log("服务端:", base);
  const browser = await lib.launch();
  const { page, errors } = await lib.openTab(browser, base);
  hookWs(page);
  startButler(page);

  try {
    await lib.pickTarget(page, TARGET);
    if (!(await waitReady(page))) {
      await page.screenshot({ path: path.join(lib.OUT, "download-notready.png") });
      console.log("    [截图] download-notready.png");
      console.log("    屏幕:", (await lib.snapshot(page)).slice(-600));
      throw new Error("连接未就绪");
    }
    console.log("已连接", TARGET);

    await say(page, NL);
    console.log("已发问:", NL);

    const done = await waitFor(page, async () => {
      const s = await lib.snapshot(page);
      return { ok: /已下载到本机|outside root|任务失败/.test(s), s };
    }, REAL ? 180000 : 90000);
    if (!done.ok) {
      console.log("    [等待超时] 屏幕尾部:", (await lib.snapshot(page)).slice(-500));
    }
    await sleep(1500);
    await page.screenshot({ path: path.join(lib.OUT, "download-fix.png") });
    console.log("    [截图] download-fix.png");

    const p = await probe(page);
    const screen = await lib.snapshot(page);
    const wf = p.tools.filter(t => /write_file/.test(t.text) || /write_file/.test(t.args));
    const ev = wsEvents.filter(e => e.m.type === "ai_tool");

    console.log("\n---- 工具卡 ----");
    for (const t of p.tools) console.log("   ", t.badge || "(无徽标)", "|", t.text.slice(0, 90));
    console.log("---- WS ai_tool ----");
    for (const e of ev) {
      const m = e.m;
      console.log(`    ${m.phase} #${m.id} ${m.name || "(配对)"} ${String(m.args || "").slice(0, 40)}${m.failed ? " FAIL" : ""}`);
    }

    record("A write_file 工具卡收「完成」徽标（非 ×失败）",
      wf.length > 0 && wf.every(t => /完成|✓|成功/.test(t.badge) && !/失败|✗/.test(t.badge)),
      "工具卡: " + JSON.stringify(wf));
    // ai_tool end 不带 name，只带 id/failed——按 id 与 start 配对，且 end 不得失败
    const starts = ev.filter(e => e.m.phase === "start");
    const ends = ev.filter(e => e.m.phase === "end");
    const endIds = new Set(ends.map(e => e.m.id));
    const paired = starts.length > 0
      && starts.every(s => endIds.has(s.m.id))
      && starts.length === ends.length;
    record("B WS ai_tool 每个 start 都有 end 且无 failed",
      paired && ends.every(e => !e.m.failed),
      ev.map(e => `${e.m.phase}#${e.m.id}:${e.m.name || ""}${e.m.failed ? ":fail" : ""}`).join(" "));
    const landed = path.join(HOME, "Downloads", "smoke_print.sh");
    const ok = fs.existsSync(landed);
    record("C 文件落到本机 " + landed, ok,
      ok ? fs.readFileSync(landed, "utf8") : "（缺失）");
    record("D 屏上无 outside root", !/outside root/.test(screen),
      /outside root/.test(screen) ? screen.slice(0, 400) : "干净");
    if (errors.length) console.log("\n页面错误:", errors.join("\n"));
  } finally {
    butlerStop = true;
    await browser.close().catch(() => {});
    server.kill();
  }
  finish();
}

main().catch(e => { console.error(e); process.exit(2); });
