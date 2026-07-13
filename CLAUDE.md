# ComfyRemix

A local, zero-dependency web app for browsing, curating, and remixing AI-generated media (images, video, audio) from ComfyUI and other tools. A single Node.js process serves the single-page front end plus a small REST/SSE API.

## Running

```bash
npm start                          # serve using config.json (HTTP 8080; HTTPS 8443 if certs/ present)
npm run restart                    # kill the running instance and restart (use after editing server.js)
node server.js 8081                # override the port
node server.js 8080 /path/to/media # override port and media root
```

- After editing **server.js**, restart the server (`npm run restart`) for changes to take effect.
- Static pages — `index.html`, `inspect.html`, `jobs.html`, `chat.html`, `voice.html`, `common.css`, `key-prompt.js` — are served straight from disk; just reload the browser, no restart needed.

## Architecture

- **server.js** — Node.js HTTP server (no external dependencies). Serves the SPA, exposes REST APIs for listing/favoriting/deleting media, proxies ComfyUI (HTTP + WebSocket), and streams Claude Code responses over SSE.
- **index.html** — Single-page application: dark theme, responsive media grid, full-screen viewer, workflow inspector/re-run, and chat/voice panels.
- **config.json** — Runtime config (ports, paths, API keys). Gitignored; create it by copying `config.example.json`.
- **Media/** — Default media root browsed by the app. Gitignored.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/list` | Directory listing with pagination, search, sort, type filter |
| POST | `/api/favorite` | Move file to `_Favorites` (or archive root if from ComfyUI output) |
| POST | `/api/delete` | Delete file and its thumbnail |
| POST | `/api/claude` | Send prompt to Claude Code, returns SSE stream |
| POST | `/api/claude/stop` | Kill running Claude process |
| GET | `/api/claude/conversations` | List saved conversations |
| DELETE | `/api/claude/conversations` | Delete a conversation by ID |
| GET | `/api/metadata` | Extract workflow metadata from PNG/video files |
| GET | `/file/{path}` | Serve media file with range support |
| GET | `/thumb/{path}` | Serve video thumbnail |

## Config

Copy `config.example.json` to `config.json` and fill in your values. Every field is also editable at runtime from the in-app ⚙ Settings panel (hot-reloaded, no restart):

- `port` / `httpsPort` — HTTP (default 8080) / HTTPS (default 8443, needs a cert+key in `certs/`)
- `mediaDir` — path to the media library root
- `comfyDir` — ComfyUI install directory (workflow list, Claude Code working dir)
- `comfyOutput` — path to ComfyUI's output folder
- `comfyUrl` — ComfyUI API address (default `http://127.0.0.1:8188`; used by the run proxy, WS proxy, and status checks)
- `comfyStartCmd` — command that launches ComfyUI (shell string or `[cmd, ...args]` array); if unset, auto-detects `Start ComfyUI.bat` next to `comfyDir`. Used by the Run button's "start it now" offer (`POST /api/comfy/start`). Note: when the app itself runs as a background service, a launched GUI may be invisible (it starts in the service session).
- `comfyNotesDir` — optional notes folder passed to Claude Code via `--add-dir`
- `ollamaUrl` / `voxtralUrl` — local LLM / TTS service addresses
- `voxtralStartCmd` — command that launches your Voxtral service (shell string or `[cmd, ...args]` array); the Start button errors without it
- `claudeCliPath` — optional explicit path to the Claude Code CLI (`claude.exe` or legacy `cli.js`); otherwise auto-detected across user profiles' npm globals
- `anthropicApiKey` / `xaiApiKey` / `civitaiApiKey` — API keys (also settable in ⚙ Settings)

## Claude Code Integration

The chat panel (🤖 button) spawns `claude -p` in headless mode against the ComfyUI directory. Each message is a fresh session; the server streams `stream-json` output back to the browser via SSE.

Requires the CLI installed globally: `npm install -g @anthropic-ai/claude-code`. Authenticate with either an Anthropic API key (in ⚙ Settings) or the host account's `claude` login.

## Running headless / at startup

The server is a plain `node server.js` process, so any service manager can keep it alive at boot:

- **Windows** — a Scheduled Task running `node server.js` from the app directory. Run it as **SYSTEM at startup** to have the app reachable before anyone logs in (headless / remote), or **at logon** for a per-user setup. Copy-paste setup is in the [README](README.md#run-at-startup-windows).
- **Linux / macOS** — a `systemd` user unit or `launchd` plist invoking `node server.js` in the app directory.

Caveats when running under a service account (e.g. Windows SYSTEM) or otherwise headless:

- The in-app 🤖 Claude assistant can't use an interactive `claude` login — set an **Anthropic API key** in ⚙ Settings instead (it's injected into the CLI environment).
- Service accounts don't inherit your per-user `PATH`, so `ffmpeg` / `ffprobe` may not resolve by name. server.js locates them and stores absolute paths at startup (`findFfBin`; override with `ffmpegDir` in config). A bare `ffprobe` invocation fails silently under a service account and video metadata comes back `null`.
- Use **one** autostart mechanism only — two instances collide on port 8080 (`EADDRINUSE`).

## Remote access hardening (optional)

The app binds `0.0.0.0` but is intended to stay private. To reach it from other devices without exposing it to the LAN or the public internet, put it behind a mesh VPN such as **Tailscale**: block inbound 8080/8443 at the firewall except from **localhost** and your **VPN address ranges**, and enable the VPN's unattended mode so the machine is reachable after a cold reboot before login. Step-by-step client + firewall setup is in the [README](README.md#accessing-it-privately-over-tailscale).

## Prompt sanitizer

The prompt/filename search index runs user prompt text through a sanitizer whose filter terms are **base64-encoded** in server.js (and mirrored in `config.json`'s `nsfwTermsB64`) so no plaintext terms live in source. Preserve that encoding when editing the term list.

---

> Deployment specifics for a particular install (real paths, service/task names, firewall rules) don't belong in this committed file — keep them in a gitignored `CLAUDE.local.md`, which Claude Code also auto-loads.
