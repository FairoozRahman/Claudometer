# Claudometer
[![Chrome Web Store](https://img.shields.io/chrome-web-store/v/ikhopccampcjlpeefeckchichkfnlejl)](https://chromewebstore.google.com/detail/ikhopccampcjlpeefeckchichkfnlejl)
<img width="1280" height="800" alt="claudometer-description" src="https://github.com/user-attachments/assets/6251b295-effd-49b7-8dfd-01a34b6981bf" />
<img width="1280" height="800" alt="claudometer-ss-1" src="https://github.com/user-attachments/assets/bdcf30f0-92bd-4d9f-991d-a2dcb01673b4" />
<img width="1280" height="800" alt="claudometer-ss-2" src="https://github.com/user-attachments/assets/9104365f-b3bd-47f0-af9e-d6fad6513535" />

**Low-profile floating HUD & quota meter for Claude session limits and burn rates.**

Claudometer sits quietly in the corner of [claude.ai](https://claude.ai) and tells you what the site itself makes you dig through Settings to find: how much of your 5-hour session and 7-day cap you've used, how fast you're burning through it, and how long you've got left — updated automatically, no page refresh required.

---

## Features

- **5-hour session window** — live percentage, status tag, and countdown to reset
- **7-day weekly cap** — same at-a-glance treatment, including a separate Opus pool where your plan reports one
- **Real-time burn rate** — hourly consumption pace, last-prompt impact, and an estimated runway ("Infinite Runway ♾️" when your current pace won't hit the cap before the window resets)
- **Theme matching** — dark and light variants tuned for low eye strain, switchable independently of your system theme
- **Customizable hover tooltips** — glassmorphism tooltips on every metric and control, with a single toggle to turn them off entirely
- **Offline safety mode** — a clear "not logged in" state with a one-click path to `claude.ai/login`, and stale-but-labeled data instead of a blank HUD if a poll fails
- **Configurable auto-refresh** — pick how often it polls (1 / 5 / 10 / 15 / 30 min) from the Settings panel; a manual refresh also resets that timer so you never get polled twice in quick succession
- Desktop alerts at 60% / 85% / 95% usage
- Drag-to-reposition, minimize/maximize/hide, and an optional "run on every website" mode for a persistent reading wherever you're tabbed to

## Installation

**Chrome Web Store** (recommended): [install Claudometer](https://chromewebstore.google.com/detail/ikhopccampcjlpeefeckchichkfnlejl) — updates automatically.

**Unpacked / dev build**, if you want to run a specific release or a build from source:

1. Go to the [Releases](../../releases) page and download the latest **`claudometer-vX.Y.Z.zip`**
2. Unzip it — you should get a folder containing `manifest.json`, `background.js`, `content.js`, etc.
3. Open `chrome://extensions` in Chrome
4. Toggle **Developer mode** on (top right)
5. Click **Load unpacked** and select the unzipped folder
6. Open or reload a claude.ai tab — the HUD appears in the top-right corner

Chrome will show a "Disable developer mode extensions" reminder on every browser restart — that's expected for unpacked extensions and can be dismissed; the extension keeps working.

## How it works

Claudometer polls claude.ai's own usage endpoint (the same data your Settings → Usage page reads) on a configurable interval — every 1 to 30 minutes, 2 by default — from your existing signed-in browser session — there's no separate login, API key, or account linking. Because this relies on an internal, undocumented endpoint rather than a published API, the parser is written defensively: an unrecognized response degrades to a visible "couldn't read usage" state instead of showing wrong numbers, and the extension keeps working off the last good reading if a single poll fails.

## Privacy & Security

Claudometer runs **100% locally in your browser**. Specifically:

- All data (usage readings, settings, position, theme) is stored in `chrome.storage.local` — on your machine, never synced to a remote server
- The only network requests it makes are to `claude.ai` itself, using your existing browser session — the same requests the site's own UI already makes
- It **never** transmits your credentials, conversation content, or prompt data anywhere. It reads usage *percentages*, nothing else
- There is no analytics, telemetry, or third-party service integration of any kind
- Source is fully readable — nothing is minified or obfuscated, so you can verify all of the above yourself

See [PRIVACY.md](PRIVACY.md) for the full privacy policy.

## Permissions

| Permission | Why |
|---|---|
| `storage` | Save settings and the latest usage reading locally |
| `alarms` | Schedule the auto-refresh polling cycle (interval configurable, default 2 minutes) |
| `notifications` | Desktop alerts at usage thresholds (optional, toggleable) |
| `scripting` | Inject the HUD into other tabs, only if you opt into "run on all websites" |
| `host_permissions: claude.ai` | Read your usage data from claude.ai |
| `optional_host_permissions: <all_urls>` | Only requested — with a Chrome permission prompt — if you enable "run on all websites" in the toolbar popup |

## Project structure

```
manifest.json     Manifest V3 config
background.js     Polling, usage parsing, alerts, badge
content.js         Floating HUD (shadow DOM), tooltips, drag/resize
popup.html/js/css  Toolbar popup — show/hide HUD, all-sites toggle
styles.css         HUD theme (dark/light, glassmorphism)
icons/             Extension icons
```

## License

MIT — see [LICENSE](LICENSE).
