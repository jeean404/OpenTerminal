// 真机校验：设置页「通用」两行控件。
//   · 界面语言 = seg，选中项要看得出（.on，不是没有样式的 .selected）
//   · 界面字号 = 滑动条，拖到哪缩到哪；且只放大文字，盒子/间距/图标一律不动
//     （zoom 会把整页连盒子一起缩放，这里专门盯死「盒子尺寸不变」）
// 用法：node tools/verify-web/verify-settings-prefs.cjs
"use strict";
const lib = require("./lib");
const path = require("node:path");
const { chromium } = require("playwright");

const PORT = Number(process.argv[2] || 8474);
const HOME = path.join(lib.REPO, ".tmp", "settings-prefs-home");
const sleep = ms => new Promise(r => setTimeout(r, ms));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? "  OK   " : "  FAIL ") + name + (detail ? "  -- " + detail : ""));
}

const MEASURE = () => {
  const rect = sel => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { w: Number(r.width.toFixed(2)), h: Number(r.height.toFixed(2)) };
  };
  const fs = sel => {
    const el = document.querySelector(sel);
    return el ? Number(getComputedStyle(el).fontSize.replace("px", "")) : null;
  };
  return {
    value: (document.getElementById("general-ui-scale") || {}).value,
    out: (document.getElementById("general-ui-scale-value") || {}).textContent,
    stored: localStorage.getItem("ot-ui-scale"),
    // 文字：calc(Npx * var(--fs)) 会算进 computed font-size，直接读即可
    text: {
      h1: fs(".settings-header h1"),
      h2: fs(".settings-section-heading h2"),
      strong: fs(".settings-row-text strong"),
      small: fs(".settings-row-text small"),
      nav: fs(".settings-nav-item"),
      sideBtn: fs(".side-btn"),
    },
    // 盒子：界面字号不该动它们
    box: {
      sidebar: rect("#sidebar"),
      sideBtn: rect(".side-btn"),
      settingsContent: rect(".settings-content"),
      panes: rect("#panes"),
    },
    outsideText: { tabbar: fs("#tabbar"), statusbar: fs(".statusbar") },
    lang: Array.from(document.querySelectorAll("[data-general-lang]")).map(b => {
      const cs = getComputedStyle(b);
      return [b.textContent.trim(), b.classList.contains("on"), cs.backgroundColor];
    }),
  };
};

// 直接派发事件：测「拖动中就生效」时焦点一直留在滑块上，不能靠 fill
function setScale(page, value, eventName) {
  return page.evaluate(([v, ev]) => {
    const el = document.getElementById("general-ui-scale");
    el.focus();
    el.value = v;
    el.dispatchEvent(new Event(ev, { bubbles: true }));
  }, [value, eventName]);
}

const ratio = (a, b) => (a && b ? Number((a / b).toFixed(4)) : null);

async function main() {
  const { base, server } = await lib.startServer(PORT, { env: { OPENTERMINAL_HOME: HOME } });
  console.log("服务端:", base);
  const browser = await chromium.launch({
    headless: true, channel: "chrome",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on("pageerror", e => errors.push("pageerror: " + e.message));
  try {
    await page.goto(base + "/", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#btn-settings", { timeout: 20000 });
    await page.click("#btn-settings");
    await page.waitForSelector("#general-ui-scale", { timeout: 10000 });
    await sleep(300);

    const base100 = await page.evaluate(MEASURE);
    console.log("基准(100%):", JSON.stringify(base100, null, 2));
    check("控件是滑动条", await page.locator("#general-ui-scale").getAttribute("type") === "range");
    check("滑动条默认 100 / 输出 100%", base100.value === "100" && base100.out === "100%",
      base100.value + " / " + base100.out);
    check("界面语言恰好一个选中", base100.lang.filter(x => x[1]).length === 1);
    check("默认选中「中文」", (base100.lang.find(x => x[1]) || [""])[0] === "中文");
    const langOn = (base100.lang.find(x => x[1]) || [])[2];
    const langOff = (base100.lang.find(x => !x[1]) || [])[2];
    check("语言选中项有底色区分", !!langOn && langOn !== langOff, langOn + " vs " + langOff);

    // --- 拖到 115：只派发 input，焦点一直在滑块上 ---
    await setScale(page, "115", "input");
    await sleep(150);
    const at115 = await page.evaluate(MEASURE);
    console.log("115% 文字比:", JSON.stringify({
      h1: ratio(at115.text.h1, base100.text.h1),
      h2: ratio(at115.text.h2, base100.text.h2),
      strong: ratio(at115.text.strong, base100.text.strong),
      small: ratio(at115.text.small, base100.text.small),
      nav: ratio(at115.text.nav, base100.text.nav),
      sideBtn: ratio(at115.text.sideBtn, base100.text.sideBtn),
    }), "盒子比:", JSON.stringify({
      sidebarW: ratio(at115.box.sidebar.w, base100.box.sidebar.w),
      sideBtnH: ratio(at115.box.sideBtn.h, base100.box.sideBtn.h),
      panesW: ratio(at115.box.panes.w, base100.box.panes.w),
      panesH: ratio(at115.box.panes.h, base100.box.panes.h),
    }));

    const textChecks = [["h1", "标题 h1"], ["h2", "标题 h2"], ["strong", "行标题"],
                        ["small", "说明文字"], ["nav", "侧栏导航"], ["sideBtn", "侧栏按钮"]];
    for (const pair of textChecks) {
      const r = ratio(at115.text[pair[0]], base100.text[pair[0]]);
      check("文字缩放 " + pair[1], r !== null && Math.abs(r - 1.15) < 0.02, "x" + r);
    }
    check("拖动中就生效（不失焦）", at115.out === "115%", at115.out);
    check("侧栏宽度不变", Math.abs(at115.box.sidebar.w - base100.box.sidebar.w) < 0.5,
      base100.box.sidebar.w + " -> " + at115.box.sidebar.w);
    check("固定高度按钮不变高", Math.abs(at115.box.sideBtn.h - base100.box.sideBtn.h) < 0.5,
      base100.box.sideBtn.h + " -> " + at115.box.sideBtn.h);
    check("设置区宽度不变", Math.abs(at115.box.settingsContent.w - base100.box.settingsContent.w) < 0.5,
      base100.box.settingsContent.w + " -> " + at115.box.settingsContent.w);
    check("落库存倍率 1.15", at115.stored === "1.15", String(at115.stored));

    await page.locator(".settings-subsection").first()
      .screenshot({ path: path.join(lib.OUT, "settings-scale-115.png") });

    // --- 关掉设置页再比：#panes 打开设置页时是 display:none，rect 恒 0x0 ---
    await page.click(".settings-close").catch(() => {});
    await sleep(300);
    const closed115 = await page.evaluate(MEASURE);
    await page.evaluate(() => { generalSet("ot-ui-scale", "1"); });
    await sleep(150);
    const closed100 = await page.evaluate(MEASURE);
    check("终端面板尺寸不变（侧栏不再变宽挤它）",
      closed115.box.panes.w > 0
      && Math.abs(closed115.box.panes.w - closed100.box.panes.w) < 0.5
      && Math.abs(closed115.box.panes.h - closed100.box.panes.h) < 0.5,
      JSON.stringify(closed100.box.panes) + " -> " + JSON.stringify(closed115.box.panes));
    const outsideSame = (a, b) => (a == null || b == null)
      ? true : Math.abs(ratio(a, b) - 1) < 0.02;
    check("区域外字号不缩（标签栏/状态栏）",
      outsideSame(closed115.outsideText.tabbar, closed100.outsideText.tabbar)
      && outsideSame(closed115.outsideText.statusbar, closed100.outsideText.statusbar),
      "tabbar " + closed100.outsideText.tabbar + "->" + closed115.outsideText.tabbar
      + " / statusbar " + closed100.outsideText.statusbar + "->" + closed115.outsideText.statusbar);

    await page.evaluate(() => { generalSet("ot-ui-scale", "1.15"); });
    await sleep(150);

    // --- 刷新后仍生效 ---
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#btn-settings", { timeout: 20000 });
    await page.click("#btn-settings");
    await page.waitForSelector("#general-ui-scale", { timeout: 10000 });
    await sleep(300);
    const reloaded = await page.evaluate(MEASURE);
    check("刷新后仍是 115 / 输出 115%", reloaded.value === "115" && reloaded.out === "115%",
      reloaded.value + " / " + reloaded.out);
    check("刷新后文字仍缩放",
      Math.abs(ratio(reloaded.text.strong, base100.text.strong) - 1.15) < 0.02,
      "x" + ratio(reloaded.text.strong, base100.text.strong));
    check("刷新后侧栏宽度仍不变",
      Math.abs(reloaded.box.sidebar.w - base100.box.sidebar.w) < 0.5,
      base100.box.sidebar.w + " -> " + reloaded.box.sidebar.w);

    // --- 滑到下限/上限 ---
    await setScale(page, "70", "input");
    await sleep(120);
    const low = await page.evaluate(MEASURE);
    check("下限 70% 生效",
      Math.abs(ratio(low.text.strong, base100.text.strong) - 0.7) < 0.02 && low.out === "70%",
      "x" + ratio(low.text.strong, base100.text.strong) + " / " + low.out);
    await setScale(page, "150", "input");
    await sleep(120);
    const high = await page.evaluate(MEASURE);
    check("上限 150% 生效",
      Math.abs(ratio(high.text.strong, base100.text.strong) - 1.5) < 0.02 && high.out === "150%",
      "x" + ratio(high.text.strong, base100.text.strong) + " / " + high.out);
    check("上限时侧栏宽度仍不变",
      Math.abs(high.box.sidebar.w - base100.box.sidebar.w) < 0.5,
      base100.box.sidebar.w + " -> " + high.box.sidebar.w);

    await page.locator(".settings-subsection").first()
      .screenshot({ path: path.join(lib.OUT, "settings-scale-150.png") });
    // 整页：150% 只放大字后，侧栏/行有没有被挤到溢出，肉眼过一遍
    await page.screenshot({ path: path.join(lib.OUT, "settings-scale-150-full.png") });

    await page.evaluate(() => { generalSet("ot-ui-scale", "1"); });
    check("无页面异常", errors.length === 0, errors.join(" | "));

    const failed = results.filter(r => !r.ok).length;
    console.log("");
    console.log(failed ? (failed + " 项未通过") : "全部通过");
    process.exitCode = failed ? 1 : 0;
  } finally {
    await browser.close().catch(() => {});
    server.kill();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
