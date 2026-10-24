// 诊断 v2：图一→图二 现场——滚动被谁拽走。
//
// v1 只拦了 stage.scrollTop 的 JS 赋值，浏览器原生滚动（focus 滚入视口 /
// scrollIntoView / 选区拖拽自动滚）不经过 setter，全漏了。v2 补齐：
//   1) stage 的 scroll 事件（谁滚的都能看见结果）
//   2) Element.prototype.scrollIntoView / scrollTo / scrollBy 全局打桩记栈
//   3) HTMLElement.prototype.focus 记栈
//   4) .ot-blocks 的 ResizeObserver + MutationObserver（_followBlockStream 的触发源）
// 场景贴近真机：任务收尾后活动终端只剩提示符 + 大片空白（不灌 300 行，
// 那会让 xterm 自己的 xterm-viewport 变成第二个滚动面，滚轮走错层）。
// 用法：node tools/verify-web/diag-scroll-jump.cjs
"use strict";
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const REPO = path.resolve(__dirname, "..", "..");
const OUT = path.join(REPO, ".tmp", "live");
const HOME = path.join(REPO, ".tmp", "scroll-jump-home");
const PORT = 8266;
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
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "scroll-key",
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

const snapshot = page => page.evaluate(() => {
  let rows = document.querySelectorAll(".xterm-rows .xterm-row");
  if (!rows.length) rows = document.querySelectorAll(".xterm-rows > div");
  return Array.from(rows).map(r => r.textContent || "").join("\n");
});

const INSTRUMENT = () => {
  const stage = document.querySelector(".ot-stage");
  const blocks = document.querySelector(".ot-blocks");
  if (!stage || !blocks) return "no-stage";
  const stack = () => String(new Error().stack || "").split("\n").slice(2, 9)
    .map(s => s.trim().replace(/^at /, "")).join(" <- ");
  window.__ot = { sets: [], calls: [], ro: [], mut: [], scrolls: [] };

  // 1) JS 赋值 scrollTop
  const desc = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
  Object.defineProperty(stage, "scrollTop", {
    configurable: true,
    get() { return desc.get.call(this); },
    set(v) {
      window.__ot.sets.push({ to: Number(v), before: Number(desc.get.call(this)), stack: stack() });
      desc.set.call(this, v);
    },
  });

  // 2) 全局滚动原语（scrollIntoView 会作用在子元素上，必须挂原型）
  for (const name of ["scrollIntoView", "scrollTo", "scrollBy", "focus"]) {
    const orig = (name === "focus" ? HTMLElement.prototype : Element.prototype)[name];
    if (typeof orig !== "function") continue;
    (name === "focus" ? HTMLElement.prototype : Element.prototype)[name] =
      function (...args) {
        window.__ot.calls.push({ fn: name, arg: String(args && args[0] && args[0].block || args[0] || ""), stack: stack() });
        return orig.apply(this, args);
      };
  }

  // 3) stage 的真实滚动结果（含浏览器原生滚动）
  let last = stage.scrollTop;
  stage.addEventListener("scroll", () => {
    window.__ot.scrolls.push({ from: Math.round(last), to: Math.round(stage.scrollTop) });
    last = stage.scrollTop;
  }, { passive: true });

  // 4) 会话方法打桩（_followBlockStream 的调用点）
  const s = (typeof sessions !== "undefined") ? sessions[activeTabId] : null;
  if (s) {
    window.__otSession = s;
    for (const name of ["_followBlockStream", "_ensureTerminalCursorVisible",
                        "fit", "_fixHostVisibility", "_remeasureCards",
                        "_clampCard", "_styleHost", "_blockStreamSync"]) {
      if (typeof s[name] !== "function") continue;
      const orig = s[name].bind(s);
      s[name] = function (...args) {
        window.__ot.calls.push({ fn: name, arg: "", stack: stack() });
        return orig(...args);
      };
    }
  }

  // 5) 块区尺寸/内容变化
  window.__ot.lastBlocksH = blocks.getBoundingClientRect().height;
  new ResizeObserver(entries => {
    for (const e of entries) {
      const h = Math.round(e.contentRect.height);
      window.__ot.ro.push({ h, d: h - window.__ot.lastBlocksH });
      window.__ot.lastBlocksH = h;
    }
  }).observe(blocks);
  new MutationObserver(muts => {
    for (const m of muts) {
      window.__ot.mut.push({
        type: m.type,
        target: (m.target && m.target.className && String(m.target.className).slice(0, 40)) ||
                (m.target && m.target.nodeName) || "",
        added: m.addedNodes.length, removed: m.removedNodes.length,
      });
    }
  }).observe(blocks, { subtree: true, childList: true, attributes: true, characterData: true });
  return "ok";
};

const GEOM = () => {
  const stage = document.querySelector(".ot-stage");
  const blocks = stage.querySelector(".ot-blocks");
  const term = stage.querySelector(".term");
  const r = el => {
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { top: Math.round(b.top), bottom: Math.round(b.bottom), h: Math.round(b.height) };
  };
  return {
    scrollTop: Math.round(stage.scrollTop),
    scrollHeight: Math.round(stage.scrollHeight),
    clientHeight: Math.round(stage.clientHeight),
    maxScroll: Math.round(stage.scrollHeight - stage.clientHeight),
    blocksBottomInStage: Math.round(
      blocks.getBoundingClientRect().bottom - stage.getBoundingClientRect().top + stage.scrollTop),
    followTop: Math.max(0, Math.round(
      blocks.getBoundingClientRect().bottom - stage.getBoundingClientRect().top +
      stage.scrollTop - stage.clientHeight)),
    blocks: r(blocks), term: r(term), stage: r(stage),
    blocksCount: blocks.children.length,
    termRows: document.querySelectorAll(".xterm-rows > div").length,
    sel: String((window.getSelection() || {}).toString() || "").slice(0, 40),
  };
};

const DRAIN = () => {
  const o = window.__ot;
  return {
    sets: o.sets.splice(0), calls: o.calls.splice(0),
    ro: o.ro.splice(0), mut: o.mut.splice(0), scrolls: o.scrolls.splice(0),
  };
};

const SHOW = (label, g, d) => {
  console.log("\n=== " + label + " ===");
  console.log("几何:", JSON.stringify(g));
  if (d.scrolls.length) console.log("  scroll 事件:", JSON.stringify(d.scrolls));
  for (const s of d.sets) console.log("  SET   ", s.before, "->", s.to, "|", s.stack.slice(0, 240));
  for (const c of d.calls) console.log("  CALL  ", c.fn, c.arg, "|", c.stack.slice(0, 240));
  if (d.ro.length) console.log("  块区RO:", JSON.stringify(d.ro));
  if (d.mut.length) console.log("  块区DOM变化:", d.mut.length, JSON.stringify(d.mut.slice(0, 6)));
};

async function step(page, label, fn) {
  await page.evaluate(() => { /* 清空 */ const o = window.__ot; o.sets.length = 0; o.calls.length = 0; o.ro.length = 0; o.mut.length = 0; o.scrolls.length = 0; });
  const gBefore = await page.evaluate(GEOM);
  await fn();
  await sleep(700);
  const g = await page.evaluate(GEOM);
  const d = await page.evaluate(DRAIN);
  SHOW(label, g, d);
  console.log("  ΔscrollTop:", g.scrollTop - gBefore.scrollTop,
    "（followTop=", g.followTop, " maxScroll=", g.maxScroll, "）");
  return { g, d, gBefore };
}

async function main() {
  prepareHome();
  const started = await startServer();
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on("pageerror", e => errors.push("pageerror: " + e.message));
  page.on("console", m => {
    if (m.type() === "error" && !/favicon/i.test(m.text())) errors.push("console: " + m.text());
  });
  try {
    await page.goto(started.base + "/", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#targets .target", { timeout: 20000 });
    await page.locator('#targets .target[data-name="local"]').first().click();
    const t0 = Date.now();
    while (Date.now() - t0 < 90000) {
      const interactive = await page.evaluate(() => {
        const el = document.querySelector('[id^="model-"]');
        return !!(el && !el.hidden);
      }).catch(() => false);
      if (interactive) break;
      await sleep(500);
    }
    await sleep(1200);
    console.log("打桩(任务前):", await page.evaluate(INSTRUMENT));
    // 顺带记录状态栏高度：状态栏文字变长换行会把舞台挤矮 → stage RO → follow
    await page.evaluate(() => {
      window.__otStatus = [];
      const bar = document.querySelector(".statusbar");
      let lastH = bar ? bar.getBoundingClientRect().height : 0;
      setInterval(() => {
        if (!bar) return;
        const h = bar.getBoundingClientRect().height;
        if (Math.abs(h - lastH) > 0.5) {
          window.__otStatus.push({ h: Math.round(h), was: Math.round(lastH), at: Date.now() });
          lastH = h;
        }
      }, 120);
    });

    // 跑任务：出总结卡（高卡 + 表格），收尾后活动终端只剩提示符
    await page.locator(".term").click({ force: true });
    await page.keyboard.type("总结", { delay: 45 });
    await sleep(350);
    await page.keyboard.press("Enter");
    const t1 = Date.now();
    while (Date.now() - t1 < 60000) {
      const n = await page.evaluate(() => document.querySelectorAll(".scard").length);
      if (n > 0) break;
      await sleep(400);
    }
    await sleep(3500);   // 等打字机/收束完全静止
    console.log();
    console.log("=== 【任务全程】follow 调用 ===");
    {
      const d = await page.evaluate(DRAIN);
      for (const c of d.calls.filter(x => x.fn === "_followBlockStream" || x.fn === "fit")) {
        console.log("   ", c.fn, "|", c.stack.slice(0, 220));
      }
      console.log("   块区RO:", JSON.stringify(d.ro.slice(0, 20)));
      console.log("   块区DOM变化:", d.mut.length);
      console.log("   状态栏高度变化:", JSON.stringify(await page.evaluate(() => window.__otStatus || [])));
    }

    // ── 0. 静置观察 5s：任务后有没有自发的块区变化 ──────────
    await step(page, "0 静置 5s（看有没有自发重排）", async () => { await sleep(5000); });

    // ── 1. 滚到下方空白（滚到底） ──────────────────────────
    await step(page, "1 滚轮下滚到空白", async () => {
      await page.mouse.move(700, 500);
      for (let i = 0; i < 10; i++) { await page.mouse.wheel(0, 300); await sleep(60); }
    });

    // ── 2. 空白区拖选（用户原话：选中下方文字） ─────────────
    const box = await page.evaluate(() => {
      const st = document.querySelector(".ot-stage").getBoundingClientRect();
      return { x: st.x, y: st.y, w: st.width, h: st.height };
    });
    await step(page, "2 空白区拖选文字", async () => {
      await page.mouse.move(box.x + 180, box.y + box.h - 200);
      await page.mouse.down();
      for (let i = 1; i <= 8; i++) {
        await page.mouse.move(box.x + 180 + i * 22, box.y + box.h - 200 + i * 14);
        await sleep(45);
      }
      await page.mouse.up();
    });

    // ── 3. 点状态栏 token 文字（图一右下 in/out） ───────────
    await step(page, "3 点状态栏 token 文字", async () => {
      const tok = page.locator(".status-tokens").first();
      if (await tok.count()) await tok.click({ force: true }).catch(() => {});
    });

    // ── 4. 选中状态栏文字后按 Ctrl+C（复制链路 → focusCursor） ─
    await step(page, "4 选中状态栏文字 + Ctrl+C", async () => {
      const st = await page.locator(".status-text").first().boundingBox().catch(() => null)
        || await page.locator(".status-tokens").first().boundingBox().catch(() => null);
      if (st) {
        await page.mouse.move(st.x + 4, st.y + st.height / 2);
        await page.mouse.down();
        await page.mouse.move(st.x + st.width - 4, st.y + st.height / 2, { steps: 6 });
        await page.mouse.up();
      }
      await page.keyboard.press("Control+C");
    });

    // ── 5. 卡内拖选（总结卡里的结论文字） ───────────────────
    await step(page, "5 卡内拖选结论文字", async () => {
      const el = await page.evaluate(() => {
        const cards = document.querySelectorAll(".scard, .acard");
        const c = cards[cards.length - 1];
        if (!c) return null;
        const b = c.getBoundingClientRect();
        return { x: b.x + 40, y: b.y + b.height / 2, w: b.width, h: b.height };
      });
      if (el) {
        await page.mouse.move(el.x, el.y);
        await page.mouse.down();
        await page.mouse.move(el.x + 160, el.y + 8, { steps: 8 });
        await page.mouse.up();
      }
    });

    // ── 6. 选中后点卡内文字（松开触发 click → focusCursor） ──
    await step(page, "6 卡内点击（无选区）", async () => {
      const el = await page.evaluate(() => {
        const cards = document.querySelectorAll(".scard, .acard");
        const c = cards[cards.length - 1];
        if (!c) return null;
        const b = c.getBoundingClientRect();
        return { x: b.x + 40, y: b.y + b.height / 2 };
      });
      if (el) await page.mouse.click(el.x, el.y);
    });

    // ── 7. 手动调用 _followBlockStream（确认它就是跳到 followTop） ─
    await step(page, "7 手动调用 _followBlockStream", async () => {
      await page.evaluate(() => {
        const s = window.__otSession;
        const st = document.querySelector(".ot-stage");
        st.scrollTop = st.scrollHeight;   // 先到底
        if (s && s._followBlockStream) s._followBlockStream();
      });
    });

    // ── 8. 窗口 resize（状态栏/侧栏改动同源） ───────────────
    await step(page, "8 窗口 resize", async () => {
      await page.setViewportSize({ width: 1400, height: 880 });
      await sleep(300);
      await page.setViewportSize({ width: 1400, height: 900 });
    });

    await page.screenshot({ path: path.join(OUT, "diag-scroll-jump-v2.png") });
    console.log("\nJS 报错:", errors.length, errors.slice(0, 3));
  } catch (e) {
    console.log("异常:", String(e).slice(0, 600));
  } finally {
    await browser.close().catch(() => {});
    started.server.kill();
    process.exit(0);
  }
}
main();
