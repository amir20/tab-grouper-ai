# WXT Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate Gruper from `vite-plugin-web-extension` to WXT for multi-browser (Chrome + Firefox) builds.

**Architecture:** Replace `vite.config.ts` + `manifest.json` with `wxt.config.ts`. Move all source files from `src/` to WXT's `entrypoints/`, `components/`, `composables/`, `utils/`, and `assets/` directories. WXT auto-discovers entrypoints and generates the manifest.

**Tech Stack:** WXT, `@wxt-dev/module-vue`, Vue 3, TypeScript, Tailwind CSS v4, WebLLM, OpenRouter

---

### Task 1: Install WXT and update package.json

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install WXT and Vue module, remove old deps**

```bash
pnpm add -D wxt @wxt-dev/module-vue
pnpm remove vite vite-plugin-web-extension @vitejs/plugin-vue @types/chrome
```

- [ ] **Step 2: Update package.json scripts**

Replace the `scripts` section in `package.json` with:

```json
{
  "scripts": {
    "dev": "wxt dev",
    "dev:firefox": "wxt dev --browser firefox",
    "build": "wxt build",
    "build:firefox": "wxt build --browser firefox",
    "zip": "wxt zip",
    "zip:firefox": "wxt zip --browser firefox",
    "typecheck": "tsc --noEmit",
    "postinstall": "wxt prepare"
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore: install WXT and update scripts"
```

---

### Task 2: Create wxt.config.ts and update tsconfig.json

**Files:**
- Create: `wxt.config.ts`
- Modify: `tsconfig.json`
- Delete: `vite.config.ts`
- Delete: `manifest.json`

- [ ] **Step 1: Create wxt.config.ts**

Create `wxt.config.ts` at the project root:

```ts
import { defineConfig } from "wxt";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  modules: ["@wxt-dev/module-vue"],
  imports: false,
  manifest: {
    name: "Gruper",
    version: "0.1.0",
    description:
      "Automatically group your tabs using a local AI model — no server required.",
    permissions: ["tabs", "tabGroups", "storage", "notifications"],
    host_permissions: [
      "https://huggingface.co/*",
      "https://*.huggingface.co/*",
      "https://openrouter.ai/*",
    ],
    content_security_policy: {
      extension_pages:
        "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
    commands: {
      "group-tabs": {
        suggested_key: {
          default: "Alt+Shift+G",
          mac: "Alt+Shift+G",
        },
        description: "Group tabs with AI",
      },
    },
  },
  vite: () => ({
    plugins: [tailwindcss()],
    build: {
      // WebLLM uses WASM — don't try to inline it
      assetsInlineLimit: 0,
      // @mlc-ai/web-llm is ~6MB, must be inlined (service worker can't use shared chunks)
      chunkSizeWarningLimit: 6000,
    },
  }),
});
```

- [ ] **Step 2: Update tsconfig.json**

Replace `tsconfig.json` with:

```json
{
  "extends": "./.wxt/tsconfig.json",
  "compilerOptions": {
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true
  }
}
```

- [ ] **Step 3: Delete old config files**

```bash
rm vite.config.ts manifest.json
```

- [ ] **Step 4: Add WXT output directories to .gitignore**

Append to `.gitignore`:

```
.wxt
.output
```

- [ ] **Step 5: Commit**

```bash
git add wxt.config.ts tsconfig.json .gitignore
git rm vite.config.ts manifest.json
git commit -m "chore: replace vite + manifest with wxt.config.ts"
```

---

### Task 3: Create entrypoints directory structure and move files

**Files:**
- Create: `entrypoints/background.ts`
- Create: `entrypoints/popup/index.html`
- Create: `entrypoints/popup/main.ts`
- Create: `entrypoints/popup/App.vue`
- Create: `entrypoints/popup/style.css`
- Move: `src/components/` → `components/`
- Move: `src/composables/` → `composables/`
- Create: `utils/config.ts`
- Create: `utils/openrouter.ts`
- Create: `assets/system-prompt.txt`
- Delete: entire `src/` directory
- Delete: `src/env.d.ts`

- [ ] **Step 1: Create directory structure**

```bash
mkdir -p entrypoints/popup components composables utils assets
```

- [ ] **Step 2: Move utility files**

```bash
cp src/config.ts utils/config.ts
cp src/openrouter.ts utils/openrouter.ts
cp src/system-prompt.txt assets/system-prompt.txt
```

- [ ] **Step 3: Create entrypoints/background.ts**

Create `entrypoints/background.ts` with the WXT `defineBackground` wrapper. The content is the same as `src/service-worker.ts` but wrapped and with updated import paths:

```ts
import { defineBackground } from "wxt/sandbox";
import {
  MLCEngine,
  ExtensionServiceWorkerMLCEngineHandler,
} from "@mlc-ai/web-llm";
import {
  SYSTEM_PROMPT,
  buildTabPrompt,
  remapTabIds,
  getCurrentTabs,
  applyGroups,
  extractJson,
  getProviderConfig,
  toMessage,
} from "@/utils/config";
import { chatCompletion } from "@/utils/openrouter";

export default defineBackground({
  type: "module",

  main() {
    let handler: ExtensionServiceWorkerMLCEngineHandler | undefined;

    chrome.runtime.onConnect.addListener((port) => {
      if (handler === undefined) {
        handler = new ExtensionServiceWorkerMLCEngineHandler(port);
      } else {
        handler.setPort(port);
      }
      port.onMessage.addListener(handler.onmessage.bind(handler));
    });

    // ─────────────────────────────────────────────────────────────
    // Model loading
    // ─────────────────────────────────────────────────────────────

    function getEngine(): MLCEngine | undefined {
      return handler?.engine;
    }

    function isModelLoaded(): boolean {
      return !!(handler?.modelId && handler.modelId.length > 0);
    }

    async function ensureModelLoaded(): Promise<void> {
      if (isModelLoaded()) return;

      if (!handler) {
        throw new Error("Model not loaded — open the extension popup to download the model first.");
      }

      const config = await getProviderConfig();
      console.log("[Gruper] Loading model from shortcut:", config.model);
      setBadge("…", "#6366f1");
      await handler.engine.reload(config.model);
      handler.modelId = [config.model];
      console.log("[Gruper] Model loaded");
    }

    // ─────────────────────────────────────────────────────────────
    // Badge helpers
    // ─────────────────────────────────────────────────────────────

    function setBadge(text: string, color: string) {
      chrome.action.setBadgeText({ text });
      chrome.action.setBadgeBackgroundColor({ color });
    }

    function clearBadge() {
      chrome.action.setBadgeText({ text: "" });
    }

    let spinnerInterval: ReturnType<typeof setInterval> | null = null;
    const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

    function startSpinner() {
      let i = 0;
      setBadge(spinnerFrames[0], "#6366f1");
      spinnerInterval = setInterval(() => {
        i = (i + 1) % spinnerFrames.length;
        setBadge(spinnerFrames[i], "#6366f1");
      }, 120);
    }

    function stopSpinner() {
      if (spinnerInterval) {
        clearInterval(spinnerInterval);
        spinnerInterval = null;
      }
    }

    // ─────────────────────────────────────────────────────────────
    // Keyboard shortcut handler (Alt+Shift+G)
    // ─────────────────────────────────────────────────────────────

    chrome.commands.onCommand.addListener(async (command) => {
      if (command !== "group-tabs") return;

      startSpinner();

      try {
        const config = await getProviderConfig();
        const tabs = await getCurrentTabs();
        console.log("[Gruper] Shortcut: found", tabs.length, "ungrouped tabs");
        if (tabs.length === 0) {
          stopSpinner();
          clearBadge();
          return;
        }

        const { prompt: tabList, idMap } = buildTabPrompt(tabs);
        const messages: { role: "system" | "user"; content: string }[] = [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `Here are my open tabs:\n${tabList}\n\nGroup them:` },
        ];

        let raw: string;

        if (config.provider === "openrouter") {
          if (!config.openrouterApiKey) throw new Error("OpenRouter API key not set. Open the popup to configure.");
          raw = await chatCompletion(config.openrouterApiKey, config.openrouterModel, messages, {
            temperature: 0.3,
            max_tokens: 1024,
          });
        } else {
          await ensureModelLoaded();
          const engine = getEngine();
          if (!engine) throw new Error("Engine unavailable after model load");
          const reply = await engine.chat.completions.create({
            messages,
            temperature: 0.3,
            max_tokens: 1024,
          });
          raw = reply.choices[0].message.content ?? "";
        }

        console.log("[Gruper] Model response:", raw);

        const parsed = extractJson(raw);
        const remapped = remapTabIds(parsed.groups, idMap);
        const applied = await applyGroups(remapped, tabs);

        stopSpinner();
        console.log("[Gruper] Applied", applied.length, "of", parsed.groups.length, "groups");

        if (applied.length > 0) {
          setBadge("✓", "#22c55e");
          chrome.notifications.create({
            type: "basic",
            iconUrl: chrome.runtime.getURL("icons/icon128.png"),
            title: "Gruper",
            message: `Grouped ${tabs.length} tabs into ${applied.length} groups.`,
          });
        } else {
          setBadge("!", "#f59e0b");
          chrome.notifications.create({
            type: "basic",
            iconUrl: chrome.runtime.getURL("icons/icon128.png"),
            title: "Gruper",
            message: "Model returned groups but no tab IDs matched. See service worker console.",
          });
        }
      } catch (err) {
        console.error("[Gruper] Shortcut grouping failed:", err);
        stopSpinner();
        setBadge("!", "#ef4444");
        chrome.notifications.create({
          type: "basic",
          iconUrl: chrome.runtime.getURL("icons/icon128.png"),
          title: "Gruper",
          message: toMessage(err),
        });
      }

      setTimeout(clearBadge, 3000);
    });
  },
});
```

- [ ] **Step 4: Create entrypoints/popup/index.html**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Gruper</title>
  <link rel="stylesheet" href="./style.css" />
</head>
<body>
  <div id="app"></div>
  <script src="./main.ts" type="module"></script>
</body>
</html>
```

- [ ] **Step 5: Create entrypoints/popup/main.ts**

```ts
import { createApp } from "vue";
import App from "./App.vue";

createApp(App).mount("#app");
```

- [ ] **Step 6: Move App.vue to entrypoints/popup/App.vue**

Copy `src/App.vue` to `entrypoints/popup/App.vue` and update the import paths:

```ts
// Change these imports:
import { getCurrentTabs, applyGroups, toMessage, type TabGroup, type Provider } from "./config";
import { useEngine } from "./composables/useEngine";
import StatusDot from "./components/StatusDot.vue";
import ProgressBar from "./components/ProgressBar.vue";
import GroupItem from "./components/GroupItem.vue";
import ModelPicker from "./components/ModelPicker.vue";

// To:
import { getCurrentTabs, applyGroups, toMessage, type TabGroup, type Provider } from "@/utils/config";
import { useEngine } from "@/composables/useEngine";
import StatusDot from "@/components/StatusDot.vue";
import ProgressBar from "@/components/ProgressBar.vue";
import GroupItem from "@/components/GroupItem.vue";
import ModelPicker from "@/components/ModelPicker.vue";
```

Also update the `@reference` in the `<style scoped>` block:

```css
/* Change: */
@reference "./style.css";

/* To: */
@reference "./style.css";
```

(This stays the same since `style.css` is now co-located in `entrypoints/popup/`.)

- [ ] **Step 7: Move style.css to entrypoints/popup/style.css**

```bash
cp src/style.css entrypoints/popup/style.css
```

No changes needed to the file content.

- [ ] **Step 8: Move components directory**

```bash
cp src/components/StatusDot.vue components/StatusDot.vue
cp src/components/ProgressBar.vue components/ProgressBar.vue
cp src/components/GroupItem.vue components/GroupItem.vue
cp src/components/ModelPicker.vue components/ModelPicker.vue
```

Update import paths in each component:

**`components/GroupItem.vue`** — change:
```ts
import type { TabGroup } from "../config";
```
to:
```ts
import type { TabGroup } from "@/utils/config";
```

**`components/StatusDot.vue`** — change:
```ts
import type { Status } from "../composables/useEngine";
```
to:
```ts
import type { Status } from "@/composables/useEngine";
```

**`components/ModelPicker.vue`** — change:
```ts
import {
  AVAILABLE_MODELS,
  POPULAR_OPENROUTER_MODELS,
  getProviderConfig,
  type Provider,
  type ModelOption,
} from "../config";
```
to:
```ts
import {
  AVAILABLE_MODELS,
  POPULAR_OPENROUTER_MODELS,
  getProviderConfig,
  type Provider,
  type ModelOption,
} from "@/utils/config";
```

**`components/ProgressBar.vue`** — no import changes needed.

- [ ] **Step 9: Move composables directory**

```bash
cp src/composables/useEngine.ts composables/useEngine.ts
```

Update import paths in `composables/useEngine.ts` — change:
```ts
import {
  SYSTEM_PROMPT,
  buildTabPrompt,
  remapTabIds,
  extractJson,
  getProviderConfig,
  saveProviderConfig,
  toMessage,
  type TabGroup,
  type Provider,
  type ProviderConfig,
} from "../config";
import { chatCompletion } from "../openrouter";
```
to:
```ts
import {
  SYSTEM_PROMPT,
  buildTabPrompt,
  remapTabIds,
  extractJson,
  getProviderConfig,
  saveProviderConfig,
  toMessage,
  type TabGroup,
  type Provider,
  type ProviderConfig,
} from "@/utils/config";
import { chatCompletion } from "@/utils/openrouter";
```

- [ ] **Step 10: Update utils/config.ts system prompt import**

In `utils/config.ts`, change:
```ts
export { default as SYSTEM_PROMPT } from "./system-prompt.txt?raw";
```
to:
```ts
export { default as SYSTEM_PROMPT } from "@/assets/system-prompt.txt?raw";
```

- [ ] **Step 11: Delete old src directory**

```bash
rm -rf src
```

- [ ] **Step 12: Commit**

```bash
git add entrypoints/ components/ composables/ utils/ assets/
git rm -rf src/
git commit -m "refactor: migrate to WXT directory structure"
```

---

### Task 4: Run wxt prepare and verify build

**Files:**
- No new files — verification only

- [ ] **Step 1: Run wxt prepare to generate types**

```bash
pnpm postinstall
```

Expected: `.wxt/` directory created with generated types, no errors.

- [ ] **Step 2: Run typecheck**

```bash
pnpm typecheck
```

Expected: No type errors. If there are errors, fix them before proceeding.

- [ ] **Step 3: Build for Chrome**

```bash
pnpm build
```

Expected: `.output/chrome-mv3/` directory created with `manifest.json` and bundled files.

- [ ] **Step 4: Verify generated manifest**

Check `.output/chrome-mv3/manifest.json` has the same permissions, host_permissions, commands, CSP, background, and action config as the old `manifest.json`. Key fields to verify:

- `permissions`: `["tabs", "tabGroups", "storage", "notifications"]`
- `host_permissions`: HuggingFace and OpenRouter URLs
- `content_security_policy.extension_pages`: includes `wasm-unsafe-eval`
- `commands.group-tabs`: has `Alt+Shift+G`
- `background.service_worker`: points to the built background file
- `action.default_popup`: points to the built popup

- [ ] **Step 5: Build for Firefox**

```bash
pnpm build:firefox
```

Expected: `.output/firefox-mv3/` (or `firefox-mv2/`) directory created. Verify it builds without errors.

- [ ] **Step 6: Commit any fixes**

If any fixes were needed during verification:

```bash
git add -A
git commit -m "fix: resolve build issues from WXT migration"
```

---

### Task 5: Add WebLLM graceful degradation for Firefox

**Files:**
- Modify: `composables/useEngine.ts`

- [ ] **Step 1: Update the init() function in composables/useEngine.ts**

In the local WebLLM branch of `init()`, wrap the engine creation in a try/catch that sets a helpful error message instead of crashing. Find the block starting with `// Local WebLLM` and replace it:

```ts
    // Local WebLLM
    currentModel.value = config.model;
    setStatus("loading", "Loading model...");

    if (engine) {
      try { await engine.unload(); } catch { /* ignore */ }
      engine = null;
    }

    try {
      engine = await CreateExtensionServiceWorkerMLCEngine(config.model, {
        initProgressCallback: ({ progress: p, text }) => {
          const pct = Math.round((p ?? 0) * 100);
          progress.value = { visible: true, pct, label: text || "Downloading model..." };
          statusText.value = `Downloading... ${pct}%`;
        },
      });

      progress.value = { visible: false, pct: 0, label: "" };
      setStatus("ready", "Model ready");
    } catch (err) {
      progress.value = { visible: false, pct: 0, label: "" };
      setError("Local AI unavailable in this browser. Switch to OpenRouter for cloud-based grouping.");
    }
```

- [ ] **Step 2: Commit**

```bash
git add composables/useEngine.ts
git commit -m "feat: graceful degradation when WebLLM unavailable"
```

---

### Task 6: Clean up old build artifacts and update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`
- Modify: `.gitignore`
- Delete: `dist/` directory
- Delete: `gruper.zip`

- [ ] **Step 1: Remove old build artifacts**

```bash
rm -rf dist gruper.zip
```

- [ ] **Step 2: Update .gitignore**

Ensure `.gitignore` contains:

```
node_modules
.wxt
.output
dist
*.zip
```

- [ ] **Step 3: Update CLAUDE.md build commands**

Replace the Build & Development Commands section in `CLAUDE.md`:

```markdown
## Build & Development Commands

\```bash
pnpm install          # Install dependencies (pnpm 10.33+)
pnpm build            # Chrome production build → .output/chrome-mv3/
pnpm build:firefox    # Firefox production build → .output/firefox-mv3/
pnpm dev              # Chrome dev mode with HMR
pnpm dev:firefox      # Firefox dev mode with HMR
pnpm typecheck        # TypeScript validation (tsc --noEmit)
pnpm zip              # Build + zip for Chrome
pnpm zip:firefox      # Build + zip for Firefox
\```

After building, load `.output/chrome-mv3/` as an unpacked extension in `chrome://extensions` (Developer mode). For Firefox, load `.output/firefox-mv3/` via `about:debugging`.
```

- [ ] **Step 4: Update CLAUDE.md architecture section**

Update the Architecture section to reflect the new directory structure. Replace the "Two entry points" subsection:

```markdown
### Two entry points

- **Background** (`entrypoints/background.ts`) — Hosts the WebLLM engine, handles keyboard shortcut (Alt+Shift+G), and manages Chrome port connections. Wrapped in WXT's `defineBackground()`.
- **Popup** (`entrypoints/popup/main.ts` → `entrypoints/popup/App.vue`) — Vue 3 app for the UI. Communicates with the service worker via `chrome.runtime.connect()` port messaging.
```

Update any references to file paths:
- `src/service-worker.ts` → `entrypoints/background.ts`
- `src/popup.ts` → `entrypoints/popup/main.ts`
- `src/App.vue` → `entrypoints/popup/App.vue`
- `src/composables/useEngine.ts` → `composables/useEngine.ts`
- `config.ts` → `utils/config.ts`
- `src/openrouter.ts` → `utils/openrouter.ts`

Also add a note about multi-browser support:

```markdown
### Multi-browser support

Built with WXT framework. Targets Chrome and Firefox from the same codebase. Browser-specific builds via `pnpm build` (Chrome) and `pnpm build:firefox` (Firefox). WebLLM local inference may not work on Firefox due to limited WebGPU support — the extension gracefully falls back to suggesting OpenRouter.
```

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md .gitignore
git rm -rf dist gruper.zip 2>/dev/null; true
git commit -m "docs: update CLAUDE.md for WXT migration"
```
