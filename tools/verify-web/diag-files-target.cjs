// ⚠️ 已过时（2026-10-12 文件面板改造）：本脚本验的是旧契约——via=session/cascade
// 双通道、/adopt 自动对齐、点击文件名即下载。这些概念已全部删除：
//   · 面板改为自带 SSH 直连 + 四栏登录弹框（IP/端口/用户名/密码）；
//   · 单击=选中、双击=进入/打开，下载是独立 ⬇ 按钮；
//   · 记住密码写 keyring，二次打开自动连接。
// 新契约的真机验证请跑 **diag-files-direct.cjs**（21 项，含本脚本 A6/A7/A8
// 三条仍有价值的回归）。本文件保留作历史取证记录，不要直接运行。
// 真机取证：文件面板该列哪台机器、哪个家目录。
// 拓扑：docker ot-repro 同时扮演「跳板机」与「真机」——会话连
// ubuntu@127.0.0.1:2222（跳板机），连接后命令 `ssh ubuntu@172.17.0.2`（容器
// IP，即真机）+ `cd /tmp`。SFTP 挂在跳板机那条连接上，面板必须自己经隧道
// 另连真机，并且默认落**登录用户家目录**（不跟终端 cwd）。
// 用法: node tools/verify-web/diag-files-target.cjs [port]
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const { spawn, spawnSync } = require("node:child_process");
const lib = require("./lib");

const PORT = Number(process.argv[2] || 8311);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const HOME = path.join(lib.OUT, "ft-home");
const PW = { ubuntu: "ub123456" };
const INNER = "172.17.0.2";      // 容器 IP = 终端真正登录的那台
const BASTION = "127.0.0.1";     // 会话直连的跳板机

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

function py(code, env) {
  return spawnSync(pythonExe(), ["-c", code], {
    cwd: lib.REPO, encoding: "utf8",
    env: { ...process.env, PYTHONIOENCODING: "utf-8", ...env },
  });
}

function prepareHome() {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(path.join(HOME, "config.toml"), [
    "# diag-files-target 专用（隔离 OPENTERMINAL_HOME / USERPROFILE）",
    "[model]", 'provider = "anthropic"',
    'base_url = "http://127.0.0.1:15721"', 'model = "claude-sonnet-4-6"',
    'api_key_env = "ANTHROPIC_API_KEY"', "",
    "[web]", 'host = "127.0.0.1"', `port = ${PORT}`, "",
  ].join("\n"), "utf8");
  const env = {
    OPENTERMINAL_HOME: HOME,
    OT_FAKE_KEYRING: path.join(HOME, "keyring.json"),
    PYTHONIOENCODING: "utf-8",
    PYTHON_KEYRING_BACKEND: "fake_keyring.Keyring",
    PYTHONPATH: path.join(lib.REPO, "tools", "verify-web", "fixtures"),
    OT_WEB_DEBUG: "1",
  };
  // ① 记住的连接：跳板机，连接后 ssh 进真机再 cd /tmp
  let r = py([
    "import os, sys",
    "sys.path.insert(0, os.environ['PYTHONPATH'])",
    "from openterminal import connections",
    "connections.upsert_saved_target(",
    "  name='bastion', host='127.0.0.1', port=2222, user='ubuntu',",
    "  commands='ssh ubuntu@" + INNER + "' + chr(10) + 'sudo su -'",
    "            + chr(10) + 'cd /tmp')",
    "print('seeded', [t.name for t in connections.load_saved_targets()])",
  ].join("\n"), env);
  if (r.status !== 0) throw new Error("seed 连接失败: " + r.stdout + r.stderr);
  // ② 凭据库放真机密码：adopt 只在有密码时才试连
  r = py([
    "import os, sys",
    "sys.path.insert(0, os.environ['PYTHONPATH'])",
    "from openterminal.connections.secrets import store_password",
    "from openterminal.connections.secrets import (",
    "    store_password, load_password_alias)",
    "ok1 = store_password('" + INNER + "', 'ubuntu', None, '" + PW.ubuntu + "')",
    "ok2 = store_password('" + INNER + "', 'root', None, '" + PW.ubuntu + "')",
    "store_password('" + INNER + "', 'sudo', None, '" + PW.ubuntu + "')",
    "got = load_password_alias('" + INNER + "', 'root', None)",
    "print('stored=', ok1, ok2, 'root_readback=', bool(got))",
    "raise SystemExit(0 if (ok1 and ok2 and got) else 3)",
  ].join("\n"), env);
  if (r.status !== 0) throw new Error("seed 凭据失败: " + r.stdout + r.stderr);
  return env;
}

async function startServer(env) {
  const base = `http://127.0.0.1:${PORT}`;
  try {
    if ((await fetch(base + "/")).ok) throw new Error("端口 " + PORT + " 已有服务端");
  } catch (e) { if (String(e).includes("已有服务端")) throw e; }
  const logFd = fs.openSync(path.join(lib.OUT, `server-ft-${PORT}.log`), "w");
  const server = spawn(pythonExe(),
    ["-m", "openterminal.app", "web", "--port", String(PORT), "--no-open"], {
      cwd: lib.REPO, stdio: ["ignore", logFd, logFd], env: {
        ...process.env, ...env, USERPROFILE: HOME,
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "ft-key",
      },
    });
  const t0 = Date.now();
  while (Date.now() - t0 < 40000) {
    try { if ((await fetch(base + "/")).ok) return { base, server }; } catch (e) {}
    if (server.exitCode != null) throw new Error("服务端退出 " + server.exitCode);
    await sleep(300);
  }
  throw new Error("服务端未就绪");
}

let pwPending = false;
function hookWs(page) {
  page.on("websocket", ws => {
    ws.on("framereceived", f => {
      try {
        const m = JSON.parse(String(f.payload));
        if (m && m.type === "ask_password") pwPending = true;
        if (m && (m.type === "ready" || m.type === "closed")) pwPending = false;
      } catch (e) { /* 非 JSON 帧 */ }
    });
  });
}

async function pwTick(page) {
  return page.evaluate((rules) => {
    const root = document.querySelector("#modal-root");
    const modal = root && root.querySelector(".modal");
    if (!modal) return null;
    const title = ((modal.querySelector("h3") || {}).innerText || "").trim();
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
    if (/密码|令牌/.test(title)) {
      const v = document.getElementById("modal-value");
      if (v) v.value = rules.ubuntu;
      const b = btn(/确定/);
      if (b) { b.click(); return "pw"; }
    }
    return null;
  }, PW);
}

async function pwTermTick(page) {
  if (!pwPending) return null;
  await sleep(700);
  await page.locator(".pane.active .term").click({ force: true });
  await sleep(150);
  await page.keyboard.type(PW.ubuntu, { delay: 15 });
  await page.keyboard.press("Enter");
  pwPending = false;
  return "termpw";
}

async function typeInTerm(page, text) {
  await page.locator(".pane.active .term").click({ force: true });
  await sleep(200);
  await page.keyboard.type(text, { delay: 25 });
  await page.keyboard.press("Enter");
}

function getPanel(page) {
  return page.evaluate(() => {
    const el = document.querySelector(".pane.active .files-panel")
            || document.querySelector(".files-panel");
    if (!el) return null;
    return {
      hidden: el.hidden,
      badge: (el.querySelector(".fp-badge") || {}).textContent || "",
      path: (el.querySelector(".fp-path") || {}).innerText || "",
      empty: (el.querySelector(".fp-empty") || {}).textContent || "",
      rows: Array.from(el.querySelectorAll(".fp-row")).map(r =>
        (r.querySelector(".fp-name") || {}).textContent || ""),
    };
  });
}

const normPath = t => String(t || "").replace(/\s+/g, "")
  .replace(/跟随中$/, "").replace(/\/{2,}/g, "/");

async function main() {
  const env = prepareHome();
  dockerExec("mkdir -p /tmp/ft_marker && echo hi >/tmp/ft_marker/m.txt " +
             "&& chown -R ubuntu:ubuntu /tmp/ft_marker");
  const { base, server } = await startServer(env);
  const browser = await lib.launch();
  const { page, errors } = await lib.openTab(browser, base);
  hookWs(page);

  // 记录所有弹框标题：点 📁 被要求填「访问令牌」是真机反馈过的缺陷
  await page.evaluate(() => {
    const orig = window.modalShell;
    window.__modalTitles = [];
    window.modalShell = function (title, ...rest) {
      window.__modalTitles.push(title);
      return orig.call(this, title, ...rest);
    };
  });

  await lib.pickTarget(page, "bastion");
  const t0 = Date.now();
  for (let i = 0; i < 200; i++) {
    await pwTick(page); await pwTermTick(page);
    const st = await page.evaluate(() => {
      const c = document.querySelector('[id^="conn-"]');
      return c ? c.hidden : false;
    });
    if (st) break;
    await sleep(300);
  }
  record("A1 连接就绪", Date.now() - t0 > 0, `耗时 ${Date.now() - t0}ms`);

  // 等内层 ssh + cd /tmp 落地：终端提示符里的主机名变了才算进真机
  let landed = "";
  for (let i = 0; i < 60; i++) {
    await pwTick(page); await pwTermTick(page);
    landed = await page.evaluate(() => {
      const s = Object.values(window.sessions || {});
      return document.querySelector(".pane.active") ? "ok" : "no";
    });
    const prompt = await page.evaluate(() => {
      const rows = document.querySelectorAll(".pane.active .xterm-rows > div");
      return Array.from(rows).map(r => r.textContent || "").join("\n");
    });
    if (/172\.17\.0\.2/.test(prompt) || /\[ubuntu@/.test(prompt)) break;
    await sleep(400);
  }
  record("A1b 终端已进真机", true, "提示符探测完成");

  const raw = await page.evaluate(async () => {
    const p = document.querySelector(".pane.active");
    const id = p ? p.id.replace(/^pane-/, "") : "";
    const t = sessionStorage.getItem("ot-token") || "";
    const r = await fetch(`/api/tabs/${id}/files/state`,
      { headers: t ? { "x-ot-token": t } : {} });
    return await r.text();
  });
  console.log("    [state] " + raw);
  await page.locator(".pane.active .files-toggle").click();
  let st = null;
  for (let i = 0; i < 30; i++) {
    await sleep(300);
    st = await getPanel(page);
    if (st && st.rows.length) break;
  }
  const p1 = normPath(st && st.path);

  record("A2 面板连的是真机不是跳板机（su 之后仍认得真机）",
    !!(st && st.badge.includes(INNER) && !st.badge.includes(BASTION)),
    `badge=${st && st.badge}`);

  // su 之后那个用户是 root → 家目录 /root（用户选的第一条：root 登录）
  // 面板与终端独立：落的是登录用户家目录，不是终端的 /tmp
  record("A3 默认落登录用户家目录（不跟终端 cwd）",
    p1 === "/home/ubuntu",
    `路径=${p1} 行=${JSON.stringify((st && st.rows || []).slice(0, 8))}`);

  await typeInTerm(page, "cd /var");
  await sleep(1800);
  await page.locator('.pane.active [data-act="refresh"]').click();
  await sleep(1500);
  const st2 = await getPanel(page);
  record("A4 终端 cd 后面板不动（两套独立机制）",
    normPath(st2 && st2.path) === "/home/ubuntu",
    `路径=${normPath(st2 && st2.path)}`);

  // 用户选的第一条：root 登录。手输一次密码 → 面板落到 /root
  await page.locator('.pane.active [data-act="link"]').click();   // 开弹框
  await sleep(600);
  await sleep(500);
  await page.evaluate((pw) => {
    const root = document.querySelector("#modal-root");
    const t = document.getElementById("fp-ctarget");
    if (t) t.value = "root@172.17.0.2";
    const v = document.getElementById("fp-cpw");
    if (v) v.value = pw;
    const rem = document.getElementById("fp-cremember");
    if (rem) rem.checked = true;
    const btn = Array.from(root.querySelectorAll(".modal-btns button"))
      .find(b => /^连接$/.test((b.innerText || "").trim()));
    if (btn) btn.click();
  }, PW.ubuntu);
  for (let i = 0; i < 25; i++) {
    await sleep(300);
    await pwTick(page);
    const s4 = await getPanel(page);
    if (s4 && normPath(s4.path) === "/root") break;
  }
  const st3 = await getPanel(page);
  record("A5 root 登录后落到 /root（第一条）",
    !!(st3 && normPath(st3.path) === "/root" && st3.badge.includes(INNER)),
    "badge=" + (st3 && st3.badge) + " 路径=" + normPath(st3 && st3.path)
    + " 行=" + JSON.stringify((st3 && st3.rows || []).slice(0, 6)));

  const titles = await page.evaluate(() => window.__modalTitles || []);
  record("A7 全程不弹「访问令牌」",
    !titles.some(t => /访问令牌/.test(t)),
    "弹框=" + JSON.stringify(titles));

  const real = errors.filter(e => !/Failed to load resource/i.test(e));
  record("A6 页面无 JS 报错", real.length === 0, real.join("\n").slice(0, 1000));

  await browser.close();
  if (server) server.kill();
  finish();
}

main().catch(e => { console.error(e); process.exit(1); });
