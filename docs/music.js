/* ArcaneOverlay — Music: local-library harmonic playlists & seamless playback.
 *
 * Backend (server.py + music.py) scans files, serves audio with Range support,
 * and stores a JSON cache.  Everything below runs in the WebView:
 *   • decode each track via Web Audio (decodeAudioData),
 *   • estimate BPM (onset envelope + autocorrelation) and musical key
 *     (chroma + Krumhansl-Schmugler) → Camelot code,
 *   • build mood playlists, auto-order by Camelot harmonic compatibility,
 *   • play with equal-power crossfades (+ optional tempo match) for seamless
 *     song-to-song transitions.
 */
(function () {
'use strict';

const API = 'http://localhost:8765/api';
const FILE_URL = id => `${API}/music/file?id=${encodeURIComponent(id)}`;

// ── State ────────────────────────────────────────────────────────────────────
const M = {
  folder: '',
  tracks: [],            // [{id,title,artist,album,ext,size}]
  analysis: {},          // id -> {bpm,key,mode,camelot,duration,energy}
  playlists: [],         // [{id,name,mood,trackIds:[],crossfade,tempoMatch}]
  byId: {},
  activePlaylist: null,  // id of the playlist being VIEWED (null = full library)
  targetPlaylist: null,  // id the library "+" buttons add to
  analyzing: false,
};

// ── Tiny API client ───────────────────────────────────────────────────────────
async function getJSON(path) {
  const r = await fetch(`${API}/${path}`);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}
async function postJSON(path, body) {
  const r = await fetch(`${API}/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

// Lightweight diagnostic log mirrored to the server so playback behaviour can
// be inspected without driving the UI (GET /api/music/diag).
const _LOG = [];
function dbg(msg) {
  const line = ((Date.now() % 100000) / 1000).toFixed(2) + 's  ' + msg;
  _LOG.push(line); if (_LOG.length > 60) _LOG.shift();
  try { postJSON('music/diag', { log: _LOG.slice(-60) }); } catch (e) {}
}

// Equal-power crossfade curves: sin/cos so the two tracks sum to constant
// perceived loudness (both ~0.71 at the midpoint) — you hear them OVERLAID,
// instead of the dip/sequential feel that exponential ramps produce.
const _FADE_N = 128;
function fadeCurve(dir) {
  const a = new Float32Array(_FADE_N);
  for (let i = 0; i < _FADE_N; i++) {
    const x = i / (_FADE_N - 1);
    a[i] = dir === 'in' ? Math.sin(x * Math.PI / 2) : Math.cos(x * Math.PI / 2);
  }
  return a;
}

// ── Camelot wheel ───────────────────────────────────────────────────────────
const PITCHES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
// Camelot code per pitch class (index 0=C .. 11=B).
const CAMELOT_MAJOR = ['8B','3B','10B','5B','12B','7B','2B','9B','4B','11B','6B','1B'];
const CAMELOT_MINOR = ['5A','12A','7A','2A','9A','4A','11A','6A','1A','8A','3A','10A'];

function keyToCamelot(pc, mode) {
  return mode === 'minor' ? CAMELOT_MINOR[pc] : CAMELOT_MAJOR[pc];
}
function parseCamelot(code) {
  if (!code) return null;
  const m = /^(\d{1,2})([AB])$/.exec(code);
  if (!m) return null;
  return { n: parseInt(m[1], 10), letter: m[2] };
}
// Harmonic "distance" between two Camelot codes (0 = identical, small = mixable).
function camelotDistance(a, b) {
  const A = parseCamelot(a), B = parseCamelot(b);
  if (!A || !B) return 99;
  let dn = Math.abs(A.n - B.n);
  dn = Math.min(dn, 12 - dn);                 // wrap around the wheel
  if (A.letter === B.letter) return dn;        // same scale: adjacency = best
  if (dn === 0) return 1;                       // relative major/minor (great)
  return dn + 1;                                // key + mode change: costlier
}
function camelotColor(code) {
  const c = parseCamelot(code);
  if (!c) return '#777';
  const hue = ((c.n - 1) / 12) * 360;
  return `hsl(${hue} 65% ${c.letter === 'A' ? 42 : 58}%)`;
}

// ── FFT (iterative radix-2 Cooley–Tukey) ─────────────────────────────────────
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = i + k + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

// ── Analysis ──────────────────────────────────────────────────────────────────
let _decodeCtx = null;
function decodeCtx() {
  if (!_decodeCtx) _decodeCtx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 1, 44100);
  return _decodeCtx;
}

async function decodeTrack(id) {
  const buf = await (await fetch(FILE_URL(id))).arrayBuffer();
  // decodeAudioData needs a real AudioContext on some WebKit builds.
  const ctx = audioCtx();
  return await ctx.decodeAudioData(buf);
}

function toMono(audioBuffer) {
  const ch = audioBuffer.numberOfChannels;
  const n = audioBuffer.length;
  const out = new Float32Array(n);
  for (let c = 0; c < ch; c++) {
    const d = audioBuffer.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += d[i] / ch;
  }
  return out;
}

function estimateBPM(mono, sr) {
  const hop = Math.max(1, Math.floor(sr * 0.01));     // ~10ms frames → ~100 fps
  const fps = sr / hop;
  const nf = Math.floor(mono.length / hop);
  const energy = new Float32Array(nf);
  for (let f = 0; f < nf; f++) {
    let e = 0; const s = f * hop;
    for (let i = 0; i < hop; i++) { const v = mono[s + i]; e += v * v; }
    energy[f] = e;
  }
  // Onset envelope = half-wave-rectified energy difference.
  const onset = new Float32Array(nf);
  for (let f = 1; f < nf; f++) onset[f] = Math.max(0, energy[f] - energy[f - 1]);
  // Mean-remove.
  let mean = 0; for (let f = 0; f < nf; f++) mean += onset[f]; mean /= (nf || 1);
  for (let f = 0; f < nf; f++) onset[f] -= mean;
  // Autocorrelate over plausible tempo lags.
  const minBPM = 70, maxBPM = 180;
  const minLag = Math.floor(60 * fps / maxBPM);
  const maxLag = Math.ceil(60 * fps / minBPM);
  let bestLag = minLag, best = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let f = lag; f < nf; f++) sum += onset[f] * onset[f - lag];
    if (sum > best) { best = sum; bestLag = lag; }
  }
  let bpm = 60 * fps / bestLag;
  while (bpm < minBPM) bpm *= 2;
  while (bpm > maxBPM) bpm /= 2;
  return Math.round(bpm);
}

const KS_MAJOR = [6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88];
const KS_MINOR = [6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17];

function pearson(a, b) {
  const n = a.length; let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  return num / (Math.sqrt(da * db) || 1);
}

function estimateKey(mono, sr) {
  const N = 4096, hop = 2048;
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
  const chroma = new Float64Array(12);
  const re = new Float32Array(N), im = new Float32Array(N);
  const fmin = 55, fmax = 2000;
  const kmin = Math.max(1, Math.floor(fmin * N / sr));
  const kmax = Math.min(N / 2, Math.ceil(fmax * N / sr));
  for (let s = 0; s + N <= mono.length; s += hop) {
    for (let i = 0; i < N; i++) { re[i] = mono[s + i] * win[i]; im[i] = 0; }
    fft(re, im);
    for (let k = kmin; k <= kmax; k++) {
      const mag = Math.hypot(re[k], im[k]);
      if (mag <= 0) continue;
      const freq = k * sr / N;
      const midi = 69 + 12 * Math.log2(freq / 440);
      let pc = Math.round(midi) % 12; if (pc < 0) pc += 12;
      chroma[pc] += mag;
    }
  }
  // Correlate against all 24 rotated KS profiles.
  let best = { score: -Infinity, pc: 0, mode: 'major' };
  const rot = new Float64Array(12);
  for (let t = 0; t < 12; t++) {
    for (let i = 0; i < 12; i++) rot[i] = KS_MAJOR[(i - t + 12) % 12];
    let sc = pearson(chroma, rot);
    if (sc > best.score) best = { score: sc, pc: t, mode: 'major' };
    for (let i = 0; i < 12; i++) rot[i] = KS_MINOR[(i - t + 12) % 12];
    sc = pearson(chroma, rot);
    if (sc > best.score) best = { score: sc, pc: t, mode: 'minor' };
  }
  // Rough energy proxy = total chroma magnitude / frames (normalized later).
  let tot = 0; for (let i = 0; i < 12; i++) tot += chroma[i];
  return { pc: best.pc, mode: best.mode, energyRaw: tot };
}

async function analyzeTrack(id) {
  const audioBuffer = await decodeTrack(id);
  const sr = audioBuffer.sampleRate;
  const full = toMono(audioBuffer);
  const dur = audioBuffer.duration;
  // Analyze up to ~90s starting ~12% in (skip intros), to bound cost.
  const startSec = Math.min(dur * 0.12, 30);
  const lenSec = Math.min(90, dur - startSec);
  const a = Math.floor(startSec * sr), b = Math.floor((startSec + lenSec) * sr);
  const slice = full.subarray(a, Math.max(a + 1, b));
  const bpm = estimateBPM(slice, sr);
  const k = estimateKey(slice, sr);
  return {
    id, bpm,
    key: PITCHES[k.pc] + (k.mode === 'minor' ? 'm' : ''),
    mode: k.mode,
    camelot: keyToCamelot(k.pc, k.mode),
    duration: Math.round(dur),
  };
}

// ── Harmonic ordering (greedy nearest-neighbour on the wheel) ─────────────────
function orderHarmonic(ids) {
  const known = ids.filter(id => M.analysis[id] && M.analysis[id].camelot);
  const unknown = ids.filter(id => !(M.analysis[id] && M.analysis[id].camelot));
  if (known.length <= 2) return known.concat(unknown);
  const cost = (x, y) => {
    const ax = M.analysis[x], ay = M.analysis[y];
    const cd = camelotDistance(ax.camelot, ay.camelot);
    const bd = (ax.bpm && ay.bpm) ? Math.abs(ax.bpm - ay.bpm) / 4 : 3;
    return cd * 2 + bd;
  };
  // Start from the lowest-BPM known track for a natural ramp-up.
  const remaining = new Set(known);
  let cur = known.reduce((m, id) => (M.analysis[id].bpm || 999) < (M.analysis[m].bpm || 999) ? id : m, known[0]);
  remaining.delete(cur);
  const order = [cur];
  while (remaining.size) {
    let next = null, bestC = Infinity;
    for (const id of remaining) { const c = cost(cur, id); if (c < bestC) { bestC = c; next = id; } }
    order.push(next); remaining.delete(next); cur = next;
  }
  return order.concat(unknown);
}

// ── Playback engine (equal-power crossfade, optional tempo match) ─────────────
let _ctx = null;
function audioCtx() {
  if (!_ctx) _ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (_ctx.state === 'suspended') _ctx.resume();
  return _ctx;
}

// Shared "music bus" so the soundboard can DUCK all music (playlist + DJ decks)
// while a sound bite plays.  Both the Player and mixer.js route to this instead
// of ctx.destination; the sampler's own output stays full volume.
let _duckBus = null, _duckEnabled = true, _duckDepth = 0.78;   // depth 0..1 (0.78 → duck to 0.22)
function duckBus() {
  if (!_duckBus) { const c = audioCtx(); _duckBus = c.createGain(); _duckBus.gain.value = 1; _duckBus.connect(c.destination); }
  return _duckBus;
}
function setDuck(on) {
  const c = audioCtx(), g = duckBus().gain, now = c.currentTime;
  const target = (on && _duckEnabled) ? Math.max(0.05, 1 - _duckDepth) : 1;
  g.cancelScheduledValues(now); g.setValueAtTime(g.value, now);
  g.linearRampToValueAtTime(target, now + (on ? 0.06 : 0.45));   // quick duck, gentle release
}

// ── Mix recording (captures the full output: playlist + DJ decks + soundboard) ─
// WKWebView's MediaRecorder is unreliable, so we tap the audio graph with a
// ScriptProcessor and encode a WAV ourselves — works everywhere.
let _recOn = false, _recNode = null, _recProc = null, _recMute = null, _recL = [], _recR = [], _recLen = 0, _recSR = 44100;
function startRec() {
  if (_recOn) return false;
  const c = audioCtx();
  _recL = []; _recR = []; _recLen = 0; _recSR = c.sampleRate;
  _recNode = c.createGain();                       // tap point
  duckBus().connect(_recNode);                     // music + DJ decks
  if (window.ArcaneSampler && window.ArcaneSampler.connectRec) window.ArcaneSampler.connectRec(_recNode);  // soundboard
  _recProc = c.createScriptProcessor(4096, 2, 2);
  _recProc.onaudioprocess = (e) => {
    if (!_recOn) return;
    const l = e.inputBuffer.getChannelData(0);
    const r = e.inputBuffer.numberOfChannels > 1 ? e.inputBuffer.getChannelData(1) : l;
    _recL.push(new Float32Array(l)); _recR.push(new Float32Array(r)); _recLen += l.length;
  };
  _recMute = c.createGain(); _recMute.gain.value = 0;   // ScriptProcessor must reach destination to run, but silent
  _recNode.connect(_recProc); _recProc.connect(_recMute); _recMute.connect(c.destination);
  _recOn = true;
  return true;
}
function stopRec() {
  return new Promise((res) => {
    if (!_recOn) { res(null); return; }
    _recOn = false;
    try { _recNode.disconnect(); _recProc.disconnect(); _recMute.disconnect(); } catch (e) {}
    if (window.ArcaneSampler && window.ArcaneSampler.disconnectRec) window.ArcaneSampler.disconnectRec(_recNode);
    res(_encodeWav(_recL, _recR, _recLen, _recSR));
    _recNode = _recProc = _recMute = null; _recL = []; _recR = [];
  });
}
function _encodeWav(chunksL, chunksR, len, sr) {
  if (!len) return null;
  const flat = (chunks) => { const o = new Float32Array(len); let off = 0; for (const ch of chunks) { o.set(ch, off); off += ch.length; } return o; };
  const L = flat(chunksL), R = flat(chunksR);
  const buf = new ArrayBuffer(44 + len * 4), v = new DataView(buf);
  const ws = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); v.setUint32(4, 36 + len * 4, true); ws(8, 'WAVE'); ws(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true);
  ws(36, 'data'); v.setUint32(40, len * 4, true);
  let off = 44;
  for (let i = 0; i < len; i++) {
    let sl = Math.max(-1, Math.min(1, L[i])), sr2 = Math.max(-1, Math.min(1, R[i]));
    v.setInt16(off, sl < 0 ? sl * 0x8000 : sl * 0x7fff, true); off += 2;
    v.setInt16(off, sr2 < 0 ? sr2 * 0x8000 : sr2 * 0x7fff, true); off += 2;
  }
  return new Blob([buf], { type: 'audio/wav' });
}

const Player = {
  queue: [],          // ordered track ids
  pos: -1,
  current: null,      // {src,gain,buffer,id,startedAt,offset}
  next: null,
  bufferCache: {},    // id -> AudioBuffer (current + next only)
  playing: false,
  crossfade: 8,       // seconds
  tempoMatch: false,
  _timer: null,
  _gen: 0,            // bumped on each user-initiated play; aborts stale async starts

  async _getBuffer(id) {
    if (this.bufferCache[id]) return this.bufferCache[id];
    const b = await decodeTrack(id);
    this.bufferCache[id] = b;
    return b;
  },
  _trimCache() {
    const keep = new Set([this.current && this.current.id, this.next && this.next.id].filter(Boolean));
    for (const id of Object.keys(this.bufferCache)) if (!keep.has(id)) delete this.bufferCache[id];
  },

  async playPlaylist(ids, opts) {
    opts = opts || {};
    this.crossfade = opts.crossfade != null ? opts.crossfade : this.crossfade;
    this.tempoMatch = !!opts.tempoMatch;
    const gen = ++this._gen;     // invalidate any in-flight _startAt from a prior play
    this.queue = ids.slice();
    this.pos = -1;
    this.stop(true);
    if (!this.queue.length) return;
    const start = Math.max(0, Math.min(this.queue.length - 1, opts.startIndex || 0));
    dbg('playPlaylist len=' + this.queue.length + ' start=' + start + ' xf=' + this.crossfade + ' gen=' + gen);
    await this._startAt(start, 0, gen);
  },

  async _startAt(index, fadeIn, gen) {
    const id = this.queue[index];
    const ctx = audioCtx();
    const buffer = await this._getBuffer(id);
    // If a newer user-initiated play happened while we were decoding, abort —
    // prevents a double-click (two click events) from starting the same track
    // twice on top of itself.
    if (gen != null && gen !== this._gen) { dbg('startAt aborted (stale gen ' + gen + '≠' + this._gen + ')'); return; }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    if (this.tempoMatch && this.current) {
      const a = M.analysis[this.current.id], b = M.analysis[id];
      if (a && b && a.bpm && b.bpm) {
        let r = a.bpm / b.bpm;
        r = Math.max(0.90, Math.min(1.10, r));   // keep pitch shift subtle
        src.playbackRate.value = r;
      }
    }
    const gain = ctx.createGain();
    src.connect(gain).connect(duckBus());
    const now = ctx.currentTime;
    if (fadeIn > 0.01) {
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueCurveAtTime(fadeCurve('in'), now, fadeIn);   // equal-power rise
    } else {
      gain.gain.setValueAtTime(1, now);
    }
    src.start(now);
    this.pos = index;
    const entry = { src, gain, buffer, id, startedAt: now };
    this.current = entry;
    this.playing = true;
    // Reliable auto-advance: fires on the audio thread when the track ends, so
    // it works even when the window is unfocused (where JS timers get throttled
    // and the overlap-crossfade timer below may never fire).  Only acts if the
    // crossfade hasn't already moved us on (this.current still === entry).
    src.onended = () => {
      dbg('onended idx=' + index + ' cur===entry?' + (this.current === entry) + ' playing=' + this.playing + ' ctx=' + (_ctx && _ctx.state));
      if (this.current !== entry) return;             // crossfade already advanced
      if (!this.playing) return;                       // stopped by user
      if (_ctx && _ctx.state !== 'running') return;    // paused (suspended), not ended
      clearTimeout(this._timer);
      if (this.queue.length > 1) {
        dbg('onended → advancing to idx=' + ((this.pos + 1) % this.queue.length));
        this._crossfadeTo((this.pos + 1) % this.queue.length, 0);  // hard start, no overlap left
      } else {
        this.playing = false; this.current = null; onPlayerState();
      }
    };
    dbg('start idx=' + index + ' "' + ((M.byId[id]||{}).title||id).slice(0,24) + '" dur=' + Math.round(buffer.duration) + ' fadeIn=' + fadeIn);
    this._trimCache();
    onPlayerState();
    // Prefetch the next track's buffer.
    if (this.queue[index + 1]) this._getBuffer(this.queue[index + 1]).catch(() => {});
    this._scheduleCrossfade();
  },

  // Timer-based overlap crossfade — fires ~XF seconds before the end so the
  // next track fades in WHILE this one fades out (only when foregrounded; the
  // onended handler above is the reliable fallback when it doesn't fire).
  _scheduleCrossfade() {
    clearTimeout(this._timer);
    if (!this.current || this.queue.length < 2) return;
    const entry = this.current;
    const ctx = audioCtx();
    const rate = entry.src.playbackRate.value || 1;
    const dur = entry.buffer.duration / rate;
    const elapsed = ctx.currentTime - entry.startedAt;
    const xf = Math.min(this.crossfade, dur * 0.45);
    const fireIn = Math.max(0, (dur - elapsed) - xf);
    if (xf <= 0.05) return;                            // XF off → let onended advance
    dbg('schedule crossfade in ' + fireIn.toFixed(1) + 's (xf=' + xf.toFixed(1) + ')');
    this._timer = setTimeout(() => {
      dbg('crossfade timer fired');
      if (this.current === entry && this.playing) this._doTransition();
    }, fireIn * 1000);
  },

  // Equal-power crossfade into queue[index]: fade the current track out while
  // the next fades in, over `xfDur` (defaults to the XF setting).  Used by both
  // the automatic end-of-track transition and the manual skip buttons so a skip
  // actually blends instead of hard-cutting.
  async _crossfadeTo(index, xfDur) {
    const ctx = audioCtx();
    dbg('crossfadeTo idx=' + index + ' xfDur=' + xfDur);
    // Decode the incoming track FIRST so the fade-in starts immediately (no gap).
    try { await this._getBuffer(this.queue[index]); } catch (e) { dbg('getBuffer FAIL idx=' + index + ' ' + (e && e.message)); }
    const outgoing = this.current;
    const cap = outgoing ? outgoing.buffer.duration * 0.45 : Infinity;
    const xf = Math.max(0, Math.min(xfDur != null ? xfDur : this.crossfade, cap));
    if (outgoing) {
      outgoing.src.onended = null;                  // don't let it reset UI state
      if (xf > 0.05) {
        const now = ctx.currentTime;
        outgoing.gain.gain.cancelScheduledValues(now);
        outgoing.gain.gain.setValueCurveAtTime(fadeCurve('out'), now, xf);   // equal-power fall
        try { outgoing.src.stop(now + xf + 0.08); } catch (e) {}
      } else {
        try { outgoing.src.stop(); } catch (e) {}
      }
    }
    await this._startAt(index, xf);               // fades the new track in
  },

  async _doTransition() {
    if (!this.playing || !this.current) return;
    if (this.queue.length === 1) return;                 // single track: let it end
    let nextIndex = this.pos + 1;
    if (nextIndex >= this.queue.length) nextIndex = 0;   // loop
    await this._crossfadeTo(nextIndex);
  },

  async skipNext() {
    if (!this.queue.length) return;
    clearTimeout(this._timer);
    if (this.queue.length === 1) return this.seek(0);
    await this._crossfadeTo((this.pos + 1) % this.queue.length);
  },
  async skipPrev() {
    if (!this.queue.length) return;
    clearTimeout(this._timer);
    if (this.queue.length === 1) return this.seek(0);
    await this._crossfadeTo((this.pos - 1 + this.queue.length) % this.queue.length);
  },
  _hardStopCurrent() {
    if (this.current) { try { this.current.src.stop(); } catch (e) {} this.current = null; }
  },
  // Jump to `frac` (0..1) of the current track.  BufferSources can't seek in
  // place, so swap in a fresh source starting at the new offset, reusing the
  // existing gain node (preserves crossfade/volume) and tempo.
  seek(frac) {
    const entry = this.current;
    if (!entry || !entry.buffer) return;
    const ctx = audioCtx();
    const rate = entry.src.playbackRate.value || 1;
    const offset = Math.max(0, Math.min(0.999, frac)) * entry.buffer.duration;
    try { entry.src.onended = null; entry.src.stop(); } catch (e) {}
    const src = ctx.createBufferSource();
    src.buffer = entry.buffer;
    src.playbackRate.value = rate;
    src.connect(entry.gain);
    const now = ctx.currentTime;
    src.start(now, offset);
    entry.src = src;
    entry.startedAt = now - offset / rate;   // virtual t where offset 0 began
    src.onended = () => {
      if (this.current === entry && this.playing && (!_ctx || _ctx.state === 'running')) {
        this.playing = false; this.current = null; onPlayerState();
      }
    };
    if (_ctx && _ctx.state === 'suspended') { this.playing = true; _ctx.resume(); }
    this.playing = true;
    this._scheduleCrossfade();
    onPlayerState();
  },
  pause() {
    if (!_ctx) return;
    clearTimeout(this._timer);          // freeze the crossfade schedule too
    if (_ctx.state === 'running') _ctx.suspend();
    this.playing = false; onPlayerState();
  },
  resume() {
    if (!_ctx) return;
    const after = () => { this.playing = true; this._scheduleCrossfade(); onPlayerState(); };
    if (_ctx.state === 'suspended') { _ctx.resume().then(after); } else { after(); }
  },
  stop(silent) {
    clearTimeout(this._timer);
    this._hardStopCurrent();
    this.next = null; this.playing = false;
    if (!silent) onPlayerState();
  },
};

// ── UI ─────────────────────────────────────────────────────────────────────
let els = {};
function el(tag, cls, txt) { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }

function injectCSS() {
  const css = `
  .music-launch{display:none}
  .music-panel{position:fixed;right:0;top:0;width:540px;height:100vh;z-index:9001;
    background:rgba(16,14,20,0.97);border-left:1px solid rgba(255,200,90,0.25);
    color:#e8e2d0;font:13px system-ui,sans-serif;display:flex;flex-direction:column;
    transform:translateX(105%);transition:transform .25s ease,width .2s ease;
    box-shadow:-8px 0 30px rgba(0,0,0,0.5)}
  .music-panel.open{transform:translateX(0)}
  .music-panel.dj-on{width:780px}   /* the two-deck FLX4 board needs the room */
  .mp-head{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;
    border-bottom:1px solid rgba(255,255,255,0.08)}
  .mp-title{font-weight:700;color:#ffd27a;letter-spacing:.03em}
  .mp-seg{display:inline-flex;margin-left:12px;border:1px solid rgba(255,255,255,0.14);border-radius:7px;overflow:hidden}
  .mp-seg-btn{background:transparent;border:none;color:#b9b9c4;font-size:12px;font-weight:700;padding:4px 10px;cursor:pointer}
  .mp-seg-btn.on{background:rgba(255,210,122,0.18);color:#ffd27a}
  .mp-x{background:none;border:none;color:#aaa;font-size:16px;cursor:pointer}
  .mp-dj{background:rgba(255,122,26,0.16);border:1px solid rgba(255,140,40,0.5);
    color:#ffb27a;border-radius:6px;padding:5px 9px;cursor:pointer;font:700 11px system-ui;
    letter-spacing:.03em;margin-right:8px}
  .mp-dj:hover{background:rgba(255,122,26,0.3);color:#fff}
  .mp-dj.active{background:#ff7a1a;border-color:#ff9a4a;color:#160d05}
  /* Mode switching: default = continuous playlist; .dj-on = two-deck mixer. */
  #dj-mount{display:none}
  .music-panel.dj-on #dj-mount{display:block}
  .music-panel.dj-on .mp-legacy{display:none}
  .mp-load{display:none}
  .music-panel.dj-on .mp-load{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;width:22px;height:22px;border-radius:5px;border:1px solid rgba(255,140,40,0.4);
    background:rgba(255,122,26,0.12);color:#ffb27a;cursor:pointer;font:700 11px system-ui;line-height:1}
  .mp-load:hover{background:rgba(255,122,26,0.3);color:#fff}
  .mp-row{display:flex;gap:6px;padding:10px 14px}
  .mp-row input{flex:1;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.15);
    color:#fff;border-radius:6px;padding:6px 8px;font:13px system-ui}
  .mp-row button,.mp-chip{background:rgba(255,200,90,0.16);border:1px solid rgba(255,200,90,0.4);
    color:#ffd27a;border-radius:6px;padding:6px 10px;cursor:pointer;font:700 12px system-ui}
  .mp-row button:hover,.mp-chip:hover{background:rgba(255,200,90,0.3)}
  .mp-row button:disabled{opacity:.5;cursor:default}
  .mp-moodbar{display:flex;flex-wrap:wrap;gap:6px;padding:0 14px 8px}
  .mp-chip{padding:5px 9px;font-size:11px}
  .mp-chip.active{background:rgba(255,200,90,0.42);color:#1a140a}
  .mp-add{background:rgba(255,255,255,0.08);border-color:rgba(255,255,255,0.2);color:#cbb}
  .mp-target{display:inline-flex;align-items:center;gap:4px;font-size:11px;color:#bba;padding:2px 0}
  .mp-target-sel{background:rgba(255,200,90,0.14);border:1px solid rgba(255,200,90,0.4);
    color:#ffd27a;border-radius:6px;padding:4px 6px;font:700 11px system-ui}
  .mp-add-btn.mp-in{color:#9fe9b4;border-color:rgba(110,220,140,0.5)}
  .mp-playall{background:rgba(110,220,140,0.2);border-color:rgba(110,220,140,0.5);color:#9fe9b4}
  .mp-search{padding:0 14px 8px}
  .mp-search input{width:100%;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);
    color:#fff;border-radius:6px;padding:6px 8px;font:13px system-ui}
  .mp-list{flex:1;min-height:120px;overflow:auto;padding:0 8px}
  /* DJ mode: the two-deck mixer is tall, so cap the track list and let the whole
     panel scroll instead of squeezing the library to nothing. */
  .music-panel.dj-on{overflow-y:auto}
  .music-panel.dj-on .mp-list{flex:0 0 auto;max-height:34vh}
  .music-panel.dj-on .mp-player{flex:0 0 auto}
  .mp-empty{padding:22px 14px;color:#8a8478;text-align:center;line-height:1.5}
  .mp-track{display:flex;align-items:center;gap:8px;padding:6px 6px;border-radius:6px;cursor:pointer}
  .mp-track:hover{background:rgba(255,255,255,0.05)}
  .mp-chip.mp-unlocked{background:rgba(110,220,140,0.22);border-color:rgba(110,220,140,0.55);color:#9fe9b4}
  .mp-track.mp-drag{cursor:grab}
  .mp-track.mp-drag:active{cursor:grabbing}
  .mp-track.mp-dragging{opacity:0.45}
  .mp-track.mp-droptarget{box-shadow:inset 0 2px 0 0 #ffd27a}
  .mp-cam{flex:0 0 auto;min-width:30px;text-align:center;border-radius:5px;padding:2px 4px;
    font:700 11px system-ui;color:#0c0c0c}
  .mp-cam-q{background:rgba(255,255,255,0.12);color:#888}
  .mp-meta{flex:1;min-width:0;display:flex;flex-direction:column}
  .mp-t{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .mp-a{font-size:11px;color:#9a9384;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .mp-bk{flex:0 0 auto;font-size:11px;color:#bba;font-variant-numeric:tabular-nums}
  .mp-add-btn{flex:0 0 auto;width:24px;height:24px;border-radius:5px;border:1px solid rgba(255,255,255,0.2);
    background:rgba(255,255,255,0.06);color:#ddd;cursor:pointer;font-size:14px;line-height:1}
  .mp-midi{display:flex;align-items:center;gap:7px;padding:6px 14px;font-size:11px;
    color:#9a9384;border-top:1px solid rgba(255,255,255,0.08)}
  .mp-midi-dot{width:8px;height:8px;border-radius:50%;background:#665;flex:0 0 auto;
    box-shadow:0 0 0 0 rgba(110,220,140,0)}
  .mp-midi-dot.on{background:#6edc8c;box-shadow:0 0 8px rgba(110,220,140,0.8)}
  .mp-midi-status{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .mp-midi-last{flex:0 0 auto;color:#cbb;font-variant-numeric:tabular-nums;opacity:.8}
  .mp-player{border-top:1px solid rgba(255,255,255,0.1);padding:10px 14px;flex-shrink:0}
  .mp-now{font-size:12px;color:#ffd27a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:8px;min-height:16px}
  .mp-seek{position:relative;width:100%;height:22px;display:flex;align-items:center;
    cursor:pointer;touch-action:none}
  .mp-seek::before{content:'';position:absolute;left:0;right:0;height:7px;border-radius:4px;
    background:rgba(255,255,255,0.16)}
  .mp-seek-fill{position:absolute;left:0;height:7px;width:0;border-radius:4px;
    background:linear-gradient(90deg,#ffb24a,#ffd27a);pointer-events:none}
  .mp-seek-head{position:absolute;left:0;top:50%;width:16px;height:16px;margin:-8px 0 0 -8px;
    border-radius:50%;background:#ffe0a0;box-shadow:0 0 8px rgba(255,200,90,0.95);
    pointer-events:none}
  .mp-seek-time{display:flex;justify-content:space-between;font-size:10px;color:#9a9384;
    font-variant-numeric:tabular-nums;margin:3px 0 8px}
  .mp-ctrls{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .mp-ctrls button{background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.18);
    color:#eee;border-radius:6px;padding:5px 9px;cursor:pointer;font-size:14px}
  .mp-ctrls button:hover{background:rgba(255,255,255,0.16)}
  .mp-xf,.mp-tm{font-size:11px;color:#bba;display:flex;align-items:center;gap:4px}
  .mp-xf input[type=range]{width:80px}
  `;
  const s = document.createElement('style'); s.textContent = css; document.head.appendChild(s);
}

function buildUI() {
  injectCSS();
  // Hidden trigger — the visible entry point is the "Music" button in the
  // player-tools dock (index.html), which clicks this via data-target.
  const launch = el('button', 'music-launch', '🎵');
  launch.id = 'music-launch';
  launch.title = 'Music & harmonic playlists';
  launch.addEventListener('click', togglePanel);
  document.body.appendChild(launch);

  const panel = el('div', 'music-panel');
  panel.innerHTML = `
    <div class="mp-head">
      <span class="mp-title">🎵 Audio</span>
      <span class="mp-seg"><button class="mp-seg-btn on" data-seg="music">🎵 Music</button><button class="mp-seg-btn" data-seg="sounds">🔊 Sounds</button></span>
      <span style="flex:1"></span>
      <button class="mp-dj" title="Toggle DJ mode — two-deck mixer + MIDI controller. Off = the playlist just plays continuously.">🎧 DJ Mode</button>
      <button class="mp-x" title="Close">✕</button>
    </div>
    <div class="mp-row">
      <input class="mp-folder" placeholder="~/Music" />
      <button class="mp-scan">Scan</button>
      <button class="mp-analyze" title="Analyze key + BPM for visible tracks">Analyze</button>
    </div>
    <div class="mp-moodbar"></div>
    <div class="mp-search"><input placeholder="Filter tracks…" /></div>
    <div class="mp-list"></div>
    <div class="mp-midi">
      <span class="mp-midi-dot"></span>
      <span class="mp-midi-status">MIDI: waiting for a controller…</span>
      <span class="mp-midi-last"></span>
    </div>
    <div class="mp-player">
      <!-- DJ mode: the two-deck FLX4 mixer (mixer.js) mounts here. -->
      <div id="dj-mount"></div>
      <!-- Default mode: the continuous single-stream playlist player. -->
      <div class="mp-legacy">
        <div class="mp-now">—</div>
        <div class="mp-seek" title="Drag to scrub through the track">
          <div class="mp-seek-fill"></div>
          <div class="mp-seek-head"></div>
        </div>
        <div class="mp-seek-time"><span class="mp-cur">0:00</span><span class="mp-dur">0:00</span></div>
        <div class="mp-ctrls">
          <button class="mp-prev">⏮</button>
          <button class="mp-play">▶</button>
          <button class="mp-next">⏭</button>
          <label class="mp-xf">XF <input type="range" class="mp-xf-range" min="0" max="16" value="8"><span class="mp-xf-val">8s</span></label>
          <label class="mp-tm"><input type="checkbox" class="mp-tm-box"> beatmatch</label>
        </div>
      </div>
    </div>`;
  document.body.appendChild(panel);

  els = {
    panel,
    folder: panel.querySelector('.mp-folder'),
    scan: panel.querySelector('.mp-scan'),
    analyze: panel.querySelector('.mp-analyze'),
    moodbar: panel.querySelector('.mp-moodbar'),
    search: panel.querySelector('.mp-search input'),
    list: panel.querySelector('.mp-list'),
    now: panel.querySelector('.mp-now'),
    prev: panel.querySelector('.mp-prev'),
    play: panel.querySelector('.mp-play'),
    next: panel.querySelector('.mp-next'),
    xf: panel.querySelector('.mp-xf-range'),
    xfVal: panel.querySelector('.mp-xf-val'),
    tm: panel.querySelector('.mp-tm-box'),
    midiDot: panel.querySelector('.mp-midi-dot'),
    midiStatus: panel.querySelector('.mp-midi-status'),
    midiLast: panel.querySelector('.mp-midi-last'),
    seek: panel.querySelector('.mp-seek'),
    seekFill: panel.querySelector('.mp-seek-fill'),
    seekHead: panel.querySelector('.mp-seek-head'),
    cur: panel.querySelector('.mp-cur'),
    dur: panel.querySelector('.mp-dur'),
  };

  panel.querySelector('.mp-x').addEventListener('click', togglePanel);
  panel.querySelector('.mp-dj').addEventListener('click', () => setDjMode(!M.djMode));
  // Audio feature switcher: flip between the Music panel and the Soundboard.
  panel.querySelector('.mp-seg').addEventListener('click', (e) => {
    const b = e.target.closest('.mp-seg-btn'); if (!b) return;
    if (b.dataset.seg === 'sounds') { els.panel.classList.remove('open'); if (window.ArcaneSampler && window.ArcaneSampler.show) window.ArcaneSampler.show(); }
  });
  // Restore saved mode (default: off → continuous playlist).
  setDjMode(localStorage.getItem('arcaneDjMode') === '1');
  els.scan.addEventListener('click', doScan);
  els.analyze.addEventListener('click', analyzeVisible);
  els.search.addEventListener('input', renderList);
  els.prev.addEventListener('click', () => Player.skipPrev());
  els.next.addEventListener('click', () => Player.skipNext());
  els.play.addEventListener('click', togglePlay);
  els.xf.addEventListener('input', () => {
    Player.crossfade = parseInt(els.xf.value, 10);
    els.xfVal.textContent = Player.crossfade + 's';
  });
  els.tm.addEventListener('change', () => { Player.tempoMatch = els.tm.checked; });

  // ── Scrub bar: click or drag to seek the current track ──
  const fracFromEvent = (e) => {
    const r = els.seek.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / (r.width || 1)));
  };
  const paintSeek = (frac) => {
    els.seekFill.style.width = (frac * 100) + '%';
    els.seekHead.style.left = (frac * 100) + '%';
    if (Player.current) els.cur.textContent = fmtTime(frac * Player.current.buffer.duration);
  };
  els.seek.addEventListener('pointerdown', (e) => {
    if (!Player.current) return;
    Player.seeking = true;
    paintSeek(fracFromEvent(e));
    els.seek.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  els.seek.addEventListener('pointermove', (e) => {
    if (Player.seeking) paintSeek(fracFromEvent(e));
  });
  els.seek.addEventListener('pointerup', (e) => {
    if (!Player.seeking) return;
    Player.seeking = false;
    if (Player.current) Player.seek(fracFromEvent(e));
  });

  requestAnimationFrame(tickProgress);
}

function fmtTime(s) {
  s = Math.max(0, Math.floor(s || 0));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

// rAF loop: advance the scrub bar while a track plays (paused while dragging).
function tickProgress() {
  requestAnimationFrame(tickProgress);
  if (!els.seek || Player.seeking) return;
  const c = Player.current;
  if (!c || !c.buffer) { return; }
  const ctx = _ctx;
  const rate = c.src.playbackRate.value || 1;
  const dur = c.buffer.duration;
  const elapsed = ctx ? Math.max(0, (ctx.currentTime - c.startedAt) * rate) : 0;
  const frac = dur ? Math.min(1, elapsed / dur) : 0;
  els.seekFill.style.width = (frac * 100) + '%';
  els.seekHead.style.left = (frac * 100) + '%';
  els.cur.textContent = fmtTime(elapsed);
  els.dur.textContent = fmtTime(dur);
}

function togglePanel() { els.panel.classList.toggle('open'); }
window.ArcaneMusicPanel = {
  show() { if (els.panel) els.panel.classList.add('open'); },
  hide() { if (els.panel) els.panel.classList.remove('open'); },
  toggle: togglePanel,
  isOpen() { return !!(els.panel && els.panel.classList.contains('open')); },
};

// DJ mode (optional): ON shows the two-deck mixer + MIDI control; OFF shows the
// continuous playlist player and just plays the set list straight through.
function setDjMode(on) {
  M.djMode = !!on;
  els.panel.classList.toggle('dj-on', M.djMode);
  const btn = els.panel.querySelector('.mp-dj');
  if (btn) { btn.classList.toggle('active', M.djMode); btn.textContent = M.djMode ? '🎧 DJ Mode: ON' : '🎧 DJ Mode'; }
  try { localStorage.setItem('arcaneDjMode', M.djMode ? '1' : '0'); } catch (e) {}
  if (M.djMode) {
    Player.stop();                                  // hand audio to the decks
  } else {
    if (window.ArcaneMixer && window.ArcaneMixer.stopAll) window.ArcaneMixer.stopAll();
  }
  renderList();   // show/hide the per-row deck-load buttons
}

const MOODS = ['Battle', 'Exploration', 'Tavern', 'Boss', 'Custom'];
function ensureDefaultPlaylists() {
  for (const mood of ['Battle', 'Exploration']) {
    if (!M.playlists.some(p => p.name === mood)) {
      M.playlists.push({ id: 'pl_' + mood.toLowerCase(), name: mood, mood, trackIds: [], crossfade: 8, tempoMatch: false });
    }
  }
  if (!M.targetPlaylist && M.playlists.length) M.targetPlaylist = M.playlists[0].id;
}

function renderMoodbar() {
  els.moodbar.innerHTML = '';
  // "Library" = view the full scanned library (no playlist selected).
  const lib = el('button', 'mp-chip' + (M.activePlaylist ? '' : ' active'), '📚 Library');
  lib.title = 'Show your full music library';
  lib.addEventListener('click', () => { M.activePlaylist = null; renderMoodbar(); renderList(); });
  els.moodbar.appendChild(lib);

  for (const p of M.playlists) {
    const chip = el('button', 'mp-chip' + (p.id === M.activePlaylist ? ' active' : ''), `${p.name} (${p.trackIds.length})`);
    chip.addEventListener('click', () => { M.activePlaylist = p.id; M.targetPlaylist = p.id; renderMoodbar(); renderList(); });
    els.moodbar.appendChild(chip);
  }
  const add = el('button', 'mp-chip mp-add', '+ Playlist');
  add.addEventListener('click', () => {
    const name = (prompt('Playlist name:', 'Custom') || '').trim();
    if (!name) return;
    const p = { id: 'pl_' + Date.now(), name, mood: 'Custom', trackIds: [], crossfade: 8, tempoMatch: false };
    M.playlists.push(p); M.activePlaylist = p.id; M.targetPlaylist = p.id; savePlaylists(); renderMoodbar(); renderList();
  });
  els.moodbar.appendChild(add);

  if (M.activePlaylist) {
    // Viewing a playlist → harmonic playback + reorder controls.
    const playBtn = el('button', 'mp-chip mp-playall', '▶ Play (harmonic)');
    playBtn.addEventListener('click', playActivePlaylist);
    els.moodbar.appendChild(playBtn);
    const orderBtn = el('button', 'mp-chip', '↹ Auto-order');
    orderBtn.addEventListener('click', () => {
      const p = activePl(); if (!p) return;
      p.trackIds = orderHarmonic(p.trackIds); savePlaylists(); renderList();
    });
    els.moodbar.appendChild(orderBtn);

    // Sort toggles: each click flips ascending ⇄ descending. The arrow shows
    // the direction the NEXT click will apply.
    const keyBtn = el('button', 'mp-chip', '🎹 Key ' + (_sort.key === 'asc' ? '↑' : '↓'));
    keyBtn.title = 'Sort by Camelot key — click to toggle low→high / high→low';
    keyBtn.addEventListener('click', () => applySort('key'));
    els.moodbar.appendChild(keyBtn);
    const bpmBtn = el('button', 'mp-chip', '♩ BPM ' + (_sort.bpm === 'asc' ? '↑' : '↓'));
    bpmBtn.title = 'Sort by BPM — click to toggle slow→fast / fast→slow';
    bpmBtn.addEventListener('click', () => applySort('bpm'));
    els.moodbar.appendChild(bpmBtn);

    // Lock / unlock — when unlocked, tracks can be dragged to reorder.
    const p = activePl();
    const locked = p.locked !== false;     // default: locked
    const lockBtn = el('button', 'mp-chip' + (locked ? '' : ' mp-unlocked'),
      locked ? '🔒 Locked' : '🔓 Unlocked');
    lockBtn.title = locked ? 'Set list locked — click to unlock and drag-reorder'
                           : 'Set list unlocked — drag tracks to reorder';
    lockBtn.addEventListener('click', () => {
      p.locked = !locked;     // toggle (default state is locked)
      savePlaylists(); renderMoodbar(); renderList();
    });
    els.moodbar.appendChild(lockBtn);
  } else if (M.playlists.length) {
    // Viewing the library → choose which playlist the "+" buttons add to.
    const wrap = el('label', 'mp-target', 'Add to: ');
    const sel = el('select', 'mp-target-sel');
    for (const p of M.playlists) {
      const o = el('option', null, p.name); o.value = p.id;
      if (p.id === M.targetPlaylist) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener('change', () => { M.targetPlaylist = sel.value; });
    wrap.appendChild(sel);
    els.moodbar.appendChild(wrap);
  }
}

function activePl() { return M.playlists.find(p => p.id === M.activePlaylist); }

function renderList() {
  els.list.innerHTML = '';
  const q = (els.search.value || '').toLowerCase();
  const pl = activePl();
  let rows;
  if (pl) {
    rows = pl.trackIds.map(id => M.byId[id]).filter(Boolean);
  } else {
    rows = M.tracks;
  }
  rows = rows.filter(t => !q || (t.title + ' ' + t.artist).toLowerCase().includes(q));
  if (!rows.length) {
    els.list.appendChild(el('div', 'mp-empty', pl ? 'Empty playlist — add tracks from the library (clear the playlist filter).' : 'No tracks. Set a folder and click Scan.'));
    return;
  }
  for (const t of rows) {
    const a = M.analysis[t.id] || {};
    const row = el('div', 'mp-track');
    const cam = a.camelot ? `<span class="mp-cam" style="background:${camelotColor(a.camelot)}">${a.camelot}</span>` : '<span class="mp-cam mp-cam-q">?</span>';
    row.innerHTML = `${cam}
      <span class="mp-meta"><span class="mp-t">${esc(t.title)}</span><span class="mp-a">${esc(t.artist || t.ext.toUpperCase())}</span></span>
      <span class="mp-bk">${a.key ? esc(a.key) : ''}${a.bpm ? ' · ' + a.bpm + '♩' : ''}</span>`;
    const target = pl || M.playlists.find(p => p.id === M.targetPlaylist) || M.playlists[0];
    const inTarget = target && target.trackIds.includes(t.id);
    // Load-to-deck buttons (FLX4 has two decks).
    const ld1 = el('button', 'mp-load', '1'); ld1.title = 'Load to Deck 1';
    ld1.addEventListener('click', (e) => { e.stopPropagation(); if (window.ArcaneMixer) window.ArcaneMixer.load(1, t.id); });
    const ld2 = el('button', 'mp-load', '2'); ld2.title = 'Load to Deck 2';
    ld2.addEventListener('click', (e) => { e.stopPropagation(); if (window.ArcaneMixer) window.ArcaneMixer.load(2, t.id); });
    row.appendChild(ld1); row.appendChild(ld2);

    const btn = el('button', 'mp-add-btn' + (inTarget && !pl ? ' mp-in' : ''), pl ? '−' : (inTarget ? '✓' : '+'));
    btn.title = pl ? 'Remove from this playlist'
                   : target ? `Add to “${target.name}”` : 'Create a playlist first';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!target) { flash('Create a playlist first'); return; }
      if (pl) { target.trackIds = target.trackIds.filter(x => x !== t.id); }
      else if (target.trackIds.includes(t.id)) { target.trackIds = target.trackIds.filter(x => x !== t.id); flash(`Removed from ${target.name}`); }
      else { target.trackIds.push(t.id); flash(`Added to ${target.name}`); }
      savePlaylists(); renderMoodbar(); renderList();
    });
    row.appendChild(btn);
    row.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;   // load/add buttons never trigger playback
      const p = activePl();
      if (p && p.trackIds.length > 1) {
        // In a playlist: play continuously from the clicked track onward.
        audioCtx();
        const idx = p.trackIds.indexOf(t.id);
        Player.playPlaylist(p.trackIds, { startIndex: idx < 0 ? 0 : idx, crossfade: Player.crossfade, tempoMatch: Player.tempoMatch });
      } else {
        previewTrack(t.id);   // library view: just preview the one track
      }
    });

    // Drag-to-reorder — only inside a playlist that's unlocked.
    if (pl && pl.locked === false) {
      row.classList.add('mp-drag');
      row.draggable = true;
      row.addEventListener('dragstart', (e) => {
        _dragId = t.id; row.classList.add('mp-dragging');
        try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', t.id); } catch (_) {}
      });
      row.addEventListener('dragend', () => { _dragId = null; row.classList.remove('mp-dragging'); });
      row.addEventListener('dragover', (e) => { e.preventDefault(); row.classList.add('mp-droptarget'); });
      row.addEventListener('dragleave', () => row.classList.remove('mp-droptarget'));
      row.addEventListener('drop', (e) => {
        e.preventDefault(); row.classList.remove('mp-droptarget');
        if (!_dragId || _dragId === t.id) return;
        const ids = pl.trackIds.slice();
        const from = ids.indexOf(_dragId);
        if (from < 0) return;
        ids.splice(from, 1);
        ids.splice(ids.indexOf(t.id), 0, _dragId);   // insert before the row dropped on
        pl.trackIds = ids;
        savePlaylists(); renderList();
      });
    }
    els.list.appendChild(row);
  }
}

let _dragId = null;
const _sort = { key: 'asc', bpm: 'asc' };   // direction the NEXT click applies

// Sort the active playlist by `field` using the current toggle direction, then
// flip that direction so the next press reverses it.
function applySort(field) {
  const dir = _sort[field];
  if (field === 'key') sortBy('key', dir); else sortBy('bpm', dir);
  _sort[field] = dir === 'asc' ? 'desc' : 'asc';
  renderMoodbar();   // refresh the arrow
}

function sortBy(field, dir) {
  const p = activePl(); if (!p) return;
  const kv = id => {
    const a = M.analysis[id] || {};
    if (field === 'bpm') return (typeof a.bpm === 'number' && a.bpm > 0) ? a.bpm : null;
    const c = parseCamelot(a.camelot);                  // key → Camelot order 1A,1B,2A…12B
    return c ? c.n * 2 + (c.letter === 'B' ? 1 : 0) : null;
  };
  const known = p.trackIds.filter(id => kv(id) != null);
  const unknown = p.trackIds.filter(id => kv(id) == null);
  known.sort((x, y) => dir === 'desc' ? kv(y) - kv(x) : kv(x) - kv(y));
  p.trackIds = known.concat(unknown);   // un-analyzed tracks stay at the end
  savePlaylists(); renderList();
}

function esc(s) { return (s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function flash(msg) { els.now.textContent = msg; }

// ── Actions ───────────────────────────────────────────────────────────────────
async function doScan() {
  const folder = els.folder.value.trim() || '~/Music';
  els.scan.disabled = true; els.scan.textContent = 'Scanning…';
  try {
    const data = await postJSON('music/scan', { folder });
    applyLibrary(data);
    flash(`Scanned ${M.tracks.length} tracks`);
  } catch (e) {
    flash('Scan failed: ' + e.message);
  } finally {
    els.scan.disabled = false; els.scan.textContent = 'Scan';
  }
}

function applyLibrary(data) {
  M.folder = data.folder || '';
  M.tracks = data.tracks || [];
  M.analysis = data.analysis || {};
  M.playlists = (data.playlists && data.playlists.length) ? data.playlists : M.playlists;
  M.byId = {}; for (const t of M.tracks) M.byId[t.id] = t;
  if (data.bindings) MIDI.bindings = data.bindings;
  if (M.folder) els.folder.value = M.folder;
  ensureDefaultPlaylists();
  renderMoodbar(); renderList();
}

async function analyzeVisible() {
  if (M.analyzing) return;
  const pl = activePl();
  let rows = pl ? pl.trackIds.map(id => M.byId[id]).filter(Boolean) : M.tracks;
  const q = (els.search.value || '').toLowerCase();
  rows = rows.filter(t => !q || (t.title + ' ' + t.artist).toLowerCase().includes(q));
  const todo = rows.filter(t => !(M.analysis[t.id] && M.analysis[t.id].camelot));
  if (!todo.length) { flash('All visible tracks already analyzed'); return; }
  M.analyzing = true; els.analyze.disabled = true;
  audioCtx();   // unlock audio on this user gesture
  let done = 0; const batch = [];
  for (const t of todo) {
    flash(`Analyzing ${++done}/${todo.length}: ${t.title.slice(0, 28)}…`);
    try {
      const res = await analyzeTrack(t.id);
      M.analysis[t.id] = res; batch.push(res);
      if (batch.length >= 5) { await postJSON('music/analysis', { items: batch.splice(0) }); }
      renderList();
    } catch (e) { /* skip undecodable file */ }
    await new Promise(r => setTimeout(r, 0));
  }
  if (batch.length) await postJSON('music/analysis', { items: batch });
  M.analyzing = false; els.analyze.disabled = false;
  flash(`Analyzed ${done} tracks`);
  renderMoodbar();
}

async function savePlaylists() {
  try { await postJSON('music/playlists', { playlists: M.playlists }); } catch (e) {}
}

async function playActivePlaylist() {
  const p = activePl(); if (!p || !p.trackIds.length) { flash('Playlist is empty'); return; }
  audioCtx();
  const ordered = orderHarmonic(p.trackIds);
  p.trackIds = ordered; savePlaylists(); renderList();
  await Player.playPlaylist(ordered, { crossfade: Player.crossfade, tempoMatch: Player.tempoMatch });
}

async function previewTrack(id) {
  try {
    audioCtx();
    await Player.playPlaylist([id], { crossfade: 0 });
  } catch (e) {
    flash('Play error: ' + (e && e.message || e));
    try { postJSON('music/diag', { type: 'play_error', msg: String(e && e.message || e), stack: String(e && e.stack || '') }); } catch (_) {}
  }
}
window.addEventListener('unhandledrejection', (ev) => {
  const m = ev.reason && ev.reason.message || ev.reason;
  try { postJSON('music/diag', { type: 'rejection', msg: String(m), stack: String(ev.reason && ev.reason.stack || '') }); } catch (_) {}
});
window.addEventListener('error', (ev) => {
  try { postJSON('music/diag', { type: 'error', msg: String(ev.message), src: ev.filename, line: ev.lineno }); } catch (_) {}
});

function togglePlay() {
  // 1) Playing → pause.
  if (Player.playing) { Player.pause(); return; }
  // 2) Paused (context suspended) with a loaded track → resume.
  if (_ctx && _ctx.state === 'suspended' && Player.current) { Player.resume(); return; }
  // 3) A queue is loaded but stopped → restart it.
  if (Player.queue.length) { Player.playPlaylist(Player.queue, { crossfade: Player.crossfade, tempoMatch: Player.tempoMatch }); return; }
  // 4) Nothing loaded → start the active playlist, or the first non-empty one.
  let p = activePl();
  if (!p || !p.trackIds.length) p = M.playlists.find(x => x.trackIds.length);
  if (p) { M.activePlaylist = p.id; renderMoodbar(); renderList(); playActivePlaylist(); }
  else flash('Add tracks to a playlist, then press play');
}

function onPlayerState() {
  if (!els.play) return;
  els.play.textContent = Player.playing ? '⏸' : '▶';
  const cur = Player.current && M.byId[Player.current.id];
  if (cur) {
    const a = M.analysis[Player.current.id] || {};
    els.now.textContent = `${cur.title}${a.camelot ? '  ·  ' + a.camelot : ''}${a.bpm ? '  ·  ' + a.bpm + ' BPM' : ''}`;
  }
}

// ── MIDI (native CoreMIDI bridge → window.arcaneOnMIDI) ──────────────────────
// The WKWebView has no Web MIDI API, so the Swift shell (MIDIManager) parses
// CoreMIDI and calls window.arcaneOnMIDI(status,d1,d2,name) for every channel-
// voice message.  This layer shows a live monitor and (later) maps controls to
// mixer/player functions via MIDI-learn.
const MIDI = {
  devices: new Set(),
  count: 0,
  learning: null,           // {fn} when waiting to bind a control
  bindings: {},             // "status:d1" -> function name
  lastShown: 0,
  handlers: {},             // function name -> callback(value 0..1, raw)

  describe(status, d1, d2) {
    const ch = (status & 0x0f) + 1;
    const hi = status & 0xf0;
    const kind = hi === 0x90 ? (d2 > 0 ? 'Note On' : 'Note Off')
               : hi === 0x80 ? 'Note Off'
               : hi === 0xb0 ? 'CC'
               : hi === 0xe0 ? 'Pitch' : 'msg';
    return `${kind} ch${ch} ${d1}=${d2}`;
  },

  controlMap: {}, _postT: 0, _seq: 0,
  _log(status, d1, d2, name) {
    // Track every distinct control with its value range + recency, so a flood
    // from one control (jog) can never hide the others.
    const key = (status & 0xf0).toString(16) + ':ch' + ((status & 0x0f) + 1) + ':' + d1;
    let c = this.controlMap[key];
    if (!c) c = this.controlMap[key] = { kind: this.describe(status, d1, d2), min: d2, max: d2, n: 0 };
    c.min = Math.min(c.min, d2); c.max = Math.max(c.max, d2); c.n++; c.seq = ++this._seq;
    const now = performance.now();
    if (now - this._postT > 250) {   // throttle (jogs fire fast)
      this._postT = now;
      try { postJSON('music/diag', { type: 'midi', devices: [...this.devices], controls: this.controlMap }); } catch (e) {}
    }
  },

  onMessage(status, d1, d2, name) {
    this.count++;
    if (name && !this.devices.has(name)) { this.devices.add(name); updateMidiStatus(); }
    this._log(status, d1, d2, name);   // mirror to server for diagnostics/mapping capture
    if (window.ArcaneMixerMIDI) window.ArcaneMixerMIDI(status, d1, d2);   // drive the FLX4-mapped decks
    if (window.ArcaneSamplerMIDI && window.ArcaneSamplerMIDI(status, d1, d2)) return;   // soundboard claimed it
    // MIDI-learn capture: bind the first control touched to the pending fn.
    if (this.learning) {
      const key = (status & 0xf0) + ':' + d1;       // ignore channel-LSB velocity
      this.bindings[key] = this.learning.fn;
      flash(`Bound ${this.describe(status, d1, d2)} → ${this.learning.label || this.learning.fn}`);
      this.learning = null;
      saveBindings();
      return;
    }
    // Dispatch to a bound handler.
    const key = (status & 0xf0) + ':' + d1;
    const fn = this.bindings[key];
    if (fn && this.handlers[fn]) {
      const val = ((status & 0xf0) === 0xe0) ? d2 / 127 : d2 / 127;  // 0..1
      try { this.handlers[fn](val, { status, d1, d2 }); } catch (e) {}
    }
    // Throttled live monitor.
    const now = performance.now();
    if (now - this.lastShown > 60 && els.midiLast) {
      this.lastShown = now;
      els.midiLast.textContent = this.describe(status, d1, d2);
    }
  },
};
window.arcaneOnMIDI = (s, d1, d2, name) => MIDI.onMessage(s, d1, d2, name);

function updateMidiStatus() {
  if (!els.midiStatus) return;
  if (MIDI.devices.size) {
    els.midiDot.classList.add('on');
    els.midiStatus.textContent = 'MIDI: ' + [...MIDI.devices].join(', ');
  } else {
    els.midiDot.classList.remove('on');
    els.midiStatus.textContent = 'MIDI: waiting for a controller…';
  }
}
async function saveBindings() {
  try { await postJSON('music/bindings', { bindings: MIDI.bindings }); } catch (e) {}
}

// ── MIDI capability probe (reports back to server so we can read it) ──────────
async function probeMIDI() {
  const diag = {
    ts: Date.now(),
    hasWebMIDI: typeof navigator.requestMIDIAccess === 'function',
    ua: navigator.userAgent,
    inputs: [], granted: false, err: '',
  };
  if (diag.hasWebMIDI) {
    try {
      const acc = await navigator.requestMIDIAccess({ sysex: false });
      diag.granted = true;
      diag.inputs = [...acc.inputs.values()].map(i => ({ name: i.name, manufacturer: i.manufacturer }));
    } catch (e) { diag.err = String(e && e.message || e); }
  }
  try { await postJSON('music/diag', diag); } catch (e) {}
}

// ── Init ───────────────────────────────────────────────────────────────────
async function init() {
  buildUI();
  ensureDefaultPlaylists();
  try { applyLibrary(await getJSON('music/library')); } catch (e) { renderMoodbar(); renderList(); }
  updateMidiStatus();
  probeMIDI();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();

window.ArcaneMusic = M;   // shared library/analysis state
// Shared helpers for the two-deck mixer (mixer.js).
window.ArcaneMusicAPI = {
  audioCtx, decodeTrack, fmtTime, camelotColor, parseCamelot, getJSON, postJSON, esc,
  pausePlayer: () => Player.stop(),   // stop the playlist player when DJ mode takes over
  duckBus,                            // shared music bus (mixer.js routes MASTER here too)
  setDuck,                            // setDuck(true/false) — lower music while a sound bite plays
  setDuckEnabled: (on) => { _duckEnabled = !!on; if (!on) setDuck(false); },
  isDuckEnabled: () => _duckEnabled,
  setDuckDepth: (d) => { _duckDepth = Math.max(0, Math.min(0.95, d)); },
  startRec, stopRec,                  // record/export the full mix
  // ── Scene→audio wiring: list / play / stop playlists by id (or name) ──
  listPlaylists: () => M.playlists.map(p => ({ id: p.id, name: p.name, count: (p.trackIds || []).length })),
  playPlaylistById: (id) => {
    const p = M.playlists.find(x => x.id === id);
    if (!p || !(p.trackIds || []).length) return false;
    audioCtx();
    Player.playPlaylist(p.trackIds, { startIndex: 0, crossfade: p.crossfade || Player.crossfade, tempoMatch: !!p.tempoMatch });
    return true;
  },
  stopPlaylist: () => Player.stop(),
};
})();
