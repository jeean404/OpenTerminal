"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  rowsForPx, blankRun, padGap,
} = require("../../src/openterminal/web/frontend/static/pad_ledger.js");

test("rowsForPx: 向上取整，最小 1 行", () => {
  assert.equal(rowsForPx(10, 15), 1);
  assert.equal(rowsForPx(15, 15), 1);
  assert.equal(rowsForPx(16, 15), 2);
  assert.equal(rowsForPx(0, 15), 1);
  assert.equal(rowsForPx(30, 0), 1);   // cellH 非法兜底 1
});

test("blankRun: 数**连续**空白，遇真实输出即停（不跨输出累加）", () => {
  const lines = ["", "   ", "hello", "", "x"];
  const buf = {
    length: lines.length,
    getLine(i) {
      const t = lines[i];
      if (t === undefined) return undefined;
      return { translateToString: (rtrim) => rtrim ? t.replace(/\s+$/, "") : t };
    },
  };
  assert.equal(blankRun(buf, 0, 5), 2);   // "" / "   " 后遇 hello 即停
  assert.equal(blankRun(buf, 3, 5), 1);   // "" 后遇 x 即停
  assert.equal(blankRun(buf, 2, 5), 0);   // 起点就是输出行
  assert.equal(blankRun(buf, 0, 0), 0);
});

test("blankRun: 受 limit 夹紧；limit 在起点之前 = 0；越界缺行视为空白", () => {
  const lines = ["a", "", "  ", "b"];
  const buf = {
    length: 99,
    getLine(i) {
      const t = lines[i];
      if (t === undefined) return { translateToString: () => "" }; // 缺行视为空白
      return { translateToString: (rtrim) => rtrim ? t.replace(/\s+$/, "") : t };
    },
  };
  assert.equal(blankRun(buf, 1, 3), 2);   // "" 与 "  " 判空，止于 limit
  assert.equal(blankRun(buf, 1, 9), 2);   // 遇 b（真实输出）即停，不跨输出累加
  assert.equal(blankRun(buf, 4, 9), 5);   // b 之后越界缺行全空白
  assert.equal(blankRun(buf, 4, 3), 0);   // limit < 起点：区宽 0
  assert.equal(blankRun(null, 0, 5), 0);
});

test("blankRun: 整行空格（zsh 重画提示符的擦痕）判空白，不掐断 run", () => {
  // translateToString(true) 只裁到「最后写入的单元格」：擦过的行返回整行空格
  // 而非空串。真机流底卡的空白 run 就是被这种空格行掐断 → 出生即盖帽。
  const lines = ["", "          ", "", "x"];
  const buf = {
    length: lines.length,
    getLine(i) {
      const t = lines[i];
      if (t === undefined) return undefined;
      return { translateToString: () => t };   // 不做右裁：原样返回空格
    },
  };
  assert.equal(blankRun(buf, 0, 4), 3);   // 空格行算空白，止于 x
  assert.equal(blankRun(buf, 1, 4), 2);
});

test("padGap: 只补真缺口（need 减区内已有空白），永不为负", () => {
  assert.equal(padGap(5, 0), 5);
  assert.equal(padGap(5, 2), 3);
  assert.equal(padGap(5, 5), 0);
  assert.equal(padGap(5, 9), 0);   // 超额垫过也不回吐
});
