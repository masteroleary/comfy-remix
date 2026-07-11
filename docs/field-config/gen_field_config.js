// ComfyRemix — workflow import field-config generator (prototype)
// Scans a ComfyUI workflow (graph or API format) and emits a JSON field config:
// which user-facing fields the import UI should offer, with targets for override application.
// Usage: node gen_field_config.js <workflow.json> [--full]     (or a directory to batch-summarize)
'use strict';
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------- constants

// Known graph widget layouts (widgets_values order). '__ctrl' = control_after_generate slot.
const LAYOUTS = {
  'KSampler': ['seed', '__ctrl', 'steps', 'cfg', 'sampler_name', 'scheduler', 'denoise'],
  'KSamplerAdvanced': ['add_noise', 'noise_seed', '__ctrl', 'steps', 'cfg', 'sampler_name', 'scheduler', 'start_at_step', 'end_at_step', 'return_with_leftover_noise'],
  'KSampler (Efficient)': ['seed', '__ctrl', 'steps', 'cfg', 'sampler_name', 'scheduler', 'denoise', 'preview_method', 'vae_decode'],
  'KSampler Adv. (Efficient)': ['add_noise', 'noise_seed', '__ctrl', 'steps', 'cfg', 'sampler_name', 'scheduler', 'start_at_step', 'end_at_step', 'return_with_leftover_noise', 'preview_method', 'vae_decode'],
  'WanVideoSampler': ['steps', 'cfg', 'shift', 'seed', '__ctrl', 'force_offload', 'scheduler', 'riflex_freq_index', 'denoise_strength', 'batched_cfg', 'rope_function', 'start_step', 'end_step', 'add_noise_to_samples'],
  'RandomNoise': ['noise_seed', '__ctrl'],
  'CFGGuider': ['cfg'],
  'BasicScheduler': ['scheduler', 'steps', 'denoise'],
  'KSamplerSelect': ['sampler_name'],
  'Flux2Scheduler': ['steps', 'width', 'height'],
  'ModelSamplingSD3': ['shift'],
  'CLIPTextEncode': ['text'],
  'LoraLoader': ['lora_name', 'strength_model', 'strength_clip'],
  'LoraLoaderModelOnly': ['lora_name', 'strength_model'],
  'WanVideoLoraSelect': ['lora', 'strength', 'low_mem_load', 'merge_loras'],
  'EmptyLatentImage': ['width', 'height', 'batch_size'],
  'EmptyFlux2LatentImage': ['width', 'height', 'batch_size'],
  'SDXLEmptyLatentSizePicker+': ['resolution', 'batch_size', 'width_override', 'height_override'],
  'CheckpointLoaderSimple': ['ckpt_name'],
  'UNETLoader': ['unet_name', 'weight_dtype'],
  'UnetLoaderGGUF': ['unet_name'],
  'VAELoader': ['vae_name'],
  'UpscaleModelLoader': ['model_name'],
  'LoadImage': ['image', '__upload'],
  'mxSlider': ['Xi', 'Xf', 'isfloatX'],
  'mxSliderF': ['Xi', 'Xf', 'isfloatX'],
  'Seed (rgthree)': ['seed'],
  'PrimitiveInt': ['value', '__ctrl'],
  'PrimitiveFloat': ['value', '__ctrl'],
  'PrimitiveBoolean': ['value'],
  'PrimitiveString': ['value'],
  'PrimitiveStringMultiline': ['value'],
  'INTConstant': ['value'],
  'Primitive integer [Crystools]': ['int'],
  'easy int': ['value'],
  'easy float': ['value'],
  'Text _O': ['text'],
  'TextBoxMira': ['text'],
  'ttN text': ['text'],
  'DF_Text': ['text'],
};

const CTRL_VALUES = new Set(['fixed', 'randomize', 'increment', 'decrement']);
const SAMPLER_CLASSES = new Set(['KSampler', 'KSamplerAdvanced', 'KSampler (Efficient)', 'KSampler Adv. (Efficient)', 'WanVideoSampler']);
// nodes whose value flows through unchanged (walk upstream through these)
const PASSTHRU = new Set(['Reroute', 'GetNode', 'SetNode', 'easy getNode', 'easy setNode', 'Any Switch (rgthree)', 'ModelPassThrough']);
const TEXT_LEAF = /^(Text _O|PrimitiveString(Multiline)?|TextBoxMira|ttN text|DF_Text|easy wildcards|ImpactWildcardProcessor|String Literal|Textbox.*)$/;
// nodes whose string widgets are NOT prompt text (serialized objects, routing keys)
const NOT_TEXT = new Set(['Lora Loader (LoraManager)', 'TriggerWord Toggle (LoraManager)', 'SetNode', 'GetNode', 'easy setNode', 'easy getNode', 'LoadImage', 'VHS_LoadVideo', 'LoadAudioUI']);
const TEXT_CHAIN = /concat|replace|regex|wildcard|switch|string/i; // walk-through string transformers
const MODEL_CHAIN = new Set(['LoraLoaderModelOnly', 'LoraLoader', 'Power Lora Loader (rgthree)', 'Lora Loader (LoraManager)', 'ModelSamplingSD3', 'PathchSageAttentionKJ', 'WanVideoSetLoRAs', 'ModelPatchTorchSettings', 'DynamicThresholdingFull', 'Skimmed CFG', 'CFGGuider', 'easy hiresFix', 'ModelPassThrough']);
const MODEL_LOADERS = /^(CheckpointLoaderSimple|UNETLoader|UnetLoaderGGUF.*|DiffusionModelLoaderKJ|WanVideoModelLoader|Efficient Loader|easy ckptNames)$/;
const DISPLAY_ONLY = new Set(['easy showAnything', 'ShowText|pysssss', 'PreviewImage', 'PreviewAny', 'Note', 'MarkdownNote', 'Label (rgthree)', 'Bookmark (rgthree)', 'Image Comparer (rgthree)', 'SEGSPreview', 'PlaySound|pysssss', 'Note _O', 'WidgetToString']);

const ZONE_INTERNAL = /spaghetti|do ?not|don'?t ?touch|internal|bypass|logic|clean ?up|metadata|conduit|detector provider|spagh/i;
const ZONE_PRESETS = /presets?$/i;
const ZONE_USER = /input|output|editor|edit here|settings?|controls?|prompt|lora|user|load (image|video|audio|reference)|main/i;

const KIND_BY_NAME = [
  [/negative/i, 'negative_prompt'],
  [/(^|[_ ])seed([_ ]|$)/i, 'seed'],
  [/^steps(_total)?$|\bsteps?\b/i, 'steps'], [/^cfg$|\bcfg\b/i, 'cfg'],
  [/denoise/i, 'denoise'], [/^shift|shift$/i, 'shift'], [/guidance/i, 'guidance'],
  [/^width$/i, 'width'], [/^height$/i, 'height'], [/resolution/i, 'size_preset'],
  [/frames?$|^length|duration|num_frames/i, 'length'], [/fps|frame_?rate/i, 'fps'],
  [/^batch(_size)?$/i, 'batch'], [/sampler(_name)?$/i, 'sampler'], [/scheduler$/i, 'scheduler'],
  [/lora/i, 'lora'], [/(ckpt|unet|model)_?name|^model$/i, 'model'], [/vae/i, 'vae'],
  [/prompt|caption|^(text|positive.*)$/i, 'prompt'],
];

function kindFromName(name) {
  for (const [re, k] of KIND_BY_NAME) if (re.test(name)) return k;
  return null;
}
const NUM_KINDS = { seed: 'seed', steps: 'int', cfg: 'float', denoise: 'float', shift: 'float', guidance: 'float', width: 'int', height: 'int', length: 'int', fps: 'float', batch: 'int' };

// ---------------------------------------------------------------- graph ctx

function buildCtx(wf) {
  const ctx = { wf, nodes: new Map(), links: new Map(), setters: new Map(), defs: new Map(), zones: [], zoneOf: new Map() };
  for (const n of wf.nodes || []) ctx.nodes.set(n.id, n);
  for (const l of wf.links || []) {
    if (Array.isArray(l)) ctx.links.set(l[0], { from: l[1], fromSlot: l[2], to: l[3], toSlot: l[4], type: l[5] });
    else if (l && typeof l === 'object') ctx.links.set(l.id, { from: l.origin_id, fromSlot: l.origin_slot, to: l.target_id, toSlot: l.target_slot, type: l.type });
  }
  for (const n of wf.nodes || []) {
    if ((n.type === 'SetNode' || n.type === 'easy setNode') && Array.isArray(n.widgets_values)) {
      ctx.setters.set(String(n.widgets_values[0]), n);
    }
  }
  for (const sg of (wf.definitions && wf.definitions.subgraphs) || []) ctx.defs.set(sg.id, sg);
  // zones: classify groups, assign nodes to smallest containing group
  const groups = (wf.groups || []).map((g, i) => ({
    idx: i, title: g.title || '', color: g.color || null, bounding: g.bounding,
    area: g.bounding ? g.bounding[2] * g.bounding[3] : Infinity,
    cls: ZONE_INTERNAL.test(g.title || '') ? 'internal' : ZONE_PRESETS.test(g.title || '') ? 'presets' : ZONE_USER.test(g.title || '') ? 'user' : 'neutral',
    nodes: [],
  }));
  for (const n of wf.nodes || []) {
    if (!n.pos) continue;
    // ComfyUI group membership = the CENTER of the node's bounding rect (incl. ~30px title bar)
    const px = Array.isArray(n.pos) ? n.pos[0] : n.pos['0'], py = Array.isArray(n.pos) ? n.pos[1] : n.pos['1'];
    const sz = (n.flags && n.flags.collapsed) ? [80, 0] : (Array.isArray(n.size) ? n.size : (n.size ? [n.size['0'] || 0, n.size['1'] || 0] : [0, 0]));
    const nx = px + sz[0] / 2, ny = py + sz[1] / 2 - 15;
    let best = null;
    for (const g of groups) {
      if (!g.bounding) continue;
      const [gx, gy, gw, gh] = g.bounding;
      if (nx >= gx && nx <= gx + gw && ny >= gy && ny <= gy + gh && (!best || g.area < best.area)) best = g;
    }
    if (best) { best.nodes.push(n.id); ctx.zoneOf.set(n.id, best); }
  }
  ctx.zones = groups;
  return ctx;
}

const isActive = n => n.mode !== 2 && n.mode !== 4;
const isSubgraphType = t => typeof t === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t);

// nodes that (transitively) feed an active output node — approximates the converter's pruning.
// Muted (mode 2) blocks traversal; bypassed (mode 4) passes through. Set/Get pairs and
// Anything-Everywhere sources are treated as reachable (their wiring is virtual).
const OUTPUT_NODE_RE = /^(SaveImage|SaveVideo|SaveAnimatedWEBP|SaveAudio|VHS_VideoCombine|Image Saver( .*)?|PreviewImage|PreviewAny|SaveImageWebsocket|ComfyCanvasOutput)$/;
function computeReachable(ctx) {
  const q = [];
  const seen = new Set();
  for (const n of ctx.nodes.values()) {
    if ((isActive(n) && OUTPUT_NODE_RE.test(n.type)) || /^Anything Everywhere/.test(n.type)) { seen.add(n.id); q.push(n.id); }
  }
  while (q.length) {
    const n = ctx.nodes.get(q.pop());
    if (!n) continue;
    if (n.type === 'GetNode' || n.type === 'easy getNode') {
      const setter = ctx.setters.get(String((n.widgets_values || [])[0]));
      if (setter && !seen.has(setter.id)) { seen.add(setter.id); q.push(setter.id); }
    }
    for (const i of n.inputs || []) {
      if (i.link == null) continue;
      const l = ctx.links.get(i.link);
      const src = l && ctx.nodes.get(l.from);
      if (!src || src.mode === 2) continue;
      if (!seen.has(src.id)) { seen.add(src.id); q.push(src.id); }
    }
  }
  return seen;
}

// widget name list for a node: explicit layout, else names from inputs[].widget (modern format), inserting __ctrl slots
function widgetLayout(node) {
  if (LAYOUTS[node.type]) return LAYOUTS[node.type];
  const fromInputs = (node.inputs || []).filter(i => i.widget).map(i => i.widget.name || i.name);
  if (!fromInputs.length) return null;
  const wv = node.widgets_values;
  if (!Array.isArray(wv)) return fromInputs;
  // insert __ctrl (control_after_generate) after *seed* widgets, but only for as many
  // surplus serialized slots as actually exist — a legit null widget must not shift indices
  const out = [];
  let vi = 0;
  let surplus = wv.length - fromInputs.length;
  for (const name of fromInputs) {
    out.push(name); vi++;
    if (surplus > 0 && /seed/i.test(name) && vi < wv.length && (CTRL_VALUES.has(wv[vi]) || wv[vi] === null)) { out.push('__ctrl'); vi++; surplus--; }
  }
  return out;
}

function widgetIndex(node, widgetName) {
  const wv = node.widgets_values;
  if (wv && !Array.isArray(wv) && typeof wv === 'object') return widgetName; // named object (VHS)
  const layout = widgetLayout(node);
  if (!layout) return null;
  const i = layout.indexOf(widgetName);
  return i >= 0 ? i : null;
}

function widgetValue(node, widgetName) {
  const wv = node.widgets_values;
  if (wv == null) return undefined;
  if (!Array.isArray(wv) && typeof wv === 'object') return wv[widgetName];
  const i = widgetIndex(node, widgetName);
  return (typeof i === 'number' && i < wv.length) ? wv[i] : undefined;
}

// follow a link upstream to its true source; returns {node, outSlot} or null.
// Never returns routing nodes (Set/Get/Reroute/switches) — dead ends resolve to null.
function resolveSource(ctx, node, inputName, depth = 0) {
  if (depth > 32) return null;
  const inp = (node.inputs || []).find(i => i.name === inputName || (i.widget && i.widget.name === inputName));
  if (!inp || inp.link == null) return null;
  const link = ctx.links.get(inp.link);
  if (!link) return null;
  const src = ctx.nodes.get(link.from);
  if (!src) return null;
  if (src.type === 'GetNode' || src.type === 'easy getNode') {
    const key = String((src.widgets_values || [])[0]);
    const setter = ctx.setters.get(key);
    if (!setter) return null;
    const first = (setter.inputs || []).find(i => i.link != null);
    return first ? resolveSource(ctx, setter, first.name, depth + 1) : null;
  }
  if (src.type === 'Any Switch (rgthree)') {
    // rgthree picks the first non-empty input at runtime; approximate with first link whose origin is active
    for (const i of src.inputs || []) {
      if (i.link == null) continue;
      const l = ctx.links.get(i.link);
      const o = l && ctx.nodes.get(l.from);
      if (o && isActive(o)) return resolveSource(ctx, src, i.name, depth + 1);
    }
    return null;
  }
  if (PASSTHRU.has(src.type)) {
    const first = (src.inputs || []).find(i => i.link != null);
    return first ? resolveSource(ctx, src, first.name, depth + 1) : null;
  }
  return { node: src, outSlot: link.fromSlot };
}

// legacy shape used by text/model walkers: source node only
function upstream(ctx, node, inputName, depth = 0) {
  const r = resolveSource(ctx, node, inputName, depth);
  return r ? r.node : null;
}

// mxSlider outputs Xi in int mode (isfloatX=0) and Xf in float mode; the live app writes both slots
const mxValue = n => widgetValue(n, widgetValue(n, 'isfloatX') ? 'Xf' : 'Xi');

// choose which widget on a resolved source corresponds to the output slot feeding the consumer;
// recurses when that widget is itself link-fed. Returns {node, widgets:[primary, ...mirrors]} or null.
function sourceWidget(ctx, srcInfo, depth = 0) {
  if (!srcInfo || depth > 8) return null;
  const src = srcInfo.node;
  if (src.type.startsWith('mxSlider')) return { node: src, widgets: ['Xi', 'Xf'], value: mxValue(src) };
  if (DISPLAY_ONLY.has(src.type) || isSubgraphType(src.type)) return null;
  const lay = (widgetLayout(src) || []).filter(x => !x.startsWith('__'));
  if (!lay.length) return null;
  const outName = String(((src.outputs || [])[srcInfo.outSlot] || {}).name || '').toLowerCase();
  let w = lay.find(x => x.toLowerCase() === outName);
  if (!w && outName) w = lay.find(x => x.toLowerCase().startsWith(outName) || outName.startsWith(x.toLowerCase()));
  if (!w && lay.length === 1) w = lay[0];
  if (!w) return null; // multi-widget source with unmatched output: bail rather than guess
  const winp = (src.inputs || []).find(i => i.widget && (i.widget.name || i.name) === w);
  if (winp && winp.link != null) return sourceWidget(ctx, resolveSource(ctx, src, w), depth + 1);
  const value = widgetValue(src, w);
  if (value === undefined) return null;
  return { node: src, widgets: [w], value };
}

// collect editable text leaves feeding a text input (walks concat/replace chains)
function textLeaves(ctx, node, inputName, acc = [], depth = 0) {
  if (depth > 24) return acc;
  const src = upstream(ctx, node, inputName);
  if (!src) return acc;
  if (TEXT_LEAF.test(src.type) || (Array.isArray(src.widgets_values) && typeof src.widgets_values[0] === 'string' && !TEXT_CHAIN.test(src.type) && !DISPLAY_ONLY.has(src.type) && !NOT_TEXT.has(src.type))) {
    if (!DISPLAY_ONLY.has(src.type) && !NOT_TEXT.has(src.type)) acc.push(src);
    return acc;
  }
  if (TEXT_CHAIN.test(src.type) || isSubgraphType(src.type)) {
    for (const i of src.inputs || []) {
      if (i.link != null && (i.type === 'STRING' || i.type === '*')) textLeaves(ctx, src, i.name, acc, depth + 1);
    }
    // chain nodes may also carry their own literal text widgets — only count actual leaf nodes
  }
  return acc;
}

// walk the model chain upstream from a node input, collecting lora loaders until a model loader
function modelChain(ctx, node, inputName) {
  const found = { loras: [], loader: null };
  let cur = node, inp = inputName, depth = 0;
  while (depth++ < 40) {
    const src = upstream(ctx, cur, inp);
    if (!src) break;
    if (MODEL_LOADERS.test(src.type)) { found.loader = src; break; }
    if (/lora/i.test(src.type)) found.loras.push(src);
    if (MODEL_CHAIN.has(src.type) || /lora/i.test(src.type) || isSubgraphType(src.type)) {
      const mi = (src.inputs || []).find(i => i.link != null && (i.type === 'MODEL' || i.name === 'model'));
      if (!mi) break;
      cur = src; inp = mi.name; continue;
    }
    break;
  }
  return found;
}

// ---------------------------------------------------------------- field factory

function makeFieldStore() {
  const fields = [];
  const byTarget = new Map();
  const ids = new Set();
  const add = (f) => {
    const key = f.targets.map(t => `${(t.path || []).join('/')}#${t.nodeId}:${t.widget}`).join('|');
    for (const t of f.targets) {
      const k = `${(t.path || []).join('/')}#${t.nodeId}:${t.widget}`;
      if (byTarget.has(k)) {
        const existing = byTarget.get(k);
        // keep higher-confidence one; merge evidence
        if ((f.confidence || 0) > (existing.confidence || 0)) {
          existing.kind = f.kind; existing.label = f.label; existing.confidence = f.confidence;
          existing.recommended = existing.recommended || f.recommended;
          existing.evidence.rules = [...new Set([...(existing.evidence.rules || []), f.evidence.rule])];
        } else {
          existing.evidence.rules = [...new Set([...(existing.evidence.rules || []), f.evidence.rule])];
        }
        return existing;
      }
    }
    let id = f.id, n = 2;
    while (ids.has(id)) id = `${f.id}_${n++}`;
    f.id = id; ids.add(id);
    fields.push(f);
    for (const t of f.targets) byTarget.set(`${(t.path || []).join('/')}#${t.nodeId}:${t.widget}`, f);
    return f;
  };
  return { fields, add, byTarget };
}

function target(node, widget, path = []) {
  return { nodeId: node.id, path, class: isSubgraphType(node.type) ? 'Subgraph' : node.type, widget, widgetIndex: widgetIndex(node, widget), title: node.title || undefined };
}

function zoneInfo(ctx, node) {
  const z = ctx.zoneOf.get(node.id);
  return { section: z ? z.title : null, zoneClass: z ? z.cls : 'neutral' };
}

function baseField(ctx, node, widget, kind, label, opts = {}) {
  const zi = zoneInfo(ctx, node);
  const value = opts.value !== undefined ? opts.value : widgetValue(node, widget);
  const controlType = opts.controlType || NUM_KINDS[kind] || (typeof value === 'boolean' ? 'boolean' : typeof value === 'number' ? 'float' : 'text');
  const f = {
    id: opts.id || kind, label, kind,
    control: Object.assign({ type: controlType }, opts.control || {}),
    value,
    enabled: false, recommended: false,
    confidence: opts.confidence != null ? opts.confidence : 0.6,
    source: 'auto',
    section: opts.section !== undefined ? opts.section : zi.section,
    zoneClass: zi.zoneClass,
    inactive: !isActive(node) || undefined,
    targets: [target(node, widget, opts.path || [])],
    evidence: { rule: opts.rule || 'generic', nodeTitle: node.title || undefined, class: node.type },
  };
  if (opts.variant) f.variant = opts.variant;
  if (opts.stage != null) f.stage = opts.stage;
  if (opts.insideSubgraph) f.insideSubgraph = true;
  if (zi.zoneClass === 'internal') f.confidence = Math.min(f.confidence, 0.4);
  return f;
}

// shared final passes: merges, unreachable demotion, auto-enable policy, gap fill, ordering,
// id uniqueness + label disambiguation. reachable=null skips reachability handling (API format).
const PRIO = ['prompt', 'negative_prompt', 'image_input', 'video_input', 'audio_input', 'seed', 'steps', 'cfg', 'lora_list', 'lora', 'length', 'fps', 'width', 'height', 'size_preset', 'batch', 'denoise', 'shift', 'guidance', 'sampler', 'scheduler', 'model', 'vae', 'toggle'];
function finalizeConfig(store, reachable) {
  // all seed fields collapse into one multi-target field (app semantics: one seed, fan out)
  const mergeKind = (kind, opts = {}) => {
    const group = store.fields.filter(f => f.kind === kind && !f.insideSubgraph);
    if (group.length < 2) return;
    if (opts.requireEqualValues && !group.every(f => f.value === group[0].value)) return;
    group.sort((a, b) => b.confidence - a.confidence);
    const primary = group[0];
    for (const f of group.slice(1)) {
      primary.targets.push(...f.targets);
      primary.evidence.merged = (primary.evidence.merged || []).concat(`${f.evidence.rule}#${f.targets[0].nodeId}`);
      primary.recommended = primary.recommended || f.recommended;
      store.fields.splice(store.fields.indexOf(f), 1);
    }
    if (opts.label) primary.label = opts.label;
    primary.id = kind;
    delete primary.variant; delete primary.pairId;
  };
  mergeKind('seed', { label: 'Seed' });
  mergeKind('cfg', { requireEqualValues: true, label: 'CFG' });

  // fields whose every target sits outside the output-reachable graph do nothing at run time
  if (reachable) {
    for (const f of store.fields) {
      const anchors = f.targets.map(t => (t.path && t.path.length) ? t.path[0] : t.nodeId);
      if (anchors.length && anchors.every(a => !reachable.has(a))) {
        f.unreachable = true;
        f.confidence = Math.round(f.confidence * 70) / 100;
      }
    }
  }

  const AUTO_ON = { prompt: 0.8, seed: 0.8, steps: 0.8, cfg: 0.8, lora_list: 0.8, length: 0.8, width: 0.8, height: 0.8, size_preset: 0.8, image_input: 0.9 };
  for (const f of store.fields) {
    if (!f.recommended && AUTO_ON[f.kind] != null && f.confidence >= AUTO_ON[f.kind]) f.recommended = true;
    if (f.zoneClass === 'internal' || f.inactive || f.unreachable) f.recommended = false;
  }
  // gap fill: if a core kind has no recommended field, promote the best lower-confidence candidate
  for (const kind of ['prompt', 'seed', 'steps', 'cfg', 'length', 'width', 'height']) {
    if (store.fields.some(f => f.kind === kind && f.recommended)) continue;
    const cand = store.fields.filter(f => f.kind === kind && !f.inactive && !f.unreachable && f.zoneClass !== 'internal' && f.confidence >= 0.6).sort((a, b) => b.confidence - a.confidence)[0];
    if (cand) cand.recommended = true;
  }
  // media-driven workflows (e.g. faceswap): expose all image inputs when none recommended
  if (!store.fields.some(f => f.kind === 'image_input' && f.recommended)) {
    for (const f of store.fields) if (f.kind === 'image_input' && !f.inactive && !f.unreachable && f.confidence >= 0.6) f.recommended = true;
  }
  for (const f of store.fields) f.enabled = !!f.recommended;

  store.fields.sort((a, b) => {
    const pa = PRIO.indexOf(a.kind), pb = PRIO.indexOf(b.kind);
    return (pa < 0 ? 99 : pa) - (pb < 0 ? 99 : pb) || (b.confidence - a.confidence);
  });

  // ids must be unique (merges/renames can collide); duplicate labels get a target hint
  const ids = new Set();
  for (const f of store.fields) { let id = f.id, n = 2; while (ids.has(id)) id = `${f.id}_${n++}`; f.id = id; ids.add(id); }
  const labelCount = {};
  for (const f of store.fields) labelCount[f.label] = (labelCount[f.label] || 0) + 1;
  for (const f of store.fields) {
    if (labelCount[f.label] > 1) {
      const t0 = f.targets[0] || {};
      f.label = `${f.label} (${t0.title || ('#' + t0.nodeId)})`;
    }
  }
}

// ---------------------------------------------------------------- detectors

function detectGraph(wf, name) {
  const ctx = buildCtx(wf);
  const store = makeFieldStore();
  const skipped = [];
  const nodes = [...ctx.nodes.values()];
  const active = nodes.filter(isActive);
  const reachable = computeReachable(ctx);

  // --- samplers ---------------------------------------------------------
  const samplers = nodes.filter(n => SAMPLER_CLASSES.has(n.type));
  const activeSamplers = samplers.filter(isActive);
  // dual high/low KSamplerAdvanced (Wan 2.2 pattern)
  let hl = null;
  const ksa = activeSamplers.filter(n => n.type === 'KSamplerAdvanced');
  if (ksa.length === 2) {
    const high = ksa.find(n => Number(widgetValue(n, 'start_at_step')) === 0);
    const low = ksa.find(n => Number(widgetValue(n, 'start_at_step')) > 0);
    if (high && low) hl = { high, low };
  }

  const samplerField = (n, widget, kind, label, conf, opts = {}) => {
    const inp = (n.inputs || []).find(i => i.name === widget || (i.widget && i.widget.name === widget));
    if (inp && inp.link != null) {
      // link-fed: resolve to the editable source, matched by the feeding output slot
      const sw = sourceWidget(ctx, resolveSource(ctx, n, widget));
      if (!sw) {
        skipped.push({ reason: 'unresolvable-source', kind, node: n.id, widget, note: 'link-fed by a non-editable chain (math/switch); expose via inspector if needed' });
        return null;
      }
      const f = store.add(baseField(ctx, sw.node, sw.widgets[0], kind, label, Object.assign({ confidence: conf, rule: `sampler-${kind}-via-source` }, opts, { value: sw.value })));
      if (f) for (const w2 of sw.widgets.slice(1)) {
        if (!f.targets.some(t => t.nodeId === sw.node.id && t.widget === w2)) f.targets.push(target(sw.node, w2, []));
      }
      return f;
    }
    if (widgetValue(n, widget) === undefined) return null;
    return store.add(baseField(ctx, n, widget, kind, label, Object.assign({ confidence: conf, rule: `sampler-${kind}` }, opts)));
  };

  if (hl) {
    // Parity with the live highLowSteps semantics: values are the SPLIT (high = end_at_step
    // of the high pass, low = total - high); apply writes total=high+low to both samplers'
    // steps and sets the boundary (high.end_at_step / low.start_at_step) to the high value.
    const stepsLinked = s => ((s.inputs || []).some(i => (i.widget && (i.widget.name || i.name) === 'steps') && i.link != null));
    const total = Number(widgetValue(hl.high, 'steps'));
    const hSteps = Number(widgetValue(hl.high, 'end_at_step'));
    if (!stepsLinked(hl.high) && !stepsLinked(hl.low) && isFinite(total) && isFinite(hSteps) && hSteps <= total) {
      const fh = store.add(baseField(ctx, hl.high, 'steps', 'steps', 'Steps (High)', { id: 'steps_high', variant: 'high', stage: 1, confidence: 0.95, rule: 'dual-ksampler-split', value: hSteps }));
      const fl = store.add(baseField(ctx, hl.low, 'steps', 'steps', 'Steps (Low)', { id: 'steps_low', variant: 'low', stage: 2, confidence: 0.95, rule: 'dual-ksampler-split', value: Math.max(0, total - hSteps) }));
      if (fh && fl) {
        fh.pairId = fl.id; fl.pairId = fh.id; fh.recommended = fl.recommended = true;
        fh.meta = { role: 'hl_steps_high', samplerHigh: hl.high.id, samplerLow: hl.low.id };
        fl.meta = { role: 'hl_steps_low', samplerHigh: hl.high.id, samplerLow: hl.low.id };
        fh.evidence.note = fl.evidence.note = 'semantic pair: apply total=high+low to both samplers\' steps, boundary (end/start_at_step) = high';
      }
    } else {
      // steps link-fed: resolve to the editable source(s)
      const fh = samplerField(hl.high, 'steps', 'steps', 'Steps (High)', 0.95, { id: 'steps_high', variant: 'high', stage: 1 });
      const fl = samplerField(hl.low, 'steps', 'steps', 'Steps (Low)', 0.95, { id: 'steps_low', variant: 'low', stage: 2 });
      if (fh && fl && fh === fl) {
        // both fed by one shared total-steps source: a single knob, not a high/low pair
        fh.label = 'Steps'; delete fh.variant; delete fh.stage; delete fh.pairId;
        fh.recommended = true;
        fh.evidence.note = 'shared total-steps source feeding both samplers';
      } else if (fh && fl) { fh.pairId = fl.id; fl.pairId = fh.id; fh.recommended = fl.recommended = true; }
    }
  }
  for (const n of activeSamplers) {
    const stage = hl ? (n === hl.high ? 1 : n === hl.low ? 2 : null) : null;
    if (!hl || (n !== hl.high && n !== hl.low)) samplerField(n, n.type === 'KSamplerAdvanced' ? 'steps' : 'steps', 'steps', n.title ? `Steps — ${n.title}` : 'Steps', 0.85, { id: 'steps' });
    const noiseOff = (n.type === 'KSamplerAdvanced' || n.type === 'KSampler Adv. (Efficient)') && widgetValue(n, 'add_noise') === 'disable';
    if (!noiseOff) samplerField(n, n.type === 'KSamplerAdvanced' || n.type === 'KSampler Adv. (Efficient)' ? 'noise_seed' : 'seed', 'seed', 'Seed', 0.9, { id: 'seed' });
    samplerField(n, 'cfg', 'cfg', stage ? `CFG (${stage === 1 ? 'High' : 'Low'})` : 'CFG', 0.85, { id: stage ? `cfg_${stage === 1 ? 'high' : 'low'}` : 'cfg', variant: stage === 1 ? 'high' : stage === 2 ? 'low' : undefined });
    samplerField(n, 'denoise', 'denoise', 'Denoise', 0.5, { id: 'denoise' });
    samplerField(n, 'sampler_name', 'sampler', 'Sampler', 0.5, { id: 'sampler', controlType: 'combo' });
    samplerField(n, 'scheduler', 'scheduler', 'Scheduler', 0.5, { id: 'scheduler', controlType: 'combo' });
    if (n.type === 'WanVideoSampler') samplerField(n, 'shift', 'shift', 'Shift', 0.5, { id: 'shift' });
  }
  // custom-sampler cluster (SamplerCustom / SamplerCustomAdvanced companions)
  for (const n of active) {
    if (n.type === 'RandomNoise') samplerField(n, 'noise_seed', 'seed', 'Seed', 0.85, { id: 'seed', rule: 'random-noise' });
    if (n.type === 'CFGGuider') samplerField(n, 'cfg', 'cfg', 'CFG', 0.85, { id: 'cfg' });
    if (n.type === 'BasicScheduler') { samplerField(n, 'steps', 'steps', 'Steps', 0.8, { id: 'steps' }); samplerField(n, 'denoise', 'denoise', 'Denoise', 0.5, { id: 'denoise' }); }
    if (n.type === 'Flux2Scheduler') { samplerField(n, 'steps', 'steps', 'Steps', 0.8, { id: 'steps' }); samplerField(n, 'width', 'width', 'Width', 0.7, { id: 'width' }); samplerField(n, 'height', 'height', 'Height', 0.7, { id: 'height' }); }
  }

  // --- standalone seed / primitives with semantic titles ------------------
  for (const n of active) {
    if (n.type === 'Seed (rgthree)') {
      const f = store.add(baseField(ctx, n, 'seed', 'seed', 'Seed', { id: 'seed', confidence: 0.95, rule: 'rgthree-seed', controlType: 'seed' }));
      if (f) f.recommended = true;
    }
    const title = (n.title || '').trim();
    if (!title || DISPLAY_ONLY.has(n.type)) continue;
    const lay = widgetLayout(n);
    if (!lay) continue;
    const kind = kindFromName(title);
    if (kind && /^(mxSlider|mxSliderF|easy (int|float)|INTConstant|Primitive(Int|Float|Boolean|String|StringMultiline)?|Primitive integer \[Crystools\]|PrimitiveNode)$/.test(n.type)) {
      const isMx = n.type.startsWith('mxSlider');
      const w = isMx ? 'Xi' : lay.find(x => !x.startsWith('__'));
      const f = store.add(baseField(ctx, n, w, kind, title.replace(/\b\w/g, c => c.toUpperCase()), { id: kind, confidence: 0.85, rule: 'titled-primitive', value: isMx ? mxValue(n) : undefined }));
      // mxSlider outputs Xi (int mode) or Xf (float mode); the live app writes both — mirror that
      if (f && isMx && !f.targets.some(t => t.nodeId === n.id && t.widget === 'Xf')) f.targets.push(target(n, 'Xf', []));
      if (f && ['seed', 'steps', 'cfg', 'length', 'width', 'height'].includes(kind)) f.recommended = true;
    } else if (/^(PrimitiveBoolean)$/.test(n.type)) {
      store.add(baseField(ctx, n, 'value', 'toggle', title, { id: 'toggle_' + title.toLowerCase().replace(/\W+/g, '_'), confidence: 0.7, rule: 'titled-boolean' }));
    }
  }

  // --- prompts ------------------------------------------------------------
  const negRe = /\bneg(ative)?\b/i;
  // "ports" = (node, widget) pairs that consume prompt text
  const promptPorts = [];
  for (const n of active) {
    if (n.type === 'CLIPTextEncode') promptPorts.push({ n, w: 'text', neg: negRe.test(n.title || '') });
    else if (n.type === 'WanVideoTextEncode') { promptPorts.push({ n, w: 'positive_prompt', neg: false }); promptPorts.push({ n, w: 'negative_prompt', neg: true }); }
    else if (/^(Efficient Loader|Eff\. Loader SDXL)$/.test(n.type)) { promptPorts.push({ n, w: 'positive', neg: false }); promptPorts.push({ n, w: 'negative', neg: true }); }
  }
  const promptCandidates = [];
  const candSeen = new Set();
  const pushCand = c => { const k = `${c.node.id}:${c.widget}`; if (c.widget && !candSeen.has(k)) { candSeen.add(k); promptCandidates.push(c); } };
  for (const { n, w, neg } of promptPorts) {
    const inp = (n.inputs || []).find(i => i.name === w || (i.widget && i.widget.name === w));
    const linked = !!(inp && inp.link != null);
    const leaves = linked ? textLeaves(ctx, n, w) : [];
    if (leaves.length) {
      for (const leaf of leaves) pushCand({ node: leaf, widget: (widgetLayout(leaf) || ['text']).filter(x => !x.startsWith('__'))[0], neg: neg || negRe.test(leaf.title || ''), viaTitle: leaf.title || n.title || '', via: n });
    } else if (!linked && widgetValue(n, w) !== undefined) {
      pushCand({ node: n, widget: w, neg, viaTitle: n.title || '' });
    } else if (linked) {
      // link-fed with no editable leaf: the widget value is stale — do NOT surface it
      skipped.push({ reason: 'prompt-source-unresolvable', node: n.id, widget: w, note: 'prompt input is link-fed by a chain with no editable text leaf' });
    }
  }
  // global title rule (parity with server resolvePromptNode): any string-widget node titled MAIN/POS + PROMPT
  for (const n of active) {
    const t = (n.title || '').toUpperCase();
    if (!t.includes('PROMPT') || !(t.includes('MAIN') || t.includes('POS'))) continue;
    if (DISPLAY_ONLY.has(n.type) || NOT_TEXT.has(n.type) || isSubgraphType(n.type)) continue;
    const lay = (widgetLayout(n) || []).filter(x => !x.startsWith('__'));
    const w = lay.find(x => typeof widgetValue(n, x) === 'string');
    if (w) pushCand({ node: n, widget: w, neg: negRe.test(n.title || ''), viaTitle: n.title || '' });
  }
  // rank: MAIN/POS title > longest text; muted or pruned-branch candidates can never win
  const posC = promptCandidates.filter(c => !c.neg);
  const negC = promptCandidates.filter(c => c.neg);
  const score = c => {
    let s = (/main/i.test(c.viaTitle) && /prompt/i.test(c.viaTitle) ? 1000 : 0) + (/pos/i.test(c.viaTitle) ? 500 : 0) + String(widgetValue(c.node, c.widget) || '').length;
    if (!isActive(c.node) || (c.via && !isActive(c.via))) s -= 5000;
    const anchor = c.via || c.node;
    if (!reachable.has(anchor.id)) s -= 1500;
    return s;
  };
  const markVia = (f, c) => { if (f && c.via && !isActive(c.via)) f.inactive = true; };
  posC.sort((a, b) => score(b) - score(a));
  posC.forEach((c, i) => {
    const f = store.add(baseField(ctx, c.node, c.widget, 'prompt', i === 0 ? 'Prompt' : `Prompt — ${c.viaTitle || c.node.type}`, { id: i === 0 ? 'prompt' : 'prompt_extra', confidence: i === 0 ? 0.9 : 0.5, rule: 'prompt-walk', controlType: 'multiline' }));
    markVia(f, c);
    if (f && i === 0 && !f.inactive) f.recommended = true;
  });
  negC.sort((a, b) => score(b) - score(a));
  negC.forEach((c, i) => {
    const f = store.add(baseField(ctx, c.node, c.widget, 'negative_prompt', i === 0 ? 'Negative Prompt' : `Negative — ${c.viaTitle}`, { id: i === 0 ? 'negative_prompt' : 'negative_extra', confidence: i === 0 ? 0.8 : 0.4, rule: 'prompt-walk', controlType: 'multiline' }));
    markVia(f, c);
  });

  // --- loras ----------------------------------------------------------------
  const plls = active.filter(n => n.type.includes('Power Lora Loader'));
  let hlLoras = null;
  if (hl && plls.length >= 2) {
    const hi = modelChain(ctx, hl.high, 'model').loras.find(l => l.type.includes('Power Lora Loader'));
    const lo = modelChain(ctx, hl.low, 'model').loras.find(l => l.type.includes('Power Lora Loader'));
    if (hi && lo && hi !== lo) hlLoras = { hi, lo };
  }
  // slot = index into the node's widgets_values array (Power Lora Loader) — the applier keys on it
  const loraRows = n => (Array.isArray(n.widgets_values) ? n.widgets_values : [])
    .map((w, i) => ({ w, i }))
    .filter(x => x.w && typeof x.w === 'object' && 'lora' in x.w)
    .map(x => ({ slot: x.i, on: !!x.w.on, lora: x.w.lora, strength: x.w.strength }));
  const addPll = (n, label, variant, pairWith) => {
    const f = store.add(baseField(ctx, n, 'loras', 'lora_list', label, { id: variant ? `loras_${variant}` : 'loras', confidence: 0.95, rule: 'power-lora-loader', controlType: 'lora_rows', value: loraRows(n), variant }));
    if (f) f.recommended = true;
    return f;
  };
  if (hlLoras) {
    const fh = addPll(hlLoras.hi, 'LoRAs (High)', 'high');
    const fl = addPll(hlLoras.lo, 'LoRAs (Low)', 'low');
    if (fh && fl) { fh.pairId = fl.id; fl.pairId = fh.id; }
  }
  for (const n of plls) {
    if (hlLoras && (n === hlLoras.hi || n === hlLoras.lo)) continue;
    addPll(n, n.title || 'LoRAs');
  }
  // plain lora loaders — group per model branch when hl known
  for (const n of active.filter(n => /^(LoraLoader|LoraLoaderModelOnly|WanVideoLoraSelect)$/.test(n.type))) {
    const nm = widgetValue(n, n.type === 'WanVideoLoraSelect' ? 'lora' : 'lora_name');
    if (nm == null) continue;
    const low = /low/i.test(String(nm)) || /low/i.test(n.title || '');
    const high = /high/i.test(String(nm)) || /high/i.test(n.title || '');
    const f = store.add(baseField(ctx, n, n.type === 'WanVideoLoraSelect' ? 'strength' : 'strength_model', 'lora', `LoRA: ${String(nm).split(/[\\/]/).pop().replace(/\.safetensors$/i, '')}`, {
      id: 'lora_' + String(n.id), confidence: 0.75, rule: 'plain-lora', controlType: 'float',
      variant: high ? 'high' : low ? 'low' : undefined,
    }));
    if (f) { f.meta = { loraName: nm }; }
  }
  // lora stacks — rows carry the exact widget names the applier must write (mode/toggle aware)
  for (const n of active.filter(n => /^(CR LoRA Stack|easy loraStack)$/.test(n.type))) {
    const rows = [];
    if (n.type === 'easy loraStack') {
      const toggle = widgetValue(n, 'toggle');
      const mode = widgetValue(n, 'mode');
      const count = Number(widgetValue(n, 'num_loras')) || 0;
      for (let i = 1; i <= count; i++) {
        const name = widgetValue(n, `lora_${i}_name`);
        if (!name || name === 'None') continue;
        const strengthWidget = mode === 'advanced' ? `lora_${i}_model_strength` : `lora_${i}_strength`;
        rows.push({ slot: i, on: toggle !== false, lora: name, strength: widgetValue(n, strengthWidget), strengthWidget });
      }
      if (toggle === false && rows.length) continue; // whole stack switched off — dead branch
    } else { // CR LoRA Stack
      for (let i = 1; widgetValue(n, `lora_name_${i}`) !== undefined; i++) {
        const name = widgetValue(n, `lora_name_${i}`);
        if (!name || name === 'None') continue;
        rows.push({ slot: i, on: widgetValue(n, `switch_${i}`) === 'On', lora: name, strength: widgetValue(n, `model_weight_${i}`), onWidget: `switch_${i}`, strengthWidget: `model_weight_${i}` });
      }
    }
    if (!rows.length) continue;
    const f = store.add(baseField(ctx, n, 'stack', 'lora_list', n.title || 'LoRA Stack', { id: 'loras_stack', confidence: 0.8, rule: 'lora-stack', controlType: 'lora_rows', value: rows }));
    if (f) f.recommended = true;
  }

  // --- size / length / media inputs / models ------------------------------
  for (const n of active) {
    switch (true) {
      case /^EmptyLatentImage$|^EmptyFlux2LatentImage$/.test(n.type): {
        const w = store.add(baseField(ctx, n, 'width', 'width', 'Width', { id: 'width', confidence: 0.85, rule: 'latent-size' }));
        const h = store.add(baseField(ctx, n, 'height', 'height', 'Height', { id: 'height', confidence: 0.85, rule: 'latent-size' }));
        if (w) w.recommended = true; if (h) h.recommended = true;
        store.add(baseField(ctx, n, 'batch_size', 'batch', 'Batch Size', { id: 'batch', confidence: 0.6, rule: 'latent-size' }));
        break;
      }
      case n.type === 'SDXLEmptyLatentSizePicker+': {
        const f = store.add(baseField(ctx, n, 'resolution', 'size_preset', 'Resolution', { id: 'size_preset', confidence: 0.85, rule: 'size-picker', controlType: 'combo' }));
        if (f) f.recommended = true;
        break;
      }
      case n.type === 'LoadImage': {
        // Detection does not depend on a MAIN title — any reachable LoadImage is a usable image
        // field. MAIN-titled nodes keep the app's "inject the currently-viewed image" default;
        // others default to the embedded path. control.picker='gallery' + value=path drive the
        // thumbnail preview + replace-from-gallery UI.
        const main = /main/i.test(n.title || '');
        const f = store.add(baseField(ctx, n, 'image', 'image_input', n.title || 'Image', {
          id: main ? 'image_main' : 'image_' + n.id, confidence: main ? 0.95 : 0.75, rule: 'load-image',
          control: { type: 'image', picker: 'gallery' },
        }));
        if (f) { f.meta = { mainImage: main, defaultSource: main ? 'viewed' : 'embedded' }; if (main) f.recommended = true; }
        break;
      }
      case n.type === 'VHS_LoadVideo': { const f = store.add(baseField(ctx, n, 'video', 'video_input', n.title || 'Video', { id: 'video_' + n.id, confidence: 0.7, rule: 'load-video', control: { type: 'video', picker: 'gallery' }, value: widgetValue(n, 'video') })); if (f) f.meta = { defaultSource: 'embedded' }; break; }
      case n.type === 'LoadAudioUI': { const f = store.add(baseField(ctx, n, 'audio', 'audio_input', n.title || 'Audio', { id: 'audio_' + n.id, confidence: 0.7, rule: 'load-audio', control: { type: 'audio', picker: 'gallery' }, value: (Array.isArray(n.widgets_values) ? n.widgets_values[0] : undefined) })); if (f) f.meta = { defaultSource: 'embedded' }; break; }
      case n.type === 'VHS_VideoCombine': store.add(baseField(ctx, n, 'frame_rate', 'fps', 'Frame Rate', { id: 'fps', confidence: 0.5, rule: 'video-combine' })); break;
      case MODEL_LOADERS.test(n.type): {
        const lay = widgetLayout(n) || [];
        const w = lay.find(x => /name|^model$/.test(x)) || lay[0];
        if (w) {
          const val = String(widgetValue(n, w) || '');
          const variant = /high/i.test(val) ? 'high' : /low/i.test(val) ? 'low' : undefined;
          store.add(baseField(ctx, n, w, 'model', variant ? `Model (${variant[0].toUpperCase() + variant.slice(1)})` : (n.title || 'Model'), { id: variant ? `model_${variant}` : 'model', confidence: 0.7, rule: 'model-loader', controlType: 'combo', variant }));
        }
        break;
      }
      case /^(VAELoader|VAELoaderKJ)$/.test(n.type): store.add(baseField(ctx, n, 'vae_name', 'vae', 'VAE', { id: 'vae', confidence: 0.5, rule: 'vae-loader', controlType: 'combo' })); break;
    }
  }

  // --- subgraph promoted widgets -------------------------------------------
  // Instance widgets_values aligns with properties.proxyWidgets entries:
  //   ["-1", name]      → promoted def-INPUT widget; value stored on the instance (consumes a wv slot)
  //   [innerId, widget] → mirror of an inner node's widget; value lives on the def's inner node
  // Legacy (no proxyWidgets): wv aligns positionally with widget-inputs.
  const instByDef = new Map();
  for (const n of nodes) if (isSubgraphType(n.type)) {
    if (!instByDef.has(n.type)) instByDef.set(n.type, []);
    instByDef.get(n.type).push(n);
  }
  const promotedInner = new Map(); // defId -> Set("innerId:widget") already exposed via mirrors/inputs
  const sgField = (inst, defName, insts, name, label, wtype, value, tgt, kExtra = {}) => {
    const kind = kindFromName(label) || kindFromName(name)
      || (wtype === 'BOOLEAN' ? 'toggle' : wtype === 'COMBO' ? 'combo' : wtype === 'INT' ? 'int' : wtype === 'FLOAT' ? 'float' : wtype === 'STRING' ? 'text'
        : typeof value === 'boolean' ? 'toggle' : typeof value === 'number' ? 'float' : 'text');
    const controlType = kind === 'seed' ? 'seed'
      : wtype === 'COMBO' ? 'combo' : wtype === 'BOOLEAN' ? 'boolean' : wtype === 'INT' ? 'int' : wtype === 'FLOAT' ? 'float'
      : wtype === 'STRING' ? ((kind === 'prompt' || kind === 'negative_prompt') ? 'multiline' : 'text')
      : (NUM_KINDS[kind] || (typeof value === 'boolean' ? 'boolean' : typeof value === 'number' ? 'float' : 'text'));
    const variant = /high/i.test(label) ? 'high' : /low/i.test(label) ? 'low' : undefined;
    const f = baseField(ctx, inst, name, kind, `${label}${insts.length > 1 ? ` (${defName} #${inst.id})` : ''}`, Object.assign({
      id: `sg_${defName.toLowerCase().replace(/\W+/g, '_')}_${label.toLowerCase().replace(/\W+/g, '_')}`.replace(/_+$/, '').replace(/_{2,}/g, '_'),
      confidence: 0.85, rule: 'subgraph-promoted', section: defName, variant,
      controlType, value,
    }, kExtra));
    f.targets = [tgt];
    if (['seed', 'steps', 'cfg', 'length', 'prompt'].includes(f.kind)) f.recommended = true;
    return store.add(f);
  };
  for (const [defId, insts] of instByDef) {
    const def = ctx.defs.get(defId);
    const defName = def ? def.name : String(defId).slice(0, 8);
    promotedInner.set(defId, new Set());
    if (insts.length > 4) {
      skipped.push({ reason: 'repeated-subgraph', subgraph: defName, instances: insts.length, note: 'too many instances; expose via inspector on demand' });
      continue;
    }
    for (const inst of insts) {
      if (!isActive(inst)) continue;
      const wInputs = (inst.inputs || []).filter(i => i.widget);
      const labelFor = (name) => {
        const wi = wInputs.find(i => i.name === name || (i.widget && i.widget.name === name));
        if (wi && wi.label) return wi.label;
        const di = def && (def.inputs || []).find(i => i.name === name);
        return (di && di.label) || name;
      };
      const pw = (inst.properties && inst.properties.proxyWidgets) || null;
      if (pw && pw.length) {
        let wvIdx = 0;
        const baseSeen = {};
        for (let k = 0; k < pw.length; k++) {
          const [pnid, pname] = pw[k];
          if (String(pnid) === '-1') {
            // def-input widget: value on instance
            if (pname === 'control_after_generate') { wvIdx++; continue; } // UI-only companion widget
            const wi = wInputs.find(i => i.name === pname);
            if (wi && wi.link != null) { wvIdx++; continue; } // externally linked — not directly editable
            const di = def && (def.inputs || []).find(i => i.name === pname);
            let value = Array.isArray(inst.widgets_values) ? inst.widgets_values[wvIdx] : undefined;
            if (value === undefined && di && di.linkIds && di.linkIds.length) {
              // default lives on the inner node the def input feeds — resolve by the link's target slot
              const dl = (def.links || []).find(l => (Array.isArray(l) ? l[0] : l.id) === di.linkIds[0]);
              const tgtId = dl && (Array.isArray(dl) ? dl[3] : dl.target_id);
              const tgtSlot = dl && (Array.isArray(dl) ? dl[4] : dl.target_slot);
              const innerNode = def.nodes.find(x => String(x.id) === String(tgtId));
              const innerInp = innerNode && (innerNode.inputs || [])[tgtSlot];
              const innerW = innerInp ? ((innerInp.widget && innerInp.widget.name) || innerInp.name) : pname;
              if (innerNode) value = widgetValue(innerNode, innerW);
            }
            sgField(inst, defName, insts, pname, labelFor(pname), (wi && wi.type) || (di && di.type), value,
              { nodeId: inst.id, path: [], class: 'Subgraph', widget: pname, widgetIndex: wvIdx, title: inst.title || undefined });
            wvIdx++;
          } else {
            // inner mirror: value on def's inner node; pair nth same-name mirror with nth same-base def input for labels
            const inner = def && def.nodes.find(x => String(x.id) === String(pnid));
            if (!inner) continue;
            promotedInner.get(defId).add(`${pnid}:${pname}`);
            const nth = baseSeen[pname] = (baseSeen[pname] || 0);
            baseSeen[pname]++;
            if (pname === 'control_after_generate') continue;
            const sameBase = def ? (def.inputs || []).filter(i => i.name === pname || i.name.replace(/_\d+$/, '') === pname) : [];
            const di = sameBase[nth];
            // if the mirrored inner widget is link-fed inside the def (e.g. from a def input that is
            // itself externally wired), its serialized value is stale and writes are dead — skip
            const innerInp = (inner.inputs || []).find(i => i.widget && ((i.widget.name || i.name) === pname));
            if (innerInp && innerInp.link != null) continue;
            if (di && wInputs.some(i => i.name === di.name && i.link != null)) continue;
            const label = (di && (di.label || di.name)) || (inner.title ? `${inner.title}.${pname}` : pname);
            sgField(inst, defName, insts, (di && di.name) || pname, label, (di && di.type), widgetValue(inner, pname),
              { nodeId: inst.id, path: [], class: 'Subgraph', widget: (di && di.name) || pname, proxy: { node: inner.id, widget: pname }, title: inst.title || undefined });
          }
        }
      } else {
        // legacy positional mapping
        wInputs.forEach((wi, k) => {
          if (wi.link != null) return;
          const value = Array.isArray(inst.widgets_values) && inst.widgets_values.length > k ? inst.widgets_values[k] : undefined;
          sgField(inst, defName, insts, wi.name, wi.label || wi.name, wi.type, value,
            { nodeId: inst.id, path: [], class: 'Subgraph', widget: wi.name, widgetIndex: k, title: inst.title || undefined });
        });
      }
    }
  }

  // --- deep scan inside subgraph definitions (depth 1) ----------------------
  // Surfaces core knobs the author did NOT promote — disabled by default, path-targeted.
  for (const [defId, insts] of instByDef) {
    const def = ctx.defs.get(defId);
    if (!def || insts.length > 4) continue;
    const defName = def.name || String(defId).slice(0, 8);
    const subCtx = buildCtx({ nodes: def.nodes || [], links: def.links || [], groups: def.groups || [] });
    // inner widgets fed from the def's input node are already the promoted interface
    const inputFed = new Set();
    for (const di of def.inputs || []) for (const lid of di.linkIds || []) {
      const dl = (def.links || []).find(l => (Array.isArray(l) ? l[0] : l.id) === lid);
      if (dl) inputFed.add(String(Array.isArray(dl) ? dl[3] : dl.target_id));
    }
    for (const inst of insts.filter(isActive)) {
      const seen = promotedInner.get(defId) || new Set();
      const deepAdd = (inner, widget, kind, label, conf) => {
        if (seen.has(`${inner.id}:${widget}`)) return;
        const inp = (inner.inputs || []).find(i => i.name === widget || (i.widget && i.widget.name === widget));
        if (inp && inp.link != null) return; // fed within the def or from a promoted def input — not a literal
        const value = widgetValue(inner, widget);
        if (value === undefined) return;
        const f = baseField(subCtx, inner, widget, kind, `${label} (${defName}${insts.length > 1 ? ` #${inst.id}` : ''})`, {
          id: `deep_${defName.toLowerCase().replace(/\W+/g, '_')}_${inst.id}_${kind}`,
          confidence: conf * 0.85, rule: 'subgraph-deep-scan', section: defName, insideSubgraph: true, path: [inst.id],
        });
        f.zoneClass = 'neutral';
        store.add(f);
      };
      for (const inner of def.nodes || []) {
        if (!isActive(inner)) continue;
        if (SAMPLER_CLASSES.has(inner.type)) {
          const seedW = /Advanced|Adv\./.test(inner.type) ? 'noise_seed' : 'seed';
          deepAdd(inner, seedW, 'seed', 'Seed', 0.9);
          deepAdd(inner, 'steps', 'steps', 'Steps', 0.9);
          deepAdd(inner, 'cfg', 'cfg', 'CFG', 0.85);
          deepAdd(inner, 'denoise', 'denoise', 'Denoise', 0.5);
        }
        if (inner.type === 'RandomNoise') deepAdd(inner, 'noise_seed', 'seed', 'Seed', 0.85);
        if (inner.type === 'CFGGuider') deepAdd(inner, 'cfg', 'cfg', 'CFG', 0.85);
        if (inner.type === 'BasicScheduler') { deepAdd(inner, 'steps', 'steps', 'Steps', 0.85); deepAdd(inner, 'denoise', 'denoise', 'Denoise', 0.5); }
        if (inner.type === 'CLIPTextEncode') deepAdd(inner, 'text', /neg/i.test(inner.title || '') ? 'negative_prompt' : 'prompt', /neg/i.test(inner.title || '') ? 'Negative Prompt' : 'Prompt', 0.75);
        if (inner.type === 'WanVideoTextEncode') { deepAdd(inner, 'positive_prompt', 'prompt', 'Prompt', 0.8); deepAdd(inner, 'negative_prompt', 'negative_prompt', 'Negative Prompt', 0.7); }
        if (/^(LoraLoader|LoraLoaderModelOnly)$/.test(inner.type)) deepAdd(inner, 'strength_model', 'lora', `LoRA: ${String(widgetValue(inner, 'lora_name') || '').split(/[\\/]/).pop()}`, 0.7);
        if (inner.type.includes('Power Lora Loader')) {
          const rows = (Array.isArray(inner.widgets_values) ? inner.widgets_values : []).filter(w => w && typeof w === 'object' && 'lora' in w).map(w => ({ on: !!w.on, lora: w.lora, strength: w.strength }));
          if (rows.length && !seen.has(`${inner.id}:loras`)) {
            const f = baseField(subCtx, inner, 'loras', 'lora_list', `LoRAs (${defName})`, { id: `deep_${inst.id}_loras`, confidence: 0.8, rule: 'subgraph-deep-scan', section: defName, insideSubgraph: true, path: [inst.id], controlType: 'lora_rows', value: rows });
            f.zoneClass = 'neutral'; store.add(f);
          }
        }
        if (/^EmptyLatentImage$|^EmptyFlux2LatentImage$/.test(inner.type)) { deepAdd(inner, 'width', 'width', 'Width', 0.8); deepAdd(inner, 'height', 'height', 'Height', 0.8); }
        if (MODEL_LOADERS.test(inner.type)) { const lay = widgetLayout(inner) || []; const w = lay.find(x => /name|^model$/.test(x)); if (w) deepAdd(inner, w, 'model', inner.title || 'Model', 0.6); }
        if (inner.type === 'LoadImage') deepAdd(inner, 'image', 'image_input', inner.title || 'Image', 0.65);
      }
    }
  }

  // --- generic canonical widget-name detector (gap fill for exotic nodes) ---
  // underscore-aware for seed: initial_seed, seed_value, noise_seed etc. all count
  const GENERIC_W = /^(([a-z0-9]+_)?seed(_[a-z0-9]+)?|steps|cfg|guidance|denoise|width|height|num_frames|frames|length|duration|fps|frame_rate)$/i;
  for (const n of active) {
    if (DISPLAY_ONLY.has(n.type) || isSubgraphType(n.type) || SAMPLER_CLASSES.has(n.type)) continue;
    for (const i of n.inputs || []) {
      if (!i.widget || i.link != null) continue;
      const wName = i.widget.name || i.name;
      if (!GENERIC_W.test(wName)) continue;
      const kind = kindFromName(wName) || 'int';
      if (widgetValue(n, wName) === undefined) continue;
      store.add(baseField(ctx, n, wName, kind, `${wName} — ${n.title || n.type}`, { id: `${kind}_${n.id}`, confidence: 0.65, rule: 'generic-widget-name' }));
    }
  }

  finalizeConfig(store, reachable);

  // presets: rgthree Fast Groups Muter (max one) over color-matched groups — parity with
  // detectPresetGroups: the muter's own mode does NOT matter, and each preset carries its
  // current on-state (any member unmuted) so the UI can initialize checkboxes.
  const presets = [];
  const presetTitles = new Set();
  for (const n of nodes.filter(n => String(n.type).includes('Fast Groups Muter') && n.properties && n.properties.toggleRestriction === 'max one')) {
    const colors = String(n.properties.matchColors || '').toLowerCase().split(/[, ]+/).filter(Boolean).map(c => c === 'purple' ? '#a1309b' : c);
    if (!colors.length) continue;
    for (const z of ctx.zones) {
      if (!z.color || !colors.some(c => z.color.toLowerCase() === c.toLowerCase())) continue;
      if (presetTitles.has(z.title)) continue;
      presetTitles.add(z.title);
      presets.push({ title: z.title, on: z.nodes.some(id => { const m = ctx.nodes.get(id); return m && m.mode !== 2; }) });
    }
  }

  return {
    version: 1,
    workflow: name,
    format: 'graph',
    generatedAt: new Date().toISOString(),
    zones: ctx.zones.map(z => ({ title: z.title, color: z.color, class: z.cls, nodes: z.nodes })),
    fields: store.fields,
    presets,
    skipped,
  };
}

// --- API-format workflows ---------------------------------------------------
function detectApi(j, name) {
  const store = makeFieldStore();
  const fakeCtx = { zoneOf: new Map(), zones: [] };
  const negRe = /\bneg(ative)?\b/i;
  const API_KINDS = new Set(['seed', 'steps', 'cfg', 'denoise', 'shift', 'guidance', 'length', 'fps', 'width', 'height', 'batch', 'size_preset', 'prompt', 'negative_prompt', 'sampler', 'scheduler', 'model', 'vae', 'lora']);
  for (const [id, n] of Object.entries(j)) {
    const node = { id, type: n.class_type, title: (n._meta && n._meta.title) || '', inputs: [], widgets_values: null, mode: 0 };
    const media = n.class_type === 'LoadImage' ? ['image', 'image_input'] : n.class_type === 'VHS_LoadVideo' ? ['video', 'video_input'] : /^LoadAudio/.test(n.class_type) ? ['audio', 'audio_input'] : null;
    if (media) {
      const [key, kind] = media;
      const main = /main/i.test(node.title);
      const f = baseField(fakeCtx, node, key, kind, node.title || key, { id: `${kind}_${id}`, confidence: main ? 0.95 : 0.7, rule: 'api-media-input', controlType: key, value: (n.inputs || {})[key] });
      f.targets = [{ nodeId: id, path: [], class: n.class_type, widget: key, widgetIndex: null }];
      store.add(f);
      continue;
    }
    for (const [k, v] of Object.entries(n.inputs || {})) {
      if (Array.isArray(v)) continue; // link ref, not a literal
      let kind = kindFromName(k);
      if (!kind || !API_KINDS.has(kind)) continue;
      if (kind === 'prompt' && negRe.test(node.title)) kind = 'negative_prompt';
      const mainPrompt = kind === 'prompt' && /main/i.test(node.title) && /prompt/i.test(node.title);
      const f = baseField(fakeCtx, node, k, kind, `${k} — ${node.title || n.class_type}`, {
        id: kind, confidence: mainPrompt ? 0.85 : 0.7, rule: 'api-input-name', value: v,
        controlType: (kind === 'prompt' || kind === 'negative_prompt') ? 'multiline' : undefined,
      });
      f.targets = [{ nodeId: id, path: [], class: n.class_type, widget: k, widgetIndex: null }];
      store.add(f);
    }
  }
  finalizeConfig(store, null);
  return { version: 1, workflow: name, format: 'api', generatedAt: new Date().toISOString(), zones: [], fields: store.fields, presets: [], skipped: [] };
}

// ---------------------------------------------------------------- main

function generate(file) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  const name = path.basename(file);
  const mtime = fs.statSync(file).mtimeMs;
  let cfg;
  if (!j.nodes && Object.values(j).every(v => v && typeof v === 'object' && v.class_type)) cfg = detectApi(j, name);
  else if (!j.nodes) cfg = { version: 1, workflow: name, format: 'unknown', fields: [], zones: [], presets: [], skipped: [] };
  else cfg = detectGraph(j, name);
  cfg.workflowMtime = mtime;
  return cfg;
}

if (require.main !== module) { module.exports = { generate, detectGraph, detectApi }; return; }

const argv = process.argv.slice(2);
const full = argv.includes('--full');
const outIx = argv.indexOf('--out');
const outPath = outIx >= 0 ? argv[outIx + 1] : null;
const paths = argv.filter((a, i) => !a.startsWith('--') && (outIx < 0 || i !== outIx + 1));
if (!paths.length) { console.error('usage: node gen_field_config.js <workflow.json|dir> [more paths...] [--full] [--out file.json]'); process.exit(1); }

const targets = paths.flatMap(p => fs.statSync(p).isDirectory()
  ? fs.readdirSync(p).filter(f => f.endsWith('.json') && !f.startsWith('.')).map(f => path.join(p, f))
  : [p]);

for (const t of targets) {
  let cfg;
  try { cfg = generate(t); } catch (e) { console.log(`\n### ${path.basename(t)}  ERROR: ${e.message}`); continue; }
  if (outPath && targets.length === 1) { fs.writeFileSync(outPath, JSON.stringify(cfg, null, 2) + '\n'); console.log(`wrote ${outPath}`); continue; }
  if (full) { console.log(JSON.stringify(cfg, null, 2)); continue; }
  console.log(`\n### ${cfg.workflow}  [${cfg.format}]  fields=${cfg.fields.length}  enabled=${cfg.fields.filter(f => f.enabled).length}  presets=${(cfg.presets || []).length}  skipped=${cfg.skipped.length}`);
  for (const f of cfg.fields) {
    const t0 = f.targets[0];
    const flags = [f.enabled ? 'ON ' : '   ', f.variant ? f.variant.padEnd(4) : '    ', f.inactive ? 'MUTED' : f.unreachable ? 'UNRCH' : '     ', f.zoneClass === 'internal' ? 'INT' : '   '].join('');
    console.log(`  ${flags} ${f.id.padEnd(26)} ${f.kind.padEnd(15)} ${(f.label || '').slice(0, 30).padEnd(30)} -> #${t0.nodeId}:${t0.widget}${t0.proxy ? ' (proxy ' + t0.proxy.node + ':' + t0.proxy.widget + ')' : ''} = ${String(JSON.stringify(f.value)).slice(0, 48)}  [${f.evidence.rule} c=${f.confidence}]${f.section ? '  §' + f.section : ''}`);
  }
  for (const s of cfg.skipped) console.log(`  ~~ skipped: ${JSON.stringify(s)}`);
}
