# ComfyRemix

Browse and curate your AI-generated media (images, video, audio), then **remix** it — rerun the workflow inside any file with a new prompt, seed, or style. Zero-dependency Node.js server + single-page front end, built to pair with [ComfyUI](https://github.com/Comfy-Org/ComfyUI).

> ComfyRemix is an independent community project. It is **not affiliated with, endorsed by, or sponsored by Comfy Org, Inc.** — "ComfyUI" is the branding of Comfy Org. This app contains no ComfyUI code; it talks to your own ComfyUI install over its local API.
>
> **License:** [CC BY-NC 4.0](LICENSE) — free to use, share, and modify **with credit** to [masteroleary/comfy-remix](https://github.com/masteroleary/comfy-remix); **commercial use requires written consent** (webdevllc@gmail.com).

- **Start:** `cd D:/Archive && npm start` → serves on **http://localhost:8080** (HTTPS on **8443**).
- **Auto-start:** runs headless at boot as a Windows scheduled task, before any user logs in.
- **API keys / settings:** click the **⚙** button in the app header (Claude, Grok/xAI, Civitai keys, service URLs).

See [CLAUDE.md](CLAUDE.md) for architecture, API endpoints, and the full firewall/hardening details.

---

## Features

The home screen is a set of tiles; a few tools live in the header (🤖 Claude, ⚙ Settings). Each feature below lists what it does and what it needs to work.

### 📂 Media Browser — Archive / ComfyUI Output / Favorites

**What it does:** Browse your media in a responsive grid — images, video, and audio, organized by folder. Search, sort (date/name), and filter by type (folders / videos / images). Tap any item for a full-screen viewer with swipe navigation. Three entry tiles point at different roots: **Archive Media** (curated library), **ComfyUI Output** (raw generations), and **Favorites**.

- **Search by name *or by prompt*** — a background index extracts the prompt text embedded in generated files, so searching "ocean" finds images whose generation prompt mentioned it, even if the filename is `Final_0042.png`. Search can also **descend into all subfolders**, grouping results under clickable folder-path shortcuts.
- **📂 Word directory** — browse every word/phrase used across your prompts, sorted by frequency or A–Z; tap one to see all matching media.
- **Favorite** a file to move it into `_Favorites` (or the archive root if it came from ComfyUI output).
- **Delete** individual files, or use **☑ multi-select** / per-search-result **Select All** for bulk actions.
- **🔒 Blur toggle** applies a privacy blur to thumbnails so the grid can be browsed discreetly on a shared screen.

**Setup:** none beyond `config.json` paths — `mediaDir` (library root) and `comfyOutput` (ComfyUI's output folder).

### ⚡ Jobs

**What it does:** Tracks ComfyUI generation runs started from the app (see *Workflow Inspector* below) — showing running vs. completed jobs, run counts, progress, and the resulting output files. Progress is shared live across open tabs.

**Setup:** none; populated automatically when you run a workflow.

### 🎨 Workflow Inspector & Re-run

**What it does:** Open any image or video and switch to the **Workflow** tab to see the ComfyUI workflow embedded in its metadata. From there you can **re-run** it:

- **Inherited** — replays the exact workflow baked into the file.
- **App workflows** — pick a curated workflow from the dropdown and drive it with on-screen controls: **prompt**, **seed** (📌 pin an exact seed, or randomize every run), **steps**, **LoRAs**, **frames**, and **style/quality presets**. Presets that can't run together are batched automatically (each selected preset runs as its own pass — *Presets × Runs*).
- **📷 Use image's prompt** — copy the prompt embedded in the viewed image into the selected workflow, instead of the workflow's saved prompt.
- **Prompt Replacements** — a saved list of find → replace word rules (each with an on/off toggle) applied to the prompt just before submission; rules are stored server-side so they follow you across devices.
- Set a **run count** to generate multiple variations in one click; outputs appear as **live thumbnails as each run completes**, with bulk Favorite/Delete right from the results grid.

**Setup:** **ComfyUI must be running** (address configurable via `comfyUrl`, default `http://127.0.0.1:8188`). Curated workflows must be enabled first (see *Manage Workflows*).

### ⚙ Manage Workflows (inside the Workflow tab)

**What it does:** Lists every workflow in your ComfyUI install directory with a checkbox to expose it in the app — no renaming or copying of the original files. For each enabled workflow you can set a display label and map which node is the **prompt / steps / seed** (auto-detected by convention, overridable from a dropdown). Choices are stored in a sidecar file so your original workflow `.json` files are never modified.

**Setup:** none; reads directly from `comfyDir`.

### 🤖 Claude Code Assistant

**What it does:** An in-app AI assistant (the Claude Code CLI) that runs against your ComfyUI directory. Ask it questions or have it help manage files and workflows; conversations are saved and can be resumed. Responses stream live into the chat panel.

**Setup:**
- Install the CLI once: `npm install -g @anthropic-ai/claude-code`.
- Provide auth **either** by pasting an **Anthropic API key in ⚙ Settings** (recommended — works even when the app runs headless at boot), **or** by signing in with the global `claude` login on the host account.

### 🏠 Chat — Local

**What it does:** A private text/voice chat backed entirely by local services: an **Ollama** model for the LLM and **Voxtral** for on-device voice. Nothing leaves the machine.

**Setup:** Run **Ollama** (default `http://localhost:11434`) with at least one model pulled (e.g. `ollama pull llama3`), and the **Voxtral** voice service (default `http://localhost:8091`). Both URLs are editable in ⚙ Settings.

### ☁️ Chat — Grok

**What it does:** Same chat experience, but voice output uses **Grok (xAI) cloud TTS** for higher-quality voices while the LLM still runs locally on Ollama.

**Setup:** An **xAI API key** in ⚙ Settings, plus Ollama running (as above). xAI usage is metered — the home screen shows your running xAI spend.

### 🎙️ Voice Agent

**What it does:** Hands-free, real-time speech-to-speech conversation powered by Grok (xAI), with selectable voices and customizable chat characters/personas. Can also generate character portrait and scene images on demand.

**Setup:**
- An **xAI API key** in ⚙ Settings.
- **Must be used over HTTPS** — browsers only grant microphone access on a secure origin. The app auto-redirects to port **8443** when you open it. The cert is self-signed, so accept the one-time browser warning.

### ⚙ Settings

**What it does:** Central place to manage credentials and service endpoints without editing files: **Claude (Anthropic)**, **Grok (xAI)**, and **Civitai** API keys, plus the **Ollama** and **Voxtral** URLs. Keys are shown masked (last 4 characters) and take effect immediately — no restart needed. Read-only fields show the current ports and paths.

**Setup:** none — it *is* the setup surface for the features above.

### External services at a glance

| Feature | Needs |
|---|---|
| Media Browser / Favorites / Jobs | Nothing extra |
| Workflow Inspector & Re-run | ComfyUI running (`comfyUrl`, default `127.0.0.1:8188`) |
| Claude Code Assistant | `@anthropic-ai/claude-code` installed + Anthropic key (or global `claude` login) |
| Chat — Local | Ollama (`:11434`) + Voxtral (`:8091`) |
| Chat — Grok | Ollama (`:11434`) + xAI key |
| Voice Agent | xAI key + HTTPS (port 8443) |

## Third-party services & data flow

The app is **local-first**: your media library is served straight off your disk and never leaves the machine. External calls happen only when you actively use a feature that needs them — nothing phones home in the background.

| Service | Runs | Purpose in the app | What gets sent |
|---|---|---|---|
| **ComfyUI** | locally | Executes image/video workflows. The app proxies HTTP + WebSocket traffic to it (`comfyUrl`) for queueing runs, streaming progress, and uploading input images. | Nothing leaves the machine |
| **Ollama** | locally | The LLM behind both Chat modes. | Nothing leaves the machine |
| **Voxtral** | locally | On-device text-to-speech for Chat — Local. | Nothing leaves the machine |
| **Anthropic (Claude)** | cloud | Powers the 🤖 assistant via the Claude Code CLI, working against your ComfyUI directory (reading/editing workflows, answering questions). | Your assistant prompts and any files the assistant chooses to read are sent to the Anthropic API |
| **xAI (Grok)** | cloud | Cloud TTS voices in Chat — Grok; real-time speech-to-speech and on-demand portrait/scene image generation in Voice Agent. | Chat text, microphone audio (Voice Agent), and image prompts go to `api.x.ai`; usage is metered and the running spend is shown on the home screen |
| **Civitai** | cloud | API key stored for authenticated model downloads (some models require an account to fetch). | Only the download requests you trigger |

All API keys live in `config.json` (gitignored) and are managed via ⚙ Settings; each cloud feature detects a missing key, prompts for it on first use, and stays inactive until you provide one.

---

## Accessing it privately over Tailscale

The app is deliberately **not exposed to the LAN or the public internet**. The Windows firewall blocks inbound 8080/8443 except from **localhost** and the **Tailscale** network. Tailscale is a private mesh VPN (WireGuard): only devices signed in to *your* tailnet can reach this machine, and the traffic is end-to-end encrypted. Nothing is port-forwarded and there's no public URL.

This machine's Tailscale identity:

| | |
|---|---|
| Machine name | `<machine>` (yours will differ) |
| MagicDNS name | `<machine>.<your-tailnet>.ts.net` |
| Tailscale IP | `100.x.y.z` |
| Ports | `8080` (HTTP), `8443` (HTTPS) |

### One-time setup on the device you want to browse from (phone, laptop, tablet)

1. **Install Tailscale** on the client device:
   - iOS / Android: "Tailscale" in the App Store / Play Store
   - macOS / Windows / Linux: https://tailscale.com/download
2. **Sign in with the same account** that owns the `office` machine. The device joins your tailnet.
3. Make sure Tailscale is **connected/enabled** on that device (toggle it on).

That's it — no config on this machine is needed; it's already on the tailnet in unattended mode (stays connected across reboots, even before anyone logs in).

### Open the app

From any device on the tailnet, open a browser to:

- **http://<machine>.<your-tailnet>.ts.net:8080** ← recommended (MagicDNS name)
- or **http://100.x.y.z:8080** (raw Tailscale IP, works even if MagicDNS is off)

For HTTPS use **https://<machine>.<your-tailnet>.ts.net:8443**. The certificate is self-signed, so the browser will show a one-time "not private" warning — accept it to proceed. (HTTP on 8080 is fine over Tailscale since the tunnel itself is already encrypted.)

> Tip: on a phone, add the URL to your home screen for an app-like shortcut.

### Why this is private

- **Firewall pinned to Tailscale ranges.** Inbound rules for 8080/8443 only allow the Tailscale address ranges (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`), so even a device on the same Wi-Fi/LAN cannot connect.
- **No public exposure.** No router port-forwarding, no public DNS, no `tailscale funnel`. Off the tailnet, the machine is unreachable.
- **Reachable pre-login.** Tailscale runs in unattended mode and the app starts at boot as SYSTEM, so it's available after a cold reboot without anyone logging in at the desk.

### Troubleshooting

| Symptom | Check |
|---|---|
| Page won't load | Tailscale is **connected** on the client device (open the Tailscale app, confirm it's on). |
| Still won't load | In the Tailscale admin console (login.tailscale.com), confirm `office` shows as **online**. |
| MagicDNS name fails but IP works | MagicDNS may be disabled for your tailnet — use `http://100.x.y.z:8080`, or enable MagicDNS in the admin console (DNS tab). |
| Works on Wi-Fi at home only | That means you're hitting it over the LAN, not Tailscale — it should work from *anywhere* the client has Tailscale on. Turn off Wi-Fi to test over cellular. |
| HTTPS warning | Expected (self-signed cert). Accept the warning, or just use the `http://…:8080` URL. |

To change these Tailscale/firewall settings on the host, see the **Network / Firewall** and **Tailscale unattended mode** sections of [CLAUDE.md](CLAUDE.md).
