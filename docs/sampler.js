// sampler.js — MIDI-keyboard soundboard for ArcaneOverlay.
//
// Plug in any MIDI keyboard (routed through the native CoreMIDI bridge →
// window.arcaneOnMIDI → music.js → window.ArcaneSamplerMIDI here) and map sound
// bites to individual keys.  Press a key → the mapped sample fires (polyphonic,
// one-shot).  Sounds + their key assignments persist in IndexedDB across launches.
(function () {
  'use strict';
  if (window.ArcaneSampler) return;            // guard against double-load

  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const COLORS = ['#ff7a1a', '#1f8fff', '#36c98a', '#cf5cff', '#ffcf3a', '#ff5c7a', '#5cd6ff', '#9aff6a'];
  const noteName = (n) => NOTE_NAMES[((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1);

  const NBANKS = 4;
  const S = { pads: [], scenes: [], learning: null, nextId: 1, sceneSeq: 1, master: 0.9, gain: null, open: false, octaveBase: 48, bank: 1, duckOn: true, duckDepth: 0.78 };
  const curPads = () => S.pads.filter((p) => (p.bank || 1) === S.bank);
  const padForNote = (note) => S.pads.find((p) => (p.bank || 1) === S.bank && p.note === note);

  function ctx() { return window.ArcaneMusicAPI ? window.ArcaneMusicAPI.audioCtx() : null; }
  function masterGain() {
    const c = ctx(); if (!c) return null;
    if (!S.gain) { S.gain = c.createGain(); S.gain.gain.value = S.master; S.gain.connect(c.destination); }
    return S.gain;
  }

  // ── IndexedDB persistence ────────────────────────────────────────────────
  let _db = null;
  function db(cb) {
    if (_db) return cb(_db);
    const r = indexedDB.open('ArcaneSampler', 2);
    r.onupgradeneeded = () => { const d = r.result; if (!d.objectStoreNames.contains('pads')) d.createObjectStore('pads', { keyPath: 'id' }); if (!d.objectStoreNames.contains('scenes')) d.createObjectStore('scenes', { keyPath: 'id' }); };
    r.onsuccess = () => { _db = r.result; cb(_db); };
    r.onerror = () => cb(null);
  }
  function dbSaveScene(sc) { db((d) => { if (!d) return; try { d.transaction('scenes', 'readwrite').objectStore('scenes').put(sc); } catch (e) {} }); }
  function dbDeleteScene(id) { db((d) => { if (!d) return; try { d.transaction('scenes', 'readwrite').objectStore('scenes').delete(id); } catch (e) {} }); }
  function dbLoadScenes(cb) { db((d) => { if (!d) return cb([]); try { const req = d.transaction('scenes', 'readonly').objectStore('scenes').getAll(); req.onsuccess = () => cb(req.result || []); req.onerror = () => cb([]); } catch (e) { cb([]); } }); }
  function dbSave(pad) {
    db((d) => { if (!d) return; try { d.transaction('pads', 'readwrite').objectStore('pads').put({ id: pad.id, name: pad.name, note: pad.note, color: pad.color, data: pad.data, mode: pad.mode, volume: pad.volume, chokeGroup: pad.chokeGroup, bank: pad.bank }); } catch (e) {} });
  }
  function dbDelete(id) { db((d) => { if (!d) return; try { d.transaction('pads', 'readwrite').objectStore('pads').delete(id); } catch (e) {} }); }
  function dbLoadAll(cb) {
    db((d) => {
      if (!d) return cb([]);
      try { const req = d.transaction('pads', 'readonly').objectStore('pads').getAll(); req.onsuccess = () => cb(req.result || []); req.onerror = () => cb([]); }
      catch (e) { cb([]); }
    });
  }

  // ── Audio ────────────────────────────────────────────────────────────────
  async function decode(arrayBuffer) {
    const c = ctx(); if (!c) return null;
    return await new Promise((res, rej) => {
      // pass a copy — decodeAudioData detaches the buffer
      c.decodeAudioData(arrayBuffer.slice(0), res, rej);
    });
  }
  function padActive(pad) { return pad._voices && pad._voices.length > 0; }
  function refreshDuck() {                          // duck music whenever any pad is sounding
    const any = S.pads.some((p) => padActive(p));
    if (window.ArcaneMusicAPI && window.ArcaneMusicAPI.setDuck) window.ArcaneMusicAPI.setDuck(any);
  }
  function startVoice(pad, vel, loop, fadeIn) {
    const c = ctx(); if (!c || !pad.buffer) return null;
    if (c.state === 'suspended') c.resume();
    const src = c.createBufferSource(); src.buffer = pad.buffer; src.loop = !!loop;
    const g = c.createGain();
    const peak = Math.max(0, Math.min(1, (pad.volume == null ? 1 : pad.volume) * (vel == null ? 1 : vel)));
    if (fadeIn > 0) { g.gain.setValueAtTime(0.0001, c.currentTime); g.gain.linearRampToValueAtTime(peak, c.currentTime + fadeIn); }
    else g.gain.value = peak;
    src.connect(g); g.connect(masterGain());
    src.start();
    const voice = { src, gain: g };
    (pad._voices || (pad._voices = [])).push(voice);
    src.onended = () => { const i = pad._voices.indexOf(voice); if (i >= 0) pad._voices.splice(i, 1); updatePadState(pad); refreshDuck(); };
    updatePadState(pad); refreshDuck();
    return voice;
  }
  function stopVoices(pad, fade) {
    const c = ctx(); if (!c || !pad._voices) return;
    pad._voices.slice().forEach((v) => {
      try {
        if (fade > 0) {
          const g = v.gain.gain; g.cancelScheduledValues(c.currentTime);
          g.setValueAtTime(g.value, c.currentTime); g.linearRampToValueAtTime(0.0001, c.currentTime + fade);
          v.src.stop(c.currentTime + fade + 0.02);
        } else v.src.stop();
      } catch (e) {}
    });
    pad._voices = [];
    updatePadState(pad); refreshDuck();
  }
  function trigger(pad, vel) {                    // a "press" — behaviour depends on the pad's mode
    const c = ctx(); if (!c || !pad || !pad.buffer) return;
    if (c.state === 'suspended') c.resume();
    if (pad.chokeGroup) S.pads.forEach((p) => { if (p !== pad && p.chokeGroup === pad.chokeGroup) stopVoices(p, 0.05); });
    if (pad.mode === 'loop') {
      if (padActive(pad)) stopVoices(pad, 0.12);   // toggle off
      else startVoice(pad, vel, true, 0.02);
    } else if (pad.mode === 'hold') {
      if (!padActive(pad)) startVoice(pad, vel, true, 0.01);   // sustains until release
    } else {
      startVoice(pad, vel, false, 0);              // one-shot (polyphonic)
    }
    flashPad(pad);
  }
  function release(pad) { if (pad && pad.mode === 'hold') stopVoices(pad, 0.08); }
  function updatePadState(pad) {
    const on = padActive(pad);
    if (pad.el) pad.el.classList.toggle('playing', on);
    if (els.piano) { const k = els.piano.querySelector('[data-note="' + pad.note + '"]'); if (k) k.classList.toggle('playing', on); }
  }

  // ── Pad model ──────────────────────────────────────────────────────────────
  function freeNote(start) {                     // first MIDI note not mapped in the current bank
    let n = (start == null ? 48 : start);        // default C3
    const used = new Set(curPads().map((p) => p.note));
    while (used.has(n) && n < 127) n++;
    return n;
  }
  function addPad(name, buffer, data, note, color, id, extra) {
    extra = extra || {};
    const pad = {
      id: id || S.nextId++, name: name || 'sound', buffer, data,
      note: (note == null ? freeNote() : note),
      color: color || COLORS[S.pads.length % COLORS.length], el: null,
      mode: extra.mode || 'oneshot',           // 'oneshot' | 'loop' | 'hold'
      volume: (extra.volume == null ? 1 : extra.volume),
      chokeGroup: extra.chokeGroup || 0,       // 0 = none, 1-9 = exclusive group
      bank: extra.bank || S.bank,              // which pad bank this lives in
      _voices: [],
    };
    if (id && id >= S.nextId) S.nextId = id + 1;
    S.pads.push(pad);
    return pad;
  }
  function removePad(pad) {
    const i = S.pads.indexOf(pad); if (i < 0) return;
    S.pads.splice(i, 1); dbDelete(pad.id); renderPads();
  }

  // ── Online sound browser (myinstants.com via server proxy) ─────────────────
  const SRV = 'http://localhost:8765/api/sounds/';
  async function onlineSearch(q, page) {
    const r = await fetch(SRV + 'search?q=' + encodeURIComponent(q || '') + '&page=' + (page || 1));
    if (!r.ok) throw new Error('search failed');
    return await r.json();   // {results, page, more}
  }
  async function importOnline(item) {
    const r = await fetch(SRV + 'fetch?url=' + encodeURIComponent(item.url));
    if (!r.ok) throw new Error('download failed');
    const data = await r.arrayBuffer();
    const buffer = await decode(data);
    if (!buffer) throw new Error('decode failed');
    const pad = addPad(item.name, buffer, data);
    dbSave(pad); renderPads();
    return pad;
  }

  async function addFiles(fileList) {
    for (const f of fileList) {
      try {
        const data = await f.arrayBuffer();
        const buffer = await decode(data);
        if (!buffer) continue;
        const nm = f.name.replace(/\.[^.]+$/, '');
        const pad = addPad(nm, buffer, data);
        dbSave(pad);
      } catch (e) { /* skip undecodable */ }
    }
    renderPads();
  }

  // ── MIDI entry point (called from music.js for every message) ──────────────
  // Returns true if the soundboard consumed the message.
  function assignLearn(note) {                     // bind a note to the pad waiting in Learn mode
    const pad = S.learning; if (!pad) return;
    S.learning = null;
    S.pads.forEach((p) => { if (p !== pad && (p.bank || 1) === (pad.bank || 1) && p.note === note) p.note = freeNote(); });   // free a clashing pad in this bank
    pad.note = note; dbSave(pad); renderPads(); renderPiano();
  }

  window.ArcaneSamplerMIDI = function (status, d1, d2) {
    const hi = status & 0xf0;
    const noteOn = (hi === 0x90 && d2 > 0);
    const noteOff = (hi === 0x80) || (hi === 0x90 && d2 === 0);
    if (S.learning != null && noteOn) { assignLearn(d1); return true; }   // MIDI-learn
    if (noteOff) { const p = padForNote(d1); if (p) { release(p); return true; } return false; }
    if (!noteOn) return false;
    const pad = padForNote(d1);
    if (!pad) return false;
    trigger(pad, d2 / 127);
    return true;                                  // consumed → don't let mixer/bindings also react
  };

  // ── UI ─────────────────────────────────────────────────────────────────────
  function injectCss() {
    if (document.getElementById('arcane-sampler-css')) return;
    const css = `
    #sampler-panel{position:fixed;right:18px;bottom:88px;width:760px;max-width:95vw;max-height:82vh;
      background:#121216;border:1px solid #2b2b32;border-radius:12px;box-shadow:0 18px 50px rgba(0,0,0,.6);
      display:none;flex-direction:column;z-index:9000;color:#e8e8ee;font:13px system-ui;overflow:hidden}
    #sampler-panel.on{display:flex}
    .sb-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 12px;border-bottom:1px solid #24242a;background:#16161b}
    .sb-head h3{margin:0;font-size:14px;font-weight:700}
    .sb-seg{display:inline-flex;border:1px solid #34343c;border-radius:7px;overflow:hidden;margin-right:auto}
    .sb-seg-btn{background:transparent;border:none;color:#b9b9c4;font-size:12px;font-weight:700;padding:4px 10px;cursor:pointer}
    .sb-seg-btn.on{background:rgba(54,201,138,0.22);color:#9fe9b4}
    .sb-head .sb-x{cursor:pointer;color:#9a9aa2;font-size:18px;line-height:1;background:none;border:none;margin-left:auto}
    .sb-btn{background:#1f8fff;color:#04121f;border:none;border-radius:7px;padding:7px 11px;font-weight:700;cursor:pointer}
    .sb-btn.alt{background:#23232a;color:#cfcfe0;border:1px solid #34343c}
    .sb-btn.alt.on{background:rgba(54,201,138,0.25);color:#9fe9b4;border-color:rgba(54,201,138,0.5)}
    .sb-btn.recording{background:#c0392b;color:#fff;border-color:#e74c3c;animation:sbpulse 1s infinite}
    @keyframes sbpulse{50%{opacity:.55}}
    .sb-vol{display:flex;align-items:center;gap:6px;font-size:11px;color:#9a9aa2}
    .sb-vol input[type=range]{width:74px}
    .sb-scenes{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:8px 12px 0}
    .sb-scenes-lbl{font-size:11px;color:#8a8a93;font-weight:700;margin-right:2px}
    .sb-scene{display:inline-flex;align-items:center;background:rgba(207,92,255,0.16);border:1px solid rgba(207,92,255,0.4);border-radius:7px;overflow:hidden}
    .sb-scene-load{background:none;border:none;color:#e3c6ff;font-size:11px;font-weight:700;padding:5px 9px;cursor:pointer}
    .sb-scene-x{background:none;border:none;color:#a98ac0;font-size:10px;padding:5px 6px 5px 0;cursor:pointer}
    .sb-scene-x:hover{color:#ff8a8a}
    .sb-scene-add{background:#23232a;border:1px dashed #4a4a55;color:#cfcfe0;font-size:11px;font-weight:700;border-radius:7px;padding:5px 10px;cursor:pointer}
    .sb-banks{display:flex;gap:6px;padding:8px 12px 0}
    .sb-bank{flex:1;background:#1a1a20;border:1px solid #2c2c34;color:#9a9aa2;border-radius:7px 7px 0 0;font-size:11px;font-weight:700;padding:6px 0;cursor:pointer}
    .sb-bank.on{background:#23232a;color:#fff;border-color:#3a3a44;border-bottom-color:transparent}
    .sb-body{padding:12px;overflow:auto;flex:1 1 auto;min-height:80px}
    .sb-resize{position:absolute;right:2px;bottom:2px;width:16px;height:16px;cursor:nwse-resize;z-index:6;
      background:linear-gradient(135deg,transparent 50%,#5a5a66 50%,#5a5a66 62%,transparent 62%,transparent 74%,#5a5a66 74%,#5a5a66 86%,transparent 86%)}
    .sb-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:9px}
    .sb-pad{background:#1a1a20;border:1px solid #2c2c34;border-left:4px solid #888;border-radius:9px;padding:9px;position:relative;cursor:pointer;transition:transform .05s,box-shadow .1s}
    .sb-pad:hover{border-color:#4a4a55}
    .sb-pad.hit{transform:scale(0.97)}
    .sb-pad.learn{outline:2px dashed #ffcf3a;outline-offset:1px}
    .sb-pad .sb-name{font-weight:700;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding-right:16px}
    .sb-pad .sb-note{font-size:11px;color:#9fd0ff;margin-top:4px;font-variant-numeric:tabular-nums}
    .sb-pad .sb-row{display:flex;gap:6px;margin-top:8px}
    .sb-pad .sb-mini{flex:1;background:#23232a;border:1px solid #34343c;color:#cfcfe0;border-radius:5px;
      font-size:10px;font-weight:700;padding:4px 0;cursor:pointer}
    .sb-pad .sb-mini.learning{background:#ffcf3a;color:#1a1a06;border-color:#e6c233}
    .sb-pad.playing{box-shadow:0 0 0 1px var(--pc,#36c98a),0 0 12px rgba(54,201,138,.4)}
    .sb-pad .sb-del{position:absolute;top:6px;right:7px;color:#7a7a82;background:none;border:none;cursor:pointer;font-size:14px;line-height:1}
    .sb-pad .sb-del:hover{color:#ff6a6a}
    .sb-modes{display:flex;gap:4px;margin-top:8px;align-items:center}
    .sb-mode{flex:0 0 auto;width:24px;background:#23232a;border:1px solid #34343c;color:#9a9aa2;border-radius:5px;font-size:11px;font-weight:700;padding:3px 0;cursor:pointer}
    .sb-mode.on{background:#1f8fff;color:#04121f;border-color:#5fb0ff}
    .sb-choke{margin-left:auto;background:#23232a;border:1px solid #34343c;color:#cfcfe0;border-radius:5px;font-size:10px;font-weight:700;padding:2px 3px;cursor:pointer}
    .sb-pvol{width:100%;accent-color:#36c98a}
    .sb-empty{color:#80808a;text-align:center;padding:26px 10px;font-size:12px;line-height:1.6}
    .sb-online{display:none;flex-direction:column;border-bottom:1px solid #24242a;background:#0f0f13}
    .sb-online.on{display:flex}
    .sb-searchrow{display:flex;gap:8px;padding:10px 12px}
    .sb-searchrow input{flex:1;background:#1a1a20;border:1px solid #34343c;color:#e8e8ee;border-radius:7px;padding:7px 10px;font-size:12px;outline:none}
    .sb-results{max-height:200px;overflow:auto;padding:0 12px 10px}
    .sb-rrow{display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid #1d1d22}
    .sb-rname{flex:1;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .sb-rrow .sb-mini{flex:0 0 auto;min-width:40px;background:#23232a;border:1px solid #34343c;color:#cfcfe0;border-radius:5px;font-size:11px;font-weight:700;padding:4px 8px;cursor:pointer}
    .sb-more{display:block;width:100%;margin:8px 0 2px}
    .sb-pianowrap{border-top:1px solid #24242a;background:#0f0f13;padding:8px 12px 12px}
    .sb-pianohead{display:flex;align-items:center;gap:10px;font-size:11px;color:#8a8a93;margin-bottom:8px}
    .sb-pianohead>span:first-child{flex:1;line-height:1.4}
    .sb-oct{display:flex;align-items:center;gap:6px;color:#cfcfe0}
    .sb-oct .sb-mini{background:#23232a;border:1px solid #34343c;color:#cfcfe0;border-radius:5px;font-size:11px;font-weight:700;padding:4px 7px;cursor:pointer}
    .sb-piano{position:relative;height:96px;overflow-x:auto;overflow-y:hidden;white-space:nowrap}
    .sb-pwhites{position:relative;display:inline-flex;height:96px}
    .sb-wkey{position:relative;width:26px;height:96px;box-sizing:border-box;background:linear-gradient(#fafafa,#e4e4e8);
      border:1px solid #2a2a30;border-radius:0 0 4px 4px;cursor:pointer;display:flex;flex-direction:column;
      justify-content:flex-end;align-items:center;padding-bottom:3px}
    .sb-wkey:active,.sb-wkey.hit{background:linear-gradient(#cfe8ff,#a9d2ff)}
    .sb-wkey.mapped{background:linear-gradient(color-mix(in srgb,var(--kc) 25%,#fafafa),color-mix(in srgb,var(--kc) 55%,#e4e4e8))}
    .sb-koct{font-size:8px;color:#8a8a90;font-weight:700}
    .sb-klabel{font-size:8px;color:#101014;font-weight:700;max-width:24px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:1.1}
    .sb-pblacks{position:absolute;top:0;left:0;height:0}
    .sb-bkey{position:absolute;top:0;width:17px;height:60px;background:linear-gradient(#2a2a30,#0c0c0e);
      border:1px solid #000;border-radius:0 0 3px 3px;cursor:pointer;z-index:2}
    .sb-bkey:active,.sb-bkey.hit{background:linear-gradient(#3f6f9f,#22405f)}
    .sb-bkey.mapped{background:linear-gradient(#6a4a1a,#3a2a0a);border-color:#5a3a10}
    .sb-wkey.playing{background:linear-gradient(#aef0c8,#5fd699)!important}
    .sb-bkey.playing{background:linear-gradient(#2f8f5f,#155a35)!important}`;
    const st = document.createElement('style'); st.id = 'arcane-sampler-css'; st.textContent = css;
    document.head.appendChild(st);
  }

  let els = {};
  function buildPanel() {
    injectCss();
    const p = document.createElement('div'); p.id = 'sampler-panel';
    p.innerHTML = `
      <div class="sb-head">
        <h3>🎵 Audio</h3>
        <span class="sb-seg"><button class="sb-seg-btn" data-seg="music">🎵 Music</button><button class="sb-seg-btn on" data-seg="sounds">🔊 Sounds</button></span>
        <div class="sb-vol">VOL <input type="range" id="sb-vol" min="0" max="100" value="${Math.round(S.master * 100)}"></div>
        <div class="sb-vol" title="How much music dips while a sound plays">DUCK <input type="range" id="sb-duckdepth" min="0" max="95" value="78"></div>
        <button class="sb-btn alt on" id="sb-duck" title="Duck music while a sound plays">🎚</button>
        <button class="sb-btn alt" id="sb-rec" title="Record the full mix (music + decks + sounds)">⏺ Rec</button>
        <button class="sb-btn alt" id="sb-stopall" title="Stop all playing sounds">⏹ Stop</button>
        <button class="sb-btn alt" id="sb-browse">🌐 Browse</button>
        <label class="sb-btn" id="sb-add" style="position:relative;overflow:hidden;display:inline-block">+ Add Sounds<input type="file" id="sb-file" accept="audio/*" multiple style="position:absolute;inset:0;opacity:0;cursor:pointer"></label>
        <button class="sb-x" id="sb-close" title="Close">✕</button>
      </div>
      <div class="sb-online" id="sb-online">
        <div class="sb-searchrow">
          <input type="text" id="sb-q" placeholder="Search myinstants.com sound effects… (blank = trending)">
          <button class="sb-btn" id="sb-go">Search</button>
        </div>
        <div class="sb-results" id="sb-results"></div>
      </div>
      <div class="sb-scenes" id="sb-scenes"></div>
      <div class="sb-banks" id="sb-banks"></div>
      <div class="sb-body"><div class="sb-grid" id="sb-grid"></div></div>
      <div class="sb-pianowrap">
        <div class="sb-pianohead">
          <span>🎹 Click a key to play · with a pad's <b>Learn</b> active, click a key to map it · or use your computer keyboard (A–K)</span>
          <span class="sb-oct"><button class="sb-mini" id="sb-octdn">◀ oct</button><span id="sb-octlbl"></span><button class="sb-mini" id="sb-octup">oct ▶</button></span>
        </div>
        <div class="sb-piano" id="sb-piano"></div>
      </div>`;
    document.body.appendChild(p);
    els.panel = p; els.grid = p.querySelector('#sb-grid'); els.file = p.querySelector('#sb-file');
    els.online = p.querySelector('#sb-online'); els.results = p.querySelector('#sb-results'); els.q = p.querySelector('#sb-q'); els.banks = p.querySelector('#sb-banks'); els.scenes = p.querySelector('#sb-scenes');
    const grip = document.createElement('div'); grip.className = 'sb-resize'; grip.title = 'Drag to resize'; p.appendChild(grip);
    makeDraggable(p, p.querySelector('.sb-head'));
    makeResizable(p, grip);
    p.querySelector('#sb-close').addEventListener('click', toggle);
    p.querySelector('.sb-seg').addEventListener('click', (e) => {
      const b = e.target.closest('.sb-seg-btn'); if (!b) return;
      if (b.dataset.seg === 'music') { hide(); if (window.ArcaneMusicPanel && window.ArcaneMusicPanel.show) window.ArcaneMusicPanel.show(); }
    });
    els.file.addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
    p.querySelector('#sb-vol').addEventListener('input', (e) => { S.master = e.target.value / 100; if (masterGain()) masterGain().gain.value = S.master; });
    p.querySelector('#sb-duck').addEventListener('click', (e) => { const on = !e.currentTarget.classList.contains('on'); e.currentTarget.classList.toggle('on', on); S.duckOn = on; if (window.ArcaneMusicAPI && window.ArcaneMusicAPI.setDuckEnabled) window.ArcaneMusicAPI.setDuckEnabled(on); });
    p.querySelector('#sb-duckdepth').addEventListener('input', (e) => { S.duckDepth = e.target.value / 100; if (window.ArcaneMusicAPI && window.ArcaneMusicAPI.setDuckDepth) window.ArcaneMusicAPI.setDuckDepth(S.duckDepth); });
    p.querySelector('#sb-stopall').addEventListener('click', stopAll);
    p.querySelector('#sb-rec').addEventListener('click', toggleRec);
    p.querySelector('#sb-browse').addEventListener('click', () => { const on = els.online.classList.toggle('on'); if (on && !els.results.dataset.loaded) runSearch(''); });
    p.querySelector('#sb-go').addEventListener('click', () => runSearch(els.q.value));
    els.q.addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(els.q.value); e.stopPropagation(); });
    els.piano = p.querySelector('#sb-piano'); els.octlbl = p.querySelector('#sb-octlbl');
    p.querySelector('#sb-octdn').addEventListener('click', () => { S.octaveBase = Math.max(12, S.octaveBase - 12); renderPiano(); });
    p.querySelector('#sb-octup').addEventListener('click', () => { S.octaveBase = Math.min(108, S.octaveBase + 12); renderPiano(); });
    els.piano.addEventListener('pointerdown', (e) => { const k = e.target.closest('[data-note]'); if (!k) return; e.preventDefault(); const note = +k.dataset.note; S._pianoNote = note; pianoHit(note); });
    renderPads(); renderPiano(); renderScenes();
  }

  function renderBankTabs() {
    if (!els.banks) return;
    els.banks.innerHTML = '';
    for (let b = 1; b <= NBANKS; b++) {
      const n = S.pads.filter((p) => (p.bank || 1) === b).length;
      const tab = document.createElement('button');
      tab.className = 'sb-bank' + (b === S.bank ? ' on' : '');
      tab.textContent = 'Bank ' + b + (n ? ' (' + n + ')' : '');
      tab.addEventListener('click', () => { S.bank = b; renderBankTabs(); renderPads(); });
      els.banks.appendChild(tab);
    }
  }
  function renderPads() {
    if (!els.grid) return;
    renderBankTabs();
    const pads = curPads();
    if (!pads.length) { els.grid.innerHTML = `<div class="sb-empty">Bank ${S.bank} is empty.<br>Click <b>+ Add Sounds</b> (or <b>🌐 Browse Online</b>), then <b>Learn</b> a pad onto a key.</div>`; renderPiano(); return; }
    els.grid.innerHTML = '';
    pads.forEach((pad) => {
      const el = document.createElement('div'); el.className = 'sb-pad'; el.style.borderLeftColor = pad.color; el.style.setProperty('--pc', pad.color);
      const choke = pad.chokeGroup || 0;
      el.innerHTML = `
        <button class="sb-del" title="Remove">✕</button>
        <div class="sb-name" title="${pad.name.replace(/"/g, '&quot;')}">${pad.name.replace(/</g, '&lt;')}</div>
        <div class="sb-note">🎹 ${noteName(pad.note)} · note ${pad.note}</div>
        <div class="sb-modes">
          <button class="sb-mode${pad.mode === 'oneshot' ? ' on' : ''}" data-mode="oneshot" title="One-shot (play once)">1×</button>
          <button class="sb-mode${pad.mode === 'loop' ? ' on' : ''}" data-mode="loop" title="Loop (press to toggle)">∞</button>
          <button class="sb-mode${pad.mode === 'hold' ? ' on' : ''}" data-mode="hold" title="Hold (plays while key held)">⊓</button>
          <select class="sb-choke" title="Choke group — pads in the same group stop each other">
            <option value="0"${choke === 0 ? ' selected' : ''}>—</option>
            ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((g) => `<option value="${g}"${choke === g ? ' selected' : ''}>G${g}</option>`).join('')}
          </select>
        </div>
        <div class="sb-row">
          <input type="range" class="sb-pvol" min="0" max="100" value="${Math.round((pad.volume == null ? 1 : pad.volume) * 100)}" title="Pad volume">
        </div>
        <div class="sb-row">
          <button class="sb-mini sb-learn">Learn</button>
          <button class="sb-mini sb-play">▶ Test</button>
        </div>`;
      pad.el = el;
      el.querySelector('.sb-del').addEventListener('click', (e) => { e.stopPropagation(); stopVoices(pad, 0); removePad(pad); });
      el.querySelector('.sb-play').addEventListener('click', (e) => { e.stopPropagation(); trigger(pad, 1); });
      el.querySelectorAll('.sb-mode').forEach((b) => b.addEventListener('click', (e) => {
        e.stopPropagation(); stopVoices(pad, 0); pad.mode = b.dataset.mode; dbSave(pad); renderPads();
      }));
      el.querySelector('.sb-choke').addEventListener('click', (e) => e.stopPropagation());
      el.querySelector('.sb-choke').addEventListener('change', (e) => { pad.chokeGroup = +e.target.value; dbSave(pad); });
      el.querySelector('.sb-pvol').addEventListener('click', (e) => e.stopPropagation());
      el.querySelector('.sb-pvol').addEventListener('input', (e) => {
        pad.volume = e.target.value / 100;
        (pad._voices || []).forEach((v) => { try { v.gain.gain.value = pad.volume; } catch (er) {} });   // live
      });
      el.querySelector('.sb-pvol').addEventListener('change', () => dbSave(pad));
      el.querySelector('.sb-learn').addEventListener('click', (e) => {
        e.stopPropagation();
        S.learning = (S.learning === pad) ? null : pad;
        renderPads();
      });
      el.addEventListener('click', () => trigger(pad, 1));
      if (S.learning === pad) { el.classList.add('learn'); const lb = el.querySelector('.sb-learn'); lb.classList.add('learning'); lb.textContent = 'Press a key…'; }
      if (padActive(pad)) el.classList.add('playing');
      els.grid.appendChild(el);
    });
    renderPiano();
  }

  function resultRow(it) {
    const row = document.createElement('div'); row.className = 'sb-rrow';
    row.innerHTML = `<span class="sb-rname" title="${it.name.replace(/"/g, '&quot;')}">${it.name.replace(/</g, '&lt;')}</span>
      <button class="sb-mini sb-prev">▶</button><button class="sb-mini sb-imp">+ Add</button>`;
    row.querySelector('.sb-prev').addEventListener('click', () => previewOnline(it.url));
    const imp = row.querySelector('.sb-imp');
    imp.addEventListener('click', async () => { imp.textContent = '…'; imp.disabled = true; try { await importOnline(it); imp.textContent = '✓'; } catch (e) { imp.textContent = 'err'; imp.disabled = false; } });
    return row;
  }
  async function runSearch(q, page, append) {
    if (!els.results) return;
    page = page || 1;
    S._q = q; S._page = page;
    if (!append) { els.results.innerHTML = '<div class="sb-empty">Loading…</div>'; els.results.dataset.loaded = '1'; }
    try {
      const data = await onlineSearch(q, page);
      const items = data.results || [];
      if (!append) els.results.innerHTML = '';
      const oldMore = els.results.querySelector('.sb-more'); if (oldMore) oldMore.remove();
      if (!items.length && !append) { els.results.innerHTML = '<div class="sb-empty">No results.</div>'; return; }
      items.forEach((it) => els.results.appendChild(resultRow(it)));
      if (data.more) {
        const more = document.createElement('button'); more.className = 'sb-btn alt sb-more'; more.textContent = '↓ Load more';
        more.addEventListener('click', () => { more.remove(); runSearch(S._q, S._page + 1, true); });
        els.results.appendChild(more);
      }
    } catch (e) {
      if (!append) els.results.innerHTML = '<div class="sb-empty">Couldn\'t reach myinstants.com.<br>Check your connection and try again.</div>';
    }
  }
  let _prevAudio = null;
  function previewOnline(url) {
    try { if (_prevAudio) _prevAudio.pause(); } catch (e) {}
    _prevAudio = new Audio(SRV + 'fetch?url=' + encodeURIComponent(url));
    _prevAudio.play().catch(() => {});
  }

  function flashPad(pad) {
    if (!pad.el) return;
    pad.el.classList.add('hit');
    setTimeout(() => { if (pad.el) pad.el.classList.remove('hit'); }, 110);
    flashKey(pad.note);
  }

  // ── On-screen piano (substitute for a hardware MIDI keyboard) ──────────────
  const WHITE_OFFS = [0, 2, 4, 5, 7, 9, 11];
  const BLACK = { 1: 1, 3: 2, 6: 4, 8: 5, 10: 6 };   // semitone → #white-keys before it in its octave
  const WW = 26;                                       // white-key width (px)
  function renderPiano() {
    if (!els.piano) return;
    const base = S.octaveBase, octs = 2;
    if (els.octlbl) els.octlbl.textContent = noteName(base);
    const padByNote = {}; curPads().forEach((p) => { padByNote[p.note] = p; });
    let whites = '';
    for (let o = 0; o < octs; o++) for (const wo of WHITE_OFFS) whites += wkey(base + o * 12 + wo, padByNote);
    whites += wkey(base + octs * 12, padByNote);       // closing C
    let blacks = '';
    for (let o = 0; o < octs; o++) for (const bo of Object.keys(BLACK)) {
      const n = base + o * 12 + Number(bo);
      const left = (o * 7 + BLACK[bo]) * WW - WW * 0.32;
      const p = padByNote[n];
      blacks += `<div class="sb-bkey${p ? ' mapped' : ''}" data-note="${n}" style="left:${left}px"${p ? ` title="${p.name.replace(/"/g, '&quot;')}"` : ''}></div>`;
    }
    els.piano.innerHTML = `<div class="sb-pwhites">${whites}</div><div class="sb-pblacks">${blacks}</div>`;
  }
  function wkey(n, padByNote) {
    const p = padByNote[n];
    const label = (n % 12 === 0) ? noteName(n) : '';
    const nm = p ? `<span class="sb-klabel">${p.name.replace(/</g, '&lt;')}</span>` : '';
    return `<div class="sb-wkey${p ? ' mapped' : ''}" data-note="${n}"${p ? ` style="--kc:${p.color}" title="${p.name.replace(/"/g, '&quot;')}"` : ''}><span class="sb-koct">${label}</span>${nm}</div>`;
  }
  function flashKey(note) {
    if (!els.piano) return;
    const k = els.piano.querySelector('[data-note="' + note + '"]');
    if (!k) return; k.classList.add('hit'); setTimeout(() => k.classList.remove('hit'), 120);
  }
  function pianoHit(note) {
    if (S.learning) { assignLearn(note); return; }
    const c = ctx(); if (c && c.state === 'suspended') c.resume();
    const pad = padForNote(note);
    if (pad) trigger(pad, 1); else flashKey(note);
  }

  // Computer-keyboard → notes (GarageBand-style musical typing), so you can play
  // and map even with no piano at all.  Active only while the panel is open.
  const KEYMAP = { a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11, k: 12, o: 13, l: 14, p: 15, ';': 16 };
  function onKeyDown(e) {
    if (!S.open) return;
    const t = e.target; if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    const off = KEYMAP[e.key.toLowerCase()];
    if (off == null) return;
    e.preventDefault();
    pianoHit(S.octaveBase + off);
  }
  function onKeyUp(e) {
    if (!S.open) return;
    const off = KEYMAP[e.key.toLowerCase()]; if (off == null) return;
    const p = padForNote(S.octaveBase + off); if (p) release(p);
  }
  function onPointerUp() {
    if (S._pianoNote == null) return;
    const p = padForNote(S._pianoNote); if (p) release(p);
    S._pianoNote = null;
  }

  function makeDraggable(panel, handle) {
    let sx, sy, ox, oy, drag = false;
    handle.style.cursor = 'move';
    handle.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button,input,select,.sb-seg')) return;   // don't drag from a control
      const r = panel.getBoundingClientRect();
      panel.style.left = r.left + 'px'; panel.style.top = r.top + 'px';
      panel.style.right = 'auto'; panel.style.bottom = 'auto';
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top; drag = true;
      handle.setPointerCapture(e.pointerId); e.preventDefault();
    });
    handle.addEventListener('pointermove', (e) => {
      if (!drag) return;
      let nx = ox + (e.clientX - sx), ny = oy + (e.clientY - sy);
      nx = Math.max(0, Math.min(window.innerWidth - 80, nx));
      ny = Math.max(0, Math.min(window.innerHeight - 40, ny));
      panel.style.left = nx + 'px'; panel.style.top = ny + 'px';
    });
    const end = () => { drag = false; };
    handle.addEventListener('pointerup', end); handle.addEventListener('pointercancel', end);
  }

  function makeResizable(panel, grip) {
    grip.addEventListener('pointerdown', (e) => {
      const r = panel.getBoundingClientRect();
      panel.style.left = r.left + 'px'; panel.style.top = r.top + 'px';
      panel.style.right = 'auto'; panel.style.bottom = 'auto';
      panel.style.maxWidth = 'none'; panel.style.maxHeight = 'none';
      const sx = e.clientX, sy = e.clientY, ow = r.width, oh = r.height; let res = true;
      grip.setPointerCapture(e.pointerId); e.preventDefault();
      const mv = (ev) => {
        if (!res) return;
        const w = Math.max(360, Math.min(window.innerWidth - r.left - 6, ow + (ev.clientX - sx)));
        const h = Math.max(260, Math.min(window.innerHeight - r.top - 6, oh + (ev.clientY - sy)));
        panel.style.width = w + 'px'; panel.style.height = h + 'px';
      };
      const up = () => { res = false; grip.removeEventListener('pointermove', mv); grip.removeEventListener('pointerup', up); };
      grip.addEventListener('pointermove', mv); grip.addEventListener('pointerup', up);
    });
  }

  function show() {
    if (!els.panel) buildPanel();
    S.open = true; els.panel.classList.add('on');
    const c = ctx(); if (c && c.state === 'suspended') c.resume();
  }
  function hide() { if (els.panel) { S.open = false; els.panel.classList.remove('on'); } }
  function toggle() { S.open ? hide() : show(); }
  S.show = show; S.hide = hide; S.toggle = toggle;

  function init() {
    const btn = document.getElementById('sampler-launch');
    if (btn) btn.addEventListener('click', toggle);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    document.addEventListener('pointerup', onPointerUp);
    // restore saved pads
    dbLoadAll(async (rows) => {
      for (const r of rows) {
        try { const buffer = await decode(r.data); if (buffer) addPad(r.name, buffer, r.data, r.note, r.color, r.id, { mode: r.mode, volume: r.volume, chokeGroup: r.chokeGroup, bank: r.bank }); } catch (e) {}
      }
      renderPads();
    });
    dbLoadScenes((rows) => { S.scenes = rows || []; rows.forEach((r) => { if (r.id >= S.sceneSeq) S.sceneSeq = r.id + 1; }); renderScenes(); });
  }

  function stopAll() { S.pads.forEach((p) => stopVoices(p, 0.05)); }

  // ── Backup export / import (used by backup.js) ──────────────────────────────
  function _ab2b64(ab) {
    let bin = ''; const bytes = new Uint8Array(ab), chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    return btoa(bin);
  }
  function _b642ab(b64) {
    const bin = atob(b64), len = bin.length, bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }
  S.exportData = () => ({
    pads: S.pads.map((p) => ({ id: p.id, name: p.name, note: p.note, color: p.color, mode: p.mode, volume: p.volume, chokeGroup: p.chokeGroup, bank: p.bank, data: p.data ? _ab2b64(p.data) : null })),
    scenes: S.scenes.map((s) => ({ ...s })),
  });
  S.importData = async (d) => {
    if (!d) return;
    await new Promise((res) => db((dd) => { if (!dd) return res(); try { const tx = dd.transaction(['pads', 'scenes'], 'readwrite'); tx.objectStore('pads').clear(); tx.objectStore('scenes').clear(); tx.oncomplete = res; tx.onerror = res; } catch (e) { res(); } }));
    stopAll(); S.pads = []; S.scenes = []; S.sceneSeq = 1; S.nextId = 1;
    for (const r of (d.pads || [])) {
      if (!r.data) continue;
      try { const ab = _b642ab(r.data); const buffer = await decode(ab); if (buffer) { const pad = addPad(r.name, buffer, ab, r.note, r.color, r.id, { mode: r.mode, volume: r.volume, chokeGroup: r.chokeGroup, bank: r.bank }); dbSave(pad); } } catch (e) {}
    }
    (d.scenes || []).forEach((s) => { S.scenes.push(s); if (s.id >= S.sceneSeq) S.sceneSeq = s.id + 1; dbSaveScene(s); });
    if (els.grid) { renderPads(); renderScenes(); }
  };

  // ── Soundscape presets (Scenes) ────────────────────────────────────────────
  function saveScene() {
    const name = (window.prompt('Name this soundscape (e.g. Tavern, Combat, Dungeon):', 'Scene ' + (S.scenes.length + 1)) || '').trim();
    if (!name) return;
    const sc = {
      id: S.sceneSeq++, name, bank: S.bank, master: S.master,
      duckOn: S.duckOn, duckDepth: S.duckDepth,
      autostart: S.pads.filter((p) => padActive(p)).map((p) => p.id),   // whatever's currently looping/held
    };
    S.scenes.push(sc); dbSaveScene(sc); renderScenes();
    recToast('Saved soundscape “' + name + '”');
  }
  function loadScene(sc) {
    stopAll();
    S.bank = sc.bank || 1;
    S.master = (sc.master == null ? 0.9 : sc.master);
    if (masterGain()) masterGain().gain.value = S.master;
    const vol = els.panel.querySelector('#sb-vol'); if (vol) vol.value = Math.round(S.master * 100);
    S.duckOn = sc.duckOn !== false; S.duckDepth = (sc.duckDepth == null ? 0.78 : sc.duckDepth);
    const db_ = els.panel.querySelector('#sb-duck'); if (db_) db_.classList.toggle('on', S.duckOn);
    const dd = els.panel.querySelector('#sb-duckdepth'); if (dd) dd.value = Math.round(S.duckDepth * 100);
    if (window.ArcaneMusicAPI) { window.ArcaneMusicAPI.setDuckEnabled && window.ArcaneMusicAPI.setDuckEnabled(S.duckOn); window.ArcaneMusicAPI.setDuckDepth && window.ArcaneMusicAPI.setDuckDepth(S.duckDepth); }
    renderBankTabs(); renderPads();
    (sc.autostart || []).forEach((id) => { const pad = S.pads.find((p) => p.id === id); if (pad) startVoice(pad, 1, true, 0.4); });   // restart ambience beds (looped)
    renderScenes();
  }
  function removeScene(sc) { const i = S.scenes.indexOf(sc); if (i >= 0) S.scenes.splice(i, 1); dbDeleteScene(sc.id); renderScenes(); }
  function renderScenes() {
    if (!els.scenes) return;
    els.scenes.innerHTML = '<span class="sb-scenes-lbl">Soundscapes:</span>';
    S.scenes.forEach((sc) => {
      const chip = document.createElement('span'); chip.className = 'sb-scene';
      chip.innerHTML = `<button class="sb-scene-load">${(sc.name || 'Scene').replace(/</g, '&lt;')}</button><button class="sb-scene-x" title="Delete">✕</button>`;
      chip.querySelector('.sb-scene-load').addEventListener('click', () => loadScene(sc));
      chip.querySelector('.sb-scene-x').addEventListener('click', () => removeScene(sc));
      els.scenes.appendChild(chip);
    });
    const add = document.createElement('button'); add.className = 'sb-scene-add'; add.textContent = '＋ Save current';
    add.addEventListener('click', saveScene); els.scenes.appendChild(add);
  }
  function recToast(msg) {
    let t = document.getElementById('sb-toast');
    if (!t) { t = document.createElement('div'); t.id = 'sb-toast'; t.style.cssText = 'position:fixed;left:50%;bottom:30px;transform:translateX(-50%);background:#1b1b22;color:#e8e8ee;border:1px solid #3a3a44;border-radius:8px;padding:9px 16px;font:13px system-ui;z-index:10001;box-shadow:0 8px 24px rgba(0,0,0,.6);max-width:80vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'; document.body.appendChild(t); }
    t.textContent = msg; t.style.opacity = '1';
    clearTimeout(t._to); t._to = setTimeout(() => { t.style.transition = 'opacity .5s'; t.style.opacity = '0'; }, 3500);
  }
  let _recording = false;
  async function toggleRec() {
    const btn = els.panel && els.panel.querySelector('#sb-rec');
    const api = window.ArcaneMusicAPI;
    if (!api || !api.startRec) return;
    if (!_recording) {
      if (api.startRec()) { _recording = true; if (btn) { btn.classList.add('recording'); btn.textContent = '⏹ Stop Rec'; } }
    } else {
      _recording = false; if (btn) { btn.classList.remove('recording'); btn.textContent = '⏺ Rec'; }
      const blob = await api.stopRec();
      if (!blob) { if (btn) btn.textContent = '⏺ Rec'; return; }
      const fname = 'arcane-mix-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.wav';
      try {                                        // save reliably via the local server → ~/Downloads
        const r = await fetch('http://localhost:8765/api/save_recording?name=' + encodeURIComponent(fname), { method: 'POST', body: blob, headers: { 'Content-Type': 'audio/wav' } });
        const j = await r.json();
        if (j && j.ok) recToast('Saved to ' + j.path);
        else throw new Error();
      } catch (e) {                                // fallback: browser download
        const url = URL.createObjectURL(blob); const a = document.createElement('a');
        a.href = url; a.download = fname; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
      }
    }
  }
  S.connectRec = (dest) => { try { masterGain().connect(dest); } catch (e) {} };       // include soundboard in mix recording
  S.disconnectRec = (dest) => { try { masterGain().disconnect(dest); } catch (e) {} };
  // ── Scene→audio wiring: list / play / stop soundscapes by id (or name) ──
  S.listSoundscapes = () => S.scenes.map((s) => ({ id: s.id, name: s.name }));
  S.playSoundscapeById = (id) => { const sc = S.scenes.find((s) => s.id === id); if (!sc) return false; loadScene(sc); return true; };
  S.stopAllSounds = () => { try { stopAll(); } catch (e) {} };
  window.ArcaneSampler = S;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
