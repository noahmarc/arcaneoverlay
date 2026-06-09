// backup.js — one-file "export everything" backup + restore.
// The board, character sheets, board-scenes, presets and settings all live in
// localStorage; the soundboard lives in IndexedDB. A backup bundles both.
(function () {
  'use strict';
  if (window.ArcaneBackup) return;
  const SRV = 'http://localhost:8765/api/';

  function _toast(msg) {
    let t = document.getElementById('arcane-backup-toast');
    if (!t) { t = document.createElement('div'); t.id = 'arcane-backup-toast'; t.style.cssText = 'position:fixed;left:50%;bottom:30px;transform:translateX(-50%);background:#1b1b22;color:#e8e8ee;border:1px solid #3a3a44;border-radius:8px;padding:9px 16px;font:13px system-ui;z-index:13000;box-shadow:0 8px 24px rgba(0,0,0,.6);max-width:80vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'; document.body.appendChild(t); }
    t.textContent = msg; t.style.opacity = '1';
    clearTimeout(t._to); t._to = setTimeout(() => { t.style.transition = 'opacity .5s'; t.style.opacity = '0'; }, 4000);
  }

  function buildBundle() {
    // Make sure the live board is flushed to its autosave key first.
    try { if (typeof getSaveData === 'function') localStorage.setItem('dnd-autosave', JSON.stringify(getSaveData())); } catch (e) {}
    const ls = {};
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); ls[k] = localStorage.getItem(k); }
    return {
      __arcaneBackup: 1, app: 'ArcaneOverlay', savedAt: Date.now(),
      localStorage: ls,
      soundboard: (window.ArcaneSampler && window.ArcaneSampler.exportData) ? window.ArcaneSampler.exportData() : null,
    };
  }

  async function exportAll() {
    let json;
    try { json = JSON.stringify(buildBundle()); } catch (e) { _toast('Backup failed: ' + e.message); return; }
    const fname = 'arcane-backup-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.json';
    try {
      const r = await fetch(SRV + 'save_file?name=' + encodeURIComponent(fname), { method: 'POST', body: json, headers: { 'Content-Type': 'application/json' } });
      const j = await r.json();
      if (j && j.ok) { _toast('Backup saved to ' + j.path); return; }
      throw new Error();
    } catch (e) {            // fallback: browser download
      const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      const a = document.createElement('a'); a.href = url; a.download = fname; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    }
  }

  async function restoreFromText(text) {
    let b;
    try { b = JSON.parse(text); } catch (e) { alert('That file is not valid JSON.'); return; }
    if (!b || b.__arcaneBackup !== 1) { alert('That doesn\'t look like an ArcaneOverlay backup.'); return; }
    const when = b.savedAt ? new Date(b.savedAt).toLocaleString() : 'unknown date';
    if (!confirm(`Restore this backup (saved ${when})?\n\nThis REPLACES your current board, character sheets, scenes, settings and soundboard. The app will reload.`)) return;
    try {
      if (b.soundboard && window.ArcaneSampler && window.ArcaneSampler.importData) await window.ArcaneSampler.importData(b.soundboard);
    } catch (e) {}
    try {
      localStorage.clear();
      const ls = b.localStorage || {};
      for (const k in ls) localStorage.setItem(k, ls[k]);
    } catch (e) { alert('Restore failed writing settings: ' + e.message); return; }
    _toast('Backup restored — reloading…');
    setTimeout(() => location.reload(), 600);
  }

  // ── In-app JSON file browser (native open dialog is unavailable here) ────────
  let _el = null;
  function _css() {
    if (document.getElementById('backup-css')) return;
    const st = document.createElement('style'); st.id = 'backup-css';
    st.textContent = `
    #backup-browser{position:fixed;inset:0;background:rgba(0,0,0,.55);display:none;align-items:center;justify-content:center;z-index:13000}
    #backup-browser.on{display:flex}
    #backup-browser .bk-box{width:540px;max-width:92vw;max-height:78vh;background:#15151a;border:1px solid #34343c;border-radius:12px;display:flex;flex-direction:column;overflow:hidden;color:#e8e8ee;font:13px system-ui;box-shadow:0 20px 60px rgba(0,0,0,.6)}
    #backup-browser .bk-head{display:flex;align-items:center;gap:10px;padding:10px 12px;border-bottom:1px solid #26262c;background:#1b1b22}
    #backup-browser .bk-title{font-weight:700;color:#9fd0ff}
    #backup-browser .bk-path{flex:1;font-size:11px;color:#9a9aa2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left}
    #backup-browser .bk-x{background:none;border:none;color:#9a9aa2;font-size:16px;cursor:pointer}
    #backup-browser .bk-list{overflow:auto;padding:6px}
    #backup-browser .bk-row{padding:7px 10px;border-radius:6px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    #backup-browser .bk-row:hover{background:#26262e}
    #backup-browser .bk-file{color:#bfe9ff}
    #backup-browser .bk-empty{color:#80808a;padding:14px;text-align:center}
    #backup-browser .bk-foot{padding:8px 12px;border-top:1px solid #26262c;color:#80808a;font-size:11px}`;
    document.head.appendChild(st);
  }
  function openRestoreBrowser() {
    _css();
    if (!_el) {
      _el = document.createElement('div'); _el.id = 'backup-browser';
      _el.innerHTML = `<div class="bk-box">
        <div class="bk-head"><span class="bk-title">♻ Choose a backup (.json)</span><span class="bk-path" id="bk-path"></span><button class="bk-x" id="bk-close">✕</button></div>
        <div class="bk-list" id="bk-list"></div>
        <div class="bk-foot">Pick an <b>arcane-backup-….json</b> — or just drag the file onto the window.</div>
      </div>`;
      document.body.appendChild(_el);
      _el.addEventListener('click', (e) => { if (e.target === _el) _el.classList.remove('on'); });
      _el.querySelector('#bk-close').addEventListener('click', () => _el.classList.remove('on'));
    }
    _el.classList.add('on');
    _browse(window.__bkPath || '');
  }
  function _browse(path) {
    fetch(SRV + 'fs/list?ext=json&path=' + encodeURIComponent(path || '')).then(r => r.json()).then(d => {
      window.__bkPath = d.path;
      const list = _el.querySelector('#bk-list'); _el.querySelector('#bk-path').textContent = d.path;
      list.innerHTML = '';
      const up = document.createElement('div'); up.className = 'bk-row'; up.textContent = '⬆  ..';
      up.addEventListener('click', () => _browse(d.parent)); list.appendChild(up);
      const sep = d.path.endsWith('/') ? '' : '/';
      (d.dirs || []).forEach((name) => { const r = document.createElement('div'); r.className = 'bk-row'; r.textContent = '📁  ' + name; r.addEventListener('click', () => _browse(d.path + sep + name)); list.appendChild(r); });
      (d.files || []).forEach((name) => { const r = document.createElement('div'); r.className = 'bk-row bk-file'; r.textContent = '🗄  ' + name; r.addEventListener('click', () => _pick(d.path + sep + name)); list.appendChild(r); });
      if (!(d.dirs || []).length && !(d.files || []).length) { const e = document.createElement('div'); e.className = 'bk-empty'; e.textContent = '(no .json files or sub-folders here)'; list.appendChild(e); }
    }).catch(() => {});
  }
  function _pick(path) {
    fetch(SRV + 'fs/readtext?path=' + encodeURIComponent(path)).then(r => r.text()).then((txt) => {
      if (_el) _el.classList.remove('on');
      restoreFromText(txt);
    }).catch(() => alert('Could not read that file.'));
  }

  // Drag-and-drop a backup .json onto the window to restore.
  window.addEventListener('drop', (e) => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f || !/\.json$/i.test(f.name)) return;
    e.preventDefault();
    const reader = new FileReader();
    reader.onload = (ev) => restoreFromText(ev.target.result);
    reader.readAsText(f);
  });

  function init() {
    const eb = document.getElementById('backup-btn'), rb = document.getElementById('restore-btn');
    if (eb) eb.addEventListener('click', exportAll);
    if (rb) rb.addEventListener('click', openRestoreBrowser);
  }
  window.ArcaneBackup = { exportAll, restoreFromText, openRestoreBrowser };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
