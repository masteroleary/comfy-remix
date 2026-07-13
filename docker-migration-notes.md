# ComfyRemix ↔ Docker ComfyUI — migration notes

**Status:** ComfyRemix left UNCHANGED for now. Apply the changes below **only if the app misbehaves** after ComfyUI is moved into Docker. Verified against `server.js` (incl. uncommitted changes) + `config.json` on 2026-07-12.

## What does NOT need changing
- `comfyUrl` stays `http://127.0.0.1:8188`. All ComfyUI traffic is URL-proxied (`/api/comfy/*` → COMFY_URL; `/comfy-ws` websocket). The container exposes 8188 on localhost, so it answers identically.
- The Inherit / Remix-Run conversion (`/api/workflow-prompt`) only applies value overrides (prompt, LoRA, steps, frames, seed). It injects no file paths — container-safe.
- Thumbnails: `ffmpeg`/`ffprobe` run on the host over the output folder — fine once `comfyOutput` points at E:.
- Input-image uploads (if used) go through the `/api/comfy/*` proxy to the container's `/upload/image` (content, not a path) — safe.

## Config changes to apply IF the app fails (`D:\Archive\config.json`)
| Key | Current | Change to |
|-----|---------|-----------|
| `comfyOutput` | `D:\ComfyUI-Easy-Install\ComfyUI\output` | `E:/comfy/output` |
| `comfyDir` | `D:\ComfyUI-Easy-Install\ComfyUI` | `E:/comfy` (workflows resolve to `E:/comfy/user/default/workflows` via the `user` bind-mount) |
| `comfyStartCmd` | `D:\ComfyUI-Easy-Install\Start ComfyUI.bat` | `["docker","start","comfyui"]` |

(Settings panel hot-reloads these — no server restart needed.)

## Content fix (workflow files with absolute paths)
Any workflow node with a hardcoded Windows path won't resolve inside the Linux container. Re-point these to **relative** names under input/output. Known instances:
- `default-workflows/APP VIDEO.json:2146` → `"fullpath": "D:\\ComfyUI_windows_portable\\ComfyUI\\output\\WAN_4K_00003.mp4"`
- `default-workflows/APP VIDEO.json:2756` → `"fullpath": "D:\\ComfyUI-Easy-Install\\ComfyUI\\output\\Video\\Wan480_00187.mp4"`
- Any media whose *embedded* workflow baked in an absolute `D:\...` input path — reachable via Inherit.

## Symptoms that mean "apply the changes above"
- File browser / Files view is empty or missing recent generations → `comfyOutput` still points at D:.
- Manage Workflows list is empty / can't save workflows → `comfyDir` still points at D:.
- "Start ComfyUI" button errors or does nothing when ComfyUI is down → `comfyStartCmd` still points at the old .bat.
- A specific workflow errors on Run with a missing-file/path error → that graph has an absolute `D:\` path; fix as above.
