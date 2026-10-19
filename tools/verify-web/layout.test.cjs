// Real browser layout regressions; no backend, SSH, model calls or shell execution.
// Run: node --test tools/verify-web/layout.test.cjs
// Optional screenshots: OT_LAYOUT_ARTIFACTS=<directory>
"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const FRONTEND = path.resolve(__dirname, "../../src/openterminal/web/frontend");
let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { if (browser) await browser.close(); });

async function openPage(t, width = 1280, height = 800) {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  // Every request is fulfilled locally. Unexpected API calls fail rather than
  // reaching a real service (including state-changing file operations).
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/targets") {
      return route.fulfill({ json: { direct: [] } });
    }
    if (url.pathname.endsWith("/files/state")) {
      return route.fulfill({ json: {
        supported: true, connected: true, host: "audit.example", user: "tester", port: 22,
      } });
    }
    if (url.pathname.endsWith("/files/list")) {
      return route.fulfill({ json: { path: "/home/tester", entries: [] } });
    }
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/ws/")) {
      return route.fulfill({ status: 503, json: { detail: "Not available in layout test" } });
    }
    const file = path.join(FRONTEND, url.pathname === "/" ? "index.html" : url.pathname);
    if (!file.startsWith(FRONTEND + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      return route.fulfill({ status: 404, body: "" });
    }
    const contentType = file.endsWith(".js") ? "application/javascript"
      : file.endsWith(".css") ? "text/css" : "text/html";
    return route.fulfill({ path: file, contentType });
  });
  t.after(async () => {
    try {
      if (process.env.OT_LAYOUT_ARTIFACTS) {
        fs.mkdirSync(process.env.OT_LAYOUT_ARTIFACTS, { recursive: true });
        await page.screenshot({ path: path.join(process.env.OT_LAYOUT_ARTIFACTS,
          t.name.replace(/[^a-z0-9-]/gi, "-") + ".png") });
      }
    } finally { await context.close(); }
    assert.deepEqual(errors, [], "no uncaught browser errors");
  });
  await page.goto("http://ot-layout.test/");
  // Narrow first load intentionally hides the sidebar; only wait for API render.
  await page.waitForSelector("#targets .target", { state: "attached" });
  return page;
}

async function session(page) {
  await page.evaluate(() => {
    window.layoutSession = new Session("layout", "local");
    sessions.layout = layoutSession;
    activateTab("layout");
    layoutSession.setStatus("connected", "Ready");
  });
  await page.waitForSelector(".pane.active .xterm-screen");
}

async function resize(page, width, height = 800) {
  await page.setViewportSize({ width, height });
  // Account for the application's 120ms window-resize debounce as well as RO.
  await page.waitForTimeout(200);
}

async function card(page, id = "approval", command = "echo first\necho second\necho third") {
  await page.evaluate(async ({ id, command }) => {
    const s = layoutSession;
    const feed = await s._ensureFeed();
    feed.handle({ kind: "tool_start", id, name: "execute", command,
      needs_approval: true, risk: "high" });
    feed.handle({ kind: "command_card_waiting", id });
    await s._runMountCardBlocks(id, "approval");
  }, { id, command });
  await page.waitForSelector(".cmdcard");
}

async function openFiles(page) {
  await page.locator(".files-toggle").click();
  await page.waitForSelector(".files-panel:not([hidden]) .fp-empty");
}

async function assertHit(locator) {
  assert.equal(await locator.evaluate(e => {
    const r = e.getBoundingClientRect();
    return e.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
  }), true, "the visible control receives a click at its center");
}

async function dimensions(page) {
  return page.evaluate(() => {
    const stage = document.querySelector(".pane.active .ot-stage");
    const term = document.querySelector(".pane.active .term");
    return { stage: stage.getBoundingClientRect().height, term: term.clientHeight,
      rows: sessions[activeTabId].term.rows, scroll: stage.scrollHeight };
  });
}

test("sidebar can be restored on desktop and narrow first load", async t => {
  const page = await openPage(t);
  await page.locator("#btn-toggle-sidebar").click();
  await page.locator("#btn-show-sidebar").click();
  assert.equal(await page.locator("#sidebar").isVisible(), true);
  await resize(page, 390);
  await page.reload();
  await page.locator("#btn-show-sidebar").click();
  assert.equal(await page.locator("#sidebar .target").isVisible(), true);
  await page.locator("#btn-add-remote").click();
  await assertHit(page.locator(".modal-btns button").first());
  await page.locator(".modal-btns button").last().click();
  await page.locator("#btn-toggle-sidebar").click();
  assert.equal(await page.locator("#btn-show-sidebar").isVisible(), true);
});

test("file dialog stays above drawer including its input and buttons", async t => {
  const page = await openPage(t, 900);
  await session(page);
  await openFiles(page);
  await page.locator('[data-act="mkdir"]').click();
  await assertHit(page.locator("#modal-value"));
  await assertHit(page.locator(".modal-btns button").first());
  await assertHit(page.locator(".modal-btns button").last());
  await page.locator("#modal-value").fill("not-created");
  await page.locator(".modal-btns button").last().click();
  assert.equal(await page.locator(".modal").count(), 0);
});

test("drawer reserves space for both terminal and historical cards", async t => {
  const page = await openPage(t);
  await session(page);
  await card(page);
  for (const width of [1280, 900, 390]) {
    await resize(page, width);
    const before = await page.locator(".ot-stage").boundingBox();
    await openFiles(page);
    await page.waitForTimeout(100);
    const boxes = await page.evaluate(() => {
      const rect = sel => document.querySelector(sel).getBoundingClientRect().toJSON();
      return { panel: rect(".files-panel"), stage: rect(".ot-stage"), term: rect(".term"),
        blocks: rect(".ot-blocks"), cols: layoutSession.term.cols };
    });
    assert.ok(Math.abs(boxes.stage.right - boxes.panel.left) <= 1);
    assert.ok(Math.abs(before.width - boxes.stage.width - boxes.panel.width) <= 1);
    assert.ok(boxes.term.right <= boxes.panel.left + 1);
    assert.ok(boxes.blocks.right <= boxes.panel.left + 1);
    const narrowCols = boxes.cols;
    await page.locator('[data-act="close"]').click();
    await page.waitForTimeout(100);
    assert.ok(await page.evaluate(() => layoutSession.term.cols) > narrowCols);
    const restored = await page.locator(".ot-stage").boundingBox();
    assert.ok(Math.abs(restored.width - before.width) <= 1);
  }
});

test("terminal height follows viewport without a content-height feedback loop", async t => {
  const page = await openPage(t, 1280, 600);
  await session(page);
  const small = await dimensions(page);
  await resize(page, 1280, 1000);
  const large = await dimensions(page);
  assert.ok(large.rows > small.rows + 10);
  assert.ok(Math.abs(large.stage - large.term) <= 1);
  for (let i = 0; i < 5; i++) await card(page, "history-" + i);
  await page.evaluate(() => { for (let i = 0; i < 10; i++) layoutSession.fit(); });
  const withHistory = await dimensions(page);
  assert.equal(withHistory.rows, large.rows);
  assert.ok(Math.abs(withHistory.term - large.term) <= 1);
  assert.ok(withHistory.scroll > withHistory.stage);
  await resize(page, 1280, 480);
  const shrunk = await dimensions(page);
  assert.ok(shrunk.rows < small.rows);
  assert.ok(Math.abs(shrunk.stage - shrunk.term) <= 1);
});

test("inactive terminal is fitted on activation after resizing", async t => {
  const page = await openPage(t, 1280, 600);
  await session(page);
  await page.evaluate(() => {
    sessions.other = new Session("other", "second");
    activateTab("other");
  });
  await resize(page, 1280, 1000);
  await page.evaluate(() => activateTab("layout"));
  const size = await dimensions(page);
  assert.ok(Math.abs(size.stage - size.term) <= 1);
  assert.ok(size.rows > 40);
});

test("multiline and wrapped commands are fully visible in block cards", async t => {
  const page = await openPage(t, 640);
  await session(page);
  await card(page, "multiline", "echo first\necho second\necho " + "long-argument".repeat(40));
  const pre = page.locator(".cmdcode");
  assert.equal(await pre.evaluate(e => e.scrollHeight <= e.clientHeight + 1), true);
  assert.ok((await pre.boundingBox()).height > 3 * 18.75);
});

test("approval controls wrap without overlap and high-risk confirmation stays visible", async t => {
  const page = await openPage(t);
  await session(page);
  await card(page);
  for (const width of [1280, 640, 480, 390, 320]) {
    await resize(page, width);
    await page.locator(".cmdcard").scrollIntoViewIfNeeded();
    const bad = await page.locator(".cmdcard").evaluate(card => {
      const head = card.querySelector(".cmdhead").getBoundingClientRect();
      const els = [...card.querySelectorAll(".cmdhead > .alabel, .cmdhead > .apstate, .cmdacts button")];
      const boxes = els.map(e => e.getBoundingClientRect());
      return boxes.some(r => r.left < head.left - 1 || r.right > head.right + 1 ||
        r.top < head.top - 1 || r.bottom > head.bottom + 1) || boxes.some((r, i) =>
        boxes.slice(i + 1).some(b => Math.min(r.right, b.right) - Math.max(r.left, b.left) > 1 &&
          Math.min(r.bottom, b.bottom) - Math.max(r.top, b.top) > 1));
    });
    assert.equal(bad, false, "no clipping or overlapping controls at width " + width);
    for (const btn of await page.locator(".cmdacts button").all()) {
      await assertHit(btn);
      assert.ok((await btn.boundingBox()).height < 40, "button labels stay on one line");
    }
    await page.locator(".apexec > button").click();
    const popup = await page.locator(".apconfirm").boundingBox();
    assert.ok(popup.x >= 0 && popup.x + popup.width <= width);
    assert.ok(popup.width < 350, "confirmation remains a compact content-sized popup");
    const execute = await page.locator(".apexec > button").boundingBox();
    assert.ok(Math.abs(popup.y - (execute.y + execute.height + 5)) <= 1,
      "confirmation stays just below the Execute button");
    await assertHit(page.locator(".apconfirm button").first());
    await page.locator(".apconfirm button").last().click();
  }
});

test("terminal command and natural-language styles survive freezing and resizing", async t => {
  const page = await openPage(t, 640);
  await session(page);
  const command = "kubectl get pods -A";
  const language = "查看k8s的pod情况，包括异常原因和建议。".repeat(8) + " e\u0301 🚀 <script>";
  await page.evaluate(async ({ command, language }) => {
    const s = layoutSession;
    await s._ensureFeed();
    const bytes = "[root@audit /tmp]# \x1b[38;5;51m" + command + "\x1b[0m\r\n" +
      "ordinary output: " + command + "\r\n" +
      "[root@audit /tmp]# \x1b[38;5;33m" + language + "\x1b[0m\r\n";
    await new Promise(resolve => s.term.write(bytes, resolve));
    s._cutBlock();
  }, { command, language });
  const body = page.locator(".ot-blk-body");
  const read = () => body.evaluate(e => ({ text: e.textContent, color: getComputedStyle(e).color,
    spans: [...e.querySelectorAll("span")].map(s => ({ text: s.textContent, color: getComputedStyle(s).color })) }));
  const before = await read();
  assert.equal(before.text, "[root@audit /tmp]# " + command + "\nordinary output: " + command +
    "\n[root@audit /tmp]# " + language);
  assert.ok(before.spans.some(s => s.text === command && s.color === "rgb(0, 255, 255)"));
  assert.equal(before.spans.filter(s => s.color === "rgb(0, 135, 255)").map(s => s.text).join(""), language);
  assert.ok(before.spans.every(s => !s.text.includes("ordinary output")), "output remains unstyled");
  assert.equal(await body.locator("script").count(), 0, "terminal text is escaped");
  await resize(page, 390);
  assert.deepEqual(await read(), before, "history keeps its colors and text after reflow");
  await card(page);
  assert.equal(await page.locator(".cmdcode").evaluate(e => getComputedStyle(e).color), "rgb(57, 197, 207)");
});

test("missing tool echo is restored with command color only and is not duplicated", async t => {
  const page = await openPage(t);
  await session(page);
  const result = await page.evaluate(async () => {
    const s = layoutSession;
    await s._ensureFeed();
    s._onTermOpen({ command: "echo hello", echo: "[root@audit /tmp]# echo hello" });
    await s._outOpQ;
    await new Promise(resolve => s.term.write("hello\r\n", resolve));
    s._onTermClose({});
    await s._outOpQ;
    const body = document.querySelector(".ot-blk-body");
    return { text: body.textContent, spans: [...body.querySelectorAll("span")].map(e => ({
      text: e.textContent, color: getComputedStyle(e).color,
    })) };
  });
  assert.equal(result.text, "[root@audit /tmp]# echo hello\nhello");
  assert.deepEqual(result.spans, [{ text: "echo hello", color: "rgb(0, 255, 255)" }]);
});

