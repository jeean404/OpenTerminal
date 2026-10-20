"use strict";

async function modelProfileRequest(url, options = {}) {
  const response = await authFetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.detail || `请求失败 (${response.status})`);
  return body;
}

async function showModelProfiles() {
  let data;
  try {
    data = await modelProfileRequest("/api/model-profiles");
  } catch (error) {
    modalShell("模型配置", `<p class="mp-error">${esc(error.message)}</p>`, [
      {label: "关闭", primary: true},
    ]);
    return;
  }

  const rows = data.profiles.map(profile => `
    <div class="mp-row">
      <div class="mp-summary">
        <strong>${esc(profile.name)}</strong>
        <span>${esc(profile.provider)} · ${esc(profile.model)}</span>
        <small>${esc(profile.base_url || "官方端点")}${profile.has_api_key ? " · Key 已保存" : ""}</small>
      </div>
      ${profile.id === data.active_id ? '<span class="mp-active">已启用</span>' :
        `<button type="button" data-mp-action="activate" data-id="${esc(profile.id)}">启用</button>`}
      <button type="button" data-mp-action="edit" data-id="${esc(profile.id)}">编辑</button>
      <button type="button" data-mp-action="delete" data-id="${esc(profile.id)}">删除</button>
    </div>`).join("");
  const markup = `
    <div class="mp-list">${rows || '<p class="mp-empty">还没有模型配置，请在下方添加。</p>'}</div>
    <form id="mp-form" class="mp-form">
      <h4 id="mp-form-title">添加配置</h4>
      <label>配置名称<input name="name" required maxlength="80" placeholder="例如：公司网关"></label>
      <label>协议<select name="provider">
        <option value="anthropic">Anthropic</option>
        <option value="openai">OpenAI 兼容</option>
      </select></label>
      <label>URL<input name="base_url" type="url" placeholder="https://api.example.com/v1"></label>
      <label>模型<input name="model" required placeholder="claude-sonnet-4-6 或 gpt-5"></label>
      <label>API Key<input name="api_key" type="password" autocomplete="new-password"
        placeholder="新建时填写；编辑时留空表示不修改"></label>
      <label class="mp-clear"><input name="clear_api_key" type="checkbox"> 清除已保存的 API Key</label>
      <p class="mp-error" id="mp-error" hidden></p>
    </form>`;

  modalShell("模型配置", markup, [
    {label: "添加 / 保存", primary: true, onClick: async () => {
      const form = document.getElementById("mp-form");
      const values = Object.fromEntries(new FormData(form).entries());
      const payload = {
        name: values.name,
        provider: values.provider,
        base_url: values.base_url,
        model: values.model,
        api_key: values.api_key,
        clear_api_key: form.elements.clear_api_key.checked,
      };
      try {
        const url = form.dataset.id
          ? `/api/model-profiles/${encodeURIComponent(form.dataset.id)}`
          : "/api/model-profiles";
        await modelProfileRequest(url, {
          method: form.dataset.id ? "PUT" : "POST",
          body: JSON.stringify(payload),
        });
        await showModelProfiles();
        return false;
      } catch (error) {
        const errorEl = document.getElementById("mp-error");
        errorEl.textContent = error.message;
        errorEl.hidden = false;
        return false;
      }
    }},
    {label: "关闭"},
  ]);

  const form = document.getElementById("mp-form");
  document.querySelectorAll("#modal-root [data-mp-action]").forEach(button => {
    button.onclick = async () => {
      const id = button.dataset.id;
      try {
        if (button.dataset.mpAction === "edit") {
          const profile = data.profiles.find(item => item.id === id);
          form.dataset.id = id;
          form.elements.name.value = profile.name;
          form.elements.provider.value = profile.provider;
          form.elements.base_url.value = profile.base_url;
          form.elements.model.value = profile.model;
          form.elements.api_key.value = "";
          form.elements.clear_api_key.checked = false;
          document.getElementById("mp-form-title").textContent = "编辑配置";
          return;
        }
        if (button.dataset.mpAction === "activate") {
          await modelProfileRequest(`/api/model-profiles/${encodeURIComponent(id)}/activate`,
            {method: "POST"});
        } else {
          await modelProfileRequest(`/api/model-profiles/${encodeURIComponent(id)}`,
            {method: "DELETE"});
        }
        await showModelProfiles();
      } catch (error) {
        const errorEl = document.getElementById("mp-error");
        errorEl.textContent = error.message;
        errorEl.hidden = false;
      }
    };
  });
}

document.getElementById("btn-model-profiles").onclick = showModelProfiles;
