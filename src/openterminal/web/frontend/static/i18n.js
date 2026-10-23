"use strict";

// 界面语言：中文（默认）/ English。
//
// 词表用**中文原文当 key**（gettext 风格）：漏翻的地方自动回落原文，也不用
// 为了起键名再发明一套标识符；插值用位置占位符 {0} {1}，让译文可以调换语序。
//
// 切换是**原地换文案，不刷新页面**：终端面板一旦重建就会毁掉 xterm 的屏幕
// 状态，所以不能靠「重跑渲染函数」了事。做法是拿词表在两种语言间做一次整页
// 文本替换（中→英查正表、英→中查反表），静态 HTML 与 JS 画出来的界面一起
// 覆盖。带插值的句子（如「已删除技能「x」」）换不回来，由各模块用
// onLangChange 注册的重绘回调补。

const I18N = { zh: {}, en: {} };
const I18N_RENDERERS = [];

function currentLang() {
  return localStorage.getItem("ot-lang") === "en" ? "en" : "zh";
}

function t(key, ...args) {
  const dict = I18N[currentLang()] || {};
  let out = dict[key] !== undefined && dict[key] !== null ? dict[key] : key;
  if (args.length) {
    out = String(out).replace(/\{(\d+)\}/g, (whole, n) => {
      const value = args[Number(n)];
      return value === undefined ? whole : String(value);
    });
  }
  return out;
}

// 目标语言 → 「现有文案」到「目标文案」的替换表。两个方向都能建：
// 切英文时是 中→英（查正表），切中文时是 英→中（查反表）。
function buildLangMap(target) {
  const map = new Map();
  const en = I18N.en || {};
  for (const [zh, enText] of Object.entries(en)) {
    if (zh === enText) continue;
    if (target === "en") map.set(zh, enText);
    else map.set(enText, zh);
  }
  return map;
}

function onLangChange(fn) {
  I18N_RENDERERS.push(fn);
}

function setLang(lang) {
  const next = lang === "en" ? "en" : "zh";
  if (next === currentLang()) return;
  localStorage.setItem("ot-lang", next);
  // 先整页换文案（立刻见效），再让各模块补带插值的句子
  applyLangChrome();
  I18N_RENDERERS.forEach(fn => {
    try { fn(); } catch (error) { console.error("[ot] 语言切换重绘失败:", error); }
  });
}

// 整页文本替换：文本节点与常见属性，按「去首尾空白后的核心」比对，
// 缩进留在外面，这样不依赖记住原文也能来回切。
const I18N_TEXT_ATTRS = ["placeholder", "title", "aria-label", "alt", "aria-description"];

function applyStaticI18n(root = document) {
  const map = buildLangMap(currentLang());
  if (!map.size) return;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  nodes.forEach(node => {
    const raw = node.nodeValue;
    const match = raw.match(/^(\s*)([\s\S]*?)(\s*)$/);
    if (!match || !match[2]) return;
    const text = map.get(match[2]);
    if (text !== undefined) node.nodeValue = match[1] + text + match[3];
  });

  root.querySelectorAll("*").forEach(el => {
    I18N_TEXT_ATTRS.forEach(attr => {
      const value = el.getAttribute(attr);
      if (!value) return;
      const text = map.get(value.trim());
      if (text !== undefined) el.setAttribute(attr, text);
    });
    // value 只在输入框的预填值上换（占位展示），用户已填的内容不动
    if (el.tagName === "INPUT" && el.type !== "password" && el.hasAttribute("value")) {
      const value = el.getAttribute("value") || "";
      const text = map.get(value.trim());
      if (text !== undefined) el.setAttribute("value", text);
    }
  });
}

function applyLangChrome() {
  document.documentElement.lang = currentLang() === "en" ? "en" : "zh-CN";
  applyStaticI18n();
}

// 词表在 i18n_en.js 里，得等它加载完；DOMContentLoaded 也保证静态节点已就位
if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", applyLangChrome);
  } else {
    applyLangChrome();
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    t, setLang, currentLang, applyStaticI18n, applyLangChrome,
    buildLangMap, onLangChange, I18N,
  };
}
