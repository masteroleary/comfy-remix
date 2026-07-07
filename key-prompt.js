// Shared "missing API key" prompt (one copy for all pages).
// Injects its modal DOM on first use and exposes:
//   window.requireApiKey(keyName, label, helpUrl) -> Promise<boolean>
// Resolves true if the key is already set OR the user enters and saves one.
// Keys are saved via POST /api/settings and hot-reloaded server-side.
(function () {
  const g = id => document.getElementById(id);

  function ensureDom() {
    if (g('keyPrompt')) return;
    const ov = document.createElement('div');
    ov.id = 'keyPrompt';
    ov.style.cssText = 'display:none;position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.72);align-items:center;justify-content:center;padding:16px';
    ov.innerHTML = '<div style="background:#1c1c1e;border:1px solid #48484a;border-radius:12px;max-width:420px;width:100%;padding:22px">'
      + '<div id="keyPromptTitle" style="font-size:16px;font-weight:600;color:#f2f2f7;margin-bottom:6px"></div>'
      + '<div id="keyPromptMsg" style="font-size:13px;color:#9a9a9e;line-height:1.5;margin-bottom:14px"></div>'
      + '<input id="keyPromptInput" type="password" autocomplete="off" placeholder="Paste API key" style="width:100%;box-sizing:border-box;background:#111;color:#f2f2f7;border:1px solid #48484a;border-radius:8px;padding:11px;font-size:14px;margin-bottom:8px">'
      + '<a id="keyPromptHelp" href="#" target="_blank" rel="noopener" style="font-size:12px;color:#0a84ff;text-decoration:none">Where do I get a key? ↗</a>'
      + '<div style="display:flex;gap:8px;margin-top:16px">'
      + '<button id="keyPromptCancel" style="flex:1;padding:11px;border:none;border-radius:8px;background:#2c2c2e;color:#f2f2f7;font-weight:600;cursor:pointer">Not now</button>'
      + '<button id="keyPromptSave" style="flex:1;padding:11px;border:none;border-radius:8px;background:#0a84ff;color:#fff;font-weight:600;cursor:pointer">Save key</button>'
      + '</div></div>';
    document.body.appendChild(ov);
  }

  window.requireApiKey = function (keyName, label, helpUrl) {
    return new Promise(resolve => {
      fetch('/api/settings').then(r => r.json()).then(s => {
        if (s && s.keys && s.keys[keyName] && s.keys[keyName].set) { resolve(true); return; }
        ensureDom();
        const ov = g('keyPrompt');
        g('keyPromptTitle').textContent = label + ' needs an API key';
        g('keyPromptMsg').textContent = 'Paste your key to use ' + label + '. It’s saved on this server and applied immediately — no restart.';
        const inp = g('keyPromptInput'); inp.value = '';
        const help = g('keyPromptHelp');
        if (helpUrl) { help.href = helpUrl; help.style.display = ''; } else { help.style.display = 'none'; }
        const done = v => { ov.style.display = 'none'; g('keyPromptSave').onclick = null; resolve(v); };
        ov.style.display = 'flex'; setTimeout(() => inp.focus(), 50);
        g('keyPromptCancel').onclick = () => done(false);
        ov.onclick = e => { if (e.target === ov) done(false); };
        inp.onkeydown = e => { if (e.key === 'Enter') g('keyPromptSave').click(); };
        g('keyPromptSave').onclick = async () => {
          const val = inp.value.trim(); if (!val) { done(false); return; }
          try {
            const r = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [keyName]: val }) });
            const d = await r.json(); done(!!d.ok);
          } catch { done(false); }
        };
      }).catch(() => resolve(true)); // if settings can't be read, don't block the feature
    });
  };
})();
