"use strict";


function _t(key, ...args) {
  // node 测试单独 require 本文件时全局 t 不存在：回落原文，但占位符仍要替换，
  // 否则断言会拿到带 {0} 的键
  const text = (typeof t === "function") ? t(key) : key;
  if (!args.length) return text;
  return String(text).replace(/\{(\d+)\}/g, (whole, n) =>
    args[Number(n)] === undefined ? whole : String(args[Number(n)]));
}

// 技能设置页：卡片列表 + 详情页 + 增删与启停。
// 数据面走 /api/skills*（见 web/skills_api.py）；启停是热生效的——agent 侧
// 每轮组装提示词时才过滤清单（skills/gating.py），所以关掉后不用重建会话。

const SKILLS_PANEL = () => document.querySelector('[data-settings-panel="skills"]');

async function skillsRequest(url, options = {}) {
  const response = await authFetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.detail || _t("请求失败 ({0})", response.status));
  return body;
}

function skillToast(message, bad = false) {
  const panel = SKILLS_PANEL();
  if (!panel) return;
  let toast = panel.querySelector(".skill-toast");
  if (!toast) {
    toast = document.createElement("p");
    toast.className = "skill-toast";
    toast.setAttribute("role", "status");
    panel.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.toggle("bad", bad);
  toast.classList.add("show");
  clearTimeout(skillToast._timer);
  skillToast._timer = setTimeout(() => toast.classList.remove("show"), 2600);
}

function skillMetaLine(skill) {
  const tags = [];
  tags.push(skill.builtin ? _t("内置技能") : _t("我的技能"));
  if (skill.overridden) tags.push(_t("已覆盖内置版"));
  return tags.join(" · ");
}

function renderSkillCards(skills) {
  const grid = document.getElementById("skills-list");
  if (!grid) return;
  if (!skills.length) {
    grid.innerHTML = `
      <div class="settings-empty">
        <strong>${_t("还没有技能")}</strong>
        <span>${_t("上传 SKILL.md 或从本机目录导入，就能让智能体多一项能力。")}</span>
      </div>`;
    return;
  }
  grid.innerHTML = skills.map(skill => `
    <article class="skill-card${skill.enabled ? "" : " skill-card-off"}"
             data-skill="${esc(skill.name)}" tabindex="0" role="button"
             aria-label="${_t("查看技能详情：{0}", esc(skill.name))}">
      ${skill.builtin ? "" : `
        <button type="button" class="skill-remove" data-skill-action="delete"
                data-name="${esc(skill.name)}" title="${_t("删除技能")}"
                aria-label="${_t("删除技能：{0}", esc(skill.name))}">×</button>`}
      <div class="skill-card-head">
        <span class="skill-mark" aria-hidden="true">${esc(skill.name.slice(0, 1).toUpperCase())}</span>
        <div class="skill-card-title">
          <strong>${esc(skill.name)}</strong>
          <small>${esc(skillMetaLine(skill))}</small>
        </div>
      </div>
      <p class="skill-desc">${esc(skill.description)}</p>
      <footer class="skill-card-foot">
        <span class="skill-size">${_t("{0} 个文件 · {1}", skill.file_count, fmtSkillSize(skill.size))}</span>
        <label class="switch" title="${skill.enabled ? _t("点击停用") : _t("点击启用")}">
          <input type="checkbox" data-skill-action="toggle"
                 data-name="${esc(skill.name)}" ${skill.enabled ? "checked" : ""}
                 aria-label="${_t("{0}技能：{1}", skill.enabled ? _t("停用") : _t("启用"), esc(skill.name))}">
          <span class="switch-track" aria-hidden="true"></span>
        </label>
      </footer>
    </article>`).join("");

  grid.querySelectorAll("[data-skill-action]").forEach(el => {
    el.addEventListener("click", event => event.stopPropagation());
    if (el.dataset.skillAction === "delete") {
      el.onclick = event => {
        event.stopPropagation();
        confirmDeleteSkill(el.dataset.name);
      };
    } else {
      el.onchange = () => toggleSkill(el.dataset.name, el.checked);
    }
  });
  // 开关在 label 里，点轨道冒泡到卡片会被当成「进详情」——必须在 label 层拦掉
  grid.querySelectorAll(".skill-card .switch").forEach(sw => {
    ["click", "keydown"].forEach(kind =>
      sw.addEventListener(kind, event => event.stopPropagation()));
  });
  // 整卡可点进详情（开关与删除键已 stopPropagation，不会误触发）
  grid.querySelectorAll(".skill-card").forEach(card => {
    card.onclick = () => openSkillDetail(card.dataset.skill);
    card.onkeydown = event => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openSkillDetail(card.dataset.skill);
      }
    };
  });
}

function fmtSkillSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function loadSkills() {
  const grid = document.getElementById("skills-list");
  if (!grid) return;
  grid.innerHTML = `<p class="settings-loading">${_t("正在加载技能…")}</p>`;
  try {
    const data = await skillsRequest("/api/skills");
    renderSkillCards(data.skills);
  } catch (error) {
    grid.innerHTML = `<p class="mp-error">${_t("加载技能失败：{0}", esc(error.message))}</p>`;
  }
}

async function toggleSkill(name, enabled) {
  try {
    await skillsRequest(`/api/skills/${encodeURIComponent(name)}/enabled`, {
      method: "POST",
      body: JSON.stringify({enabled}),
    });
    // 卡片的置灰态是渲染时定的，这里跟着改，否则界面上看不出开关到底生效没有
    const card = document.querySelector(
      `.skill-card[data-skill="${CSS.escape(name)}"]`);
    if (card) card.classList.toggle("skill-card-off", !enabled);
    skillToast(_t("{0} 已{1}，下一轮对话即生效", name, enabled ? _t("启用") : _t("停用")));
  } catch (error) {
    skillToast(_t("设置失败：{0}", error.message), true);
    await loadSkills();
  }
}

function confirmDeleteSkill(name) {
  const message = _t("确定删除「{0}」吗？删除后无法恢复。", name)
    + _t("若系统内置技能里也有同名技能，删除后会回退到内置版本。");
  modalConfirm(_t("删除技能"), message, async ok => {
    if (!ok) return;
    try {
      const result = await skillsRequest(`/api/skills/${encodeURIComponent(name)}`,
        {method: "DELETE"});
      skillToast(result.reverted_to_builtin
        ? _t("已删除我的技能「{0}」，现在使用内置版本", name)
        : _t("已删除技能「{0}」", name));
    } catch (error) {
      skillToast(_t("删除失败：{0}", error.message), true);
    }
    await loadSkills();
  }, _t("删除"), _t("取消"));
}

// --- 详情页（卡片页 ⇄ 详情页来回切，与 section 切换互不干扰） ---

function showSkillsView(view) {
  const panel = SKILLS_PANEL();
  if (!panel) return;
  panel.dataset.skillView = view;
  const grid = document.getElementById("skills-list");
  const detail = document.getElementById("skills-detail");
  const heading = panel.querySelector(".settings-section-heading");
  if (grid) grid.hidden = view !== "list";
  if (detail) detail.hidden = view !== "detail";
  if (heading) heading.hidden = view !== "list";
  const back = document.getElementById("btn-skill-back");
  if (back) back.hidden = view !== "detail";
}

async function openSkillDetail(name) {
  const detail = document.getElementById("skills-detail");
  if (!detail) return;
  detail.innerHTML = `<p class="settings-loading">${_t("正在加载技能详情…")}</p>`;
  showSkillsView("detail");
  try {
    const skill = await skillsRequest(`/api/skills/${encodeURIComponent(name)}`);
    renderSkillDetail(skill);
  } catch (error) {
    detail.innerHTML = `
      <p class="mp-error">${_t("加载技能详情失败：{0}", esc(error.message))}</p>
      <button type="button" class="settings-secondary" id="btn-skill-back-inline">${_t("← 返回技能列表")}</button>`;
    const inline = document.getElementById("btn-skill-back-inline");
    if (inline) inline.onclick = () => {
      showSkillsView("list");
      loadSkills();
    };
  }
}

function renderSkillDetail(skill) {
  const detail = document.getElementById("skills-detail");
  // 记住当前详情页是哪个 skill：语言切换时要在原地重绘它，不能丢上下文
  detail.dataset.skillName = skill.name;
  detail.innerHTML = `
    <div class="skill-detail-head">
      <div class="skill-detail-title">
        <span class="skill-mark skill-mark-lg" aria-hidden="true">${esc(skill.name.slice(0, 1).toUpperCase())}</span>
        <div>
          <h3>${esc(skill.name)}</h3>
          <p class="skill-detail-sub">${esc(skillMetaLine(skill))}</p>
        </div>
      </div>
      <label class="switch" title="${skill.enabled ? _t("点击停用") : _t("点击启用")}">
        <input type="checkbox" id="skill-detail-toggle" ${skill.enabled ? "checked" : ""}
               aria-label="${_t("{0}技能", skill.enabled ? _t("停用") : _t("启用"))}">
        <span class="switch-track" aria-hidden="true"></span>
      </label>
    </div>
    <p class="skill-detail-desc">${esc(skill.description)}</p>
    <dl class="skill-detail-meta">
      <div><dt>${_t("模型读取路径")}</dt><dd><code>${esc(skill.path)}</code></dd></div>
      <div><dt>${_t("本机目录")}</dt><dd><code>${esc(skill.dir)}</code></dd></div>
      <div><dt>${_t("文件")}</dt><dd>${skill.files.map(f => `${esc(f.name)}（${fmtSkillSize(f.size)}）`).join("、")}</dd></div>
    </dl>
    <h4 class="skill-detail-h">${_t("技能说明")}</h4>
    <div class="skill-detail-body">${mdLite(skill.body)}</div>
    ${skill.builtin ? "" : `
      <div class="skill-detail-actions">
        <button type="button" class="settings-secondary" id="btn-skill-delete-detail">${_t("删除技能")}</button>
      </div>`}`;

  const toggle = document.getElementById("skill-detail-toggle");
  if (toggle) {
    toggle.onchange = async () => {
      await toggleSkill(skill.name, toggle.checked);
      skill.enabled = toggle.checked;
    };
  }
  const remove = document.getElementById("btn-skill-delete-detail");
  if (remove) remove.onclick = () => confirmDeleteSkill(skill.name);
}

// --- 增加技能：新建 / 上传 / 本机目录导入 ---

function openSkillAdd() {
  const markup = `
    <div class="skill-add">
      <div class="seg skill-add-tabs" role="tablist">
        <button type="button" class="on" data-skill-add="upload">${_t("上传文件")}</button>
        <button type="button" data-skill-add="dir">${_t("本机目录")}</button>
        <button type="button" data-skill-add="new">${_t("新建")}</button>
      </div>
      <div data-skill-add-panel="upload">
        <p class="skill-add-hint">${_t("支持")} <code>.md</code>${_t("（须含 name / description 的 YAML 头）或")}
          <code>.zip</code>${_t("（内含 SKILL.md 的一个或多个技能目录）。")}</p>
        <label class="skill-file-drop" for="skill-file-input" id="skill-file-drop">
          <span class="wallpaper-upload-icon" aria-hidden="true">＋</span>
          <span class="wallpaper-upload-title">${_t("点击选择或拖拽到此处")}</span>
          <span class="wallpaper-upload-hint">.md / .zip，≤ 8 MB</span>
        </label>
        <input id="skill-file-input" type="file" accept=".md,.zip,text/markdown,application/zip" hidden>
        <p class="wallpaper-status" id="skill-file-name" hidden></p>
      </div>
      <div data-skill-add-panel="dir" hidden>
        <p class="skill-add-hint">${_t("填本机上某个技能目录的绝对路径（该目录内须有 SKILL.md），会整体拷进你的技能库。")}</p>
        <label class="mp-wide">${_t("技能目录")}
          <input id="skill-dir-path" placeholder="${_t("例如：C:\\Users\\me\\.claude\\skills\\my-skill")}">
        </label>
      </div>
      <div data-skill-add-panel="new" hidden>
        <label>${_t("名称")}<input id="skill-new-name" maxlength="64" placeholder="${_t("小写字母、数字或连字符")}"></label>
        <label>${_t("描述")}<input id="skill-new-desc" maxlength="1024"
          placeholder="${_t("一句话说清什么时候该用它——模型据此决定是否加载")}"></label>
        <label class="mp-wide">${_t("技能说明（Markdown）")}
          <textarea id="skill-new-body" rows="8" placeholder="${_t("# 标题&#10;&#10;正文…")}"></textarea>
        </label>
      </div>
      <p class="mp-error mp-wide" id="skill-add-error" hidden></p>
    </div>`;

  let mode = "upload";
  const close = modalShell(_t("添加技能"), markup, [
    {label: _t("添加"), primary: true, onClick: async () => {
      const errorEl = document.getElementById("skill-add-error");
      errorEl.hidden = true;
      try {
        if (mode === "upload") await submitSkillUpload();
        else if (mode === "dir") {
          const path = document.getElementById("skill-dir-path").value.trim();
          if (!path) throw new Error(_t("请填写技能目录路径"));
          await skillsRequest("/api/skills/import", {
            method: "POST", body: JSON.stringify({path}),
          });
        } else {
          await skillsRequest("/api/skills", {
            method: "POST",
            body: JSON.stringify({
              name: document.getElementById("skill-new-name").value.trim(),
              description: document.getElementById("skill-new-desc").value.trim(),
              body: document.getElementById("skill-new-body").value,
            }),
          });
        }
        skillToast(_t("技能已添加"));
        await loadSkills();
        return true;
      } catch (error) {
        errorEl.textContent = error.message;
        errorEl.hidden = false;
        return false;
      }
    }},
    {label: _t("取消")},
  ]);

  document.querySelectorAll("[data-skill-add]").forEach(button => {
    button.onclick = () => {
      mode = button.dataset.skillAdd;
      document.querySelectorAll("[data-skill-add]").forEach(other => {
        other.classList.toggle("on", other === button);
      });
      document.querySelectorAll("[data-skill-add-panel]").forEach(panel => {
        panel.hidden = panel.dataset.skillAddPanel !== mode;
      });
    };
  });

  const input = document.getElementById("skill-file-input");
  const drop = document.getElementById("skill-file-drop");
  input.addEventListener("change", () => updateSkillFileLabel());
  drop.addEventListener("dragover", event => {
    event.preventDefault();
    drop.classList.add("dragover");
  });
  drop.addEventListener("dragleave", () => drop.classList.remove("dragover"));
  drop.addEventListener("drop", event => {
    event.preventDefault();
    drop.classList.remove("dragover");
    input.files = event.dataTransfer.files;
    updateSkillFileLabel();
  });
  return close;
}

function updateSkillFileLabel() {
  const input = document.getElementById("skill-file-input");
  const label = document.getElementById("skill-file-name");
  const file = input.files && input.files[0];
  if (label) {
    label.textContent = file ? _t("已选择：{0}", file.name) : "";
    label.hidden = !file;
  }
}

async function submitSkillUpload() {
  const input = document.getElementById("skill-file-input");
  const file = input.files && input.files[0];
  if (!file) throw new Error(_t("请先选择要上传的 .md 或 .zip 文件"));
  const data = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(_t("读取文件失败")));
    reader.onload = () => {
      // ArrayBuffer → base64，避免 btoa 对二进制/多字节文本的坑
      const bytes = new Uint8Array(reader.result);
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      resolve(btoa(binary));
    };
    reader.readAsArrayBuffer(file);
  });
  await skillsRequest("/api/skills/upload", {
    method: "POST",
    body: JSON.stringify({filename: file.name, data}),
  });
}

// --- 入口 ---

function initSkillsPanel() {
  const add = document.getElementById("btn-add-skill");
  if (add) add.onclick = () => openSkillAdd();
  const back = document.getElementById("btn-skill-back");
  if (back) back.onclick = () => {
    showSkillsView("list");
    loadSkills();
  };
}

initSkillsPanel();

// 语言切换：卡片上的「N 个文件 · 大小」带插值，整页文本替换换不回来，得重绘。
// 详情页开着就重绘详情（保住上下文），否则刷卡片列表。
if (typeof onLangChange === "function") {
  onLangChange(() => {
    const detail = document.getElementById("skills-detail");
    if (detail && !detail.hidden && detail.dataset.skillName) {
      openSkillDetail(detail.dataset.skillName);
    } else {
      loadSkills();
    }
  });
}
