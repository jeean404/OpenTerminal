"use strict";

// 界面语言：中文（默认）/ English。
//
// 词表用**中文原文当 key**（gettext 风格）：漏翻的地方自动回落原文，也不用
// 为了起键名再发明一套标识符；插值用位置占位符 {0} {1}，让译文可以调换语序。
//
// 切换语言走「落盘 + 整页刷新」而不是就地重绘：界面文案散落在十几个渲染函数
// 里，逐个挂重绘钩子必然漏，刷新一次才是真的「全站换语言」。

const I18N = { zh: {}, en: {} };

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

function setLang(lang) {
  const next = lang === "en" ? "en" : "zh";
  if (next === currentLang()) return;
  localStorage.setItem("ot-lang", next);
  location.reload();
}

// 静态 HTML（index.html）没法调 t()：启动时扫一遍文本节点与属性，按原文查表。
// 不给 HTML 加 data-i18n 属性，是因为那样要给上百处手工标注，漏一处就是半中半英。
// 文本节点只比对「去首尾空白后的核心」，缩进留在外面，键才干净。
const I18N_TEXT_ATTRS = ["placeholder", "title", "aria-label", "alt", "aria-description"];

function applyStaticI18n(root = document) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  nodes.forEach(node => {
    const raw = node.nodeValue;
    const match = raw.match(/^(\s*)([\s\S]*?)(\s*)$/);
    if (!match || !match[2]) return;
    const text = t(match[2]);
    if (text !== match[2]) node.nodeValue = match[1] + text + match[3];
  });
  root.querySelectorAll("*").forEach(el => {
    I18N_TEXT_ATTRS.forEach(attr => {
      const value = el.getAttribute(attr);
      if (!value) return;
      const text = t(value.trim());
      if (text !== value.trim()) el.setAttribute(attr, text);
    });
    // value 只在输入框的预填值上翻（占位展示），用户已填的内容不动
    if (el.tagName === "INPUT" && el.type !== "password" && el.hasAttribute("value")) {
      const value = el.getAttribute("value") || "";
      const text = t(value.trim());
      if (text !== value.trim()) el.setAttribute("value", text);
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
  module.exports = {t, setLang, currentLang, applyStaticI18n, applyLangChrome, I18N};
}
