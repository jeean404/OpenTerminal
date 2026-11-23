"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "..", "src",
  "openterminal", "web", "frontend", "static", "app.js"), "utf8");

function load() {
  const document = {
    addEventListener() {},
    getElementById: () => ({onclick: null, addEventListener() {}}),
    querySelectorAll: () => [],
    body: {classList: {toggle() {}}},
  };
  return new Function("window", "document", "sessionStorage", "fetch",
    "performance", "mdLite",
    source + "\nreturn {Session, historyMessageFrames};")(
    {addEventListener() {}}, document,
    {getItem: () => null}, () => new Promise(() => {}), {now: () => 0},
    text => text);
}

test("replay waits for card mounts and terminal writes in event order", async () => {
  const {Session} = load();
  const session = Object.create(Session.prototype);
  const log = [];
  session._dead = false;
  session._cardReady = Promise.resolve();
  session._ensureFeed = async () => ({});
  session._writeTerm = bytes => { log.push("input:" + new TextDecoder().decode(bytes).trim()); };
  session._ingestBytes = bytes => {
    session._writes = new Promise(resolve => setTimeout(() => {
      log.push("bytes:" + new TextDecoder().decode(bytes));
      resolve();
    }, 5));
  };
  session._flushWrites = () => session._writes || Promise.resolve();
  session._followBottom = () => {};
  session.handleEvent = event => {
    if (event.kind === "ai_result") {
      session._cardReady = new Promise(resolve => setTimeout(() => {
        log.push("analysis");
        resolve();
      }, 5));
    } else if (event.kind === "final") {
      session._sweepQ = new Promise(resolve => setTimeout(() => {
        log.push("summary");
        resolve();
      }, 5));
    } else {
      log.push(event.kind);
    }
  };
  await session.replayFrames([
    {kind: "input", data: "question"},
    {kind: "json", data: {type: "event", event: {kind: "task_start"}}},
    {kind: "json", data: {type: "event", event: {kind: "ai_result"}}},
    {kind: "bytes", data: Buffer.from("output").toString("base64")},
    {kind: "json", data: {type: "event", event: {kind: "final"}}},
    {kind: "json", data: {type: "approval", command: "must-not-run"}},
    {kind: "json", data: {type: "event", event: {kind: "task_end"}}},
  ]);
  assert.deepEqual(log, [
    "input:question", "task_start", "analysis", "bytes:output",
    "summary", "task_end",
  ]);
  assert.equal(session._replaying, false);
});

test("connection glass overlay stays for connecting and initializes, then clears on success", () => {
  const {Session} = load();
  const title = {textContent: "连接中"};
  const detail = {textContent: "正在建立终端连接，请稍候"};
  const overlay = {hidden: false, querySelector: selector =>
    selector === ".ctext" ? title : detail};
  const status = {textContent: ""};
  const conn = {hidden: false};
  const dot = {className: "dot tab-dot connecting"};
  const tabEl = {querySelector: () => dot};
  const documentWithOverlay = {
    addEventListener() {},
    getElementById(id) {
      if (id === "status-t1") return status;
      if (id === "conn-t1") return conn;
      if (id === "connov-t1") return overlay;
      return {onclick: null, addEventListener() {}};
    },
    querySelectorAll: () => [],
    body: {classList: {toggle() {}}},
  };
  const harness = new Function("window", "document", "sessionStorage", "fetch",
    "performance", "mdLite",
    source + "\nreturn {Session};")(
    {addEventListener() {}}, documentWithOverlay,
    {getItem: () => null}, () => new Promise(() => {}), {now: () => 0},
    text => text);
  const session = Object.create(harness.Session.prototype);
  session.tabId = "t1";
  session.status = "connecting";
  session.statusText = "";
  session.tabEl = tabEl;
  session.setStatus("connecting");
  assert.equal(overlay.hidden, false);
  assert.equal(conn.hidden, false);
  session._setConnectStage("agent_init");
  assert.equal(title.textContent, "初始化 Agent");
  session.setStatus("connected", "已连接");
  assert.equal(overlay.hidden, true);
  assert.equal(conn.hidden, true);
  assert.equal(dot.className, "dot tab-dot connected");
});

test("message-only older history produces user, tool, output and answer", () => {
  const {historyMessageFrames} = load();
  const frames = historyMessageFrames([
    {role: "user", content: "question"},
    {role: "assistant", content: "", tool_calls: [
      {id: "call", name: "execute", args: {command: "echo hello"}},
    ]},
    {role: "tool", content: "hello", tool_call_id: "call"},
    {role: "assistant", content: "answer"},
  ]);
  assert.deepEqual(frames.map(frame => frame.kind === "json"
    ? frame.data.event.kind + (frame.data.event.phase || "")
    : frame.kind), [
    "input", "task_start", "ai_toolstart", "term_open", "text",
    "term_close", "ai_toolend", "final", "task_end",
  ]);
  assert.equal(frames[4].data, "hello");
});

test("continued message-only history replays old messages before new frames", async () => {
  const {Session} = load();
  const session = Object.create(Session.prototype);
  const log = [];
  session._dead = false;
  session._ensureFeed = async () => ({});
  session._writeTerm = bytes => log.push(new TextDecoder().decode(bytes).trim());
  session._flushWrites = async () => {};
  session._followBottom = () => {};
  session.handleEvent = event => log.push(event.kind + ":" + (event.text || ""));
  await session.replayFrames([
    {kind: "messages", data: [
      {role: "user", content: "old question"},
      {role: "assistant", content: "old answer"},
    ]},
    {kind: "json", data: {type: "event", event: {
      kind: "task_start", text: "new question"}}},
  ]);
  assert.deepEqual(log, [
    "old question", "task_start:old question", "final:old answer",
    "task_end:", "task_start:new question",
  ]);
});

function historyListHarness(detail, options = {}) {
  const log = [];
  const modals = [];
  const row = {dataset: {id: "saved"}, disabled: false};
  const deleteButton = {dataset: {id: "saved"}};
  const document = {
    addEventListener() {},
    getElementById: () => ({onclick: null, addEventListener() {}}),
    querySelectorAll: selector => selector === ".history-row" ? [row]
      : selector === ".history-list-delete" ? [deleteButton] : [],
    body: {classList: {toggle() {}}},
  };
  class FakeSession {
    constructor(id, target, opts) {
      this.tabId = id;
      this.target = target;
      this.opts = opts;
      this._dead = false;
      log.push(["session", id, target, opts]);
    }
    activate() {}
    async replayFrames(frames) { log.push(["replay", frames]); }
    connectWS() { log.push(["connect"]); }
    setStatus(state, text) { log.push(["status", state, text]); }
  }
  const fetch = async (url, opts = {}) => {
    log.push(["fetch", url, opts.method || "GET", opts.body]);
    let data;
    let status = 200;
    if (url.startsWith("/api/history?")) {
      data = {items: [{id: "saved", title: "Task", status: detail.status}]};
    } else if (url.endsWith("/continue")) {
      data = options.continueError ? {detail: options.continueError} : {tab_id: "new-tab"};
      if (options.continueError) status = 409;
    } else if (opts.method === "DELETE") {
      data = {ok: true};
    } else {
      data = options.readError ? {detail: options.readError} : detail;
      if (options.readError) status = 500;
    }
    return {ok: status === 200, status, json: async () => data};
  };
  const modalShell = (title, body, buttons) => {
    modals.push({title, body, buttons});
    return () => { log.push(["close-modal"]); };
  };
  const app = new Function("window", "document", "sessionStorage", "fetch",
    "performance", "mdLite", "modalShell", "FakeSession",
    source + "\nSession = FakeSession; return {showHistory, sessions};")(
    {addEventListener() {}}, document, {getItem: () => null}, fetch,
    {now: () => 0}, text => text, modalShell, FakeSession);
  return {...app, row, deleteButton, log, modals};
}

const uiFrame = {kind: "input", data: "earlier question"};

test("clicking a continuable history entry replays before connecting", async () => {
  const h = historyListHarness({
    id: "saved", status: "completed", continuable: true, ui_frames: [uiFrame],
  });
  await h.showHistory("web01");
  await h.row.onclick();
  assert.deepEqual(h.log.filter(e => e[0] === "fetch" && e[1].startsWith("/api/history")), [
    ["fetch", "/api/history?target=web01", "GET", undefined],
    ["fetch", "/api/history/saved?target=web01", "GET", undefined],
    ["fetch", "/api/history/saved/continue", "POST", '{"target":"web01"}'],
  ]);
  assert.equal(h.sessions["new-tab"].opts.historyOnly, false);
  assert.deepEqual(h.log.filter(e => ["replay", "connect"].includes(e[0])), [
    ["replay", [uiFrame]], ["connect"],
  ]);
});

test("interrupted history with a completed state still resumes and explains the boundary", async () => {
  const h = historyListHarness({
    id: "saved", status: "interrupted", continuable: true, ui_frames: [uiFrame],
  });
  await h.showHistory("local");
  await h.row.onclick();
  assert.ok(h.sessions["new-tab"]);
  assert.match(h.modals.at(-1).body, /最近一次已完成的对话继续/);
});

test("history without a completed state is read-only and explains why", async () => {
  const h = historyListHarness({
    id: "saved", status: "interrupted", continuable: false, ui_frames: [uiFrame],
  });
  await h.showHistory("local");
  await h.row.onclick();
  assert.equal(h.sessions["history-saved"].opts.historyOnly, true);
  assert.ok(!h.log.some(e => e[0] === "fetch" && e[1].endsWith("/continue")));
  assert.match(h.log.find(e => e[0] === "status")[2], /没有已完成的对话可继承/);
});

test("message-only read-only history explains both limitations", async () => {
  const h = historyListHarness({
    id: "saved", status: "interrupted", continuable: false,
    messages: [{role: "user", content: "question"}],
  });
  await h.showHistory("local");
  await h.row.onclick();
  const status = h.log.find(e => e[0] === "status")[2];
  assert.match(status, /没有已完成的对话可继承/);
  assert.match(status, /无法还原原始界面/);
});

test("history read or continuation errors are visible and do not open an empty session", async () => {
  for (const options of [{readError: "read failed"}, {continueError: "restore failed"}]) {
    const h = historyListHarness({
      id: "saved", status: "completed", continuable: true, ui_frames: [uiFrame],
    }, options);
    await h.showHistory("local");
    await h.row.onclick();
    assert.match(h.modals.at(-1).body, new RegExp(Object.values(options)[0]));
    assert.deepEqual(Object.keys(h.sessions), []);
  }
});

test("history with no replayable content reports an error without starting a branch", async () => {
  const h = historyListHarness({
    id: "saved", status: "interrupted", continuable: false, ui_frames: [],
  });
  await h.showHistory("local");
  await h.row.onclick();
  assert.match(h.modals.at(-1).body, /没有可回放的内容/);
  assert.ok(!h.log.some(e => e[0] === "fetch" && e[1].endsWith("/continue")));
});

test("history deletion requires confirmation and refreshes the list", async () => {
  const h = historyListHarness({
    id: "saved", status: "completed", continuable: true, ui_frames: [uiFrame],
  });
  await h.showHistory("local");
  h.deleteButton.onclick();
  assert.ok(!h.log.some(e => e[2] === "DELETE"));
  await h.modals.at(-1).buttons[0].onClick();
  assert.ok(h.log.some(e => e[1] === "/api/history/saved?target=local" && e[2] === "DELETE"));
  assert.equal(h.log.filter(e => e[1] === "/api/history?target=local").length, 2);
});
