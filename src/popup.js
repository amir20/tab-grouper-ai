// src/popup.js
//
// Orchestrates everything:
//   1. Connects to the service worker WebLLM engine
//   2. Queries open tabs
//   3. Sends tab list to the model → gets JSON groupings
//   4. Applies groups via chrome.tabGroups API

import { CreateServiceWorkerMLCEngine } from "@mlc-ai/web-llm";

// ─────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────

const DEFAULT_MODEL = "Phi-3.5-mini-instruct-q4f16_1-MLC";

// JSON schema for structured output — WebLLM will guarantee this shape
const GROUPING_SCHEMA = {
  type: "object",
  properties: {
    groups: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name:   { type: "string" },
          color:  {
            type: "string",
            enum: ["grey","blue","red","yellow","green","pink","purple","cyan","orange"]
          },
          tabIds: { type: "array", items: { type: "integer" } },
        },
        required: ["name", "color", "tabIds"],
      },
    },
  },
  required: ["groups"],
};

const SYSTEM_PROMPT = `You are a browser tab organizer. You MUST group tabs into MULTIPLE groups by topic.

Rules:
- Create between 2 and 8 groups based on tab topics
- NEVER put all tabs in one group — always split by topic
- Group names must be short (2-4 words max)
- Every tab must belong to exactly one group
- Use a different color for each group
- Group by domain AND topic similarity (e.g. two YouTube tabs about different topics may go in different groups)
- Return ONLY valid JSON

Example: if tabs include GitHub, Amazon, YouTube, Gmail, the result should have separate groups like "Dev Tools", "Shopping", "Entertainment", "Email" — NOT one big group.`;

// ─────────────────────────────────────────────────────────────
// DOM refs
// ─────────────────────────────────────────────────────────────

const $dot      = document.getElementById("statusDot");
const $status   = document.getElementById("statusText");
const $progress = document.getElementById("progressWrap");
const $fill     = document.getElementById("progressFill");
const $progLbl  = document.getElementById("progressLabel");
const $tabCount = document.getElementById("tabCount");
const $btnGroup = document.getElementById("btnGroup");
const $results  = document.getElementById("results");
const $list     = document.getElementById("groupList");
const $error    = document.getElementById("errorBox");
const $clear    = document.getElementById("clearBtn");
const $settings = document.getElementById("settingsBtn");
const $badge    = document.getElementById("modelBadge");

// ─────────────────────────────────────────────────────────────
// State helpers
// ─────────────────────────────────────────────────────────────

function setStatus(state, text) {
  $dot.className = `status-dot ${state}`;
  $status.textContent = text;
}

function showProgress(pct, label) {
  $progress.classList.add("visible");
  $fill.style.width = `${pct}%`;
  $progLbl.textContent = label;
}

function hideProgress() {
  $progress.classList.remove("visible");
}

function showError(msg) {
  $error.textContent = msg;
  $error.classList.add("visible");
}

function hideError() {
  $error.classList.remove("visible");
}

function setButtonState(enabled, label = "Group Tabs") {
  $btnGroup.disabled = !enabled;
  $btnGroup.textContent = label;
}

// ─────────────────────────────────────────────────────────────
// Model init
// ─────────────────────────────────────────────────────────────

let engine = null;

async function getModel() {
  const stored = await chrome.storage.local.get("model");
  return stored.model || DEFAULT_MODEL;
}

async function initEngine() {
  const model = await getModel();
  $badge.textContent = model.split("-").slice(0, 3).join("-").toLowerCase();

  setStatus("loading", "Loading model…");
  setButtonState(false);

  engine = await CreateServiceWorkerMLCEngine(model, {
    initProgressCallback: (progress) => {
      const pct = Math.round((progress.progress ?? 0) * 100);
      showProgress(pct, progress.text || "Downloading model…");
      setStatus("loading", `Downloading… ${pct}%`);
    },
  });

  hideProgress();
  setStatus("ready", "Model ready");
  setButtonState(true);
}

// ─────────────────────────────────────────────────────────────
// Tab utilities
// ─────────────────────────────────────────────────────────────

async function getCurrentTabs() {
  return chrome.tabs.query({ currentWindow: true });
}

function formatTabsForPrompt(tabs) {
  return tabs
    .map((t) => `id:${t.id} title:"${sanitize(t.title)}" url:"${sanitize(t.url)}"`)
    .join("\n");
}

// Strip quotes/newlines that could break the prompt
function sanitize(str = "") {
  return str.replace(/["'\n\r]/g, " ").slice(0, 120);
}

// ─────────────────────────────────────────────────────────────
// AI grouping
// ─────────────────────────────────────────────────────────────

async function getGroupingsFromModel(tabs, retried = false) {
  const tabList = formatTabsForPrompt(tabs);

  let reply;
  try {
    reply = await engine.chat.completions.create({
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user",   content: `Here are my open tabs:\n${tabList}\n\nGroup them:` },
    ],
    response_format: {
      type: "json_object",
      schema: JSON.stringify(GROUPING_SCHEMA),
    },
    temperature: 0.1,   // low temp = consistent groupings
    max_tokens: 1024,
  });
  } catch (err) {
    // Service worker may have died — reload engine once and retry
    if (!retried && err.message?.includes("Model not loaded")) {
      console.warn("[TabGrouperAI] Engine lost, reloading…");
      setStatus("loading", "Reconnecting to model…");
      await initEngine();
      return getGroupingsFromModel(tabs, true);
    }
    throw err;
  }

  const raw = reply.choices[0].message.content;
  const parsed = JSON.parse(raw);

  if (!parsed.groups || !Array.isArray(parsed.groups)) {
    throw new Error("Model returned unexpected JSON shape");
  }

  return parsed.groups;
}

// ─────────────────────────────────────────────────────────────
// Apply Chrome tab groups
// ─────────────────────────────────────────────────────────────

async function applyGroups(groups, allTabs) {
  const validTabIds = new Set(allTabs.map((t) => t.id));
  const applied = [];

  for (const group of groups) {
    // Filter to only IDs that actually exist in this window
    const ids = (group.tabIds || []).filter((id) => validTabIds.has(id));
    if (ids.length === 0) continue;

    const groupId = await chrome.tabs.group({ tabIds: ids });
    await chrome.tabGroups.update(groupId, {
      title: group.name,
      color: group.color,
      collapsed: false,
    });

    applied.push({ ...group, tabIds: ids });
  }

  return applied;
}

// ─────────────────────────────────────────────────────────────
// Render results
// ─────────────────────────────────────────────────────────────

function renderResults(groups) {
  $list.innerHTML = "";

  for (const g of groups) {
    const item = document.createElement("div");
    item.className = "group-item";
    item.innerHTML = `
      <div class="group-color color-${g.color}"></div>
      <span class="group-name">${escapeHtml(g.name)}</span>
      <span class="group-count">${g.tabIds.length} tab${g.tabIds.length !== 1 ? "s" : ""}</span>
    `;
    $list.appendChild(item);
  }

  $results.classList.add("visible");
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─────────────────────────────────────────────────────────────
// Main flow
// ─────────────────────────────────────────────────────────────

async function doGroupTabs() {
  hideError();
  $results.classList.remove("visible");
  setStatus("working", "Analyzing tabs…");
  setButtonState(false, "Working…");

  try {
    const tabs = await getCurrentTabs();
    setStatus("working", `Grouping ${tabs.length} tabs…`);

    const groups   = await getGroupingsFromModel(tabs);
    const applied  = await applyGroups(groups, tabs);

    renderResults(applied);
    setStatus("ready", `Done — ${applied.length} groups created`);
    setButtonState(true);
  } catch (err) {
    console.error("[TabGrouperAI]", err);
    showError(`Error: ${err.message}`);
    setStatus("error", "Something went wrong");
    setButtonState(true);
  }
}

// ─────────────────────────────────────────────────────────────
// Clear groups
// ─────────────────────────────────────────────────────────────

async function clearGroups() {
  try {
    const groups = await chrome.tabGroups.query({ windowId: chrome.windows.WINDOW_ID_CURRENT });
    for (const g of groups) {
      const tabs = await chrome.tabs.query({ groupId: g.id });
      await chrome.tabs.ungroup(tabs.map((t) => t.id));
    }
    $results.classList.remove("visible");
    setStatus("ready", "Groups cleared");
  } catch (err) {
    showError(`Could not clear groups: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────
// Settings (simple model picker via prompt)
// ─────────────────────────────────────────────────────────────

const AVAILABLE_MODELS = [
  "Phi-3.5-mini-instruct-q4f16_1-MLC",   // ~2.2GB  — recommended
  "Llama-3.1-8B-Instruct-q4f32_1-MLC",   // ~4.5GB  — best quality
];

async function openSettings() {
  const current = await getModel();
  const list = AVAILABLE_MODELS.map((m, i) => `${i + 1}. ${m}${m === current ? " ✓" : ""}`).join("\n");
  const choice = prompt(`Choose model (enter number):\n\n${list}\n\n⚠ Changing model triggers a new download.`);
  const idx = parseInt(choice, 10) - 1;

  if (idx >= 0 && idx < AVAILABLE_MODELS.length && AVAILABLE_MODELS[idx] !== current) {
    await chrome.storage.local.set({ model: AVAILABLE_MODELS[idx] });
    engine = null;
    await initEngine();
  }
}

// ─────────────────────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────────────────────

(async () => {
  // Show tab count immediately
  const tabs = await getCurrentTabs();
  $tabCount.innerHTML = `<span>${tabs.length}</span> tabs in this window`;

  // Wire up buttons
  $btnGroup.addEventListener("click", doGroupTabs);
  $clear.addEventListener("click", clearGroups);
  $settings.addEventListener("click", openSettings);

  // Init engine (downloads model on first run)
  try {
    await initEngine();
  } catch (err) {
    console.error("[TabGrouperAI] init failed:", err);
    setStatus("error", "Failed to load model");
    showError(`Model init failed: ${err.message}\n\n${err.stack || ""}`);
  }
})();
