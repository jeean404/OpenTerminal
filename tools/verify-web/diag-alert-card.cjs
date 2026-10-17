// 诊断：红色警告卡（配置错误：协议二选一冲突/都缺）。
// 用法：node tools/verify-web/diag-alert-card.cjs
"use strict";
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const REPO = path.resolve(__dirname, "..", "..");
const OUT = path.join(REPO, ".tmp", "live");
fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

function pythonExe() {
  for (const c of [
    path.join(REPO, ".venv-win", "Scripts", "python.exe"),
    path.join(REPO, ".venv", "Scripts", "python.exe"),
  ]) if (fs.existsSync(c)) return c;
  throw new Error("no python found");
}

// 场景：home 下放冲突/都缺的 .env，CWD 用独立目录（避开仓库根 .env）
function prepareScenario(tag, envContent, port) {
  const home = path.join(REPO, ".tmp", `alert-home-${tag}`);
  const cwd = path.join(REPO, ".tmp", `alert-cwd-${tag}`);
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(home, ".env"), envContent, "utf8");
  fs.writeFileSync(path.join(home, "config.toml"), [
    "[model]", 'provider = "anthropic"',
    'base_url = "http://127.0.0.1:15721"', 'model = "claude-sonnet-4-6"',
    'api_key_env = "ANTHROPIC_API_KEY"', "",
    "[web]", 'host = "127.0.0.1"', `port = ${port}`, "",
  ].join("\n"), "utf8");
  return { home, cwd };
}

async function runScenario(tag, envContent, expectText) {
  const port = tag === "both" ? 8266 : 8267;
  const { home, cwd } = prepareScenario(tag, envContent, port);
  const base = `http://127.0.0.1:${port}`;
  const logFd = fs.openSync(path.join(OUT, `server-alert-${tag}.log`), "w");
  const server = spawn(pythonExe(),
    [path.join(REPO, "tools", "verify-web", "serve_scripted_model.py"),
     "--port", String(port), "--no-open"],
    { cwd, stdio: ["ignore", logFd, logFd],
      env: { ...process.env, OPENTERMINAL_HOME: home,
        ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "",
        OT_WEB_DEBUG: "1",
        PYTHON_KEYRING_BACKEND: "keyring.backends.null.Keyring",
        PYTHONIOENCODING: "utf-8" } });
  const t0 = Date.now();
  while (Date.now() - t0 < 25000) {
    try { if ((await fetch(base + "/")).ok) break; } catch (e) {}
    await sleep(400);
  }
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  let alertText = null;
  page.on("console", m => {
    const t = m.text();
    if (t.includes("root 迁移") || t.includes("display 翻转")) return;
    if (m.type() === "error" && !/favicon/i.test(t) && !/WebSocket/i.test(t))
      console.log("  [js-err]", t.slice(0, 120));
  });
  try {
    await page.goto(base + "/", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#targets .target", { timeout: 20000 });
    await page.locator('#targets .target[data-name="local"]').first().click();
    // 等红卡出现
    const t1 = Date.now();
    while (Date.now() - t1 < 30000) {
      alertText = await page.evaluate(() => {
        const a = document.querySelector(".alertcard");
        return a ? (a.innerText || "").replace(/\s+/g, " ").trim() : null;
      });
      if (alertText) break;
      await sleep(500);
    }
    const ok = !!alertText && (!expectText || alertText.includes(expectText));
    console.log(`[${tag}] 红卡:`, ok ? "PASS" : "FAIL", JSON.stringify(alertText));
    await page.screenshot({ path: path.join(OUT, `diag-alert-${tag}.png`) });
    return ok;
  } catch (e) {
    console.log(`[${tag}] 异常:`, String(e).slice(0, 200));
    return false;
  } finally {
    await browser.close().catch(() => {});
    server.kill();
  }
}

async function main() {
  // 场景 A：两套协议都配 → 冲突报错
  const a = await runScenario("both",
    "ANTHROPIC_BASE_URL=https://gw/ant\nANTHROPIC_API_KEY=k1\nOPENAI_BASE_URL=https://gw/v1\nOPENAI_API_KEY=k2\n",
    "只能配一个");
  // 场景 B：都没配 → 未配置报错
  const b = await runScenario("none", "# 空 .env\n", "未配置模型协议");
  console.log("\n汇总: both=", a, " none=", b);
  process.exit(a && b ? 0 : 1);
}
main();
