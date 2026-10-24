// 真机校验：卡片面/字色跟主题走，浅色主题下不再是「黑字压深色卡」。
// 用法：node tools/verify-web/verify-card-theme.cjs
"use strict";
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const REPO = path.resolve(__dirname, "..", "..");
const OUT = path.join(REPO, ".tmp", "live");
const HOME = path.join(REPO, ".tmp", "card-theme-home");
const PORT = 8269;
fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

function pythonExe() {
  for (const c of [
    path.join(REPO, ".venv-win", "Scripts", "python.exe"),
    path.join(REPO, ".venv", "Scripts", "python.exe"),
  ]) if (fs.existsSync(c)) return c;
  throw new Error("no python found");
}

function prepareHome() {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(path.join(HOME, "config.toml"), [
    "[model]", 'provider = "anthropic"', 'base_url = "http://127.0.0.1:15721"',
    'model = "claude-sonnet-4-6"', 'api_key_env = "ANTHROPIC_API_KEY"', "",
    "[policy]", 'mode = "tiered"',
    'auto_extra = ["echo", "ls", "pwd", "cat", "uname", "df"]', "",
    "[web]", 'host = "127.0.0.1"', `port = ${PORT}`, "",
  ].join("\n"), "utf8");
}

async function startServer() {
  const base = `http://127.0.0.1:${PORT}`;
  try {
    if ((await fetch(base + "/")).ok) throw new Error("端口 " + PORT + " 残留服务端，换端口");
  } catch (e) {
    if (String(e.message).includes("残留")) throw e;
  }
  const logFd = fs.openSync(path.join(OUT, `server-${PORT}.log`), "w");
  const server = spawn(pythonExe(),
    [path.join(__dirname, "serve_scripted_model.py"),
     "--port", String(PORT), "--no-open"],
    { cwd: REPO, stdio: ["ignore", logFd, logFd],
      env: { ...process.env, OPENTERMINAL_HOME: HOME,
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "card-key",
        OT_WEB_DEBUG: "1",
        PYTHON_KEYRING_BACKEND: "keyring.backends.null.Keyring",
        PYTHONIOENCODING: "utf-8" } });
  const t0 = Date.now();
  while (Date.now() - t0 < 25000) {
    try { if ((await fetch(base + "/")).ok) break; } catch (e) {}
    await sleep(400);
  }
  return { base, server };
}

// 对比度（WCAG）：卡片正文/表格/表头各自的「字色 vs 底色」
const PROBE = () => {
  const parse = raw => {
    raw = String(raw || "").trim();
    let m = /rgba?\(([^)]+)\)/.exec(raw);
    if (m) {
      const p = m[1].split(",").map(x => parseFloat(x));
      return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
    }
    m = /color\(srgb\s+([0-9.eE+-]+)\s+([0-9.eE+-]+)\s+([0-9.eE+-]+)\)/.exec(raw);
    if (m) return [m[1] * 255, m[2] * 255, m[3] * 255, 1];
    return null;
  };
  const over = (fg, bg) => {   // fg 盖在 bg 上（fg 可带 alpha）
    const a = fg[3];
    return [fg[0] * a + bg[0] * (1 - a),
            fg[1] * a + bg[1] * (1 - a),
            fg[2] * a + bg[2] * (1 - a), 1];
  };
  const lum = c => {
    const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const ratio = (a, b) => {
    const l1 = lum(a), l2 = lum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };
  const sample = (cardSel, textSel, root) => {
    const scope = root || document;
    const card = root || scope.querySelector(cardSel);
    const txt = scope.querySelector(textSel);
    if (!card || !txt) return null;
    const bg = parse(getComputedStyle(card).backgroundColor);
    const fg = parse(getComputedStyle(txt).color);
    return {
      bg: getComputedStyle(card).backgroundColor,
      fg: getComputedStyle(txt).color,
      ratio: (bg && fg) ? Number(ratio(fg, bg).toFixed(2)) : null,
    };
  };
  // 多轮会话里可能有多张 .scard：挑带表格的那张（querySelector 取的是第一张，
  // 上一轮的总结卡不一定有表）
  const cards = Array.from(document.querySelectorAll(".scard"));
  const scard = cards.filter(c => c.querySelector("td")).pop() || cards[cards.length - 1] || null;
  const th = scard ? scard.querySelector("th") : null;
  let thRatio = null;
  if (th && scard) {
    const cs = getComputedStyle(th);
    const cardBg = parse(getComputedStyle(scard).backgroundColor);
    const mixTop = parse(cs.getPropertyValue("--card-th-top"))
      || parse("rgba(47, 111, 235, 0.6)");
    const fg = parse(cs.color);
    if (cardBg && mixTop && fg) {
      thRatio = Number(ratio(over(mixTop, cardBg), fg).toFixed(2));
    }
  }
  return {
    analysis: sample(".ablock", ".atext"),
    summary: sample(null, ".mline, .mh, p", scard),
    cell: sample(null, "td", scard),
    th: thRatio,
  };
};

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? "  OK   " : "  FAIL ") + name + (detail ? "  -- " + detail : ""));
}

async function main() {
  prepareHome();
  const started = await startServer();
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on("pageerror", e => errors.push("pageerror: " + e.message));
  try {
    await page.goto(started.base + "/", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#targets .target", { timeout: 20000 });
    await page.locator('#targets .target[data-name="local"]').first().click();
    const t0 = Date.now();
    while (Date.now() - t0 < 90000) {
      const ok = await page.evaluate(() => {
        const el = document.querySelector('[id^="model-"]');
        return !!(el && !el.hidden);
      }).catch(() => false);
      if (ok) break;
      await sleep(500);
    }
    await sleep(1500);

    // 两轮：「总结」产带表格的总结卡，「分析」产分析卡（think+intro）。
    // 一轮只出一种卡——只跑一轮时另一种卡根本不在 DOM 里，探针必然空。
    for (const q of ["总结", "分析"]) {
      let grew = false;
      for (let attempt = 0; attempt < 2 && !grew; attempt++) {
        const before = await page.evaluate(() =>
          document.querySelectorAll(".ablock, .scard").length);
        await page.locator(".term").click({ force: true });
        await sleep(250);
        await page.keyboard.type(q, { delay: 45 });
        await sleep(250);
        await page.keyboard.press("Enter");
        const t1 = Date.now();
        while (Date.now() - t1 < 25000) {
          const n = await page.evaluate(() =>
            document.querySelectorAll(".ablock, .scard").length);
          if (n > before) { grew = true; break; }
          await sleep(400);
        }
      }
      await sleep(3500);
      console.log("  [" + q + "] grew=" + grew + " cards=" + await page.evaluate(
        () => document.querySelectorAll(".ablock, .scard").length));
    }

    console.log("卡片清点:", JSON.stringify(await page.evaluate(() =>
      Array.from(document.querySelectorAll(".ablock, .scard")).map(c => ({
        cls: c.className, td: c.querySelectorAll("td").length,
        th: c.querySelectorAll("th").length,
        txt: (c.textContent || "").trim().slice(0, 40),
      })))));

    for (const theme of ["dark", "light"]) {
      await page.evaluate(t => {
        if (t === "light") document.documentElement.dataset.theme = "light";
        else delete document.documentElement.dataset.theme;
      }, theme);
      await sleep(500);
      const r = await page.evaluate(PROBE);
      console.log(theme + ":", JSON.stringify(r));
      const label = theme === "dark" ? "深色" : "浅色";
      check(label + " 分析卡正文字对比 ≥ 4.5",
        !!(r.analysis && r.analysis.ratio >= 4.5),
        "ratio=" + (r.analysis && r.analysis.ratio) + " fg=" + (r.analysis && r.analysis.fg) +
        " bg=" + (r.analysis && r.analysis.bg));
      check(label + " 总结卡正文字对比 ≥ 4.5",
        !!(r.summary && r.summary.ratio >= 4.5),
        "ratio=" + (r.summary && r.summary.ratio) + " fg=" + (r.summary && r.summary.fg) +
        " bg=" + (r.summary && r.summary.bg));
      check(label + " 表格单元格对比 ≥ 4.5",
        !!(r.cell && r.cell.ratio >= 4.5),
        "ratio=" + (r.cell && r.cell.ratio));
      check(label + " 表头文字对比 ≥ 3",
        !!(r.th && r.th >= 3), "ratio=" + r.th);
      // 把带表格的总结卡滚进视野：活动终端恒占一屏，不滚就只能拍到终端
      await page.evaluate(() => {
        const st = document.querySelector(".ot-stage");
        const cards = Array.from(document.querySelectorAll(".scard"));
        const card = cards.filter(c => c.querySelector("td")).pop() || cards[cards.length - 1];
        if (st && card) {
          const b = card.getBoundingClientRect();
          const s = st.getBoundingClientRect();
          st.scrollTop += (b.top - s.top) - 16;
        }
      });
      await sleep(350);
      await page.screenshot({ path: path.join(OUT, "card-theme-" + theme + ".png") });
    }

    console.log("");
    console.log("JS 报错:", errors.length, errors.slice(0, 3));
    const bad = results.filter(r => !r.ok);
    console.log(bad.length ? ("失败 " + bad.length + " 条：") : "全部通过");
    for (const r of bad) console.log("  FAIL", r.name, r.detail || "");
  } catch (e) {
    console.log("异常:", String(e).slice(0, 600));
  } finally {
    await browser.close().catch(() => {});
    started.server.kill();
    process.exit(0);
  }
}
main();
