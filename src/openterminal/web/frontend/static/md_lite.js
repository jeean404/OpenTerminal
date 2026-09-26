// 轻量 markdown 渲染（行内 code / 粗体 / 标题 / 列表 / 表格 / 段落），不引外部库。
// 从 app.js 抽出独立成文件：node --test 可直接加载（module.exports 守卫），
// 浏览器经 index.html 先于 app.js 装载为全局函数。
"use strict";

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c => (
    {"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
}

function mdInline(s) {
  return s.replace(/`([^`]+)`/g, "<code>$1</code>")
          .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

// --- 表格：按单元格切分一行（处理 \| 转义；去掉行首尾分隔符产生的空 cell）---
function _splitRow(ln) {
  const cells = [];
  let cur = "";
  for (let i = 0; i < ln.length; i++) {
    const ch = ln[i];
    if (ch === "\\" && ln[i + 1] === "|") { cur += "|"; i++; continue; }
    if (ch === "|") { cells.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  cells.push(cur.trim());
  if (cells.length && cells[0] === "") cells.shift();
  if (cells.length && cells[cells.length - 1] === "") cells.pop();
  return cells;
}

function _renderTable(rows) {
  const cells = rows.map(_splitRow);
  const aligns = cells[1].map(a =>
    /^:-+:$/.test(a) ? "center" : /-+:$/.test(a) ? "right" : "left");
  const attr = i => (aligns[i] && aligns[i] !== "left" ? ` class="a-${aligns[i]}"` : "");
  const tr = (row, tag) => "<tr>" + row.map((c, i) =>
    `<${tag}${attr(i)}>` + mdInline(c) + `</${tag}>`).join("") + "</tr>";
  return '<div class="mtable"><table><thead>' + tr(cells[0], "th") +
    "</thead><tbody>" + cells.slice(2).map(r => tr(r, "td")).join("") +
    "</tbody></table></div>";
}

const isPipeRow = ln => /^\s*\|.*\|\s*$/.test(ln);

// 流式尾巴：未闭合的 `code / **bold 半截记号先剥掉，等闭合再渲染样式
function stripIncompleteMarkers(s) {
  let t = String(s == null ? "" : s);
  if (((t.match(/`/g) || []).length) % 2) t = t.slice(0, t.lastIndexOf("`"));
  if (((t.match(/\*\*/g) || []).length) % 2) t = t.slice(0, t.lastIndexOf("**"));
  return t;
}

// emoji 裸小节标题启发式：emoji 开头 + 无句末标点 + 去空白 ≤24 字符 → 当作 ## 小节标题渲染
const _EMOJI_START = /^\p{Extended_Pictographic}/u;
const _END_PUNCT = /[。！？；：,.;:）)】\]」"']$/;
function isBareSectionTitle(ln) {
  const t = ln.trim();
  if (!t || t.includes("|")) return false;
  if (!_EMOJI_START.test(t)) return false;
  if (_END_PUNCT.test(t)) return false;
  return [...t].length <= 24;
}

function mdLite(src) {
  const lines = esc(String(src == null ? "" : src)).split("\n");
  const out = [];
  let list = null;
  const closeList = () => { if (list) { out.push("</" + list + ">"); list = null; } };
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    // 表格：管道行且下一行是分隔行（|---|:--:|）→ 整表吞并渲染
    if (isPipeRow(ln) && i + 1 < lines.length
        && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      closeList();
      const rows = [];
      let j = i;
      while (j < lines.length && isPipeRow(lines[j])) rows.push(lines[j++]);
      out.push(_renderTable(rows));
      i = j - 1;
      continue;
    }
    // 标题（# ~ ####）
    const h = ln.match(/^\s*(#{1,4})\s+(.+)$/);
    if (h) {
      closeList();
      out.push('<div class="mh mh' + h[1].length + '">' + mdInline(h[2]) + "</div>");
      continue;
    }
    let m = ln.match(/^\s*(\d+)[.)]\s+(.*)$/);
    if (m) {
      if (list !== "ol") { closeList(); out.push("<ol>"); list = "ol"; }
      out.push("<li>" + mdInline(m[2]) + "</li>");
      continue;
    }
    m = ln.match(/^\s*[-*]\s+(.*)$/);
    if (m) {
      if (list !== "ul") { closeList(); out.push("<ul>"); list = "ul"; }
      out.push("<li>" + mdInline(m[1]) + "</li>");
      continue;
    }
    closeList();
    if (!ln.trim()) { out.push("<div class=\"mgap\"></div>"); continue; }
    if (isBareSectionTitle(ln)) {
      out.push('<div class="mh mh2">' + mdInline(ln.trim()) + "</div>");
      continue;
    }
    out.push("<div class=\"mline\">" + mdInline(ln) + "</div>");
  }
  closeList();
  return out.join("");
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {esc, mdInline, mdLite, stripIncompleteMarkers,
                    isBareSectionTitle, _splitRow, _renderTable, isPipeRow};
}
