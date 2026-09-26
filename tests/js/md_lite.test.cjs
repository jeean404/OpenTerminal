"use strict";
const {test} = require("node:test");
const assert = require("node:assert/strict");
const {esc, mdInline, mdLite, stripIncompleteMarkers} = require(
  "../../src/openterminal/web/frontend/static/md_lite.js");

test("esc 转义五类特殊字符", () => {
  assert.equal(esc(`&<>"'`), "&amp;&lt;&gt;&quot;&#39;");
});

test("mdInline 行内码与粗体", () => {
  assert.equal(mdInline("`c` 和 **b**"), "<code>c</code> 和 <strong>b</strong>");
});

test("mdLite 标准 ## 标题 → mh2", () => {
  assert.match(mdLite("## 内存使用"), /class="mh mh2">内存使用</);
});

test("mdLite 表格渲染 thead/tbody 与对齐", () => {
  const html = mdLite("| 指标 | 数值 |\n|---|---:|\n| 运行时长 | 122 天 |");
  assert.match(html, /class="mtable"/);
  assert.match(html, /<thead><tr><th>指标<\/th><th class="a-right">数值<\/th>/);
  assert.match(html, /<td class="a-right">122 天<\/td>/);
});

test("mdLite 列表与空行", () => {
  const html = mdLite("- 甲\n- 乙\n\n段落");
  assert.match(html, /<ul><li>甲<\/li><li>乙<\/li><\/ul>/);
  assert.match(html, /class="mgap"/);
  assert.match(html, /class="mline">段落</);
});

test("stripIncompleteMarkers 剥尾部未闭合粗体", () => {
  assert.equal(stripIncompleteMarkers("结论 **重点"), "结论 ");
  assert.equal(stripIncompleteMarkers("结论 **重点**"), "结论 **重点**");
});

test("stripIncompleteMarkers 剥尾部未闭合行内码", () => {
  assert.equal(stripIncompleteMarkers("看 `ls -l"), "看 ");
  assert.equal(stripIncompleteMarkers("看 `ls -l`"), "看 `ls -l`");
});

test("mdLite emoji 裸小节行 → mh2", () => {
  const html = mdLite("📊 系统概况");
  assert.match(html, /class="mh mh2">📊 系统概况</);
});

test("mdLite 带句末标点的 emoji 行不进 mh2", () => {
  const html = mdLite("📊 系统整体运行正常。");
  assert.doesNotMatch(html, /class="mh mh2"/);
  assert.match(html, /class="mline"/);
});

test("mdLite 超长 emoji 行不进 mh2", () => {
  const long = "📊 " + "这是一段超出小节标题长度限制的很长很长很长很长很长的句子";
  assert.doesNotMatch(mdLite(long), /class="mh mh2"/);
});
