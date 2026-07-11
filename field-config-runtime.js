'use strict';
// Runtime side of the import-time "field config" feature: build a workflow's
// field config (detected fields merged with saved user edits) and apply generic
// {fieldId: value} overrides onto the raw graph before conversion.
//
// Pure logic + injected deps (generator, loadStore, detectPresetGroups) so it can
// be unit-tested without standing up the HTTP server. See docs/field-config/DESIGN.md.
module.exports = function createFieldConfigRuntime(deps) {
  const generator = deps.generator;             // gen_field_config.js module (or null)
  const loadStore = deps.loadStore;             // () => wf store (has fieldConfigs)
  const detectPresetGroups = deps.detectPresetGroups; // (wf) => [{title, memberIds, on}]

  // Generate a workflow's field config, merged with the user's saved edits.
  // userEdits: store.fieldConfigs[name] = { edits: {<id>:{enabled?,label?,value?}}, manual: [field...] }
  function buildFieldConfig(wf, wfName, mtimeMs) {
    if (!generator) return { version: 1, workflow: wfName, format: 'unavailable', fields: [], zones: [], presets: [], skipped: [], error: 'generator module not loaded' };
    if (!wf || typeof wf !== 'object') return { version: 1, workflow: wfName, format: 'error', fields: [], zones: [], presets: [], skipped: [], error: 'workflow is not an object' };
    const vals = Object.values(wf);
    const isApi = !wf.nodes && vals.length > 0 && vals.every(v => v && typeof v === 'object' && v.class_type);
    let cfg;
    try { cfg = isApi ? generator.detectApi(wf, wfName) : generator.detectGraph(wf, wfName); }
    catch (e) { return { version: 1, workflow: wfName, format: 'error', fields: [], zones: [], presets: [], skipped: [], error: e.message }; }
    cfg.workflowMtime = mtimeMs || 0;
    const saved = (loadStore().fieldConfigs || {})[wfName];
    if (saved) {
      if (saved.edits) for (const f of cfg.fields) {
        const e = saved.edits[f.id];
        if (!e) continue;
        if (e.enabled !== undefined) f.enabled = e.enabled;
        if (e.label !== undefined) f.label = e.label;
        if (e.value !== undefined) f.value = e.value;
        f.userEdited = true;
      }
      if (Array.isArray(saved.manual)) for (const mf of saved.manual) {
        if (!cfg.fields.some(f => f.id === mf.id)) cfg.fields.push(Object.assign({ source: 'manual', enabled: true }, mf));
      }
    }
    return cfg;
  }

  // Write one value into a graph node's widgets_values (array or dict form).
  function setNodeWidget(node, widget, widgetIndex, value) {
    if (!node) return false;
    const wv = node.widgets_values;
    if (wv && !Array.isArray(wv) && typeof wv === 'object') { wv[widget] = value; return true; }
    if (Array.isArray(wv)) {
      const idx = typeof widgetIndex === 'number' ? widgetIndex
        : (typeof widgetIndex === 'string' && /^\d+$/.test(widgetIndex)) ? parseInt(widgetIndex, 10) : -1;
      if (idx >= 0 && idx < wv.length) { wv[idx] = value; return true; }
    }
    return false;
  }

  function coerceFieldValue(field, value) {
    const t = (field.control && field.control.type) || '';
    if (t === 'int' || ['seed', 'steps', 'length', 'width', 'height', 'batch'].includes(field.kind)) {
      const n = parseInt(value, 10); return isNaN(n) ? value : n;
    }
    if (t === 'float' || ['cfg', 'denoise', 'shift', 'guidance', 'fps'].includes(field.kind)) {
      const n = parseFloat(value); return isNaN(n) ? value : n;
    }
    if (t === 'boolean' || field.kind === 'toggle') return value === true || value === 'true' || value === 1;
    return value;
  }

  // Apply { <fieldId>: value } onto the raw graph before conversion. Mutates wf.
  function applyFieldConfigOverrides(wf, config, fieldValues) {
    const warnings = [];
    const byId = {}; for (const n of wf.nodes || []) byId[String(n.id)] = n;
    const fieldById = {}; for (const f of config.fields || []) fieldById[f.id] = f;
    const handled = new Set();

    // 1) Dual-sampler high/low steps pair — total=high+low on both, boundary=high.
    for (const f of config.fields || []) {
      if (!f.meta || f.meta.role !== 'hl_steps_high') continue;
      const lowF = f.pairId && fieldById[f.pairId];
      if (!(f.id in fieldValues) && !(lowF && lowF.id in fieldValues)) continue;
      const hs = parseInt(fieldValues[f.id], 10);
      const ls = lowF ? parseInt(fieldValues[lowF.id], 10) : NaN;
      if (isNaN(hs) || isNaN(ls) || hs < 0 || ls < 0 || hs + ls <= 0) continue;
      const hi = byId[String(f.meta.samplerHigh)], lo = byId[String(f.meta.samplerLow)];
      if (hi && Array.isArray(hi.widgets_values)) { hi.widgets_values[3] = hs + ls; hi.widgets_values[7] = 0; hi.widgets_values[8] = hs; }
      if (lo && Array.isArray(lo.widgets_values)) { lo.widgets_values[3] = hs + ls; lo.widgets_values[7] = hs; }
      handled.add(f.id); if (lowF) handled.add(lowF.id);
    }

    // 2) Every other provided field → write to each of its graph targets.
    for (const [fid, rawVal] of Object.entries(fieldValues)) {
      if (fid === '__preset' || handled.has(fid)) continue;
      const f = fieldById[fid];
      if (!f) { warnings.push(`unknown field ${fid}`); continue; }

      if (f.kind === 'seed') { // pin only when a concrete >=0 value is given
        const s = parseInt(rawVal, 10);
        if (isNaN(s) || s < 0) continue;
        for (const t of f.targets || []) {
          if (t.path && t.path.length) { warnings.push(`subgraph target skipped for ${fid}`); continue; }
          setNodeWidget(byId[String(t.nodeId)], t.widget, t.widgetIndex, s);
        }
        continue;
      }

      if (f.kind === 'lora_list') {
        const rows = Array.isArray(rawVal) ? rawVal : f.value;
        const t = (f.targets || [])[0];
        const node = t && byId[String(t.nodeId)];
        if (!node || !Array.isArray(node.widgets_values)) { warnings.push(`lora target missing for ${fid}`); continue; }
        if (t.widget === 'loras') { // Power Lora Loader — row.slot indexes widgets_values
          for (const r of rows || []) {
            const cur = node.widgets_values[r.slot];
            if (cur && typeof cur === 'object' && 'lora' in cur) { cur.on = !!r.on; if (r.strength != null) cur.strength = r.strength; }
          }
        } else { warnings.push(`lora-stack apply not yet supported (${fid})`); }
        continue;
      }

      const val = coerceFieldValue(f, rawVal);
      for (const t of f.targets || []) {
        if (t.path && t.path.length) { warnings.push(`subgraph target skipped for ${fid} (needs converter expansion)`); continue; }
        if (!setNodeWidget(byId[String(t.nodeId)], t.widget, t.widgetIndex, val)) warnings.push(`could not write ${fid} -> #${t.nodeId}:${t.widget}`);
      }
    }

    // 3) Presets: activate exactly one, mute the rest.
    if (fieldValues.__preset && detectPresetGroups) {
      const groups = detectPresetGroups(wf);
      const nb = {}; for (const n of wf.nodes || []) nb[n.id] = n;
      for (const g of groups) { const mode = g.title === fieldValues.__preset ? 0 : 2; for (const id of g.memberIds) if (nb[id]) nb[id].mode = mode; }
    }
    return { warnings };
  }

  return { buildFieldConfig, setNodeWidget, coerceFieldValue, applyFieldConfigOverrides };
};
