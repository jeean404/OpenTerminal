"use strict";


function _t(key, ...args) {
  // node 测试单独 require 本文件时全局 t 不存在：回落原文，但占位符仍要替换，
  // 否则断言会拿到带 {0} 的键
  const text = (typeof t === "function") ? t(key) : key;
  if (!args.length) return text;
  return String(text).replace(/\{(\d+)\}/g, (whole, n) =>
    args[Number(n)] === undefined ? whole : String(args[Number(n)]));
}

// 工具（MCP）设置页：服务器卡片 + 启停 + 连接测试（展开看 tools 列表）。
// 数据面走 /api/mcp-servers*（见 web/tools_api.py）。

const TOOLS_PANEL = () => document.querySelector('[data-settings-panel="tools"]');

async function toolsRequest(url, options = {}) {
  const response = await authFetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.detail || _t("请求失败 ({0})", response.status));
  return body;
}

function toolsToast(message, bad = false) {
  const panel = TOOLS_PANEL();
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
  clearTimeout(toolsToast._timer);
  toolsToast._timer = setTimeout(() => toast.classList.remove("show"), 2600);
}

function mcpSummary(server) {
  return server.transport === "stdio"
    ? [server.command, ...(server.args || [])].filter(Boolean).join(" ")
    : server.url;
}

function renderMcpCards(servers) {
  const grid = document.getElementById("tools-list");
  if (!grid) return;
  if (!servers.length) {
    grid.innerHTML = `
      <div class="settings-empty">
        <strong>${_t("还没有 MCP 服务器")}</strong>
        <span>${_t("接入 MCP 服务器后，智能体会多出它提供的工具。")}</span>
      </div>`;
    return;
  }
  grid.innerHTML = servers.map(server => `
    <article class="mcp-card${server.enabled ? "" : " mcp-card-off"}" data-mcp="${esc(server.id)}">
      <button type="button" class="skill-remove" data-mcp-action="delete"
              data-id="${esc(server.id)}" title="${_t("删除服务器")}"
              aria-label="${_t("删除服务器：{0}", esc(server.name))}">×</button>
      <div class="skill-card-head">
        <span class="skill-mark" aria-hidden="true">${esc(server.name.slice(0, 1).toUpperCase())}</span>
        <div class="skill-card-title">
          <strong>${esc(server.name)}</strong>
          <small>${esc(server.transport_label)}</small>
        </div>
      </div>
      <p class="mcp-endpoint"><code>${esc(mcpSummary(server))}</code></p>
      <footer class="skill-card-foot">
        <span class="mcp-actions">
          <button type="button" class="settings-secondary settings-btn-sm"
                  data-mcp-action="probe" data-id="${esc(server.id)}">${_t("连接测试")}</button>
          <button type="button" class="settings-secondary settings-btn-sm"
                  data-mcp-action="edit" data-id="${esc(server.id)}">${_t("编辑")}</button>
        </span>
        <label class="switch" title="${server.enabled ? _t("点击停用") : _t("点击启用")}">
          <input type="checkbox" data-mcp-action="toggle"
                 data-id="${esc(server.id)}" ${server.enabled ? "checked" : ""}
                 aria-label="${_t("{0}服务器：{1}", server.enabled ? _t("停用") : _t("启用"), esc(server.name))}">
          <span class="switch-track" aria-hidden="true"></span>
        </label>
      </footer>
      <div class="mcp-tools" data-mcp-tools="${esc(server.id)}" hidden></div>
    </article>`).join("");

  // 同 skills：开关的点击/按键不许冒泡到卡片
  grid.querySelectorAll(".mcp-card .switch").forEach(sw => {
    ["click", "keydown"].forEach(kind =>
      sw.addEventListener(kind, event => event.stopPropagation()));
  });
  grid.querySelectorAll("[data-mcp-action]").forEach(el => {
    el.addEventListener("click", event => event.stopPropagation());
    const id = el.dataset.id;
    if (el.dataset.mcpAction === "delete") {
      el.onclick = () => confirmDeleteMcp(id);
    } else if (el.dataset.mcpAction === "edit") {
      el.onclick = () => openMcpImport(servers.find(item => item.id === id));
    } else if (el.dataset.mcpAction === "probe") {
      el.onclick = () => probeMcp(id, el);
    } else {
      el.onchange = () => toggleMcp(id, el.checked);
    }
  });
}

async function loadTools() {
  const grid = document.getElementById("tools-list");
  if (!grid) return;
  grid.innerHTML = `<p class="settings-loading">${_t("正在加载 MCP 服务器…")}</p>`;
  try {
    const data = await toolsRequest("/api/mcp-servers");
    renderMcpCards(data.servers);
  } catch (error) {
    grid.innerHTML = `<p class="mp-error">${_t("加载工具配置失败：{0}", esc(error.message))}</p>`;
  }
}

async function toggleMcp(id, enabled) {
  try {
    await toolsRequest(`/api/mcp-servers/${encodeURIComponent(id)}/enabled`, {
      method: "POST",
      body: JSON.stringify({enabled}),
    });
    toolsToast(enabled ? _t("已启用，新建的终端会加载它的工具") : _t("已停用，新建的终端不再加载它的工具"));
    await loadTools();
  } catch (error) {
    toolsToast(_t("设置失败：{0}", error.message), true);
    await loadTools();
  }
}

function confirmDeleteMcp(id) {
  const card = document.querySelector(`[data-mcp="${CSS.escape(id)}"]`);
  const name = card ? (card.querySelector(".skill-card-title strong") || {}).textContent : id;
  modalConfirm(_t("删除 MCP 服务器"), _t("确定删除「{0}」吗？它提供的工具将不再可用。", name), async ok => {
    if (!ok) return;
    try {
      await toolsRequest(`/api/mcp-servers/${encodeURIComponent(id)}`, {method: "DELETE"});
      toolsToast(_t("已删除「{0}」", name));
    } catch (error) {
      toolsToast(_t("删除失败：{0}", error.message), true);
    }
    await loadTools();
  }, _t("删除"), _t("取消"));
}

async function probeMcp(id, button) {
  const box = document.querySelector(`[data-mcp-tools="${CSS.escape(id)}"]`);
  if (!box) return;
  box.hidden = false;
  box.innerHTML = `<p class="settings-loading">${_t("正在连接并拉取工具列表…")}</p>`;
  if (button) button.disabled = true;
  try {
    const result = await toolsRequest(`/api/mcp-servers/${encodeURIComponent(id)}/probe`,
      {method: "POST"});
    if (!result.ok) {
      box.innerHTML = `<p class="mp-error">${_t("连接失败：{0}", esc(result.error))}</p>`;
      return;
    }
    if (!result.tools.length) {
      box.innerHTML = `<p class="wallpaper-status">${_t("连接成功，但服务器没有暴露任何工具。")}</p>`;
      return;
    }
    box.innerHTML = `
      <p class="wallpaper-status">${_t("连接成功，共 {0} 个工具：", result.tools.length)}</p>
      <ul class="mcp-tool-list">
        ${result.tools.map(tool => `
          <li>
            <code>${esc(tool.name)}</code>
            <p>${esc(tool.description || "（无描述）")}</p>
          </li>`).join("")}
      </ul>`;
  } catch (error) {
    box.innerHTML = `<p class="mp-error">${_t("连接失败：{0}", esc(error.message))}</p>`;
  } finally {
    if (button) button.disabled = false;
  }
}

// 支持 Claude Desktop / .mcp.json 的标准写法（{"mcpServers": {...}}），也接受
// 去掉包装层的裸映射。同名更新、新名新增，一次可导入多个。
const MCP_JSON_TEMPLATE = `{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:/data"],
      "env": { "API_TOKEN": "xxx" }
    },
    "remote-tools": {
      "type": "http",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer xxx" }
    }
  }
}`;

function mcpServerToConfig(server) {
  if (server.transport === "stdio") {
    return { command: server.command, args: server.args || [], env: server.env || {} };
  }
  return {
    type: server.transport === "sse" ? "sse" : "http",
    url: server.url,
    headers: server.headers || {},
  };
}

function openMcpImport(server = null) {
  const editing = Boolean(server);
  const initial = editing
    ? JSON.stringify({ mcpServers: { [server.name]: mcpServerToConfig(server) } }, null, 2)
    : MCP_JSON_TEMPLATE;
  const markup = `
    <div class="mp-form mp-form-json">
      <p class="skill-add-hint">${_t("粘贴 MCP 配置 JSON（Claude Desktop / .mcp.json 格式）。同名服务器会被更新，新名字新增，一次可导入多个。")}</p>
      <label class="mp-wide">${_t("MCP 配置（JSON）")}
        <textarea id="mcp-json" rows="16" spellcheck="false"></textarea>
      </label>
      <p class="mp-error mp-wide" id="mcp-error" hidden></p>
    </div>`;

  const close = modalShell(
    editing ? _t("编辑 MCP 服务器") : _t("导入 MCP 服务器"), markup, [
    {label: _t("导入"), primary: true, onClick: async () => {
      const errorEl = document.getElementById("mcp-error");
      errorEl.hidden = true;
      const box = document.getElementById("mcp-json");
      try {
        const result = await toolsRequest("/api/mcp-servers/import", {
          method: "POST",
          body: JSON.stringify({ config: box.value }),
        });
        const added = (result.added || []).length;
        const updated = (result.updated || []).length;
        toolsToast(added && updated ? _t("已导入：新增 {0} 个、更新 {1} 个", added, updated)
          : added ? _t("已导入 {0} 个服务器", added)
          : _t("已更新 {0} 个服务器", updated));
        await loadTools();
        return true;
      } catch (error) {
        errorEl.textContent = error.message;
        errorEl.hidden = false;
        box.focus();
        return false;
      }
    }},
    {label: _t("取消")},
  ]);

  const box = document.getElementById("mcp-json");
  if (box) {
    box.value = initial;
    box.focus();
  }
  return close;
}

function initToolsPanel() {
  const add = document.getElementById("btn-add-mcp");
  if (add) add.onclick = () => openMcpImport();
}

initToolsPanel();

// 语言切换：卡片文案重绘一遍（整页文本替换覆盖不到动态生成的插值句）
if (typeof onLangChange === "function") onLangChange(loadTools);
