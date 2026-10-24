// 真机验证：设置页「保存位置」= 路径 + 浏览…，选完自动存（无保存按钮/弹框/文字）
// 用法: node tools/verify-web/diag-wallpaper-dir.cjs [port]
//
// 路径全用 path.join 按当前平台拼，不写死盘符——同一份脚本在 macOS/Windows 都能跑。
// 系统对话框自动化点不了（也不能在跑测时乱弹框），一律 stub /dir/pick 的三分支。
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { chromium } = require("playwright");

const PORT = Number(process.argv[2] || 8905);
const IS_WIN = process.platform === "win32";

const SCENE = path.join(os.tmpdir(), "ot-wp-scene");
const CHILD = path.join(SCENE, "wallpapers");
const NATIVE = path.join(os.tmpdir(), "ot-wp-native");
const TYPED = path.join(os.tmpdir(), "ot-wp-typed");

const PICK_ROUTE = "**/api/wallpapers/dir/pick**";

// shell 简写（`~/.openterminal/...`）才是假路径；Windows 8.3 短名里的波浪号
// （ADMINI~1）是真实路径，不能一杆子打死
const noShorthand = v => {
  const s = String(v == null ? "" : v).trim();
  return !s.startsWith("~") && !s.includes("~/") && !s.includes("~\\");
};
const isAbs = v => IS_WIN ? path.win32.isAbsolute(v) : path.posix.isAbsolute(v);

(async () => {
  fs.rmSync(SCENE, { recursive: true, force: true });
  fs.mkdirSync(CHILD, { recursive: true });

  const base = `http://127.0.0.1:${PORT}`;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on("pageerror", e => errors.push("pageerror: " + e.message));
  page.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });

  // 默认 stub 成「系统框不可用」，分支用例再逐条覆盖
  const stub = async payload => {
    await page.unroute(PICK_ROUTE).catch(() => {});
    await page.route(PICK_ROUTE, route => route.fulfill({
      status: 200, contentType: "application/json", body: JSON.stringify(payload),
    }));
  };
  await stub({ ok: false, result: "unavailable", path: "" });

  await page.goto(base, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  await page.click("#btn-settings");
  await page.waitForTimeout(250);
  await page.click('[data-settings-section="appearance"]');
  await page.waitForTimeout(400);

  const read = async label => {
    const s = await page.evaluate(() => {
      const input = document.getElementById("wallpaper-dir-input");
      const r = input.getBoundingClientRect();
      return {
        value: input.value,
        placeholder: input.placeholder,
        width: Math.round(r.width),
        clipped: input.scrollWidth > Math.ceil(r.width),
        statusEl: !!document.getElementById("wallpaper-dir-status"),
        modal: !!document.querySelector(".modal"),
        focused: document.activeElement === input,
      };
    });
    console.log(label, JSON.stringify(s));
    return s;
  };

  const row = page.locator(".wallpaper-dir");
  await row.scrollIntoViewIfNeeded();
  await page.waitForTimeout(150);
  await row.screenshot({ path: "tools/verify-web/out/diag-wallpaper-dir.png" });

  const ui = await page.evaluate(() => ({
    browse: !!document.getElementById("btn-wallpaper-dir-browse"),
    save: !!document.getElementById("btn-wallpaper-dir-save"),
    reset: !!document.getElementById("btn-wallpaper-dir-reset"),
    buttons: [...document.querySelectorAll(".wallpaper-dir button")].map(b => b.textContent.trim()),
  }));
  console.log("按钮行 ", JSON.stringify(ui));

  // --- 系统框：选中即自动存，取消不动，弹不出来不叠框 ---
  await stub({ ok: true, result: "picked", path: NATIVE });
  await page.click("#btn-wallpaper-dir-browse");
  await page.waitForTimeout(800);
  const viaNative = await read("系统框选中 ");

  await stub({ ok: false, result: "cancelled", path: "" });
  await page.click("#btn-wallpaper-dir-browse");
  await page.waitForTimeout(700);
  const viaCancel = await read("系统框取消 ");

  await stub({ ok: false, result: "unavailable", path: "" });
  await page.click("#btn-wallpaper-dir-browse");
  await page.waitForTimeout(700);
  const viaUnavailable = await read("系统框不可用");

  // --- 手填路径：回车即存（无保存按钮的退路） ---
  await page.fill("#wallpaper-dir-input", TYPED.split(path.sep).join("/"));
  await page.press("#wallpaper-dir-input", "Enter");
  await page.waitForTimeout(800);
  const viaTyping = await read("手填回车 ");

  // --- 英文界面 + 窄屏 ---
  await page.evaluate(() => setLang("en"));
  await page.waitForTimeout(250);
  const en = await page.evaluate(() => ({
    label: document.querySelector(".wallpaper-dir-label").textContent.trim(),
    browse: document.getElementById("btn-wallpaper-dir-browse").textContent.trim(),
  }));
  console.log("英文界面 ", JSON.stringify(en));

  await page.setViewportSize({ width: 520, height: 900 });
  await page.waitForTimeout(250);
  const narrow = await page.evaluate(() => {
    const input = document.getElementById("wallpaper-dir-input");
    return {
      width: Math.round(input.getBoundingClientRect().width),
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });
  console.log("窄屏 520  ", JSON.stringify(narrow));

  const checks = {
    "系统框选中即自动保存": viaNative.value.includes("ot-wp-native"),
    "系统框取消界面不动": viaCancel.value === viaNative.value,
    "手填路径回车即存": viaTyping.value.includes("ot-wp-typed"),
    "全路径都是真实绝对路径": isAbs(viaNative.value) && isAbs(viaTyping.value),
    "无 ~ 简写假路径": [viaNative, viaCancel, viaUnavailable, viaTyping]
      .every(r => noShorthand(r.value) && noShorthand(r.placeholder)),
    "占位符示例跟平台一致": IS_WIN
      ? viaNative.placeholder.includes(":") : viaNative.placeholder.startsWith("/"),
    "输入框 ≥3 倍默认宽(≥459px)": viaNative.width >= 459,
    "完整路径不截断": [viaNative, viaTyping].every(r => !r.clipped),
    "有「浏览…」按钮": ui.browse,
    "无「保存」按钮（选完自动存）": !ui.save && !ui.buttons.includes("保存"),
    "无「恢复默认」按钮": !ui.reset && !ui.buttons.includes("恢复默认"),
    "无状态文字": !viaNative.statusEl && !viaTyping.statusEl,
    "选文件夹全程不弹框": !viaNative.modal && !viaCancel.modal &&
      !viaUnavailable.modal && !viaTyping.modal,
    "系统框弹不出来只聚焦输入框": viaUnavailable.focused && !viaUnavailable.modal,
    "英文界面生效": en.label === "Save location" && en.browse === "Browse…",
    "窄屏输入框不塌缩(≥220px)": narrow.width >= 220,
    "窄屏不横向溢出": !narrow.overflowX,
  };

  console.log("\n=== 判据 ===");
  let ok = true;
  for (const [k, v] of Object.entries(checks)) {
    console.log((v ? "PASS" : "FAIL") + "  " + k);
    if (!v) ok = false;
  }
  if (errors.length) { console.log("\n页面错误:", errors.join("\n")); ok = false; }
  console.log(ok ? "\n全部通过" : "\n存在失败");
  await browser.close();
  process.exit(ok ? 0 : 1);
})();
