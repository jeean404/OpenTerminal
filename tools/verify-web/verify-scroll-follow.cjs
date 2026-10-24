// 真机回归：跟流不得抢用户滚动条（2026-10-24 图一→图二 跳变）。
//
// 现场：块流布局下 .ot-stage 是唯一滚动面（上半冻结块流、下半活动终端一屏高）。
// 旧实现每次重排都把 scrollTop 硬贴到块流底边，于是
//   · 活动终端被整块挤出视口（图二：只剩总结卡底、命令行整块消失）
//   · 用户翻到下方空白（图一）后，状态栏 2px 高度翻动 / 卡片长高 一触发就把
//     视口拽回去——用户看到的是「选中文字时界面突然跳到卡片底部」
//
// 断言：任务收尾后活尾巴在屏上；用户翻到别处后任何重排零位移；选中文字零位移；
//       回车重新武装后跟流仍有效。
// 用法：node tools/verify-web/verify-scroll-follow.cjs
"use strict";
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const REPO = path.resolve(__dirname, "..", "..");
const OUT = path.join(REPO, ".tmp", "live");
const HOME = path.join(REPO, ".tmp", "scroll-follow-home");
const PORT = 8267;
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
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "follow-key",
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

const GEOM = () => {
  const stage = document.querySelector(".ot-stage");
  const blocks = stage.querySelector(".ot-blocks");
  const cursor = document.querySelector(".xterm-cursor");
  const s = stage.getBoundingClientRect();
  const c = cursor ? cursor.getBoundingClientRect() : null;
  return {
    scrollTop: stage.scrollTop,
    maxScroll: stage.scrollHeight - stage.clientHeight,
    blocksH: Math.round(blocks.getBoundingClientRect().height),
    cursorVisible: !!(c && c.height > 0 && c.bottom > s.top && c.top < s.bottom),
  };
};

// 模拟用户翻滚到位。**必须先派发 wheel**（那是「用户在翻」的手势标记），
// 且落位要真的改动 scrollTop——位置不变就没有 scroll 事件，跟流意愿不会更新，
// 等于这次翻滚没发生（那测出来的就是假绿）。
//   mode: "fig1"=块流底边落在视口上部 arg px（上方露出卡尾）/ "bottom" / "up"
const WHEEL_TO = (o) => {
  const stage = document.querySelector(".ot-stage");
  const mode = o.mode, arg = o.arg;
  stage.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true }));
  const before = stage.scrollTop;
  if (mode === "fig1") {
    const b = stage.querySelector(".ot-blocks").getBoundingClientRect();
    const s = stage.getBoundingClientRect();
    stage.scrollTop += (b.bottom - s.top) - arg;
  } else if (mode === "bottom") {
    stage.scrollTop = stage.scrollHeight;
  } else if (mode === "up") {
    stage.scrollTop = Math.max(0, before - arg);
  }
  if (stage.scrollTop === before) stage.scrollTop = before + 1;   // 强制产生 scroll
  return stage.scrollTop;
};

// 重排触发器：真实 2px 窗口抖动（走 stage RO → fit + follow）+ 直接调 follow
const TRIGGER = async page => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.evaluate(() => {
    const s = sessions[activeTabId];
    if (s && s._followBlockStream) { s._followBlockStream(); s._followBlockStream(); }
  });
  await page.setViewportSize({ width: 1400, height: 898 });
  await page.evaluate(() => {
    const s = sessions[activeTabId];
    if (s && s._followBlockStream) s._followBlockStream();
  });
  await page.setViewportSize({ width: 1400, height: 900 });
  await sleep(400);
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
    await sleep(1200);

    // 一轮任务 → 总结卡（高卡 + 表格）+ 冻结文本块
    await page.locator(".term").click({ force: true });
    await page.keyboard.type("总结", { delay: 45 });
    await sleep(350);
    await page.keyboard.press("Enter");
    const t1 = Date.now();
    while (Date.now() - t1 < 60000) {
      if (await page.evaluate(() => document.querySelectorAll(".scard").length) > 0) break;
      await sleep(400);
    }
    await sleep(3500);

    // 状态栏高度采样：它一翻动舞台就变高变矮，是这次跳变的扳机之一
    await page.evaluate(() => {
      window.__otBarH = [];
      const bar = document.querySelector(".statusbar");
      let last = bar ? bar.getBoundingClientRect().height : 0;
      setInterval(() => {
        if (!bar) return;
        const h = bar.getBoundingClientRect().height;
        if (Math.abs(h - last) > 0.5) {
          window.__otBarH.push({ h: Math.round(h), was: Math.round(last) });
          last = h;
        }
      }, 100);
    });

    const g0 = await page.evaluate(GEOM);
    console.log("基线几何:", JSON.stringify(g0));
    check("0 任务收尾后活尾巴仍在屏上", g0.cursorVisible,
      "cursorVisible=" + g0.cursorVisible + " scrollTop=" + g0.scrollTop.toFixed(0));

    // 1 图一现场：上方卡尾 + 下方活动终端（用户翻到这儿）
    {
      const y1 = await page.evaluate(WHEEL_TO, { mode: "fig1", arg: 200 });
      await sleep(250);
      const g1 = await page.evaluate(GEOM);
      await TRIGGER(page);
      const g = await page.evaluate(GEOM);
      check("1 翻到卡尾+终端处，重排零位移", Math.abs(g.scrollTop - y1) < 2,
        "cursorVisible=" + g1.cursorVisible +
        " scrollTop " + y1.toFixed(1) + " -> " + g.scrollTop.toFixed(1));
    }

    // 2 翻到内容底（下方大片空白）
    {
      const y = await page.evaluate(WHEEL_TO, { mode: "bottom" });
      await sleep(250);
      await TRIGGER(page);
      const g = await page.evaluate(GEOM);
      check("2 空白区里重排零位移", Math.abs(g.scrollTop - y) < 2,
        "scrollTop " + y.toFixed(1) + " -> " + g.scrollTop.toFixed(1));
    }

    // 3 上翻历史
    {
      const y = await page.evaluate(WHEEL_TO, { mode: "up", arg: 1800 });
      await sleep(250);
      await TRIGGER(page);
      const g = await page.evaluate(GEOM);
      check("3 上翻历史后重排零位移", Math.abs(g.scrollTop - y) < 2,
        "scrollTop " + y.toFixed(1) + " -> " + g.scrollTop.toFixed(1));
    }

    // 4 选中文字（用户原话的触发动作）
    {
      const y = await page.evaluate(() => document.querySelector(".ot-stage").scrollTop);
      const box = await page.evaluate(() => {
        const st = document.querySelector(".ot-stage").getBoundingClientRect();
        return { x: st.x, y: st.y, w: st.width, h: st.height };
      });
      await page.mouse.move(box.x + 200, box.y + 120);
      await page.mouse.down();
      for (let i = 1; i <= 6; i++) {
        await page.mouse.move(box.x + 200 + i * 26, box.y + 120 + i * 10);
        await sleep(40);
      }
      await page.mouse.up();
      await sleep(500);
      const g = await page.evaluate(GEOM);
      check("4 选中文字零位移", Math.abs(g.scrollTop - y) < 2,
        "scrollTop " + Number(y).toFixed(1) + " -> " + g.scrollTop.toFixed(1));
    }

    // 5 回车重新武装：再跑一轮任务，活尾巴不丢
    {
      await page.locator(".term").click({ force: true });
      await page.keyboard.press("Enter");
      await sleep(700);
      const armed = await page.evaluate(GEOM);
      await page.keyboard.type("分析", { delay: 45 });
      await sleep(300);
      await page.keyboard.press("Enter");
      const baseBlocks = await page.evaluate(
        () => document.querySelectorAll(".ot-blocks > *").length);
      const t2 = Date.now();
      while (Date.now() - t2 < 60000) {
        const n = await page.evaluate(
          () => document.querySelectorAll(".ot-blocks > *").length);
        if (n > baseBlocks) break;
        await sleep(400);
      }
      await sleep(3500);
      const g = await page.evaluate(GEOM);
      check("5 回车重新武装后跟流仍有效（活尾巴在屏上）", g.cursorVisible,
        "回车后 cursorVisible=" + armed.cursorVisible +
        " 事后 cursorVisible=" + g.cursorVisible +
        " scrollTop " + armed.scrollTop.toFixed(0) + " -> " + g.scrollTop.toFixed(0) +
        " maxScroll " + g.maxScroll.toFixed(0));
    }

    const barH = await page.evaluate(() => window.__otBarH || []);
    check("6 状态栏高度不翻动（扳机不复发）", barH.length === 0,
      JSON.stringify(barH));

    await page.screenshot({ path: path.join(OUT, "verify-scroll-follow.png") });
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
