// 真机浏览器验证：设置页三块新模块（通用 / 技能 / 工具）。
// 用法：node tools/verify-web/verify-settings-modules.cjs [port]
//
// 覆盖点：
//   通用 —— 控件齐全、改完立刻写进 window.__otTermOptions 并下发
//   技能 —— 卡片/悬浮/启停/右上角删除/详情页与返回/上传 .md/内置不可删
//   工具 —— 增删改、启停、连接测试拉真 MCP 服务器的 tools 列表
// 截图与逐步日志落 .tmp/live/；无论成败都回收浏览器与服务端后退出，
// 免得事件循环被吊住（上次就是这么挂住的）。
"use strict";
const lib = require("./lib");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const sleep = ms => new Promise(r => setTimeout(r, ms));
const PORT = Number(process.argv[2] || 8433);
const HOME = path.join(lib.REPO, ".tmp", "settings-verify-home");
const FIX = path.join(lib.REPO, "tools", "verify-web", "fixtures");
const PY = path.join(lib.REPO, ".venv-win", "Scripts", "python.exe");
const LOG = path.join(lib.OUT, "settings-verify.log");

const results = [];
function log(line) {
  // 同步落盘：node 往管道写会被缓冲，卡住时看不到进度
  try { fs.appendFileSync(LOG, line + "\n", "utf8"); } catch (e) { /* ignore */ }
  console.log(line);
}
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  → " + detail : ""}`);
}
const step = name => log("… " + name);

let browser = null;
let serverRef = null;
function cleanup() {
  try { if (browser) browser.close(); } catch (e) { /* ignore */ }
  try { if (serverRef) serverRef.kill(); } catch (e) { /* ignore */ }
}

(async () => {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  fs.mkdirSync(lib.OUT, { recursive: true });
  fs.writeFileSync(LOG, "", "utf8");

  const started = await lib.startServer(PORT, { env: { OPENTERMINAL_HOME: HOME } });
  serverRef = started.server;
  const base = started.base;
  log("服务端: " + base + (serverRef ? "（本次启动）" : "（复用已有）"));

  for (const opts of [{ channel: "chrome" }, { channel: "msedge" }, {}]) {
    try {
      browser = await chromium.launch({
        headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"], ...opts,
      });
      log("浏览器: " + (opts.channel || "bundled chromium"));
      break;
    } catch (e) { /* 换下一个 */ }
  }
  if (!browser) throw new Error("无法启动浏览器");

  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const problems = [];
  page.on("pageerror", e => problems.push("pageerror: " + e.message));
  // 控制台的资源错误不带 URL，只有「Failed to load resource…」；改从响应侧
  // 取真实 URL，才能把 favicon 这类无关 404 过滤掉
  page.on("response", r => {
    if (r.status() >= 400 && !/favicon/i.test(r.url()))
      problems.push(`http ${r.status()} ${r.url()}`);
  });
  page.on("console", m => {
    const t = m.text();
    if (m.type() === "error" && !/favicon|Failed to load resource/i.test(t))
      problems.push("console: " + t);
  });

  step("打开页面并进设置");
  await page.goto(base + "/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#btn-settings", { timeout: 20000 });
  await page.click("#btn-settings");
  await page.waitForFunction(() => {
    const v = document.getElementById("settings-view");
    return v && !v.hidden;
  });

  // ---------- 完整性：关键全局必须都在 ----------
  // 文件被写坏（截断/语法错）时脚本仍能加载，只有点按钮才暴露；先在入口钉一次
  step("检查关键全局");
  const globals = await page.evaluate(() => ({
    showSettings: typeof showSettings,
    loadSkills: typeof loadSkills,
    loadTools: typeof loadTools,
    openSkillDetail: typeof openSkillDetail,
    openMcpForm: typeof openMcpForm,
    showModelProfiles: typeof showModelProfiles,
    clearGeneralPrefs: typeof clearGeneralPrefs,
    applyStaticI18n: typeof applyStaticI18n,
    t: typeof t,
  }));
  const dead = Object.entries(globals).filter(([, v]) => v !== "function").map(([k]) => k);
  check("各模块关键全局都已定义", dead.length === 0,
    dead.length ? "缺失: " + dead.join(",") : "9 个都在");

  // ---------- 导航 ----------
  step("检查导航分类");
  const nav = await page.$$eval("[data-settings-section]",
    els => els.map(e => e.dataset.settingsSection));
  check("设置导航含 通用/外观/技能/工具/模型",
    ["general", "appearance", "skills", "tools", "models"].every(n => nav.includes(n)),
    nav.join(","));

  // ---------- 通用 ----------
  step("通用页");
  await page.click('[data-settings-section="general"]');
  await sleep(250);
  const generalIds = await page.$$eval('[data-settings-panel="general"] [id]',
    els => els.map(e => e.id));
  const needGeneral = ["general-font-size",
    "general-scrollback", "general-cursor", "general-cursor-blink",
    "general-copy-on-select", "general-debug", "btn-general-reset"];
  const scaleBtns = await page.$$eval("[data-general-scale]", els => els.length);
  const langBtns = await page.$$eval("[data-general-lang]", els => els.length);
  const missing = needGeneral.filter(id => !generalIds.includes(id));
  check("通用页控件齐全",
    missing.length === 0 && scaleBtns === 3 && langBtns === 2,
    (missing.join(",") || "全在") + " 字号档位=" + scaleBtns + " 语言档位=" + langBtns);

  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("#btn-settings", { state: "visible", timeout: 20000 });
  await page.click("#btn-settings");
  await page.waitForFunction(() => {
    const v = document.getElementById("settings-view");
    return v && !v.hidden;
  }, { timeout: 20000 });
  await page.click('[data-settings-section="general"]');
  await sleep(250);

  step("改终端字号");
  await page.evaluate(() => {
    const el = document.getElementById("general-font-size");
    el.value = "17";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await sleep(200);
  const fontState = await page.evaluate(() => ({
    store: localStorage.getItem("ot-term-font-size"),
    live: window.__otTermOptions && window.__otTermOptions.fontSize,
    out: (document.getElementById("general-font-size-value") || {}).textContent,
  }));
  check("终端字号改动落库并下发",
    fontState.store === "17" && fontState.live === 17 && fontState.out === "17",
    JSON.stringify(fontState));

  await page.click('[data-general-scale="1.15"]');
  await sleep(200);
  const scale = await page.evaluate(() => ({
    store: localStorage.getItem("ot-ui-scale"),
    root: document.documentElement.style.fontSize,
  }));
  check("界面字号立刻生效",
    scale.store === "1.15" && scale.root === "115%", JSON.stringify(scale));

  step("切换界面语言");
  await page.click('[data-general-lang="en"]');
  await page.waitForFunction(() => document.documentElement.lang === "en", { timeout: 20000 });
  // 切语言是整页刷新：得重新进设置页才能读到面板内容
  await page.waitForSelector("#btn-settings", { state: "visible", timeout: 20000 });
  await page.click("#btn-settings");
  await page.waitForFunction(() => {
    const v = document.getElementById("settings-view");
    return v && !v.hidden;
  }, { timeout: 20000 });
  await page.click('[data-settings-section="general"]');
  await sleep(500);
  const en = await page.evaluate(() => ({
    lang: document.documentElement.lang,
    stored: localStorage.getItem("ot-lang"),
    nav: [...document.querySelectorAll("[data-settings-section]")].map(e => e.textContent.trim()),
    h2: (document.querySelector('[data-settings-panel="general"] h2') || {}).textContent,
    row: (document.querySelector(".settings-row-text strong") || {}).textContent,
  }));
  check("切到英文后全站文案换掉",
    en.stored === "en" && en.nav.includes("General") && en.nav.includes("Skills")
      && en.h2 === "General" && en.row === "Interface language", JSON.stringify(en));
  await page.screenshot({ path: path.join(lib.OUT, "settings-general-en.png") });

  step("切回中文");
  await page.click('[data-general-lang="zh"]');
  await page.waitForFunction(() => document.documentElement.lang === "zh-CN", { timeout: 20000 });
  await page.waitForSelector("#btn-settings", { timeout: 20000 });
  await page.click("#btn-settings");
  await page.click('[data-settings-section="general"]');
  await sleep(400);
  const zh = await page.evaluate(() => ({
    stored: localStorage.getItem("ot-lang"),
    nav: [...document.querySelectorAll("[data-settings-section]")].map(e => e.textContent.trim()),
    h2: (document.querySelector('[data-settings-panel="general"] h2') || {}).textContent,
  }));
  check("切回中文后文案还原",
    zh.stored === "zh" && zh.nav.includes("通用") && zh.h2 === "通用", JSON.stringify(zh));
  await page.screenshot({ path: path.join(lib.OUT, "settings-general.png") });

  // ---------- 技能 ----------
  step("技能页");
  await page.click('[data-settings-section="skills"]');
  await page.waitForSelector(".skill-card", { timeout: 20000 });
  await sleep(400);
  await page.screenshot({ path: path.join(lib.OUT, "settings-skills.png") });

  const cardInfo = await page.evaluate(() => {
    const builtin = document.querySelector('.skill-card[data-skill="markdown-tables"]');
    return {
      count: document.querySelectorAll(".skill-card").length,
      builtinMark: builtin ? builtin.textContent.includes("内置技能") : null,
      builtinDelete: builtin ? !!builtin.querySelector('[data-skill-action="delete"]') : null,
      builtinToggle: builtin ? !!builtin.querySelector('[data-skill-action="toggle"]') : null,
    };
  });
  check("内置技能卡片出现", cardInfo.count >= 1, "卡片数=" + cardInfo.count);
  check("内置技能标为「内置」", cardInfo.builtinMark === true);
  check("内置技能没有删除按钮", cardInfo.builtinDelete === false);
  check("内置技能仍有启停开关", cardInfo.builtinToggle === true);

  step("卡片悬浮效果");
  const before = await page.$eval(".skill-card", el => getComputedStyle(el).transform);
  await page.hover('.skill-card[data-skill="markdown-tables"]');
  await sleep(400);
  const after = await page.$eval('.skill-card[data-skill="markdown-tables"]',
    el => getComputedStyle(el).transform);
  check("卡片悬浮有抬起效果", before !== after && after !== "none",
    `before=${before} after=${after}`);

  step("启停开关");
  await page.click(
    '.skill-card[data-skill="markdown-tables"] [data-skill-action="toggle"] + .switch-track');
  await sleep(700);
  const toggleResp = await page.evaluate(() => {
    const box = document.querySelector(
      '.skill-card[data-skill="markdown-tables"] [data-skill-action="toggle"]');
    const card = document.querySelector('.skill-card[data-skill="markdown-tables"]');
    return { off: card.classList.contains("skill-card-off"), checked: box.checked };
  });
  check("停用开关可切换",
    toggleResp.off === true && toggleResp.checked === false, JSON.stringify(toggleResp));
  // 点开关绝不能连带进详情页（开关点击曾冒泡到整张卡片）
  const stayed = await page.evaluate(() =>
    document.getElementById("skills-detail").hidden);
  check("点开关不会误进详情页", stayed === true, "detail.hidden=" + stayed);
  const disabledList = await page.evaluate(async () => {
    const r = await authFetch("/api/skills");
    const d = await r.json();
    return d.skills.filter(s => !s.enabled).map(s => s.name);
  });
  check("停用状态写进后端", disabledList.includes("markdown-tables"),
    "disabled=" + disabledList.join(","));
  await page.evaluate(async () => {
    await authFetch("/api/skills/markdown-tables/enabled", {
      method: "POST", body: JSON.stringify({ enabled: true }),
    });
  });

  step("技能详情页");
  await page.click('.skill-card[data-skill="markdown-tables"]');
  await page.waitForSelector("#skills-detail .skill-detail-body", { timeout: 20000 });
  await sleep(400);
  await page.screenshot({ path: path.join(lib.OUT, "settings-skill-detail.png") });
  const detail = await page.evaluate(() => ({
    bodyLen: (document.querySelector(".skill-detail-body") || {}).innerHTML.length,
    hasPath: !!document.querySelector(".skill-detail-meta code"),
    gridHidden: document.getElementById("skills-list").hidden,
    backShown: !document.getElementById("btn-skill-back").hidden,
  }));
  check("详情页渲染技能说明", detail.bodyLen > 200, "正文 HTML " + detail.bodyLen + " 字符");
  check("详情页给出模型读取路径", detail.hasPath === true);
  check("详情页替换卡片页且露出返回", detail.gridHidden && detail.backShown,
    JSON.stringify(detail));

  step("返回卡片页");
  await page.click("#btn-skill-back");
  await sleep(500);
  const backed = await page.evaluate(() => ({
    gridHidden: document.getElementById("skills-list").hidden,
    detailHidden: document.getElementById("skills-detail").hidden,
    cards: document.querySelectorAll(".skill-card").length,
  }));
  check("返回按钮回到卡片页",
    !backed.gridHidden && backed.detailHidden && backed.cards >= 1, JSON.stringify(backed));

  step("上传 .md 新增技能");
  const mdPath = path.join(lib.OUT, "uploaded-skill.md");
  fs.writeFileSync(mdPath,
    "---\nname: uploaded-demo\ndescription: 用上传方式装进来的演示技能\n---\n\n# 上传技能\n\n这是正文。\n",
    "utf8");
  await page.click("#btn-add-skill");
  // 文件输入框带 hidden：waitForSelector 默认等「可见」，得改成等「在 DOM 里」
  await page.waitForSelector("#skill-file-input", { state: "attached", timeout: 10000 });
  await page.setInputFiles("#skill-file-input", mdPath);
  await sleep(300);
  await page.click(".modal-btns button");
  await sleep(1000);
  const afterUpload = await page.evaluate(() => ({
    cards: document.querySelectorAll(".skill-card").length,
    hasNew: !!document.querySelector('.skill-card[data-skill="uploaded-demo"]'),
  }));
  check("上传 .md 后技能入库", afterUpload.hasNew, JSON.stringify(afterUpload));
  await page.screenshot({ path: path.join(lib.OUT, "settings-skill-added.png") });

  step("删除用户技能");
  const canDelete = await page.evaluate(() => {
    const card = document.querySelector('.skill-card[data-skill="uploaded-demo"]');
    return card ? !!card.querySelector('[data-skill-action="delete"]') : false;
  });
  check("用户技能卡片右上角有删除按钮", canDelete === true);
  if (canDelete) {
    await page.hover('.skill-card[data-skill="uploaded-demo"]');
    await sleep(300);
    await page.click('.skill-card[data-skill="uploaded-demo"] [data-skill-action="delete"]');
    await page.waitForSelector(".modal-btns button", { timeout: 10000 });
    await sleep(300);
    await page.click(".modal-btns button");   // 「删除」是主按钮，排第一位
    await sleep(1000);
    const gone = await page.evaluate(() =>
      !document.querySelector('.skill-card[data-skill="uploaded-demo"]'));
    check("删除后卡片消失", gone === true);
  }

  // ---------- 工具（MCP） ----------
  step("工具页");
  await page.click('[data-settings-section="tools"]');
  await page.waitForSelector("#tools-list", { timeout: 10000 });
  await sleep(400);
  await page.screenshot({ path: path.join(lib.OUT, "settings-tools-empty.png") });
  const emptyShown = await page.evaluate(() =>
    (document.getElementById("tools-list") || {}).textContent.includes("还没有 MCP"));
  check("工具页空状态文案", emptyShown === true);

  step("添加 MCP 服务器");
  await page.click("#btn-add-mcp");
  await page.waitForSelector("#mcp-name", { timeout: 10000 });
  await page.fill("#mcp-name", "验证工具集");
  await page.selectOption("#mcp-transport", "stdio");
  await page.fill("#mcp-command", PY);
  await page.fill("#mcp-args", path.join(FIX, "mcp_demo_server.py"));
  await page.fill("#mcp-env", "MY_FLAG=1");
  await page.click(".modal-btns button");
  await sleep(1000);
  const serverCard = await page.evaluate(() => {
    const card = document.querySelector(".mcp-card");
    return card ? {
      name: card.querySelector(".skill-card-title strong").textContent,
      endpoint: card.querySelector(".mcp-endpoint code").textContent,
      hasProbe: !!card.querySelector('[data-mcp-action="probe"]'),
      hasEdit: !!card.querySelector('[data-mcp-action="edit"]'),
      hasToggle: !!card.querySelector('[data-mcp-action="toggle"]'),
      hasDelete: !!card.querySelector('[data-mcp-action="delete"]'),
    } : null;
  });
  check("MCP 服务器卡片渲染", !!serverCard, JSON.stringify(serverCard));
  check("卡片带连接测试/编辑/启停/删除", !!serverCard
    && ["hasProbe", "hasEdit", "hasToggle", "hasDelete"].every(k => serverCard[k]), "");
  await page.screenshot({ path: path.join(lib.OUT, "settings-tools-card.png") });

  step("连接测试（真 MCP）");
  await page.click('[data-mcp-action="probe"]');
  // 等「连接中」文案被真结果替换：框一打开就非空，只判非空会立刻放行
  await page.waitForFunction(() => {
    const box = document.querySelector("[data-mcp-tools]");
    return box && !box.hidden && !/正在连接/.test(box.textContent);
  }, { timeout: 60000 });
  await sleep(400);
  const probe = await page.evaluate(() =>
    document.querySelector("[data-mcp-tools]").textContent.replace(/\s+/g, " ").trim());
  check("连接测试列出工具", /add/.test(probe) && /shout/.test(probe), probe.slice(0, 160));
  check("工具名已过 API 正则（点被清掉）",
    /search_web/.test(probe) && !/search\.web/.test(probe), probe.slice(0, 200));
  await page.screenshot({ path: path.join(lib.OUT, "settings-tools-probe.png") });

  step("MCP 启停");
  await page.click('.mcp-card [data-mcp-action="toggle"] + .switch-track');
  await sleep(800);
  const toggled = await page.evaluate(async () => {
    const r = await authFetch("/api/mcp-servers");
    const d = await r.json();
    return d.servers.map(s => ({ name: s.name, enabled: s.enabled }));
  });
  check("MCP 启停写进后端",
    toggled.length === 1 && toggled[0].enabled === false, JSON.stringify(toggled));

  step("删除 MCP 服务器");
  await page.hover(".mcp-card");
  await sleep(300);
  await page.click('[data-mcp-action="delete"]');
  await page.waitForSelector(".modal-btns button", { timeout: 10000 });
  await sleep(300);
  await page.click(".modal-btns button");
  await sleep(900);
  const deleted = await page.evaluate(() => !document.querySelector(".mcp-card"));
  check("删除 MCP 服务器后卡片消失", deleted === true);

  check("无控制台报错", problems.length === 0, problems.slice(0, 5).join(" | "));
  await page.screenshot({ path: path.join(lib.OUT, "settings-final.png") });

  const failed = results.filter(r => !r.ok);
  log(`\n合计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
  if (failed.length) {
    log("失败项：");
    failed.forEach(f => log(`  - ${f.name}: ${f.detail}`));
  }
  cleanup();
  process.exit(failed.length ? 1 : 0);
})().catch(e => {
  console.error("验证脚本异常:", (e && e.stack) || e);
  try { fs.appendFileSync(LOG, "异常: " + ((e && e.stack) || e) + "\n", "utf8"); } catch (_) {}
  cleanup();
  process.exit(1);
});
