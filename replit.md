# Horror Prompt Automator

A Chrome Manifest V3 browser extension that automates the workflow of generating cinematic horror image/video prompts via ChatGPT, then submitting them to Google Flow (labs.google) for generation. The popup UI is in Bengali.

## How to load in Chrome

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** and select the `horror-prompt-extension/` folder
4. The extension icon will appear in your toolbar

After any code change, go back to `chrome://extensions` and click the **↺ refresh** button on the extension card, then re-open the popup.

## Extension files (`horror-prompt-extension/`)

| File | Role |
|---|---|
| `manifest.json` | Extension config — permissions, content script declarations |
| `popup.html` / `popup.css` / `popup.js` | Main UI (all tabs, ChatGPT flow, Google Flow, saved projects, settings) |
| `background.js` | Service worker — persists automation status to `chrome.storage.local` |
| `content-bridge.js` | **Isolated world** content script on ChatGPT — orchestrates the multi-step automation, messages `content-page.js` via `postMessage` |
| `content-page.js` | **Main world** content script on ChatGPT — directly accesses React internals / DOM to type text and detect streaming |
| `flow-bridge.js` | **Isolated world** content script on Google Flow — orchestrates prompt submission loop |
| `flow-page.js` | **Main world** content script on Google Flow — handles contenteditable injection, image paste, send-button detection |

## Stack

- Pure JavaScript, no build step required
- Chrome Extension Manifest V3
- `chrome.storage.local` for all persistence (projects, settings, run state)
- UI language: Bengali (বাংলা)

## Where things live

- Extension source: `horror-prompt-extension/`
- `lib/` — unused backend scaffold (Express + Drizzle + PostgreSQL template; not connected to the extension)
- `scripts/` — workspace utility scripts

## Architecture decisions

- Two content script pairs (isolated + main world) per target site — isolated world handles chrome API calls and flow control, main world handles direct DOM/React manipulation
- Status is stored in `chrome.storage.local` and polled by the popup (every 600–800 ms) rather than using long-lived connections, which avoids service worker lifecycle issues
- Storage quota failures on large outputs are handled with a three-tier fallback: full output → truncated to 8 KB → scene names only
- A 2.5 s delay after each `scene_done` before sending `all_done` prevents a race condition where background.js hasn't finished writing the last result when the popup reads it

## Gotchas

- After every code change, the extension must be **reloaded** in `chrome://extensions` or changes won't take effect
- Content scripts require the target page to be **refreshed** after extension reload before they inject into it
- The `MAIN` world content scripts (`content-page.js`, `flow-page.js`) run in the page's own JS context and can reach React fiber internals; the isolated world scripts cannot
- Google Flow's input handling is complex — `flow-page.js` uses five fallback strategies to submit text because Flow's React editor blocks most synthetic input approaches

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._
