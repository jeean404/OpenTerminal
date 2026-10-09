// 真机浏览器驱动公共件：启动/复用 ot web、开页、选目标、读 xterm 文本。
"use strict";
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const REPO = path.resolve(__dirname, "..", "..");
const OUT = path.join(REPO, ".tmp", "live");
fs.mkdirSync(OUT, { recursive: true });

function pythonExe() {
  const cands = [
    path.join(REPO, ".venv-win", "Scripts", "python.exe"),
    path.join(REPO, ".venv-win", "Scripts", "ot.exe"),
    path.join(REPO, ".venv", "bin", "ot"),
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  throw new Error("no ot/python found");
}

async function waitServer(base, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if ((await fetch(base + "/")).ok) return true; } catch (e) { /* retry */ }
    await new Promise(r => setTimeout(r, 400));
  }
  throw new Error("server not up: " + base);
}

async function startServer(port, opts = {}) {
  const base = `http://127.0.0.1:${port}`;
  try {
    if ((await fetch(base + "/")).ok) return { base, server: null, reused: true };
  } catch (e) { /* not up yet */ }
  const logFd = fs.openSync(path.join(OUT, `server-${port}.log`), "w");
  const exe = pythonExe();
  const args = exe.endsWith("ot.exe") || exe.includes(`${path.sep}ot`)
    ? ["web", "--port", String(port), "--no-open"]
    : ["-m", "openterminal.app", "web", "--port", String(port), "--no-open"];
  // opts.env:隔离 OPENTERMINAL_HOME / PATH 的测试专用服务端（不碰用户真实配置）
  const server = spawn(exe, args, {
    cwd: REPO,
    stdio: ["ignore", logFd, logFd],
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
  });
  await waitServer(base, 25000);
  return { base, server, reused: false };
}

async function launch() {
  return chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
}

async function openTab(browser, base) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on("pageerror", e => errors.push("pageerror: " + e.message));
  page.on("console", m => {
    if (m.type() === "error" && !/favicon/i.test(m.text())) errors.push("console: " + m.text());
  });
  await page.goto(base + "/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#targets .target", { timeout: 20000 });
  return { page, errors };
}

async function pickTarget(page, nameOrHost) {
  const loc = page.locator("#targets .target", { hasText: nameOrHost }).first();
  if (await loc.count()) { await loc.click(); return true; }
  await page.locator("#targets .target").first().click();
  return false;
}

// xterm 可见纯文本：逐行取再以 \n 连接（直接读 .xterm-rows.textContent
// 会把行粘成一串，行首/行尾正则全部失效——顺序断言需要真实换行）
function snapshot(page) {
  return page.evaluate(() => {
    let rows = document.querySelectorAll(".xterm-rows .xterm-row");
    if (!rows.length) {
      // xterm v5 的行节点没有 .xterm-row 类：直接取 .xterm-rows 的子 div，
      // 否则整屏文本会粘成一行（行级断言与「尾 N 行」全部失真）
      rows = document.querySelectorAll(".xterm-rows > div");
    }
    if (!rows.length) {
      const t = document.querySelector(".xterm-rows");
      return t ? (t.textContent || "") : "";
    }
    return Array.from(rows).map(r => r.textContent || "").join("\n");
  });
}

const rowsText = snapshot;

module.exports = { REPO, OUT, startServer, launch, openTab, pickTarget, rowsText, snapshot };
