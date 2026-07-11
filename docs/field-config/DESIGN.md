# ComfyRemix — Workflow Import Field Config (design proposal)

*Updated 2026-07-10 after a multi-agent review (36 confirmed findings) and a fix pass. The prototype generator `gen_field_config.js` now passes a 27-assertion harness covering the cases the review broke. Validated against **40 unique workflows** (44 files — the 4 `APP *` files in `default-workflows` are separate copies of workflows also in the main dir) across the local ComfyUI workflows dir + `default-workflows`.*

> **Generating example configs:** `node gen_field_config.js <workflow.json> --out out.json` (or pass a directory for a batch summary). Example outputs and the batch log are **not committed** — they embed real prompt text and model/LoRA filenames from local workflows, which this public repo deliberately keeps out of git. Regenerate them locally as needed.

> **Status:** prototype + design only. **No app code (server.js / inspect.html) has been changed.** This documents what to port. Items still needing a product decision are collected in **§9**.

## 1. Why

Today the generate form is hardcoded server-side (`/api/workflow-config`, server.js:2544-2615): `{prompt, loras, frames, seed, steps, cfg, presets, highLowSteps, lorasHigh, lorasLow, mtime}` — each key backed by a bespoke heuristic. The Manage Workflows modal only lets the user remap 3 node ids (`mappings[name] = {promptNodeId, stepsNodeId, seedNodeId}`). There is:

- no width/height/length/sampler/scheduler/denoise/model/vae override anywhere,
- no way to expose a field the heuristics miss (beyond those 3 remaps),
- **no subgraph support** — `workflowToPrompt` (server.js:676-1035) skips UUID-typed nodes (`if (!info) continue`). 28 of the 44 files contain subgraphs; several expose their only editable knobs as promoted subgraph widgets. (Not all 28 *fail* to run today — a subgraph whose instance is bypassed, or whose subtree is pruned off the output chain, still converts; but any workflow that needs a value from inside an active subgraph does.)

This proposal replaces the hardcoded config with a **per-workflow field config JSON**, generated when the user enables (imports) a workflow, editable in the import UI (tick/untick + relabel fields), stored server-side, and consumed by both the form renderer and the override applier.

## 2. The config JSON

```jsonc
{
  "version": 1,
  "workflow": "APP VIDEO.json",
  "format": "graph",                     // "graph" | "api" | "unknown"
  "generatedAt": "2026-07-10T…",
  "workflowMtime": 1752000000000,        // source file mtimeMs → staleness check (offer re-scan)
  "zones": [                             // groups from the graph, classified — UI grouping + defaults
    { "title": "Models", "color": "#3f789e", "class": "neutral", "nodes": [63, 147, 127] },
    { "title": "Spaghetti Zone 3.0", "color": null, "class": "internal", "nodes": [ … ] }
  ],
  "presets": [                           // rgthree Fast-Groups-Muter(max one) color-matched groups
    { "title": "Anime Presets", "on": false }, { "title": "Realism Presets", "on": true }
  ],
  "fields": [ /* Field objects, below */ ],
  "skipped": [                           // transparency: what detection deliberately dropped
    { "reason": "unresolvable-source", "kind": "sampler", "node": 193, "widget": "sampler_name", "note": "…" }
  ]
}
```

### Field object

```jsonc
{
  "id": "steps_high",                    // stable slug, unique per config; referenced by run overrides
  "label": "Steps (High)",               // shown in form; user-editable at import. Duplicate labels get a "(#id)" suffix
  "kind": "steps",                       // semantic kind (catalog below) — drives control + ordering
  "control": { "type": "int" },          // int|float|text|multiline|boolean|combo|seed|lora_rows|image|video|audio
                                         //   (+ optional min/max/step/options; combo options filled from /object_info at render)
  "value": 1,                            // default captured from the workflow. MAY BE ABSENT if none was serialized
  "enabled": true,                       // the user's import-time tick (initialized to `recommended`)
  "recommended": true,                   // generator's suggestion
  "confidence": 0.95,                    // 0..1
  "source": "auto",                      // "auto" | "manual" (added from node inspector)
  "variant": "high",                     // optional: "high"|"low" for Wan-2.2-style pairs
  "pairId": "steps_low",                 // optional: id of the sibling variant
  "stage": 1,                            // optional: multi-stage workflows (LTX Stage #1/#2/#3)
  "section": "Models",                   // UI grouping — group title or subgraph name
  "zoneClass": "neutral",                // user|neutral|internal|presets (from zones)
  "inactive": true,                      // optional: target (or its via-node) muted/bypassed — listed, never auto-on
  "unreachable": true,                   // optional: no target feeds an output node (pruned in conversion) — never auto-on
  "insideSubgraph": true,                // optional: from deep scan of a subgraph definition
  "meta": { … },                         // optional: rule-specific (e.g. dual-sampler boundary roles, lora filename)
  "targets": [                           // where to write the value (1..n = fan-out, e.g. one Seed → all samplers)
    {
      "nodeId": 127,                     // graph node id (== API prompt key; converter preserves ids)
      "path": [],                        // subgraph instance chain; [] = top level, [7125] = inside instance 7125
      "class": "KSamplerAdvanced",       // for validation/repair when the workflow file changes
      "widget": "steps",                 // widget/input name (== API prompt input key)
      "widgetIndex": 3,                  // int index into array widgets_values; STRING (widget name) for
                                         //   object-form widgets_values (VHS); null when no layout is derivable.
                                         //   The applier dispatches on typeof — see §5.
      "proxy": { "node": 7123, "widget": "lora_name" }   // subgraph mirror: real storage is this inner def node
    }
  ],
  "evidence": { "rule": "sampler-steps", "class": "KSamplerAdvanced",
                "merged": ["…"], "note": "…", "nodeTitle": "…" }  // debug / inspector display
}
```

### Kind catalog

`prompt, negative_prompt, seed, steps, cfg, denoise, shift, guidance, sampler, scheduler, width, height, size_preset, length, fps, batch, model, vae, lora, lora_list, image_input, video_input, audio_input, toggle, int, float, text, combo`

`lora_list.value` is `[{slot, on, lora, strength, …}]` — see §5 for how `slot` / the extra widget-name keys drive application per loader type.

## 3. Detection rules

Order matters; every rule records itself in `evidence.rule`. Dedupe is by resolved target `(path, nodeId, widget)`.

**Source resolution (the load-bearing fix).** When a sampler/consumer widget is link-fed, the generator walks upstream to the *editable literal* that feeds it and targets **that** node — never a routing node. The walk:
- passes through `Reroute`, `Set/GetNode`, `easy set/getNode`, and `Any Switch (rgthree)` (the switch resolves to its first **active** input, matching rgthree's runtime pick);
- chooses the source widget by the **feeding link's output-slot name** (`src.outputs[fromSlot].name`), not "the first widget" — so a multi-output node like `Input Parameters (Image Saver)` maps its `steps` output to the `steps` widget, not `seed`;
- recurses if that widget is itself link-fed, and **bails to a `skipped` entry** if the chain ends in something non-editable (math nodes, unmatched multi-output). It never guesses.

This replaces the original bug where every link-fed sampler param resolved to the source's first widget and collided under dedupe (which silently swallowed CFG on APP T2I, etc.).

1. **Samplers** — `KSampler(Advanced)`, `KSampler (Efficient)`/`Adv.`, `WanVideoSampler`; custom-sampling cluster `RandomNoise`/`CFGGuider`/`BasicScheduler`/`KSamplerSelect`/`Flux2Scheduler`. Seed/steps/cfg/denoise/sampler/scheduler(/shift). Widget indices from per-class layouts that account for the `control_after_generate` slot — inserted **only when there is a surplus serialized slot**, so a legitimately-null widget after a seed no longer shifts every later index.
2. **Wan 2.2 dual high/low** — exactly two active `KSamplerAdvanced`, high = `start_at_step==0`. Emits `steps_high`/`steps_low` whose **values are the split** (`high = end_at_step`, `low = total − high`), with `meta` recording the sampler ids and boundary role so the applier can reproduce the live `highLowSteps` semantics (§5). If both samplers' steps are fed from one shared source, they collapse to a single `Steps` knob (no self-referential pair). Power-Lora-Loader / GGUF-loader pairs matched by model-chain trace and `high|low` filename.
3. **Seed** — `Seed (rgthree)` preferred; underscore-compound names (`initial_seed`, `noise_seed`, `seed_value`) now match. All seed-kind fields merge into **one multi-target field** (control type `seed`, `-1` = randomize; pin/randomize semantics preserved).
4. **Prompts** — ports = text-consuming inputs on `CLIPTextEncode`, `WanVideoTextEncode` (pos+neg), and `Efficient Loader` (`positive`/`negative`). Link-fed ports walk concat/replace/switch/wildcard chains to editable leaves; **a link-fed port with no editable leaf is dropped to `skipped`** (its serialized widget is stale — not surfaced). A global title rule (parity with `resolvePromptNode`) also promotes any string-widget node titled MAIN/POS + PROMPT. Ranking: MAIN/POS title > longest text, with a heavy penalty for muted or output-unreachable candidates so a muted preset branch can't win. `Lora Loader (LoraManager)` and other serialized-object nodes are excluded from text leaves.
5. **Titled primitives** — `easy int/float`, `INTConstant`, `Primitive*`, `mxSlider(F)`, Crystools ints whose **title** maps to a kind. mxSlider value = `Xi` (int mode, `isfloatX=0`) or `Xf` (float mode); the field targets **both** `Xi` and `Xf` so the applier's single write path can't miss the live slot (parity with the app writing both).
6. **LoRAs** — Power Lora Loader → `lora_list` (rows carry `slot` = index into `widgets_values`); `CR LoRA Stack` / `easy loraStack` → `lora_list` with rows carrying the exact `switch_N`/`model_weight_N` or mode-dependent `lora_N_(model_)strength` widget names, and honoring the stack's `toggle`/`mode`/`num_loras`; plain `LoraLoader(ModelOnly)`/`WanVideoLoraSelect` → per-node `lora` field with high/low variant. `Lora Loader (LoraManager)` is **not** detected (its widget is a serialized object; the manual-add flow covers it if needed).
7. **Size / length / media / models** — `EmptyLatentImage`(+Flux2), `SDXLEmptyLatentSizePicker+` (combo), `LoadImage` (MAIN boost), `VHS_LoadVideo`, `LoadAudioUI`, `VHS_VideoCombine.frame_rate` (fps), checkpoint/UNET/GGUF/WanVideo/VAE loaders (off by default, combo).
8. **Generic canonical-widget-name gap fill** — active node with an unlinked widget named `…seed…|steps|cfg|guidance|denoise|width|height|frames|length|duration|fps|frame_rate` (c=0.65, off). Catches all-in-one nodes (`WanLooperNative`, `LoopConfigWan`, `NativeVaceLooper`).
9. **Subgraph promoted widgets** (§4).
10. **Subgraph deep scan** (§4).
11. **Presets** — rgthree `Fast Groups Muter` with `toggleRestriction:"max one"`, groups by `matchColors` (case-insensitive; "Purple"→`#a1309b`). The muter's **own mode is ignored** (parity with `detectPresetGroups`). Each preset carries `on` (any member group node unmuted).

### Zones ("areas acceptable to change")

Group titles are the author's contract. Classification by **title regex** (color is unreliable across authors): `internal` (`spaghetti|do not|don't touch|internal|bypass|logic|clean up|metadata|…`), `presets` (`…Presets`), `user` (`input|output|editor|settings|controls|prompt|lora|load image/video…`), else `neutral`. Internal-zone fields are capped at 0.4 confidence and never auto-enabled. Membership = the **center** of a node's bounding rect (incl. ~30px title bar) inside the smallest containing group — matching the ComfyUI frontend / rgthree, not the node's top-left corner.

### Reachability

A field whose every target sits outside the output-reachable graph (approximation of `workflowToPrompt` pruning: walk inputs back from active `Save*`/`Preview*`/`VHS_VideoCombine`/`Image Saver`/Anything-Everywhere nodes; mode-2 blocks, mode-4 passes through) is flagged `unreachable`, has confidence reduced, and is never auto-enabled. This stops gap-fill from promoting a dead-branch knob (e.g. a FaceDetailer CFG in a bypassed preset) as "the" control.

### Auto-enable policy

`recommended` (→ initial `enabled`): prompt/seed/steps/cfg/lora_list/length/width/height/size_preset at confidence ≥ 0.8; MAIN image ≥ 0.9. **Gap-fill**: if a core kind (prompt/seed/steps/cfg/length/width/height) has no recommended field, the best remaining candidate ≥ 0.6 that is active + reachable + non-internal is promoted. Media-driven workflows (faceswap) get all reachable image inputs. Everything else — models, samplers, schedulers, denoise, fps, toggles, subgraph deep-scan finds — is generated **disabled**. See §9(A) for the one interaction this creates.

## 4. Subgraphs

Definitions live in `definitions.subgraphs[]`; instances are nodes whose `type` is the def UUID. The author's chosen interface is what we show, hiding children:

- **Def inputs** carry `name`, `type`, and a user-facing `label` (`shift_high`, `lora_name_low`, `length (seconds)`) — labels drive naming AND high/low pairing.
- **Instance `properties.proxyWidgets`** is the ordered widget list:
  - `["-1", <defInputName>]` → promoted **def-input widget**; value in the next slot of the **instance's** `widgets_values`. If that slot is empty, the default is read from the inner node the def input feeds, **resolved through the def link's `target_slot`** to the correct inner widget name (fixes the earlier name-mismatch misread). A `control_after_generate` promoted widget is skipped.
  - `[<innerId>, <widgetName>]` → a **mirror**; value lives on the def's inner node. **Skipped if that inner widget is link-fed inside the def** (its serialized value is stale and writes are dead — this was the purz "two contradictory Width fields" bug) or if its paired def input is externally linked.
  - Externally-linked promoted inputs are not fields.
- **Control types** derive from the def-input `type` (`COMBO`→combo, `INT`/`FLOAT`, `BOOLEAN`, `STRING`→text/multiline), with a `seed` control for seed-kind — so a promoted `noise_seed` no longer renders as a plain text box.
- **Application**: def-input targets write the instance (`widgetIndex` into instance wv); mirror targets carry `proxy:{node,widget}` and write the def's inner node. Both require the converter to **expand subgraphs** (§8). Deep-scan targets use `path:[instanceId]` + inner node id.
- **Deep scan** (depth 1, defs with ≤ 4 instances): runs the sampler/prompt/lora/size/model detectors inside each def, skipping widgets that are input-fed or already mirrored, emitting `insideSubgraph:true` fields at 0.85× confidence. These are **off by default** *except* when gap-fill has nothing else to promote for a core kind — see §9(A). Defs with > 4 instances get a `skipped` entry rather than field spam. (Note: no workflow in the current corpus actually trips the > 4 cap — every def has exactly one instance; the cap is a safety valve, not an exercised path.)

## 5. Applying overrides at run time

Run request stays `POST /api/workflow-prompt`; `overrides` becomes `{ fieldId: value, … }` (legacy keys kept during migration). For each enabled field the server writes `value` to every target. **Two write legs** (mirroring today's CFG dual-write, server.js:2725-2739):

| Control / kind | Graph write (pre-conversion) | Converted-prompt write (post) | Notes |
|---|---|---|---|
| int/float/text/combo/boolean | `wv[widgetIndex]` (array) or `wv[widget]` (object-form, `widgetIndex` is the name) or, for subgraph targets, instance/inner-node per `path`+`proxy` | `prompt[nodeId].inputs[widget] = value` **if the input is a literal** (skip if it's a link ref — the CFG precedent) | `widgetIndex:null` targets have no graph leg; the converted-prompt leg by input-name still applies |
| seed | randomize every `*seed*` target unless pinned (today's loop, inspect.html:1767-81) | same | one multi-target field fans out |
| mxSlider (int/float) | write **both** `Xi` and `Xf` slots | `inputs.Xi`/`inputs.Xf` if literal | value is Xi (int) or Xf (float); writing both is what the live app does |
| steps_high / steps_low (dual pair) | `total = high+low`; write `total` to **both** samplers' `steps`; set boundary `high.end_at_step = low.start_at_step = high` | write `steps` on both converted samplers | driven by `meta.samplerHigh/Low`; reproduces the live highLowSteps split |
| lora_list — Power Lora Loader | per row, set `wv[row.slot].on` / `.strength` | converter emits `lora_1..N` (server.js:826-836); write by row order | rows carry `slot` = wv index |
| lora_list — CR / easy stack | per row, set `wv[row.onWidget]` / `wv[row.strengthWidget]` (names in the row) | corresponding stack inputs | mode/toggle captured at scan time |
| image_input / video_input / audio_input | set the load node's path widget | — | interaction with existing auto-inject is a decision — §9(B) |

Because most previously link-fed targets now resolve to editable literal source nodes, the "write to a link-fed widget is dead" case is largely designed out; the remaining rule is the CFG-precedent literal check above. §9(D) notes the one residual policy question.

## 6. UI flows

**Import (Manage Workflows modal)** — on tick-to-enable, server generates the config; the row expands into a field checklist grouped by `section`, pre-ticked from `recommended`, with confidence dots, internal-zone fields de-emphasized, and `inactive`/`unreachable` fields shown but off. Save persists the config. The 3 prompt/steps/seed dropdowns become ordinary field-target edits. "Refresh fields" regenerates and **merges**: user `enabled`/`label` edits and `source:"manual"` fields survive (matched by target identity); auto fields whose targets vanished move to `skipped` (`reason:"stale"`).

**Node inspector ("expose a missed field")** — each editable input row gets a `＋ field` button → `POST /api/workflows/field-add {workflow, nodeId, widget, path?}` appending a `source:"manual"` field. Reach vs. today's graph-based remap dropdowns is a decision — §9(C).

**Storage** — new top-level `fields` map in `app-workflows.json` keyed by filename, beside `enabled`/`labels`/`mappings`. If size grows (Katie 2 ≈ 25 fields, SVI-10-clips ≈ 120), split to `workflow-fields/<name>.json` (gitignored); schema identical.

## 7. Validation results (post-fix)

- **0 errors** across all 44 files. `verify_fixes.js` passes **27/27** assertions.
- **APP T2I** — steps now targets `#128:steps=32` (was `#128:seed=0`, a silent no-op); CFG is the main-pass `#128:cfg=2` (was dedupe-swallowed → FaceDetailer's 6). Sampler/scheduler are link-fed by a math/switch chain and correctly land in `skipped` rather than mis-target.
- **APP ANIMA** — steps `#366:Xi=32` (was stale `steps_total=20`); CFG `#253:Xi` via the titled mxSlider; 6 style presets with `on` state.
- **APP VIDEO** — `steps_high=1` / `steps_low=8` (the split, not raw 9/9 which would double total steps); Frames mxSlider writes both Xi+Xf.
- **APP REAL** — primary prompt resolves through the Efficient Loader to the real `#246` text leaf (was landing on a bypassed "Upscale Positive"); lora rows carry slot indices.
- **Katie 2** — seed detected on `#6919:initial_seed` (was entirely missing across the WanSVI family); field count 60→25 as duplicate mirror spam collapsed.
- **LTX subgraph** — promoted `noise_seed` renders as a `seed` control (was `text`).
- **purz** — the two contradictory Width fields are gone; width = titled primitive `#159=480`.
- **API (VACE)** — image input enabled, width/height/length present, presets key present, seed/steps/cfg/prompt + all 10 `prompt_loop_N` detected.
- **MGH V5.2.2** — the muted `#291` negative is no longer even a candidate (source resolution follows the active preset leaf `#347`); no `[object Object]` LoraManager prompt.

**Known gaps** (in `skipped` / by design): LTXDirector/LTXSequencer mega-nodes hold prompts in opaque widgets (manual-add covers this); `Anything Everywhere` broadcast value-links aren't walked; deep scan stops at depth 1; combo `options` must be filled from `/object_info` at render; deep-scan model fields default to a `text` control until options load.

## 8a. Implementation status (2026-07-10)

A first working slice is wired into the app on branch `feat-inputconfig`:

- **`field-config-runtime.js`** (new, at repo root) — `buildFieldConfig` (detect + merge saved user edits) and `applyFieldConfigOverrides` (generic `{fieldId: value}` → raw-graph writes, incl. the dual-sampler split, mxSlider both-slots, seed pin/fan-out, Power-Lora rows, preset selection). Pure logic with injected deps; unit-tested against the real APP workflows.
- **server.js** — requires the generator (`docs/field-config/gen_field_config.js`) + runtime; `store.fieldConfigs` in `app-workflows.json`; endpoints `GET/POST /api/workflow-field-config`; and `/api/workflow-prompt` now accepts `overrides.fieldValues` (applied before conversion, coexisting with the legacy keys).
- **inspect.html** — the **Detected Fields** panel is the generate form for APP workflows (default on; `body.fields-mode` hides the classic scattered controls via CSS, "↩ Classic controls" flips back per-workflow). Enabled fields render directly, reusing the existing styled components (seed pin switch, high/low LoRA columns via `renderLoraRows`, same input styling); disabled fields sit in a "(N hidden fields)" expander and pop to the top when toggled on. Per-kind controls: prompt/negative (textarea + replacement rules), seed (🎲/📌 switch), steps/cfg/width/height/length/etc (number), LoRA rows/columns, image (thumbnail + editable path + "📷 current"). **Save field setup** persists on/off per workflow; **Refresh detection** re-runs generation keeping edits. Run sends `fieldValues`; the existing image-upload, seed-randomize, preset-multiply, and output/job machinery are reused unchanged.

Verified live end-to-end on APP T2I/VIDEO (e.g. steps→#128:steps=40, cfg→#128:cfg=3.5, seed pin, dual-sampler split). **Not yet done:** subgraph-path targets are skipped with a warning (needs converter expansion, below); LoRA-stack (CR/easy) row-apply; combo option lists from `/object_info`; a full gallery picker for image fields (current control is a thumbnail + editable filename + "use current").

## 8. Suggested implementation order

1. Port the generator into server.js (it has `getObjectInfo` for exact widget layouts — replaces the hardcoded layout maps and makes control-type/options exact).
2. Subgraph expansion in `workflowToPrompt` — prerequisite for **running** any workflow that needs a value from an active subgraph, and for applying subgraph-targeted fields.
3. `fields` storage + generic override applier (§5 table; keep legacy override keys working).
4. Manage-modal field checklist UI.
5. Inspector `＋ field` / `hide` actions.
6. Regenerate + hand-check the 4 APP workflows against current behavior (they pass the harness).

## 9. Decisions (resolved 2026-07-10)

- **(A) Deep-scan auto-enable — DECIDED: yes, keep gap-fill auto-enable.** When a subgraph-heavy workflow has no top-level core knob, gap-fill promotes a deep-scan field (e.g. LTX Director's Stage #1 steps/cfg turn **on**) so the default form is usable. This is the prototype's current behavior.
- **(B) `image_input` vs auto-injection — DECIDED: coexist, and drop the MAIN dependency.** Detection no longer requires a MAIN title — every reachable `LoadImage`/`VHS_LoadVideo`/`LoadAudioUI` becomes a field (`control.picker:"gallery"`, `value` = embedded path). Run-time model:
  - The field shows a **thumbnail of the current selection** when the path resolves to a file in the app's Media root; otherwise a placeholder + "pick image."
  - The user can **replace it with any image from the app gallery**; that choice is injected into the target node at run.
  - **Default source** (`meta.defaultSource`): MAIN-titled nodes default to `"viewed"` — the existing behavior of injecting the currently-viewed gallery image, so one-click runs are unchanged — while non-MAIN nodes default to `"embedded"` (the workflow's own path, shown as the thumb). Either can be overridden per run via the picker.
  - Auto-injection is thus *surfaced and overridable* rather than replaced; a workflow with no MAIN node still gets a working, pickable image field.
- **(C) Inspector manual-add reach — DECIDED: active + reachable (converted-prompt) nodes only.** `＋ field` does **not** offer muted or conversion-pruned nodes. Rationale: a field on a node that doesn't execute silently does nothing; excluding them prevents dead controls. (This is stricter than today's graph-based remap dropdowns, which can point into muted preset branches — an intentional narrowing.)
- **(D) Converted-prompt write for link-fed targets — DECIDED: keep the CFG precedent (never sever author wiring); manual-add auto-redirects to the source.** Explanation below.

### On (D): why link-fed targets are handled by resolution, not overwrite

ComfyUI keeps two representations of a workflow:

1. **The graph** (LiteGraph JSON) — each node has a `widgets_values` array. A widget can be *"converted to an input,"* meaning the node receives that value over a wire from another node instead of from its own literal. When that happens the widget's slot in `widgets_values` still holds a **stale leftover value** that ComfyUI ignores at run time (the wire wins).
2. **The converted prompt** (API format, what actually executes) — each `inputs.<name>` is either a **literal** or a **link reference** `[sourceNodeId, slot]`.

When we apply an override we write to both (the graph copy feeds the embedded `extra_pnginfo.workflow`; the converted prompt is what runs). For a widget that is **link-fed**, each leg has a failure mode:

- Writing the value into the graph's `widgets_values` slot does **nothing** — the wire overrides it at run time (stale slot).
- Writing the value into the converted prompt's `inputs.<name>` **replaces the link reference with a literal**. That takes effect — but it **severs the wire the author built.** Example: if two samplers' `steps` are both wired from one "total steps" node, overwriting one sampler's `inputs.steps` with a literal silently desynchronizes them.

The live app already avoids this for CFG (server.js:2729): it writes only when the input is already a literal number and skips link-fed inputs. That is the "CFG precedent."

Our fix makes the problem largely disappear: the detector **resolves every link-fed widget back to the editable literal that feeds the wire** and targets *that* node. Writing the literal source propagates correctly through the wire to all consumers — which is the intended result. So auto-detected fields essentially never target a link-fed input.

The only residual case is a **manually-added** field where the user clicks an input that happens to be link-fed. The decision:

- **Keep the CFG precedent** — the applier writes the (harmless) graph slot and does **not** overwrite the converted-prompt link ref. It never severs author wiring.
- **And** run the same source-resolution walk on manual-add, so the `＋ field` action **auto-redirects** the target to the resolved literal source (or, if the chain ends in something non-editable like a math node, refuses with "this input is driven by node #N — edit that instead"). This makes the manual path behave like the auto path: you always end up editing the value that actually controls the widget, never a dead slot or a severed wire.
