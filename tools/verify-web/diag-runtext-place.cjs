// 真机诊断：「执行长文本」是否与「新会话」同款同尺寸、并在其旁边。
// 结果写 .tmp/live/runtext-place.json（不走 stdout，避免管道缓冲丢输出）。
"use strict";
const lib = require("./lib");
const path = require("node:path");
const fs = require("node:fs");
const { chromium } = require("playwright");
const PORT = 8472;
const HOME = path.join(lib.REPO, ".tmp", "runtext-home");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const checks = [];
const ok = (n, v, d) => checks.push({ name: n, pass: !!v, detail: d || "" });

(async () => {
  fs.rmSync(HOME, { recursive: true, force: true });
  const { base } = await lib.startServer(PORT, { env: { OPENTERMINAL_HOME: HOME } });
  const b = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const p = await b.newPage({ viewport: { width: 1400, height: 900 } });
  p.on("pageerror", e => checks.push({ name: "PAGEERROR", pass: false, detail: e.message }));
  await p.goto(base + "/", { waitUntil: "domcontentloaded" });
  await p.waitForSelector("#targets .target", { timeout: 20000 });
  await p.evaluate(() => openTab("local"));
  await sleep(1500);

  const info = await p.evaluate(() => {
    const rt = document.querySelector(".pane.active .run-text-btn");
    const nt = document.querySelector(".pane.active .status-newtask");
    const meta = document.querySelector(".pane.active .status-meta");
    const grab = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const c = getComputedStyle(el);
      return {
        rect: { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) },
        parent: el.parentElement && el.parentElement.className,
        inStatusbar: !!el.closest(".statusbar"),
        inStage: !!el.closest(".ot-stage"),
        position: c.position,
        style: {
          padding: c.padding, fontSize: c.fontSize,
          fontFamily: c.fontFamily.split(",")[0],
          borderRadius: c.borderRadius, background: c.backgroundColor,
          border: c.border, color: c.color, fontWeight: c.fontWeight,
        },
        text: el.textContent.trim(),
      };
    };
    return {
      run: grab(rt), newtask: grab(nt),
      gap: meta ? getComputedStyle(meta).gap : null,
      order: meta ? Array.from(meta.children).map(e => e.className || e.id) : null,
      barText: (document.querySelector(".pane.active .statusbar") || {}).innerText,
    };
  });

  ok("长文本按钮在状态栏内", info.run && info.run.inStatusbar);
  ok("长文本按钮不在终端格子里（不碰卡片/预留行）", info.run && !info.run.inStage);
  ok("与新会话同父容器 .status-meta",
     info.run && info.newtask && info.run.parent === info.newtask.parent && /status-meta/.test(info.run.parent));
  ok("不再是浮层（position 非 absolute/fixed）",
     info.run && info.run.position === "static", "position=" + (info.run && info.run.position));

  const sameStyle = info.run && info.newtask &&
    JSON.stringify(info.run.style) === JSON.stringify(info.newtask.style);
  ok("与新会话同款（padding/字号/字族/圆角/底色/描边/字色/字重）", sameStyle,
     sameStyle ? "" : "run=" + JSON.stringify(info.run.style) + " | newtask=" + JSON.stringify(info.newtask.style));

  ok("与新会话同高", info.run && info.newtask && Math.abs(info.run.rect.h - info.newtask.rect.h) < 0.5,
     info.run.rect.h + " vs " + info.newtask.rect.h);

  const edge = info.run && info.newtask
    ? Math.min(Math.abs(info.run.rect.x + info.run.rect.w - info.newtask.rect.x),
               Math.abs(info.newtask.rect.x + info.newtask.rect.w - info.run.rect.x))
    : null;
  ok("紧挨新会话（间距 = status-meta gap）",
     edge !== null && Math.abs(edge - (parseFloat(info.gap) || 0)) < 1.5,
     "gap=" + info.gap + " 实测间距=" + (edge === null ? "-" : edge.toFixed(1)));

  const meta = info.order || [];
  const iRun = meta.findIndex(c => /run-text-btn/.test(c));
  const iNew = meta.findIndex(c => /status-newtask/.test(c));
  ok("两者在 status-meta 中相邻", iRun >= 0 && iNew >= 0 && Math.abs(iRun - iNew) === 1,
     meta.join(" | "));

  // 弹框功能没被搬家弄坏（点得开、能提交一次回车）
  await p.click(".pane.active .run-text-btn");
  await p.waitForSelector("#run-text-input", { timeout: 5000 });
  ok("点击仍能打开长文本弹框", true);
  await p.fill("#run-text-input", "echo hello-runtext");
  await p.evaluate(() => {
    window.__sent = [];
    const s = Object.values(sessions)[0];
    const o = s.ws.send.bind(s.ws);
    s.ws.send = (d) => {
      try { window.__sent.push(typeof d === "string" ? d : new TextDecoder().decode(d)); }
      catch (e) { window.__sent.push("[bin]"); }
      return o(d);
    };
  });
  await p.click(".modal-btns button.primary");
  await sleep(600);
  const flat = (await p.evaluate(() => window.__sent)).join("");
  ok("长文本一次性进终端", flat.includes("echo hello-runtext"), JSON.stringify(flat).slice(0, 120));
  ok("只提交一次回车", (flat.match(new RegExp(String.fromCharCode(13), "g")) || []).length === 1,
     JSON.stringify(flat));

  // 关掉弹框后再截状态栏（Escape 关不掉，走「取消」）
  const cancel = p.locator(".modal-btns button:not(.primary)").first();
  if (await cancel.count()) await cancel.click().catch(() => {});
  await sleep(300);

  // 截图：状态栏整条 + 右侧放大
  await p.screenshot({ path: path.join(lib.OUT, "runtext-btn-place-full.png") });
  const box = await p.evaluate(() => {
    const b = document.querySelector(".pane.active .statusbar");
    const r = b.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  await p.screenshot({
    path: path.join(lib.OUT, "runtext-btn-place.png"),
    clip: { x: box.x, y: box.y - 2, width: box.w, height: box.h + 4 },
  });
  await p.screenshot({
    path: path.join(lib.OUT, "runtext-btn-place-zoom.png"),
    clip: { x: box.x + box.w * 0.55, y: box.y - 2, width: box.w * 0.45, height: box.h + 4 },
  });

  const out = { info, checks, pass: checks.every(c => c.pass) };
  fs.writeFileSync(path.join(lib.OUT, "runtext-place.json"), JSON.stringify(out, null, 2), "utf8");
  fs.appendFileSync(path.join(lib.OUT, "runtext-place.log"),
    checks.map(c => (c.pass ? "PASS " : "FAIL ") + c.name + (c.detail ? "  → " + c.detail : "")).join("\n") + "\n",
    "utf8");
  await b.close();
  process.exit(out.pass ? 0 : 1);
})().catch(e => {
  fs.appendFileSync(path.join(lib.OUT, "runtext-place.log"), "ERROR " + (e && e.stack || e) + "\n", "utf8");
  process.exit(1);
});
