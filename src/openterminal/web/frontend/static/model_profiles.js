"use strict";


function _t(key, ...args) {
  // node 测试单独 require 本文件时全局 t 不存在：回落原文，但占位符仍要替换，
  // 否则断言会拿到带 {0} 的键
  const text = (typeof t === "function") ? t(key) : key;
  if (!args.length) return text;
  return String(text).replace(/\{(\d+)\}/g, (whole, n) =>
    args[Number(n)] === undefined ? whole : String(args[Number(n)]));
}

async function modelProfileRequest(url, options = {}) {
  const response = await authFetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.detail || _t("请求失败 ({0})", response.status));
  return body;
}

async function showModelProfiles() {
  const list = document.getElementById("model-profile-list");
  list.innerHTML = `<p class="settings-loading">${_t("正在加载模型配置…")}</p>`;
  try {
    const data = await modelProfileRequest("/api/model-profiles");
    if (!data.profiles.length) {
      list.innerHTML = `
        <div class="settings-empty">
          <strong>${_t("还没有模型配置")}</strong>
          <span>${_t("添加一个模型服务后，即可在创建新终端时使用。")}</span>
        </div>`;
      return;
    }
    list.innerHTML = data.profiles.map(profile => `
      <article class="settings-model-row">
        <div class="settings-model-mark">${esc(profile.provider === "openai" ? "O" : "A")}</div>
        <div class="settings-model-summary">
          <div class="settings-model-title">
            <strong>${esc(profile.name)}</strong>
            ${profile.id === data.active_id ? `<span class="mp-active">${_t("已启用")}</span>` : ""}
          </div>
          <span>${esc(profile.provider === "openai" ? _t("OpenAI 兼容") : "Anthropic")} · ${esc(profile.model)}</span>
          <small>${esc(profile.base_url || _t("官方端点"))}${profile.has_api_key ? _t(" · API Key 已保存") : ""}</small>
        </div>
        <div class="settings-model-actions">
          ${profile.id === data.active_id ? "" :
            `<button type="button" data-mp-action="activate" data-id="${esc(profile.id)}">${_t("启用")}</button>`}
          <button type="button" data-mp-action="edit" data-id="${esc(profile.id)}">${_t("编辑")}</button>
          <button type="button" data-mp-action="delete" data-id="${esc(profile.id)}">${_t("删除")}</button>
        </div>
      </article>`).join("");
    list.querySelectorAll("[data-mp-action]").forEach(button => {
      button.onclick = () => handleModelProfileAction(button.dataset.mpAction, button.dataset.id, data);
    });
  } catch (error) {
    list.innerHTML = `<p class="mp-error">${_t("加载模型配置失败：{0}", esc(error.message))}</p>`;
  }
}

function openModelProfileForm(profile = null) {
  const editing = Boolean(profile);
  const markup = `
    <form id="mp-form" class="mp-form">
      <label>${_t("配置名称")}<input name="name" required maxlength="80" placeholder="${_t("例如：公司网关")}"></label>
      <label>${_t("协议")}<select name="provider">
        <option value="anthropic">Anthropic</option>
        <option value="openai">${_t("OpenAI 兼容")}</option>
      </select></label>
      <label class="mp-wide">URL<input name="base_url" type="url" placeholder="https://api.example.com/v1"></label>
      <label class="mp-wide">${_t("模型名称")}<input name="model" required placeholder="${_t("claude-sonnet-4-6 或 gpt-5")}"></label>
      <label class="mp-wide">API Key<input name="api_key" type="password" autocomplete="new-password"
        placeholder="${editing ? _t("留空表示不修改") : _t("输入服务商提供的 API Key")}"></label>
      ${editing ? `<label class="mp-clear mp-wide"><input name="clear_api_key" type="checkbox"> ${_t("清除已保存的 API Key")}</label>` : ""}
      <p class="mp-error mp-wide" id="mp-error" hidden></p>
    </form>`;
  const close = modalShell(editing ? _t("编辑模型配置") : _t("添加模型配置"), markup, [
    {label: _t("保存配置"), primary: true, onClick: async () => {
      const form = document.getElementById("mp-form");
      if (!form.reportValidity()) return false;
      const values = Object.fromEntries(new FormData(form).entries());
      const payload = {
        name: values.name,
        provider: values.provider,
        base_url: values.base_url,
        model: values.model,
        api_key: values.api_key,
        clear_api_key: Boolean(form.elements.clear_api_key?.checked),
      };
      try {
        const url = editing
          ? `/api/model-profiles/${encodeURIComponent(profile.id)}`
          : "/api/model-profiles";
        await modelProfileRequest(url, {
          method: editing ? "PUT" : "POST",
          body: JSON.stringify(payload),
        });
        await showModelProfiles();
        return true;
      } catch (error) {
        const errorEl = document.getElementById("mp-error");
        errorEl.textContent = error.message;
        errorEl.hidden = false;
        return false;
      }
    }},
    {label: _t("取消")},
  ]);
  const form = document.getElementById("mp-form");
  if (editing) {
    form.elements.name.value = profile.name;
    form.elements.provider.value = profile.provider;
    form.elements.base_url.value = profile.base_url;
    form.elements.model.value = profile.model;
    form.elements.clear_api_key.checked = false;
  }
  form.elements.name.focus();
  return close;
}

async function handleModelProfileAction(action, id, data) {
  try {
    if (action === "edit") {
      openModelProfileForm(data.profiles.find(profile => profile.id === id));
      return;
    }
    if (action === "activate") {
      await modelProfileRequest(`/api/model-profiles/${encodeURIComponent(id)}/activate`,
        {method: "POST"});
    } else {
      const profile = data.profiles.find(item => item.id === id);
      modalConfirm(_t("删除模型配置"), _t("确定删除“{0}”吗？", profile.name), async ok => {
        if (!ok) return;
        try {
          await modelProfileRequest(`/api/model-profiles/${encodeURIComponent(id)}`,
            {method: "DELETE"});
          await showModelProfiles();
        } catch (error) {
          modalShell(_t("删除失败"), `<p class="mp-error">${esc(error.message)}</p>`, [
            {label: _t("关闭"), primary: true},
          ]);
        }
      }, _t("删除"), _t("取消"));
      return;
    }
    await showModelProfiles();
  } catch (error) {
    const list = document.getElementById("model-profile-list");
    list.insertAdjacentHTML("afterbegin",
      `<p class="mp-error">${_t("操作失败：{0}", esc(error.message))}</p>`);
  }
}

document.getElementById("btn-add-model-profile").onclick = () => openModelProfileForm();

// 语言切换：列表行重绘一遍
if (typeof onLangChange === "function") onLangChange(showModelProfiles);
