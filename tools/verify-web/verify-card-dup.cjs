// 真机浏览器验证：docs/card_duplicate.md §5 验收 1-5（并行工具卡重复挂载修复）。
// 拓扑：docker ot-repro（ubuntu@127.0.0.1:2222，bash，pad 几何正常）+
// 脚本化模型（serve_scripted_model.py，模型边界可复现；core/HITL/WS/卡片层/
// PTY 全真实）；--real 走 15721 网关真模型。
//   S1 并行 2 execute → 恰 2 张工具卡 + 2 张审批卡（逐个确认）→ 放行 →
//      输出后不长新卡 → 原卡原位徽标 → 总结后卡都还在（带徽标）
//   S2 单工具 → 1 张工具卡、徽标原位
//   S3 edit 决策 → 不长新卡；编辑后命令执行、原命令不执行；徽标在原卡
//   S4 --real 真模型一轮：通用不变量（无重复宣告、徽标配对、计数稳）
// 事件级断言（WS 录帧）：每轮 ai_tool start/end 条数与 id 配对、final 一条——
// 重复宣告（bug）在 start×4 处直接现形。全程不变量：工具卡参数两两互异。
// 用法: node tools/verify-web/verify-card-dup.cjs [port] [--real]
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const { spawn, spawnSync } = require("node:child_process");
const lib = require("./lib");

const PORT = Number(process.argv[2] || 8251);
const REAL = process.argv.includes("--real");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const HOME = path.join(lib.OUT, REAL ? "carddup-home-real" : "carddup-home");
const TARGET = "repro";
const SSH_PORT = 2222;
const PW = { ubuntu: "ub123456" };
const MARKERS = ["ot-cc-aa.txt", "ot-cc-bb.txt", "ot-cc-single.txt",
                 "ot-cc-orig.txt", "ot-cc-edited.txt"];
const FINAL_TEXT = {
  并行: "并行写入完成",
  单个: "单个写入完成",
  编辑: "按编辑后的命令写入完成",
};
const REAL_PROMPT = "请并行调用两个 execute 工具建两个标记文件：" +
  "一条执行 echo aa | tee /tmp/ot-cc-aa.txt，" +
  "另一条执行 echo bb | tee /tmp/ot-cc-bb.txt，" +
  "务必在同一轮并行发出，不要合并成一条命令";

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`\n### [${ok ? "PASS" : "FAIL"}] ${name}`);
  if (detail) console.log("    " + String(detail).split("\n").join("\n    "));
}
function finish(logPath) {
  const fails = results.filter(r => !r.ok).length;
  console.log("\n================ 汇总 ================");
  for (const r of results) console.log(`[${r.ok ? "PASS" : "FAIL"}] ${r.name}`);
  console.log(`\n合计 ${results.length - fails}/${results.length} 通过`);
  if (logPath) console.log("服务端日志: " + logPath);
  process.exit(fails ? 1 : 0);
}

function dockerExec(cmd) {
  const r = spawnSync("docker", ["exec", "ot-repro", "bash", "-c", cmd],
    { encoding: "utf8" });
  return ((r.stdout || "") + (r.stderr || "")).trim();
}
function markerExists(f) {
  return dockerExec(`test -f /tmp/${f} && echo 1 || echo 0`) === "1";
}
function markerCleanup() {
  dockerExec("rm -f " + MARKERS.map(f => "/tmp/" + f).join(" "));
}

function prepareHome() {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(path.join(HOME, "config.toml"), [
    "# verify-card-dup 专用（隔离 OPENTERMINAL_HOME）",
    "[model]",
    'provider = "anthropic"',
    'base_url = "http://127.0.0.1:15721"',
    'model = "claude-sonnet-4-6"',
    'api_key_env = "ANTHROPIC_API_KEY"',
    "",
    "[policy]",
    'mode = "tiered"',
    'auto_extra = ["echo", "ls", "pwd", "cat", "id", "whoami", "hostname"]',
    "",
    "[web]",
    'host = "127.0.0.1"',
    `port = ${PORT}`,
    "",
  ].join("\n"), "utf8");
  const py = pythonExe();
  const r = spawnSync(py, [path.join(lib.REPO, "tools", "verify-web", "fixtures",
                                     "seed-saved-conn.py")], {
    cwd: lib.REPO,
    env: {
      ...process.env, OPENTERMINAL_HOME: HOME, PYTHONIOENCODING: "utf-8",
      OT_SEED_NAME: TARGET, OT_SEED_HOST: "127.0.0.1",
      OT_SEED_PORT: String(SSH_PORT), OT_SEED_USER: "ubuntu",
      OT_SEED_COMMANDS: "",
    },
    encoding: "utf8",
  });
  const out = ((r.stdout || "") + (r.stderr || "")).trim();
  if (r.status !== 0 || out.indexOf(TARGET) === -1) {
    throw new Error("seed connections.db 失败: " + out);
  }
  console.log("已落库 saved connection:", out);
}

function pythonExe() {
  for (const c of [
    path.join(lib.REPO, ".venv-win", "Scripts", "python.exe"),
    path.join(lib.REPO, ".venv", "Scripts", "python.exe"),
  ]) if (fs.existsSync(c)) return c;
  throw new Error("no python found");
}

async function startServer() {
  const base = `http://127.0.0.1:${PORT}`;
  let up = false;
  try { up = (await fetch(base + "/")).ok; } catch (e) { up = false; }
  if (up) throw new Error("端口 " + PORT + " 已有服务端；换端口重试");
  const logFd = fs.openSync(path.join(lib.OUT, `server-${PORT}.log`), "w");
  const env = {
    ...process.env,
    OPENTERMINAL_HOME: HOME,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "carddup-key",
    OT_WEB_DEBUG: "1",
    PYTHON_KEYRING_BACKEND: "keyring.backends.null.Keyring",
    PYTHONIOENCODING: "utf-8",
  };
  const exe = pythonExe();
  const args = REAL
    ? ["-m", "openterminal.app", "web", "--port", String(PORT), "--no-open"]
    : [path.join(__dirname, "serve_scripted_model.py"),
       "--port", String(PORT), "--no-open"];
  const server = spawn(exe, args, {
    cwd: lib.REPO, stdio: ["ignore", logFd, logFd], env,
  });
  const t0 = Date.now();
  while (Date.now() - t0 < 40000) {
    try { if ((await fetch(base + "/")).ok) return { base, server }; } catch (e) {}
    if (server.exitCode != null) throw new Error("服务端提前退出 code=" + server.exitCode);
    await sleep(400);
  }
  throw new Error("服务端 40s 未就绪");
}

// ---- WS 事件录帧（事件级断言的真值来源）----
// 线上形态：AI 事件嵌在 {type:"event", event:{kind:...}} 信封里；
// approval/ask_password 等是顶层 type
const wsEvents = [];
let evCursor = 0;
let pwPending = false, pwSeenAt = 0;
function hookWs(page) {
  page.on("websocket", ws => {
    ws.on("framereceived", f => {
      try {
        const m = JSON.parse(String(f.payload));
        if (!m) return;
        if (m.type === "event" && m.event && m.event.kind) {
          wsEvents.push({ t: Date.now(), m: { type: m.event.kind, ...m.event } });
        } else if (m.type === "ask_password") {
          pwPending = true; pwSeenAt = Date.now();
        } else if (m.type === "ready") {
          pwPending = false;
        } else if (m.type === "closed") {
          pwPending = false;
        }
      } catch (e) { /* 非 JSON 帧（PTY 二进制）*/ }
    });
  });
}
function drainEvents() {
  const ev = wsEvents.slice(evCursor);
  evCursor = wsEvents.length;
  return ev;
}
function eventSummary(ev) {
  // ai_token/ai_think 连发压成一条计数，别刷屏
  const out = [];
  let tok = 0, think = 0;
  for (const e of ev) {
    const m = e.m;
    if (m.type === "ai_token") { tok++; continue; }
    if (m.type === "ai_think") { think++; continue; }
    if (tok) { out.push(`ai_token×${tok}`); tok = 0; }
    if (think) { out.push(`ai_think×${think}`); think = 0; }
    if (m.type === "ai_tool") {
      const a = m.args ? "(" + String(m.args).slice(0, 32) + ")" : "";
      const fl = m.failed ? ":fail" : "";
      out.push("ai_tool:" + m.phase + "#" + m.id + ":" + m.name + a + fl);
    } else {
      out.push(m.type + (m.text ? "(" + String(m.text).slice(0, 24) + ")" : ""));
    }
  }
  if (tok) out.push(`ai_token×${tok}`);
  if (think) out.push(`ai_think×${think}`);
  return out.join(" | ");
}

// ---- 页面探针 ----
const probe = page => page.evaluate(() => {
  // 工具卡 .tcard；审批卡 .acard.aprobe:not(.tcard)（含已决策：问句换成徽标）；
  // 总结卡 .scard（不是 .acard！）
  const tools = Array.from(document.querySelectorAll(".tcard")).map(x => ({
    text: (x.innerText || "").replace(/\s+/g, " ").slice(0, 160),
    args: ((x.querySelector(".apcode") || {}).innerText || "").replace(/\s+/g, " ").trim(),
    badge: ((x.querySelector(".apstate") || {}).innerText || "").replace(/\s+/g, " ").trim(),
  }));
  const aps = Array.from(document.querySelectorAll(".acard.aprobe:not(.tcard)")).map(x => {
    const head = ((x.querySelector(".aphead") || {}).innerText || "");
    if (!/是否同意|已同意|已编辑|已拒绝/.test(head)) return null;   // 救援卡等排除
    return {
      head: head.replace(/\s+/g, " ").slice(0, 120),
      decided: !!x.querySelector(".apstate"),
      state: ((x.querySelector(".apstate") || {}).innerText || "").replace(/\s+/g, " ").trim(),
      cmd: ((x.querySelector(".apcode") || {}).innerText || "").replace(/\s+/g, " ").trim(),
    };
  }).filter(Boolean);
  const think = document.querySelector('[id^="think-"]');
  return {
    tools, aps,
    think: think ? (think.hidden ? "hidden" : "shown") : "missing",
    summary: Array.from(document.querySelectorAll(".scard"))
      .map(x => (x.innerText || "").replace(/\s+/g, " ").slice(0, 200)),
    cards: Array.from(document.querySelectorAll(".acard"))
      .map(x => (x.innerText || "").replace(/\s+/g, " ").slice(0, 220)),
  };
});

async function shot(page, name) {
  await page.screenshot({ path: path.join(lib.OUT, `carddup-${name}.png`) });
  console.log("    [截图] carddup-" + name + ".png");
}

async function clickTerm(page, tries = 6) {
  for (let i = 0; i < tries; i++) {
    try {
      await page.locator(".term").click({ timeout: 3000, force: true });
      await sleep(120);
      return true;
    } catch (e) {}
    await sleep(300);
  }
  return false;
}

async function say(page, text) {
  const clear = await waitNoModal(page);
  if (!clear) throw new Error("模态未退场，输入会丢失");   // 吞键盘的根因，宁可断言失败
  if (!(await clickTerm(page))) throw new Error("点不到终端");
  await sleep(150);
  // 慢打 + 回读验证行文本完整再回车：hook 上报是 readline 取行，CJK 尾字
  // 在回车瞬间还没进缓冲就被截断（截断文本与 submit 全文对不上 → 去重失效
  // → 同一行触发两个任务，踩过）。行文本齐了才提交
  await page.keyboard.type(text, { delay: 45 });
  const t0 = Date.now();
  while (Date.now() - t0 < 3000) {
    const txt = await lib.snapshot(page);
    if (txt.includes(text)) break;
    await sleep(150);
  }
  await sleep(350);
  await page.keyboard.press("Enter");
}

// ---- 会话代答：主机密钥/密码/记住密码弹窗 + WS 驱动的终端讨密码 ----
// 绝不按终端文本正则猜密码提示（注入脚本回显/滞留提示行会误匹配，把密码
// 敲进 shell 触发假任务——踩过）；只认 WS ask_password 帧 + 模态标题
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
      const rem = document.getElementById("modal-remember");
      if (rem) rem.checked = false;
      const b = btn(/确定/);
      if (b) { b.click(); return "pw:" + pw; }
    }
    return null;
  }, PW);
}

// WS ask_password → 终端内联捕获期敲密码（客户端捕获吃键，发 auth JSON）
async function pwTermTick(page) {
  if (!pwPending || Date.now() - pwSeenAt < 600) return null;
  if (!(await clickTerm(page))) return null;
  await page.keyboard.type(PW.ubuntu, { delay: 15 });
  await page.keyboard.press("Enter");
  pwPending = false;
  return "termpw:" + PW.ubuntu;
}

let butlerStop = false;
function startButler(page) {
  (async () => {
    let cool = 0;
    while (!butlerStop) {
      try {
        if (Date.now() > cool) {
          const act = (await pwTick(page)) || (await pwTermTick(page));
          if (act) { console.log("    [butler] " + act); cool = Date.now() + 800; }
        }
      } catch (e) { /* 页面导航/关闭 */ }
      await sleep(300);
    }
  })();
}

// say 前置：模态在场会吞键盘（「记住密码」弹窗顶层阻塞，踩过）——等它退场
async function waitNoModal(page, timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const has = await page.evaluate(() =>
      !!document.querySelector("#modal-root .modal"));
    if (!has) return true;
    await sleep(250);
  }
  return false;
}

async function waitReady(page, timeout = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const ok = await page.evaluate(() => {
      const g = id => {
        const el = document.querySelector(`[id^="${id}-"]`);
        return el ? (el.hidden ? "hidden" : "shown") : "missing";
      };
      return g("conn") !== "shown" && g("connov") !== "shown"
        && !!((document.querySelector('[id^="status-"]') || {}).innerText || "").trim();
    });
    if (ok) return true;
    await sleep(400);
  }
  return false;
}

async function waitFor(page, fn, timeout) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    last = await fn();
    if (last && last.ok) return { ok: true, waited: Date.now() - t0, ...last };
    await sleep(250);
  }
  return { ok: false, waited: Date.now() - t0, last };
}

const waitTools = (page, needle, count, timeout = 30000) =>
  waitFor(page, async () => {
    const p = await probe(page);
    const n = p.tools.filter(t => t.args.includes(needle)).length;
    return { ok: n === count, n };
  }, timeout);

// 审批卡按本轮命令圈定（跨轮遗留的已决卡不得顶掉计数——踩过：S1 的两张
// 已决卡让 S2 的 approveAll 秒退，S2 审批悬空）
const apMatches = (a, needles) =>
  !needles || !needles.length || needles.some(n => (a.cmd || "").includes(n));

const waitApprovalsFor = (page, needles, n, timeout = 30000) =>
  waitFor(page, async () => {
    const p = await probe(page);
    const mine = p.aps.filter(a => apMatches(a, needles));
    return { ok: mine.length >= n, total: mine.length,
             decided: mine.filter(a => a.decided).length };
  }, timeout);

const waitNoUndecided = (page, timeout = 60000) =>
  waitFor(page, async () => {
    const p = await probe(page);
    return { ok: p.aps.every(a => a.decided), p };
  }, timeout);

// ---- 审批操作 ----
async function clickApproveOnce(page) {
  return page.evaluate(() => {
    const txt = x => (x.innerText || "").replace(/\s+/g, "");
    const heads = Array.from(document.querySelectorAll(".acard.aprobe:not(.tcard)"))
      .filter(card => /是否同意/.test((card.querySelector(".aphead") || {}).innerText || ""))
      .filter(card => !card.querySelector(".apstate"));
    const head = heads[0];
    if (!head) return "none";
    const btns = Array.from(head.querySelectorAll("button"));
    const b = btns.find(x => /^确认执行$/.test(txt(x)))
            || btns.find(x => /^(执行|保存并执行|同意|批准)$/.test(txt(x)))
            || btns.find(x => /执行|同意|批准/.test(txt(x))
                          && !/始终|永久|取消|修改|拒绝/.test(txt(x)));
    if (!b) return "no-btn:" + (head.innerText || "").slice(0, 60);
    b.click();
    return "click:" + txt(b);
  });
}

// 逐个确认循环：点到「本轮审批全部已决」（高危卡两段：执行→确认执行）。
// 完成条件按 needles 圈定本轮卡：旧轮已决卡不得顶掉计数
async function approveAll(page, want, needles, timeout = 60000) {
  const acts = [];
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const a = await clickApproveOnce(page);
    if (a !== "none") { acts.push(a); await sleep(400); continue; }
    const p = await probe(page);
    const anyUndecided = p.aps.some(x => !x.decided);
    const myDecided = p.aps.filter(x => x.decided && apMatches(x, needles)).length;
    if (!anyUndecided && myDecided >= want) break;
    await sleep(300);
  }
  return acts;
}

// 编辑流：点「修改」→ 浮层 textarea 改命令 → 「保存并执行」
async function editAndSave(page, newCmd) {
  const opened = await page.evaluate(() => {
    const txt = x => (x.innerText || "").replace(/\s+/g, "");
    const heads = Array.from(document.querySelectorAll(".acard.aprobe:not(.tcard)"))
      .filter(card => /是否同意/.test((card.querySelector(".aphead") || {}).innerText || ""))
      .filter(card => !card.querySelector(".apstate"));
    const head = heads[0];
    if (!head) return "no-approval";
    const b = Array.from(head.querySelectorAll("button"))
      .find(x => /^修改/.test(txt(x)));
    if (!b) return "no-edit-btn";
    b.click();
    return "opened";
  });
  if (opened !== "opened") return opened;
  await sleep(400);
  const ta = page.locator(".apedit textarea");
  if (!(await ta.count())) return "no-textarea";
  await ta.fill(newCmd);
  await sleep(150);
  return page.evaluate(() => {
    const b = Array.from(document.querySelectorAll(".apedit-btns button"))
      .find(x => /保存并执行/.test(x.innerText || ""));
    if (!b) return "no-save-btn";
    b.click();
    return "saved";
  });
}

// ---- 不变量 ----
function uniqueArgs(p) {
  const args = p.tools.map(t => t.args).filter(Boolean);
  return { ok: new Set(args).size === args.length, args };
}

async function assertInvariants(page, tag) {
  const p = await probe(page);
  const u = uniqueArgs(p);
  record(`R7 全程工具卡参数互异（无重复宣告指纹）@${tag}`, u.ok,
    u.ok ? `共 ${u.args.length} 张工具卡` : "重复: " + JSON.stringify(u.args));
  return p;
}

// 事件级断言：一轮里 tool_start/end 条数与 id 配对、final 恰一条
function assertRoundEvents(tag, ev, wantStarts) {
  const starts = ev.filter(e => e.m.type === "ai_tool" && e.m.phase === "start");
  const ends = ev.filter(e => e.m.type === "ai_tool" && e.m.phase === "end");
  const finals = ev.filter(e => e.m.type === "final");
  const tasks = ev.filter(e => e.m.type === "task_start");
  record(`R9 tool_start 恰 ${wantStarts} 条（重复宣告即×2）@${tag}`,
    starts.length === wantStarts,
    `start=${starts.length} end=${ends.length} final=${finals.length}；${eventSummary(ev)}`);
  const sids = starts.map(e => String(e.m.id)).sort();
  const eids = ends.map(e => String(e.m.id)).sort();
  record(`R10 tool_end 与 start 一一配对@${tag}`,
    ends.length === wantStarts && JSON.stringify(sids) === JSON.stringify(eids),
    `start ids=[${sids}] end ids=[${eids}]`);
  record(`R11 恰 1 条 final（收束）@${tag}`, finals.length === 1,
    `final=${finals.length}`);
  record(`R12 单次触发恰 1 个任务@${tag}`, tasks.length === 1,
    `task_start=${tasks.length}（>1 = submit/hook 双路去重失效，窗口被污染）`);
}

async function main() {
  markerCleanup();
  prepareHome();
  const started = await startServer();
  const logPath = path.join(lib.OUT, `server-${PORT}.log`);
  console.log("服务端:", started.base, REAL ? "（真模型/网关）" : "（脚本化模型）");

  const browser = await lib.launch();
  const { page, errors } = await lib.openTab(browser, started.base);
  hookWs(page);

  try {
    startButler(page);
    const picked = await lib.pickTarget(page, TARGET);
    record("A0 侧栏选中 SSH 目标 " + TARGET, picked,
      picked ? "命中" : "未命中（点了第一个）");
    const ready = await waitReady(page);
    record("A1 SSH 会话就绪（ubuntu@ot-repro bash）", ready,
      ready ? "ok" : "90s 未就绪");
    if (!ready) {
      await shot(page, "a1-not-ready");
      const dbg = await page.evaluate(() => {
        const modal = document.querySelector("#modal-root .modal");
        return {
          modal: modal ? (modal.innerText || "").replace(/\s+/g, " ").slice(0, 200) : "",
          conn: (document.querySelector('[id^="conn-"]') || {}).hidden,
          status: ((document.querySelector('[id^="status-"]') || {}).innerText || "").slice(0, 80),
          body: (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 300),
        };
      });
      console.log("    [诊断] " + JSON.stringify(dbg));
      return finish(logPath);
    }
    await sleep(1200);

    if (REAL) {
      await runReal(page);
    } else {
      await runS1(page);
      await runS2(page);
      await runS3(page);
    }

    record("R8 页面无 JS 报错", errors.length === 0,
      errors.length ? errors.join("\n") : "无 pageerror/console error");
    butlerStop = true;
  } catch (e) {
    butlerStop = true;
    record("脚本异常", false, String(e && e.stack || e));
    try { await shot(page, "crash"); } catch (e2) {}
  } finally {
    await browser.close().catch(() => {});
    started.server.kill();
  }
  finish(logPath);
}

// ---- S1 并行 ----
async function runS1(page) {
  console.log("\n########## S1 并行 2 execute（脚本化） ##########");
  const evStart = wsEvents.length;
  await say(page, "并行执行文件写入测试");
  const t1 = await waitTools(page, "ot-cc-aa", 1, 30000);
  const t2 = await waitTools(page, "ot-cc-bb", 1, 15000);
  record("S1-1 两工具卡各自宣告一次", t1.ok && t2.ok,
    `aa=${t1.ok ? 1 : (t1.last || {}).n} bb=${t2.ok ? 1 : (t2.last || {}).n}`);
  // 审批是**逐个确认**（core 串行 ask_approval，状态栏明示）：同一时刻只有
  // 1 张未决卡；「累计 2 张」在放行后成立（S1-7 验），这里只验首张及时出现
  const apr = await waitApprovalsFor(page, ["ot-cc-aa", "ot-cc-bb"], 1, 30000);
  record("S1-2 首张审批卡出现（逐个确认）", apr.ok,
    apr.ok ? "已见 " + apr.total + " 张（总数到 2 由 S1-7 验）"
           : "30s 内没有审批卡");
  let p = await probe(page);
  record("S1-3 宣告期恰 2 张工具卡（无第 3 张）", p.tools.length === 2,
    "工具卡数=" + p.tools.length + " " + JSON.stringify(p.tools.map(t => t.args)));
  await shot(page, "s1-a-announce");

  const acts = await approveAll(page, 2, ["ot-cc-aa", "ot-cc-bb"]);
  console.log("    [审批] " + JSON.stringify(acts));
  const done = await waitFor(page, async () => {
    const p2 = await probe(page);
    const ev = wsEvents.slice(evStart);
    return {
      ok: p2.aps.every(a => a.decided) && p2.tools.length > 0 &&
          p2.tools.every(t => /✓|✗/.test(t.badge)) &&
          ev.some(e => e.m.type === "final"),
      p: p2,
    };
  }, 90000);
  record("S1-4 放行后轮次收尾（徽标全落 + final 到达）", done.ok,
    done.ok ? JSON.stringify(done.p.tools.map(t => t.badge)) : JSON.stringify((done.last || {}).p || done.last));
  const evS1 = wsEvents.slice(evStart);
  assertRoundEvents("s1", evS1, 2);
  await assertInvariants(page, "s1-done");
  p = await probe(page);
  const s1Tools = p.tools.filter(t => /ot-cc-(aa|bb)/.test(t.args));
  record("S1-5 输出后不长新卡（仍恰 2 张、且在原卡上）", p.tools.length === 2 && s1Tools.length === 2,
    "工具卡数=" + p.tools.length + " 场景卡=" + s1Tools.length);
  record("S1-6 原卡原位收徽标", s1Tools.length === 2 && s1Tools.every(t => /✓|✗/.test(t.badge)),
    JSON.stringify(s1Tools.map(t => ({ cmd: t.args, badge: t.badge }))));
  record("S1-7 审批卡原位决策", p.aps.length === 2 && p.aps.every(a => a.decided),
    JSON.stringify(p.aps.map(a => a.state)));
  await shot(page, "s1-b-badges");

  const sum = await waitFor(page, async () => {
    const p2 = await probe(page);
    return { ok: p2.summary.some(c => c.includes(FINAL_TEXT.并行)) };
  }, 30000);
  if (!sum.ok) {
    const dom = await page.evaluate(() => ({
      summaryEls: document.querySelectorAll(".scard").length,
      allCards: Array.from(
        document.querySelectorAll(".acard, .scard, [class*='card']"))
        .map(x => (x.className || "") + "::" + (x.innerText || "").replace(/\s+/g, " ").slice(0, 60)),
    }));
    console.log("    [DOM 转储] " + JSON.stringify(dom));
  }
  record("S1-8 总结卡出现（任务收束）", sum.ok,
    sum.ok ? JSON.stringify((await probe(page)).summary) : "30s 无总结卡 " +
      JSON.stringify((await probe(page)).summary));
  await sleep(600);   // 等收束扫尾落定
  await assertInvariants(page, "s1-final");
  p = await probe(page);
  const stillThere = p.tools.filter(t => /ot-cc-(aa|bb)/.test(t.args));
  record("S1-9 收束后 2 张工具卡都还在（带徽标，未整卡消失）",
    stillThere.length === 2 && stillThere.every(t => /✓|✗/.test(t.badge)),
    JSON.stringify(stillThere.map(t => ({ cmd: t.args, badge: t.badge }))));
  await shot(page, "s1-c-after-summary");
}

// ---- S2 单工具 ----
async function runS2(page) {
  console.log("\n########## S2 单 execute（脚本化） ##########");
  const before = (await probe(page)).tools.length;
  const evStart = wsEvents.length;
  await say(page, "单个文件写入测试");
  const t1 = await waitTools(page, "ot-cc-single", 1, 30000);
  record("S2-1 恰 1 张工具卡", t1.ok, "该命令工具卡=" + (t1.ok ? 1 : (t1.last || {}).n));
  const apr = await waitApprovalsFor(page, ["ot-cc-single"], 1, 30000);
  record("S2-2 1 张审批卡", apr.ok, "本轮共 " + (apr.ok ? apr.total : (apr.last || {}).total) + " 张");
  await shot(page, "s2-a-announce");
  const acts = await approveAll(page, 1, ["ot-cc-single"]);
  console.log("    [审批] " + JSON.stringify(acts));
  const done = await waitFor(page, async () => {
    const p2 = await probe(page);
    const ev = wsEvents.slice(evStart);
    return {
      ok: p2.aps.filter(a => !a.decided).length === 0 && p2.tools.length > 0 &&
          p2.tools.every(t => /✓|✗/.test(t.badge)) &&
          ev.some(e => e.m.type === "final"),
      p: p2,
    };
  }, 90000);
  record("S2-3 轮次收尾", done.ok, done.ok ? "ok" : JSON.stringify(done.last));
  assertRoundEvents("s2", wsEvents.slice(evStart), 1);
  await assertInvariants(page, "s2-done");
  const p = await probe(page);
  const mine = p.tools.filter(t => t.args.includes("ot-cc-single"));
  record("S2-4 徽标原位、无重复卡", mine.length === 1 && /✓|✗/.test(mine[0].badge)
    && p.tools.length === before + 1,
    JSON.stringify(mine) + "；工具卡总数 " + before + "→" + p.tools.length);
  const sum = await waitFor(page, async () => ({
    ok: (await probe(page)).summary.some(c => c.includes(FINAL_TEXT.单个)),
  }), 30000);
  if (!sum.ok) {
    const dom = await page.evaluate(() => ({
      scards: Array.from(document.querySelectorAll(".scard"))
        .map(x => (x.innerText || "").replace(/\s+/g, " ").slice(0, 80)),
      allCards: Array.from(document.querySelectorAll(".acard, .scard"))
        .map(x => (x.className || "") + "::" + (x.innerText || "").replace(/\s+/g, " ").slice(0, 50)),
    }));
    console.log("    [DOM 转储@S2-5] " + JSON.stringify(dom));
  }
  record("S2-5 总结卡出现", sum.ok,
    sum.ok ? "ok" : "30s 无 " + JSON.stringify((await probe(page)).summary));
  await shot(page, "s2-b-after-summary");
}

// ---- S3 edit 决策 ----
async function runS3(page) {
  console.log("\n########## S3 edit 决策（脚本化） ##########");
  const before = (await probe(page)).tools.length;
  const evStart = wsEvents.length;
  await say(page, "编辑流程文件写入测试");
  const t1 = await waitTools(page, "ot-cc-orig", 1, 30000);
  record("S3-1 恰 1 张工具卡（宣告原始命令）", t1.ok,
    "该命令工具卡=" + (t1.ok ? 1 : (t1.last || {}).n));
  const apr = await waitApprovalsFor(page, ["ot-cc-orig"], 1, 30000);
  record("S3-2 1 张审批卡", apr.ok, "本轮共 " + (apr.ok ? apr.total : (apr.last || {}).total) + " 张");
  await shot(page, "s3-a-announce");

  const edited = "echo edited | tee /tmp/ot-cc-edited.txt";
  const act = await editAndSave(page, edited);
  record("S3-3 编辑流点完「修改→保存并执行」", act === "saved", act);
  const done = await waitFor(page, async () => {
    const p2 = await probe(page);
    const ev = wsEvents.slice(evStart);
    return {
      ok: p2.aps.filter(a => !a.decided).length === 0 && p2.tools.length > 0 &&
          p2.tools.every(t => /✓|✗/.test(t.badge)) &&
          ev.some(e => e.m.type === "final"),
      p: p2,
    };
  }, 90000);
  record("S3-4 轮次收尾", done.ok, done.ok ? "ok" : JSON.stringify(done.last));
  assertRoundEvents("s3", wsEvents.slice(evStart), 1);
  await sleep(500);
  await assertInvariants(page, "s3-done");
  const p = await probe(page);
  const mine = p.tools.filter(t => t.args.includes("ot-cc-orig"));
  record("S3-5 不长新卡：仍 1 张、卡上保留宣告时原始参数", mine.length === 1
    && p.tools.length === before + 1,
    JSON.stringify(mine) + "；工具卡总数 " + before + "→" + p.tools.length);
  record("S3-6 徽标落原卡", mine.length === 1 && /✓|✗/.test(mine[0].badge),
    mine.length ? mine[0].badge : "卡不在");
  const editedOk = markerExists("ot-cc-edited.txt");
  const origGone = !markerExists("ot-cc-orig.txt");
  record("S3-7 编辑后命令真实执行 / 原命令未执行", editedOk && origGone,
    `ot-cc-edited.txt=${editedOk ? "存在" : "缺失"}，ot-cc-orig.txt=${origGone ? "不存在" : "存在(!)"}`);
  const ap = p.aps[p.aps.length - 1] || {};
  record("S3-8 审批卡回执「已编辑」+ 编辑后命令",
    /已编辑|已同意/.test(ap.state || "") && (ap.cmd || "").includes("ot-cc-edited"),
    JSON.stringify({ state: ap.state, cmd: ap.cmd }));
  await shot(page, "s3-b-after-edit");
}

// ---- S4 真模型（网关）一轮 ----
async function runReal(page) {
  console.log("\n########## S4 真模型一轮（15721 网关） ##########");
  const before = (await probe(page)).tools.length;
  const evStart = wsEvents.length;
  await say(page, REAL_PROMPT);
  const seen = await waitFor(page, async () => {
    const p = await probe(page);
    return { ok: p.tools.length >= 1, p };
  }, 120000);
  record("R4-1 模型宣告了工具卡", seen.ok,
    seen.ok ? JSON.stringify(seen.p.tools.map(t => t.args)) : "120s 无工具卡");
  if (!seen.ok) return;
  await sleep(1500);
  let p = await probe(page);
  const announced = p.tools.length;
  const und = p.aps.filter(a => !a.decided).length;
  // 「逐个确认」语义：同一时刻未决审批只有 1 张；一一对应由放行后的
  // R4-5（事件级）/R4-7（徽标）对账。这里只验并行宣告未被拆散成多轮
  // （多轮时 tool 卡会分批出现、announced 每批 <2）
  record("R4-2 同轮工具卡在场 + 审批已弹出", announced >= 1 && und >= 1,
    `工具卡 ${announced} 张同轮在场，未决审批 ${und} 张（逐个确认，一一对应由 R4-5 对账）`);
  record("R4-3 本轮为并行多工具", announced >= 2,
    "一轮宣告 " + announced + " 张" + (announced >= 2 ? "（并行达成）" : "（未并行，弱化为单工具路径）"));
  await assertInvariants(page, "real-announce");
  await shot(page, "real-a-announce");

  const acts = await approveAll(page, announced, []);
  console.log("    [审批] " + JSON.stringify(acts));
  const done = await waitFor(page, async () => {
    const p2 = await probe(page);
    const ev = wsEvents.slice(evStart);
    return {
      ok: p2.aps.filter(a => !a.decided).length === 0 && p2.tools.length > 0 &&
          p2.tools.every(t => /✓|✗/.test(t.badge)) &&
          ev.some(e => e.m.type === "final"),
      p: p2,
    };
  }, 120000);
  record("R4-4 放行后轮次收尾", done.ok, done.ok ? "ok" : JSON.stringify(done.last));
  await sleep(800);
  const ev = wsEvents.slice(evStart);
  const starts = ev.filter(e => e.m.type === "ai_tool" && e.m.phase === "start").length;
  const ends = ev.filter(e => e.m.type === "ai_tool" && e.m.phase === "end").length;
  record("R4-5 事件级 start/end 条数一致（无重复宣告）",
    starts === announced && ends === announced,
    `start=${starts} end=${ends} DOM=${announced}；${eventSummary(ev)}`);
  await assertInvariants(page, "real-done");
  p = await probe(page);
  record("R4-6 计数稳定（输出后不长新卡）", p.tools.length === announced,
    "宣告 " + announced + " → 结束 " + p.tools.length);
  record("R4-7 每张原卡原位收徽标",
    p.tools.slice(before).length > 0 && p.tools.slice(before).every(t => /✓|✗/.test(t.badge)),
    JSON.stringify(p.tools.slice(before).map(t => ({ cmd: t.args, badge: t.badge }))));
  await shot(page, "real-b-after");
  const sum = await waitFor(page, async () => ({
    ok: (await probe(page)).summary.length > 0,
  }), 60000);
  record("R4-8 总结卡出现", sum.ok, sum.ok ? "ok" : "60s 无总结卡");
  p = await probe(page);
  record("R4-9 收束后卡都在（带徽标）",
    p.tools.length === announced && p.tools.every(t => /✓|✗/.test(t.badge)),
    JSON.stringify(p.tools.map(t => t.badge)));
  await shot(page, "real-c-final");
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
