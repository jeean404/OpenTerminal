// 一次性诊断：island 加载/命令卡渲染为什么在冒烟里空壳
"use strict";
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const REPO = path.resolve(__dirname, "..", "..");
const HOME = path.join(REPO, ".tmp", "phase5-home");
const PORT = 8262;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const py = path.join(REPO, ".venv-win", "Scripts", "python.exe");
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });
fs.writeFileSync(path.join(HOME, "config.toml"), [
  "[model]", 'provider = "anthropic"', 'base_url = "http://127.0.0.1:15721"',
  'model = "claude-sonnet-4-6"', 'api_key_env = "ANTHROPIC_API_KEY"',
  "", "[policy]", 'mode = "tiered"',
  'auto_extra = ["echo"]', 'approve_extra = ["uname -a && df -h"]',
  "", "[web]", 'host = "127.0.0.1"', `port = ${PORT}`, "",
].join("\n"), "utf8");

async function main() {
  const logFd = fs.openSync(path.join(REPO, ".tmp", "live", `diag-${PORT}.log`), "w");
  const server = spawn(py,
    [path.join(__dirname, "serve_scripted_model.py"), "--port", String(PORT), "--no-open"],
    { cwd: REPO, stdio: ["ignore", logFd, logFd], env: {
      ...process.env, OPENTERMINAL_HOME: HOME,
      ANTHROPIC_API_KEY: "diag-key", OT_WEB_DEBUG: "1",
      PYTHON_KEYRING_BACKEND: "keyring.backends.null.Keyring",
      PYTHONIOENCODING: "utf-8",
    }});
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) break; } catch (e) {}
    await sleep(400);
  }
  const browser = await chromium.launch({ headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const logs = [];
  page.on("pageerror", e => logs.push("PAGEERROR: " + e.message));
  page.on("console", m => logs.push("CONSOLE[" + m.type() + "]: " + m.text().slice(0, 200)));
  page.on("requestfailed", r => logs.push("REQFAIL: " + r.url() + " " + (r.failure() || {}).errorText));
  page.on("response", r => {
    if (/ui\.js|app\.js/.test(r.url()))
      logs.push("RESP: " + r.status() + " " + r.url());
  });

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#targets .target", { timeout: 20000 });
  await page.locator('#targets .target[data-name="local"]').first().click();
  // 等真就绪：提示符文本 + interactive（抢跑打字会打进未就绪的壳）
  const snap = () => page.evaluate(() => {
    let rows = document.querySelectorAll(".xterm-rows .xterm-row");
    if (!rows.length) rows = document.querySelectorAll(".xterm-rows > div");
    return Array.from(rows).map(r => r.textContent || "").join("\n");
  });
  for (let i = 0; i < 180; i++) {
    const ok = await page.evaluate(() => {
      const el = document.querySelector('[id^="model-"]');
      return !!(el && !el.hidden);
    }).catch(() => false);
    const t = await snap().catch(() => "");
    const last = (t.split("\n").filter(Boolean).pop() || "");
    if (ok && /PS |>/.test(last)) break;
    await sleep(500);
  }
  console.log("== 就绪，开始打字 ==");
  await page.locator(".term").click({ timeout: 5000, force: true }).catch(() => {});
  await page.keyboard.type("总结", { delay: 45 });
  await sleep(400);
  await page.keyboard.press("Enter");
  for (let i = 0; i < 12; i++) {
    await sleep(5000);
    const st = await page.evaluate(() => ({
      hosts: Array.from(document.querySelectorAll(".ot-card-host")).map(h => ({
        cls: h.className, maxH: h.style.maxHeight || "",
        html: (h.innerHTML || "").slice(0, 200),
      })),
      cmdcard: document.querySelectorAll(".cmdcard").length,
      acard: document.querySelectorAll(".acard").length,
      tcard: document.querySelectorAll(".tcard").length,
      scard: document.querySelectorAll(".scard").length,
      modal: !!document.querySelector("#modal-root .modal"),
      think: {
        hidden: (document.querySelector('[id^="think-"]') || {}).hidden,
        text: ((document.querySelector('[id^="think-"]') || {}).innerText || "").slice(0, 50),
      },
    }));
    console.log(`t+${(i + 1) * 5}s`, JSON.stringify(st));
    if (st.cmdcard + st.acard + st.tcard + st.scard > 0 && !st.think.hidden === false) break;
  }
  console.log("== 控制台/网络 ==");
  for (const l of logs) console.log(l.slice(0, 250));
  await browser.close().catch(() => {});
  server.kill();
}
main().catch(e => { console.error(e); process.exit(1); });
