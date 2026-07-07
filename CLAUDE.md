# ComfyRemix

A local web app for browsing, curating, and managing AI-generated media (images, videos, audio) from ComfyUI and other tools.

> **To start the app:** `cd D:/Archive && npm start` (runs `node server.js`, serves on **http://localhost:8080**). After editing server.js or index.html, restart with `node restart.js`.
>
> **Auto-start:** runs headless at boot via scheduled task **`ComfyRemixAutoStart`** (renamed from `ArchiveAutoStartBoot` on 2026-07-07) — Trigger=AtStartup, Principal=**SYSTEM** (RunLevel Highest), runs `C:\Program Files\nodejs\node.exe server.js` from `D:\Archive`, hidden, no time limit, auto-restart 3× on failure. Serves HTTP 8080 + HTTPS 8443 (certs in `certs/`) before any login. The older at-logon task **`ArchiveAutoStart`** (user `webde`) is left **Disabled** to avoid double-starting node (EADDRINUSE on 8080). The 8080 listener is **node** — if you ever see python on 8080, that's an unrelated squatter (e.g. ComfyUI) and a second node will EADDRINUSE.
>
> **Restarting after code changes (server.js):** run `D:\Archive\scripts\register_comfyremix_task.ps1` (self-elevating; one UAC prompt at the console). It kills the current listener, (re)registers `ComfyRemixAutoStart`, starts it, and writes the outcome to `scripts\register_task_result.txt` — **always read that log to confirm**, because of the visibility gotcha below. Static pages (index/inspect/jobs/chat/voice html, common.css, key-prompt.js) are served from disk — no restart needed.
>
> **Windows 11 24H2+ gotcha:** non-admin `Get-ScheduledTask` **cannot see SYSTEM tasks** — the boot task will look missing from a normal shell. That's query visibility, not absence. Verify via the result log above, via an elevated shell, or by checking who owns port 8080 (`Get-NetTCPConnection -LocalPort 8080 -State Listen`).
>
> **Known caveat (SYSTEM context):** under SYSTEM the in-app Claude-chat panel can't resolve the user's global `claude` login — set **`anthropicApiKey`** in ⚙ Settings (it's injected into the CLI env), after which the assistant works headless. To revert to the per-user at-logon model: `Enable-ScheduledTask ArchiveAutoStart` and disable/unregister `ComfyRemixAutoStart`.

## Architecture

- **server.js** — Node.js HTTP server (zero dependencies). Serves the SPA, provides REST APIs for file listing/favoriting/deletion, streams Claude Code responses via SSE.
- **index.html** — Single-page application. Dark theme, responsive grid, modal viewer, Claude Code chat panel.
- **config.json** — Runtime config (port, paths, API keys). Gitignored.
- **Media/** — Root media directory. Contains all browsable content. Gitignored.

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

## Running

```bash
npm start              # Uses config.json defaults
npm run restart        # Kill existing + restart (use after code changes)
node server.js 8081    # Override port
node server.js 8080 E:/other/media  # Override port and media dir
```

**After editing server.js or index.html**, restart with: `cd D:/Archive && node restart.js`

## Config

Copy `config.example.json` to `config.json` and fill in your values. Paths/URLs/keys are also editable at runtime via the in-app ⚙ Settings panel (hot-reloaded, no restart):
- `port` / `httpsPort` — HTTP (default 8080) / HTTPS (default 8443, needs `certs/`)
- `mediaDir` — Path to media files root
- `comfyDir` — ComfyUI install directory (workflow list, Claude Code cwd)
- `comfyOutput` — Path to ComfyUI output folder
- `comfyUrl` — ComfyUI API address (default `http://127.0.0.1:8188`; used by the run proxy, WS proxy, and status checks)
- `comfyStartCmd` — command that launches ComfyUI (shell string or `[cmd, ...args]` array); if unset, auto-detects `Start ComfyUI.bat` next to `comfyDir`. Used by the Run button's "start it now" offer (`POST /api/comfy/start`). Note: launched by the SYSTEM server it runs invisibly in session 0.
- `comfyNotesDir` — optional notes folder passed to Claude Code via `--add-dir`
- `ollamaUrl` / `voxtralUrl` — local LLM / TTS service addresses
- `voxtralStartCmd` — command that launches your Voxtral service (shell string or `[cmd, ...args]` array); the Start button errors without it
- `claudeCliPath` — optional explicit path to the Claude Code CLI (`claude.exe` or legacy `cli.js`); otherwise auto-detected across user profiles' npm globals
- `anthropicApiKey` / `xaiApiKey` / `civitaiApiKey` — API keys (also settable in ⚙ Settings)

## Claude Code Integration

The chat panel (robot button) spawns `claude -p` in headless mode against the ComfyUI directory. Each message is a fresh session. The server streams `stream-json` output back to the browser via SSE.

Requires `@anthropic-ai/claude-code` installed globally: `npm install -g @anthropic-ai/claude-code`

## Network / Firewall (Tailscale-only access)

This machine (Tailscale hostname **`<machine>`**, IP `100.x.y.z`) is hardened so the Archive app and remote access are reachable **only over Tailscale + localhost**, not the LAN or public internet. Windows Defender Firewall: all profiles ON, default inbound = Block. The Tailscale adapter is classified **Private**; the physical Wi-Fi NIC is **Public**.

Rules don't rely on profile classification alone — they're pinned to the Tailscale address ranges:
- IPv4 CGNAT: `100.64.0.0/10`
- IPv6 ULA: `fd7a:115c:a1e0::/48`

Inbound ALLOW rules configured (RemoteAddress = the two Tailscale ranges above, so they're Tailscale-only regardless of profile):

| Rule | Port/Proto | Profile | Notes |
|------|-----------|---------|-------|
| `Archive HTTP 8080` | TCP 8080 | Private | Scoped to Tailscale ranges |
| `Archive HTTPS 8443` | TCP 8443 | Private | Scoped to Tailscale ranges |
| `RDP Tailscale only` | TCP 3389 | **Any** | Profile=Any (not Private) so it still matches if the Tailscale adapter is classified Public/Unidentified pre-login; built-in "Remote Desktop" group left DISABLED so RDP can't be reached from the LAN |
| `RDP Tailscale only UDP` | UDP 3389 | **Any** | **Required companion** — RDP's RemoteFX transport uses UDP 3389. Without it, RDP connects over TCP then hangs at "Configuring remote PC". |
| `Ollama Tailscale only` | TCP 11434 | Replaces the broad auto-created `ollama.exe` "Defer to user" rules, which are now DISABLED |

Notes / gotchas:
- The original `ollama.exe` inbound rules were "Defer to user" allow rules — `Set-NetFirewallRule -RemoteAddress` can't scope those (`HRESULT 0x80070057`). They were disabled and replaced with the explicit `Ollama Tailscale only` rule.
- Localhost keeps working for all of the above (loopback isn't subject to these rules).
- Broad app rules intentionally left alone: OVR/VR Server and Meta Quest/VR (used over Wi-Fi/LAN, not Tailscale), plus node/VS Code/Steam/etc.
- Open follow-ups: Ollama was observed listening on IPv6 `::` only (not `0.0.0.0`), so IPv4 Tailscale clients may not reach `11434` until it also binds IPv4. The Archive app binds `0.0.0.0`; binding it to the Tailscale IP would add defense in depth.

**Tailscale unattended mode** (required for pre-login reachability): `HKLM\SOFTWARE\Tailscale IPN\UnattendedMode = "always"` (REG_SZ) is set, so the tailnet stays connected after reboot **before any user logs in**. Without it, Tailscale drops at logoff and the box is unreachable until someone logs in at the desk (this broke pre-login RDP). Combined with the SYSTEM at-startup `ComfyRemixAutoStart` task + Profile=Any RDP rules, the machine is fully reachable headless after a cold boot. Setup script: `D:\Archive\scripts\enable_headless_access.ps1` (unattended + Profile=Any in one run).

To re-verify rule scope (read-only):
```powershell
'Archive HTTP 8080','Archive HTTPS 8443','RDP Tailscale only','Ollama Tailscale only' | ForEach-Object {
  $r = Get-NetFirewallRule -DisplayName $_ -ErrorAction SilentlyContinue
  if ($r) { $af = $r | Get-NetFirewallAddressFilter
    [pscustomobject]@{ Rule=$_; Enabled=$r.Enabled; Profile=$r.Profile; Remote=($af.RemoteAddress -join ',') } }
} | Format-Table -Auto
```

## Auto-mute at logon

`mute_audio.ps1` mutes **all active render endpoints** via the Windows Core Audio API (`IMMDeviceEnumerator.EnumAudioEndpoints(eRender, ACTIVE)` → `IAudioEndpointVolume.SetMute($true)` on each) — no external deps, sets mute=true definitively. Muting *all* active endpoints (not just the default) is required for RDP: in an RDP session the active device is **"Remote Audio"** (the redirected endpoint), and it's created *late* on connect — muting only the default at logon missed it. `mute_audio.ps1 list` enumerates endpoints (name / default flags / muted) for diagnosis. **Keep this file**; the scheduled task references it.

Scheduled task **`MuteAudioAtLogon`** (user `<MACHINE>\<user>`, RunLevel=Limited, LogonType=Interactive, hidden) runs it on **two triggers**: At-logon **and** TerminalServices session connect/reconnect (`Microsoft-Windows-TerminalServices-LocalSessionManager/Operational` Event ID 21/25), each with a **5s delay** so the Remote Audio endpoint is initialized first. Re-registered via `Register-ScheduledTask` (no elevation for a per-user interactive task).

```powershell
# inspect / re-run
Get-ScheduledTask -TaskName 'MuteAudioAtLogon' | Select State,@{n='RunLevel';e={$_.Principal.RunLevel}}
powershell -NoProfile -ExecutionPolicy Bypass -File D:\Archive\scripts\mute_audio.ps1   # manual mute now
```

> Scratch scripts/reports from the firewall + mute setup were moved into `D:\Archive\_fw_scratch\` (hard-delete was blocked); safe to delete that folder manually.

## "Dark drive" privacy (D:)

To minimize D:\ files surfacing in Windows UI, these per-user settings were applied (HKCU, no admin): `Explorer\Advanced` → `ShowRecent=0`, `ShowFrequent=0` (Quick Access recents/frequent off), `Start_TrackDocs=0` (recent-docs/jump-list tracking off); jump lists cleared (`%AppData%\Microsoft\Windows\Recent\AutomaticDestinations` + `CustomDestinations`, wholesale); explorer restarted. Turning OFF D: content indexing (`Win32_Volume IndexingEnabled=$false`) needs admin — run `D:\Archive\scripts\set_dark_indexing.ps1` (self-elevating). Details/before-after in `scripts\dark_drive_notes.txt`. NOT covered: app MRU lists (Office/VS Code/etc.), and files stay visible to anyone browsing D: directly.
