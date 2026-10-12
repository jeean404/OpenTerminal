// ⚠️ 已过时（2026-10-12 文件面板改造）：本脚本验的是旧契约——via=session/cascade
// 双通道、/adopt 自动对齐、点击文件名即下载。这些概念已全部删除：
//   · 面板改为自带 SSH 直连 + 四栏登录弹框（IP/端口/用户名/密码）；
//   · 单击=选中、双击=进入/打开，下载是独立 ⬇ 按钮；
//   · 记住密码写 keyring，二次打开自动连接。
// 新契约的真机验证请跑 **diag-files-direct.cjs**（21 项，含本脚本 A6/A7/A8
// 三条仍有价值的回归）。本文件保留作历史取证记录，不要直接运行。
// 真机取证：文件面板现状诊断（重构前抓缺陷，重构后同一脚本回归）。
// 全程只走真实 UI（不读 JS 内部状态），竞态用 page.route 注入延迟构造。
// 拓扑：docker ot-repro（ubuntu@127.0.0.1:2222），连接后命令 cd /tmp（远端
// cwd=/tmp），面板应自动显示该目录文件列表。
// 用法: node tools/verify-web/diag-files-panel.cjs [port]
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const { spawn, spawnSync } = require("node:child_process");
const lib = require("./lib");

const PORT = Number(process.argv[2] || 8271);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const HOME = path.join(lib.OUT, "fp-home");
const TARGET = "repro";
const PW = { ubuntu: "ub123456" };

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`\n### [${ok ? "PASS" : "FAIL"}] ${name}`);
  if (detail) console.log("    " + String(detail).split("\n").join("\n    "));
}
function finish() {
  const fails = results.filter(r => !r.ok).length;
  console.log("\n================ 汇总 ================");
  for (const r of results) console.log(`[${r.ok ? "PASS" : "FAIL"}] ${r.name}`);
  console.log(`\n合计 ${results.length - fails}/${results.length} 通过`);
  process.exit(fails ? 1 : 0);
}

function pythonExe() {
  for (const c of [
    path.join(lib.REPO, ".venv-win", "Scripts", "python.exe"),
    path.join(lib.REPO, ".venv", "Scripts", "python.exe"),
  ]) if (fs.existsSync(c)) return c;
  throw new Error("no python found");
}

function dockerExec(cmd) {
  const r = spawnSync("docker", ["exec", "ot-repro", "bash", "-c", cmd],
    { encoding: "utf8" });
  return ((r.stdout || "") + (r.stderr || "")).trim();
}

function prepareHome() {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(path.join(HOME, "Downloads"), { recursive: true });
  fs.writeFileSync(path.join(HOME, "config.toml"), [
    "# diag-files-panel 专用（隔离 OPENTERMINAL_HOME / USERPROFILE）",
    "[model]",
    'provider = "anthropic"',
    'base_url = "http://127.0.0.1:15721"',
    'model = "claude-sonnet-4-6"',
    'api_key_env = "ANTHROPIC_API_KEY"',
    "",
    "[web]",
    'host = "127.0.0.1"',
    `port = ${PORT}`,
    "",
  ].join("\n"), "utf8");
  const r = spawnSync(pythonExe(), [path.join(lib.REPO, "tools", "verify-web",
                                              "fixtures", "seed-saved-conn.py")], {
    cwd: lib.REPO,
    env: {
      ...process.env, OPENTERMINAL_HOME: HOME, PYTHONIOENCODING: "utf-8",
      OT_SEED_NAME: TARGET, OT_SEED_HOST: "127.0.0.1",
      OT_SEED_PORT: "2222", OT_SEED_USER: "ubuntu",
      OT_SEED_COMMANDS: "cd /tmp",
    },
    encoding: "utf8",
  });
  const out = ((r.stdout || "") + (r.stderr || "")).trim();
  if (r.status !== 0 || out.indexOf(TARGET) === -1) {
    throw new Error("seed connections.db 失败: " + out);
  }
}

async function startServer() {
  const base = `http://127.0.0.1:${PORT}`;
  try {
    if ((await fetch(base + "/")).ok) throw new Error("端口 " + PORT + " 已有服务端");
  } catch (e) { if (String(e).includes("已有服务端")) throw e; }
  const logFd = fs.openSync(path.join(lib.OUT, `server-fp-${PORT}.log`), "w");
  const server = spawn(pythonExe(),
    ["-m", "openterminal.app", "web", "--port", String(PORT), "--no-open"], {
      cwd: lib.REPO, stdio: ["ignore", logFd, logFd], env: {
        ...process.env,
        OPENTERMINAL_HOME: HOME,
        USERPROFILE: HOME,
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "fp-key",
        PYTHON_KEYRING_BACKEND: "keyring.backends.null.Keyring",
        PYTHONIOENCODING: "utf-8",
        OT_WEB_DEBUG: "1",
      },
    });
  const t0 = Date.now();
  while (Date.now() - t0 < 40000) {
    try { if ((await fetch(base + "/")).ok) return { base, server }; } catch (e) {}
    if (server.exitCode != null) throw new Error("服务端提前退出 code=" + server.exitCode);
    await sleep(400);
  }
  throw new Error("服务端 40s 未就绪");
}

// 会话代答：只认模态标题，不按终端行尾正则猜
let pwPending = false;
function hookWs(page) {
  page.on("websocket", ws => {
    ws.on("framereceived", f => {
      try {
        const m = JSON.parse(String(f.payload));
        if (m && m.type === "ask_password") pwPending = true;
        if (m && (m.type === "ready" || m.type === "closed")) pwPending = false;
      } catch (e) { /* 非 JSON 帧 */ }
    });
  });
}

async function pwTick(page) {
  return page.evaluate((rules) => {
    const root = document.querySelector("#modal-root");
    const modal = root && root.querySelector(".modal");
    if (!modal) return null;
    const title = ((modal.querySelector("h3") || {}).innerText || "").trim();
    const body = (modal.innerText || "").replace(/\s+/g, " ");
    const btn = re => Array.from(root.querySelectorAll(".modal-btns button"))
      .find(b => re.test(b.innerText || ""));
    if (/记住/.test(title) && /密码/.test(title)) {
      const b = btn(/不记住|不记|拒绝|取消/);
      if (b) { b.click(); return "remember:no"; }
      return null;
    }
    if (/主机密钥|host key/i.test(title)) {
      const b = btn(/信任|确定/);
      if (b) { b.click(); return "hostkey:trust"; }
      return null;
    }
    if (/密码|令牌|password|token/i.test(title)) {
      const v = document.getElementById("modal-value");
      let pw = rules.ubuntu;
      for (const u of Object.keys(rules)) if (body.indexOf(u) !== -1) { pw = rules[u]; break; }
      if (v) v.value = pw;
      const b = btn(/确定/);
      if (b) { b.click(); return "pw:" + pw; }
    }
    return null;
  }, PW);
}

async function clickTerm(page, tries = 6) {
  for (let i = 0; i < tries; i++) {
    try {
      await page.locator(".pane.active .term").click({ timeout: 3000, force: true });
      await sleep(120);
      return true;
    } catch (e) {}
    await sleep(300);
  }
  return false;
}

async function pwTermTick(page) {
  if (!pwPending) return null;
  await sleep(600);
  if (!(await clickTerm(page))) return null;
  await page.keyboard.type(PW.ubuntu, { delay: 15 });
  await page.keyboard.press("Enter");
  pwPending = false;
  return "termpw";
}

// 面板状态快照（只读 DOM）
// 面包屑渲染成 "/ / home / ubuntu"（分隔符两侧有空格），断言前压掉空白
const chr10 = String.fromCharCode(10);
const normPath = t => String(t || "").replace(/\s+/g, "").replace(/跟随中$/, "").replace(/\/{2,}/g, "/");

async function activeTabId(page) {
  return page.evaluate(() => {
    const p = document.querySelector(".pane.active");
    return p ? p.id.replace(/^pane-/, "") : "";
  });
}

function getPanel(page, scope) {
  return page.evaluate((sc) => {
    const root = sc === "active" ? (document.querySelector(".pane.active") || document)
                                 : document;
    const el = root.querySelector(".files-panel") ||
               document.querySelector(".files-panel");
    if (!el) return null;
    return {
      hidden: el.hidden,
      badge: (el.querySelector(".fp-badge") || {}).textContent || "",
      title: (el.querySelector(".fp-title") || {}).textContent || "",
      path: (el.querySelector(".fp-path") || {}).innerText || "",
      pathClickable: el.querySelectorAll(".fp-path a").length,
      empty: (el.querySelector(".fp-empty") || {}).textContent || "",
      rows: Array.from(el.querySelectorAll(".fp-row")).map(r => ({
        name: (r.querySelector(".fp-name") || {}).textContent || "",
        isDir: r.classList.contains("dir"),
        meta: (r.querySelector(".fp-meta") || {}).textContent || "",
      })),
      buttons: Array.from(el.querySelectorAll(".fp-btn, .fp-up"))
        .map(b => (b.textContent || "").trim()),
    };
  }, scope || "any");
}

async function openFilesButton(page) {
  const pane = page.locator(".pane.active");
  await pane.locator(".files-toggle").first().click();
}

async function enterDir(page, name) {
  await page.waitForSelector('.pane.active .fp-row .fp-name', { timeout: 8000 });
  await clickRow(page, name);
  for (let i = 0; i < 20; i++) {
    await sleep(200);
    const p = normPath((await getPanel(page)).path);
    if (p.endsWith('/' + name)) return p;
  }
  return normPath((await getPanel(page)).path);
}

async function clickRow(page, name) {
  const row = page.locator(".pane.active .fp-row .fp-name", { hasText: name }).first();
  await row.click();
}

async function promptFill(page, text, confirmRe) {
  await page.evaluate(({ text, re }) => {
    const root = document.querySelector("#modal-root");
    const v = root.querySelector("input, textarea");
    if (v) {
      const proto = Object.getOwnPropertyDescriptor(
        v.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
        "value");
      proto.set.call(v, text);
      v.dispatchEvent(new Event("input", { bubbles: true }));
    }
    const btn = Array.from(root.querySelectorAll(".modal-btns button"))
      .find(b => new RegExp(re).test(b.innerText || ""));
    if (btn) btn.click();
  }, { text, re: confirmRe || "确定" });
}

async function main() {
  prepareHome();
  // docker exec 以 root 落盘，ubuntu 要能写：目录/文件一并放开
  dockerExec("mkdir -p /tmp/fp_a /tmp/fp_b && echo hello >/tmp/fp_a/x.txt " +
             "&& echo keep >/tmp/existing.txt && rm -f /tmp/PWNED.txt /PWNED.txt " +
             "&& chown -R ubuntu:ubuntu /tmp/fp_a /tmp/fp_b /tmp/existing.txt");
  const { base, server } = await startServer();
  const browser = await lib.launch();
  const { page, errors } = await lib.openTab(browser, base);
  hookWs(page);

  // ---- 1. 登录（选目标 + 代答密码）----
  const t0 = Date.now();
  await lib.pickTarget(page, TARGET);
  let readyAt = 0;
  for (let i = 0; i < 120; i++) {
    await pwTick(page); await pwTermTick(page);
    const st = await page.evaluate(() => {
      const c = document.querySelector('[id^="conn-"]');
      return c ? { hidden: c.hidden } : null;
    });
    if (st && st.hidden) { readyAt = Date.now() - t0; break; }
    await sleep(300);
  }
  record("A1 连接就绪", readyAt > 0, `就绪耗时 ${readyAt}ms`);

  // 连接后命令 cd /tmp 落地才是「终端当前目录」；抢跑只会测到登录 home
  const stateUrl = async () => page.evaluate(async (id) => {
    const t = sessionStorage.getItem("ot-token") || "";
    const r = await fetch(`/api/tabs/${id}/files/state`,
      { headers: t ? { "x-ot-token": t } : {} });
    return r.json();
  }, await activeTabId(page));
  let landed = "";
  for (let i = 0; i < 60; i++) {
    const st0 = await stateUrl().catch(() => null);
    landed = (st0 && st0.path) || "";
    if (landed === ".") break;
    await sleep(300);
  }
  record("A1b state 就绪且路径是家目录",
    landed === ".",
    `state.path=${landed}`);

  // ---- 2. 点📁 文件：是否自动出列表 ----
  const clickAt = Date.now();
  await openFilesButton(page);
  let st = null, appearMs = 0;
  for (let i = 0; i < 40; i++) {
    await sleep(150);
    st = await getPanel(page);
    if (st && st.rows.length) { appearMs = Date.now() - clickAt; break; }
    if (st && st.empty && !/加载中/.test(st.empty)) { appearMs = Date.now() - clickAt; break; }
  }
  record("A2 点击后自动出文件列表", !!(st && st.rows.length),
    `耗时 ${appearMs}ms\n${JSON.stringify(st, null, 2)}`);

  // ---- 3. 路径是否跟随终端 cwd（远端 cwd=/tmp）----
  // 契约变了：面板与终端独立，落**登录用户家目录**，不跟终端 cwd
  record("A3 默认落登录用户家目录（不跟终端 cwd）",
    !!(st && normPath(st.path) === "/home/ubuntu"),
    `面包屑=${st && st.path} 归一=${normPath(st && st.path)}`);

  // ---- 4. 面板按钮集合 ----
  record("A4 面板按钮", true, JSON.stringify(st && st.buttons));

  // ---- 5. 终端里 cd 之后，面板是否跟随 ----
  await clickTerm(page);
  await page.keyboard.type("cd /var/log", { delay: 15 });
  await page.keyboard.press("Enter");
  let after = "";
  for (let i = 0; i < 40; i++) {
    const st1 = await stateUrl().catch(() => null);
    after = (st1 && st1.path) || "";
    if (after === ".") break;
    await sleep(300);
  }
  // 终端 cwd 不再进 state：面板与终端是两套独立机制
  await sleep(1200);           // 让「跟随中」的沉降刷新跑完
  const afterCd = await getPanel(page);
  record("A5 终端 cd 后面板不动（两套独立机制）",
    !!(afterCd && normPath(afterCd.path) === "/home/ubuntu"),
    `面板路径=${afterCd && afterCd.path} 归一=${normPath(afterCd && afterCd.path)}`);

  // ---- 6. 竞态：慢响应的旧请求是否覆盖新列表 ----
  let slowLeft = 2;
  await page.route("**/api/tabs/*/files/list*", async (route) => {
    const u = route.request().url();
    if (slowLeft > 0 && /fp_a/.test(u)) {           // 第一次进 fp_a 让它慢
      slowLeft--;
      await sleep(1500);
    }
    await route.continue();
  });
  // A6：慢的 fp_a 响应落地后，面板不得被拖回 fp_a
  await enterDir(page, "fp_a").catch(() => {});   // 慢请求
  await sleep(150);
  await page.unroute("**/api/tabs/*/files/list*");
  await page.locator(".pane.active .fp-path a").first().click().catch(() => {});
  await sleep(2200);                              // 让慢响应落地
  const raceSt = await getPanel(page);
  record("A6 竞态：慢的旧响应不覆盖新列表",
    !!(raceSt && !/fp_a/.test(normPath(raceSt.path))),
    "最终路径=" + raceSt.path + " 行=" +
    JSON.stringify((raceSt.rows || []).map(r => r.name)));

  // ---- 7. ＋文件 对已有文件名：是否会清空原有内容 ----
  await enterDir(page, "tmp");
  await page.locator('.pane.active .fp-btn[data-act="create"]').click();
  await promptFill(page, "existing.txt");
  await sleep(1500);
  const afterCreate = dockerExec("cat /tmp/existing.txt");
  record("A7 新建同名文件不破坏已有内容", afterCreate === "keep",
    "远端内容=" + JSON.stringify(afterCreate));

  // ---- 8. 上传文件名路径穿越 ----
  // A5 把面板带到了 /var/log（跟随生效），先回根再进 /tmp/fp_a：
  // 穿越名 ../../tmp/PWNED.txt 不消毒会落到 /tmp/PWNED.txt，
  // 消毒后只能落在面板自己的目录 /tmp/fp_a 下
  await page.locator(".pane.active .fp-path a").first().click().catch(() => {});
  await sleep(500);
  await enterDir(page, "tmp");
  const inA = await enterDir(page, "fp_a");
  await page.evaluate(() => {
    const el = document.querySelector(".pane.active .files-panel");
    const f = new File(["x"], "../../tmp/PWNED.txt", { type: "text/plain" });
    const dt = new DataTransfer();
    dt.items.add(f);
    el.querySelector(".fp-input").files = dt.files;
    el.querySelector(".fp-input").dispatchEvent(new Event("change", { bubbles: true }));
  });
  await sleep(1800);
  const toast = await page.evaluate(() => {
    const t = document.querySelector(".pane.active .fp-toast")
           || document.querySelector(".fp-toast");
    return t ? (t.textContent || "") : "(no toast)";
  });
  console.log("    [A8 toast]", JSON.stringify(toast));
  const escaped = dockerExec(
    "ls -la /PWNED.txt /etc/PWNED.txt /tmp/PWNED.txt 2>&1 | head -6");
  const legit = dockerExec("ls -la /tmp/fp_a/PWNED.txt 2>&1 | head -2");
  // ls 的报错文案里本来就带 PWNED：判「没有任何真实条目」而不是「没出现这个词」
  const escapedOk = escaped.split(chr10).every(l =>
    !l.trim() || /No such file/.test(l));
  record("A8 上传文件名不能路径穿越",
    escapedOk && /^-/.test(legit.trim()),
    "目标目录=" + inA + "\n越界检查（应全 No such file）:\n" + escaped +
    "\n目标目录内（应有）:\n" + legit);

  // ---- 9. 连接尚未就绪时点📁文件（登录后立刻点）----
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll("#targets .target"))
      .find(x => /repro/.test(x.innerText));
    if (b) b.click();
  });
  await sleep(250);                       // 只等 250ms：连接多半还没就绪
  const btnCount = await page.locator(".pane.active .files-toggle").count();
  let earlyPanel = "n/a";
  if (btnCount) {
    await page.locator(".pane.active .files-toggle").click();
    await sleep(6000);       // 留足自动重试窗口：未就绪→就绪应自动列目录
    earlyPanel = JSON.stringify(await getPanel(page, "active"));
  }
  record("A9 连接未就绪时点文件按钮", true,
    "按钮数=" + btnCount + "\n点下即时状态=" + earlyPanel);

  // 关键诉求：未就绪时点了文件，连上后**无需任何操作**自动出列表
  for (let i = 0; i < 50; i++) {
    await pwTick(page); await pwTermTick(page);
    const s2 = await getPanel(page, "active");
    if (s2 && s2.rows.length) {
      record("A9b 连上后自动出列表（无需再点）", true,
        "路径=" + normPath(s2.path) + " 条目=" + s2.rows.length);
      break;
    }
    if (i === 49) {
      record("A9b 连上后自动出列表（无需再点）", false,
        JSON.stringify(await getPanel(page, "active")));
    }
    await sleep(300);
  }

  // ---- 10. 本机终端 tab 点📁 文件 ----
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll("#targets .target"))
      .find(x => /local/.test(x.innerText));
    if (b) b.click();
  });
  await sleep(1800);
  let localPanel = "n/a";
  try {
    await page.locator(".pane.active .files-toggle").click({ timeout: 4000 });
    await sleep(1500);
    localPanel = JSON.stringify(await getPanel(page, "active"));
  } catch (e) { localPanel = "点不到按钮/面板: " + e.message; }
  record("A10 本机终端点文件面板的体验", true, localPanel);

  // ---- 11. 控制台报错 ----
  // probeSupport 会主动探一次 /state 判会话类型，本机终端必回 409——
  // 浏览器把非 2xx 打成 "Failed to load resource"，属预期噪音不是 JS 报错
  const real = errors.filter(e => !/Failed to load resource/i.test(e));
  record("A11 页面无 JS 报错", real.length === 0, real.join("\n").slice(0, 1200));

  console.log("\n== 服务端日志尾部 ==");
  try {
    const log = fs.readFileSync(path.join(lib.OUT, `server-fp-${PORT}.log`), "utf8");
    console.log(log.split("\n").slice(-30).join("\n"));
  } catch (e) {}

  await browser.close();
  if (server) server.kill();
  finish();
}

main().catch(e => { console.error(e); process.exit(1); });
