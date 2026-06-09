/* ArcaneOverlay — two-deck DJ mixer (DDJ-FLX4 styled), mounted INLINE in the
 * music panel's player section (no popup, no button — always visible).
 *
 * Dual-deck Web Audio engine + FLX4-inspired compact UI.  Reuses the library/
 * analysis state (window.ArcaneMusic) and audio helpers (window.ArcaneMusicAPI)
 * from music.js.  Loaded no-cache like music.js.
 *
 * Per deck:  source → LOW → MID → HIGH (biquads) → trim → volume(channel
 * fader) → xfade(crossfader) → MASTER → destination.
 */
(function () {
'use strict';

const API = window.ArcaneMusicAPI;
const M = window.ArcaneMusic;
if (!API || !M) { return; }

const TEMPO_RANGE = 0.16;     // ±16% tempo fader range
let MASTER = null;

// ── Key-lock time-stretch (WSOLA) ────────────────────────────────────────────
// Changes tempo while preserving pitch.  50%-overlap Hann grains; the analysis
// position advances by stretch×hop while output advances by one hop.
let KEYLOCK = true;
let QUANTIZE = true;          // snap hot cues / loop points to the nearest beat
const TS_FRAME = 2048, TS_HOP = 1024, TS_OVL = TS_FRAME - TS_HOP, TS_SEARCH = 420, TS_STEP = 8, TS_CORR = 256;
const TS_WIN = new Float32Array(TS_FRAME);
for (let i = 0; i < TS_FRAME; i++) TS_WIN[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (TS_FRAME - 1));

// Produce one synthesis hop (TS_HOP samples) into deck._bufL/R via WSOLA.
function tsHop(deck, chL, chR, len, stretch) {
  let head = deck.head;
  if (deck.loopOn && head >= deck.loopEnd) head -= (deck.loopEnd - deck.loopStart);
  // WSOLA: pick the grain offset δ whose start best continues the carried tail.
  let bestD = 0, bestScore = -Infinity;
  const tL = deck._tailL;
  for (let dlt = -TS_SEARCH; dlt <= TS_SEARCH; dlt += TS_STEP) {
    const gp = (head + dlt) | 0;
    if (gp < 1 || gp + TS_FRAME >= len) continue;
    let sc = 0; for (let i = 0; i < TS_CORR; i += 2) sc += chL[gp + i] * tL[i];
    if (sc > bestScore) { bestScore = sc; bestD = dlt; }
  }
  let gp = head + bestD;                             // clamp so the full grain stays in-bounds
  if (gp < 0) gp = 0; if (gp + TS_FRAME >= len) gp = Math.max(0, len - TS_FRAME - 1);
  const bufL = deck._bufL, bufR = deck._bufR, tlL = deck._tailL, tlR = deck._tailR;
  for (let i = 0; i < TS_HOP; i++) {                 // emit overlap region (tail + new grain front)
    const p = gp + i, i0 = p | 0, fr = p - i0, i1 = i0 + 1 < len ? i0 + 1 : i0, wv = TS_WIN[i];
    bufL[i] = tlL[i] + (chL[i0] + (chL[i1] - chL[i0]) * fr) * wv;
    bufR[i] = tlR[i] + (chR[i0] + (chR[i1] - chR[i0]) * fr) * wv;
  }
  for (let i = 0; i < TS_OVL; i++) {                 // stash grain back as the next tail
    const j = TS_HOP + i, p = gp + j, i0 = p | 0, fr = p - i0, i1 = i0 + 1 < len ? i0 + 1 : i0, wv = TS_WIN[j];
    tlL[i] = (chL[i0] + (chL[i1] - chL[i0]) * fr) * wv;
    tlR[i] = (chR[i0] + (chR[i1] - chR[i0]) * fr) * wv;
  }
  let nh = deck.head + TS_HOP * stretch;             // advance analysis position by stretch×hop
  if (deck.loopOn && nh >= deck.loopEnd) nh -= (deck.loopEnd - deck.loopStart);
  if (nh > len - 1) { nh = len - 1; deck.playing = false; }
  deck.head = nh;
}
function ctx() { return API.audioCtx(); }
function master() {
  if (!MASTER) {
    const c = ctx(); MASTER = c.createGain(); MASTER.gain.value = 0.9;
    const bus = (window.ArcaneMusicAPI && window.ArcaneMusicAPI.duckBus) ? window.ArcaneMusicAPI.duckBus() : c.destination;
    MASTER.connect(bus);   // route through the shared duck bus so soundboard can duck the decks too
  }
  return MASTER;
}

// ── Deck ──────────────────────────────────────────────────────────────────
function makeDeck(num) {
  const c = ctx();
  const low = c.createBiquadFilter();  low.type = 'lowshelf';  low.frequency.value = 220;
  const mid = c.createBiquadFilter();  mid.type = 'peaking';   mid.frequency.value = 1000; mid.Q.value = 0.9;
  const high = c.createBiquadFilter(); high.type = 'highshelf'; high.frequency.value = 3500;
  const cfx = c.createBiquadFilter(); cfx.type = 'lowpass'; cfx.frequency.value = 22000;  // Sound Color FX (bypassed at centre)
  const trim = c.createGain();
  const vol = c.createGain();
  const xf = c.createGain();
  low.connect(mid); mid.connect(high); high.connect(cfx); cfx.connect(trim); trim.connect(vol); vol.connect(xf); xf.connect(master());

  // Sample-level read-head player (instead of a one-shot BufferSource) so the
  // jog can drive the playback position forward AND backward in real time —
  // that's what makes turntable scratching (and the scratch sound) possible.
  const sp = c.createScriptProcessor(1024, 1, 2);
  sp.connect(low);

  const deck = {
    num, low, mid, high, cfx, trim, vol, xf, sp,
    buffer: null, trackId: null,
    head: 0,                 // playback position, in samples (float)
    playing: false, scratching: false, synced: false, shift: false,
    baseRate: 1, scratchSpeed: 0, scratchTarget: 0, bend: 0, cue: 0,
    hotcues: [null,null,null,null,null,null,null,null],   // sample positions (null = unset)
    loopStart: -1, loopEnd: -1, loopOn: false, loopBeats: 4, gridOffset: 0,
    _scrubbing: false,
    _tailL: new Float32Array(TS_OVL), _tailR: new Float32Array(TS_OVL),
    _bufL: new Float32Array(TS_HOP), _bufR: new Float32Array(TS_HOP), _bufLen: 0, _bufPos: 0,
    _tsReset() { this._bufLen = 0; this._bufPos = 0; this._tailL.fill(0); this._tailR.fill(0); },

    async load(trackId) {
      this.stop();
      this.trackId = trackId; this.buffer = null; render();
      try { this.buffer = await API.decodeTrack(trackId); } catch (e) { this.buffer = null; }
      this._wave = this.buffer ? buildBands(this.buffer) : null;   // 3-band scrolling data
      // BPM + beat-phase: get BPM (analyzed or estimate) AND detect WHERE the beats
      // actually fall, so the grid lands on real beats instead of assuming one at t=0.
      const an = M.analysis[trackId];
      const known = (an && an.bpm > 0) ? an.bpm : 0;
      const bi = this.buffer ? analyzeBeat(this.buffer, known) : { bpm: 0, offset: 0 };
      this._bpm = bi.bpm;                          // fractional (refined near the analyzed BPM if any)
      this.baseRate = 1;
      this.head = 0; this.cue = 0; this.synced = false; this.hotcues = [null,null,null,null,null,null,null,null];
      this.loopOn = false; this.loopStart = -1; this.loopEnd = -1; this.gridOffset = bi.offset;
      if (root) { const b = root.querySelector('#dj-sync-' + this.num); if (b) b.classList.remove('on'); }
      render();
    },
    position() { return this.buffer ? this.head / this.buffer.sampleRate : 0; },   // seconds
    play() {
      if (!this.buffer) return;
      const cc = ctx(); if (cc.state === 'suspended') cc.resume();
      API.pausePlayer && API.pausePlayer();
      if (this.head >= this.buffer.length - 2) this.head = 0;   // restart if at end
      this._tsReset(); this.playing = true; render();
    },
    pause() { this.playing = false; render(); },
    toggle() { this.playing ? this.pause() : this.play(); },
    // Snap a sample position to the nearest beat when Quantize is on.
    _q(p) {
      if (!QUANTIZE || !this.buffer) return p;
      const bpm = _bpm(this); if (!bpm) return p;
      const sr = this.buffer.sampleRate, beatSamp = (60 / bpm) * sr, off = (this.gridOffset || 0) * sr;
      const q = off + Math.round((p - off) / beatSamp) * beatSamp;
      return Math.max(0, Math.min(this.buffer.length - 1, q));
    },
    cuePress() {
      if (!this.buffer) return;
      if (this.playing) { this.playing = false; this.head = this.cue; this._tsReset(); render(); }   // jump to cue, stop
      else { this.cue = this._q(this.head); render(); }                              // set cue (quantized)
    },
    seek(frac) { if (this.buffer) { this.head = Math.max(0, Math.min(0.9999, frac)) * this.buffer.length; this._tsReset(); render(); } },
    // Hot cue: SHIFT+pad clears; empty pad sets a cue; a set pad jumps (and plays).
    hotcue(i) {
      if (!this.buffer) return;
      if (this.shift) { this.clearHotcue(i); return; }
      if (this.hotcues[i] == null) { this.hotcues[i] = this._q(this.head); }   // set on-beat when quantized
      else { this.head = this.hotcues[i]; this._tsReset(); if (!this.playing) this.play(); }
      renderPads(this.num);
    },
    clearHotcue(i) { this.hotcues[i] = null; renderPads(this.num); },
    toggleShift() { this.shift = !this.shift; renderShift(this.num); },
    // Manual loop: IN sets start, OUT sets end + engages (OUT again exits).
    _beatSamp() { const bpm = _bpm(this) || 120; return (60 / (bpm * this.baseRate)) * (this.buffer ? this.buffer.sampleRate : 44100); },
    loopIn() { if (this.buffer) { this.loopStart = this._q(this.head); this.loopEnd = -1; this.loopOn = false; renderLoop(this.num); } },
    loopOut() {
      if (!this.buffer) return;
      if (this.loopOn) { this.loopOn = false; }
      else if (this.loopStart >= 0 && this.head > this.loopStart + 10) {
        this.loopEnd = this._q(this.head); this.loopOn = true;
        this.loopBeats = Math.max(0.125, Math.round((this.loopEnd - this.loopStart) / this._beatSamp() * 4) / 4);
      }
      renderLoop(this.num);
    },
    loopExit() { this.loopOn = false; this.loopStart = -1; this.loopEnd = -1; renderLoop(this.num); },
    // Manual beat-grid: set the down-beat to the playhead, or nudge it.
    setGrid() { if (this.buffer) this.gridOffset = this.head / this.buffer.sampleRate; },
    nudgeGrid(dt) { this.gridOffset = Math.max(0, this.gridOffset + dt); },
    beatLoop(beats) {   // auto loop of `beats` length from current position (start on-beat)
      if (!this.buffer) return;
      this.loopBeats = beats; this.loopStart = this._q(this.head);
      this.loopEnd = this.loopStart + this._beatSamp() * beats; this.loopOn = true; renderLoop(this.num);
    },
    fourBeatOrExit() { this.loopOn ? this.loopExit() : this.beatLoop(this.loopBeats || 4); },
    // Shorter / longer: halve or double the loop length (in beats); resize a live loop.
    loopShorter() { this._resize(0.5); },
    loopLonger() { this._resize(2); },
    _resize(f) {
      this.loopBeats = Math.max(0.125, Math.min(64, (this.loopBeats || 4) * f));
      if (this.loopOn && this.buffer) this.loopEnd = Math.min(this.buffer.length - 1, this.loopStart + this._beatSamp() * this.loopBeats);
      renderLoop(this.num);
    },
    setTrim(g) { this.trim.gain.setTargetAtTime(g, ctx().currentTime, 0.01); },
    setCFX(v) {                                  // -1 = full low-pass, 0 = bypass, +1 = full high-pass
      const f = this.cfx, now = ctx().currentTime;
      if (v < -0.02) { f.type = 'lowpass'; f.frequency.setTargetAtTime(22000 * Math.pow(200 / 22000, -v), now, 0.02); }
      else if (v > 0.02) { f.type = 'highpass'; f.frequency.setTargetAtTime(20 * Math.pow(6000 / 20, v), now, 0.02); }
      else { f.type = 'lowpass'; f.frequency.setTargetAtTime(22000, now, 0.02); }
    },
    setRate(r) { this.baseRate = r; },
    setEQ(band, db) { this[band].gain.setTargetAtTime(db, ctx().currentTime, 0.01); },
    // Position-following scratch: the pointer drives a TARGET head position; the
    // audio thread eases the real head toward it, so the track moves with your
    // finger (like vinyl) and the easing motion is the scratch sound.
    scratchStart() { const cc = ctx(); if (cc.state === 'suspended') cc.resume(); this.scratching = true; this.scratchTarget = this.head; },
    scratchTo(samples) {
      this.scratching = true;
      this.scratchTarget = Math.max(0, Math.min((this.buffer ? this.buffer.length - 1 : 0), samples));
      if (!this.playing) this.head = this.scratchTarget;   // paused: scrub instantly (audio thread may be idle)
    },
    scratchBy(dSamples) { this.scratchTo((this.scratchTarget || this.head) + dSamples); },
    // Real-time scratch: set the instantaneous playback rate (signed; negative = reverse).
    scratch(rate) { this.scratching = true; this.scratchSpeed = rate; },
    scratchEnd() { this.scratching = false; this.scratchSpeed = 0; this._tsReset(); },   // fresh grains when stretch resumes
    stop() { this.playing = false; this.scratching = false; this.scratchSpeed = 0; },
  };

  sp.onaudioprocess = (e) => {
    const outL = e.outputBuffer.getChannelData(0), outR = e.outputBuffer.getChannelData(1);
    const N = outL.length, buf = deck.buffer;
    if (!buf) { for (let i = 0; i < N; i++) { outL[i] = 0; outR[i] = 0; } return; }
    const chL = buf.getChannelData(0), chR = buf.numberOfChannels > 1 ? buf.getChannelData(1) : chL;
    const len = buf.length;
    const scr = deck.scratching;
    const stretch = deck.baseRate * (1 + deck.bend);
    if (!scr && deck.playing && KEYLOCK && Math.abs(stretch - 1) > 0.001) {
      // KEY-LOCK path: time-stretch (pitch preserved) by pulling synthesis hops.
      for (let o = 0; o < N;) {
        if (deck._bufPos < deck._bufLen) { outL[o] = deck._bufL[deck._bufPos]; outR[o] = deck._bufR[deck._bufPos]; deck._bufPos++; o++; }
        else if (deck.playing && deck.head < len - 1) { tsHop(deck, chL, chR, len, stretch); deck._bufPos = 0; deck._bufLen = TS_HOP; }
        else { outL[o] = 0; outR[o] = 0; o++; }
      }
    } else if (scr) {
      // SCRATCH path: the pointer set a target head position; ease the real head
      // toward it at audio rate.  The track follows your finger, and the easing
      // motion produces the scratch sound.  A velocity API (MIDI jog) nudges the
      // target each block so it still works without a pointer.
      if (deck.scratchSpeed) { deck.scratchTo((deck.scratchTarget || deck.head) + deck.scratchSpeed * N); deck.scratchSpeed *= 0.82; }
      let pos = deck.head; const target = deck.scratchTarget;
      for (let i = 0; i < N; i++) {
        pos += (target - pos) * SCRATCH_EASE;
        if (pos < 0) pos = 0; if (pos > len - 1) pos = len - 1;
        const i0 = pos | 0, i1 = i0 + 1 < len ? i0 + 1 : i0, fr = pos - i0;
        outL[i] = chL[i0] + (chL[i1] - chL[i0]) * fr;
        outR[i] = chR[i0] + (chR[i1] - chR[i0]) * fr;
      }
      deck.head = pos;
      if (deck._bufLen) { deck._bufLen = 0; deck._bufPos = 0; }
    } else {
      // RESAMPLING path: key-lock off, or stretch≈1 (pitch follows rate).
      let spd = deck.playing ? stretch : 0;
      const loop = deck.loopOn, ls = deck.loopStart, le = deck.loopEnd;
      let pos = deck.head;
      for (let i = 0; i < N; i++) {
        if (pos < 0) pos = 0;
        if (loop && pos >= le) pos -= (le - ls);
        if (pos > len - 1) { pos = len - 1; deck.playing = false; spd = 0; }
        const i0 = pos | 0, i1 = i0 + 1 < len ? i0 + 1 : i0, fr = pos - i0;
        outL[i] = chL[i0] + (chL[i1] - chL[i0]) * fr;
        outR[i] = chR[i0] + (chR[i1] - chR[i0]) * fr;
        pos += spd;
      }
      deck.head = pos;
      if (deck._bufLen) { deck._bufLen = 0; deck._bufPos = 0; }   // invalidate stretch buffer when not stretching
    }
    if (deck.bend) deck.bend *= 0.82;     // ring-nudge bend relaxes back to normal speed
  };

  return deck;
}

let decks = null;
function ensureDecks() { if (!decks) decks = [makeDeck(1), makeDeck(2)]; return decks; }

let xfPos = 0.5;
function applyCrossfader() {
  const [d1, d2] = ensureDecks();
  d1.xf.gain.setTargetAtTime(Math.cos(xfPos * Math.PI / 2), ctx().currentTime, 0.01);
  d2.xf.gain.setTargetAtTime(Math.sin(xfPos * Math.PI / 2), ctx().currentTime, 0.01);
}

// ── Beat sync ───────────────────────────────────────────────────────────────
// Prefer the library's analyzed BPM; fall back to a per-deck estimate computed
// on load, so SYNC always has a tempo to match even for un-analyzed tracks.
function _bpm(d) {
  if (d && d._bpm) return d._bpm;                 // refined fractional estimate (best for grid accuracy)
  const a = d && d.trackId && M.analysis[d.trackId];
  return (a && a.bpm > 0) ? a.bpm : 0;
}

// Onset-envelope analysis → { bpm, offset }.  `offset` is the time (sec, within
// one beat) where beats actually land — detected by correlating the onset
// envelope against a pulse train, so the grid sits on real beats regardless of
// intro length / pickup notes.  Pass a known BPM to only detect the phase.
function analyzeBeat(buffer, knownBpm) {
  const sr = buffer.sampleRate, data = buffer.getChannelData(0);
  const start = Math.floor(data.length * 0.12), end = Math.min(data.length, start + sr * 90);
  const hop = Math.max(1, Math.floor(sr * 0.01)), fps = sr / hop;
  const nf = Math.floor((end - start) / hop);
  if (nf < 16) return { bpm: knownBpm || 0, offset: 0 };
  const en = new Float32Array(nf);
  for (let f = 0; f < nf; f++) { let e = 0; const s = start + f * hop; for (let i = 0; i < hop; i++) { const v = data[s + i] || 0; e += v * v; } en[f] = e; }
  const on = new Float32Array(nf);              // rectified onset (spectral-flux-ish)
  for (let f = 1; f < nf; f++) on[f] = Math.max(0, en[f] - en[f - 1]);
  // FRACTIONAL BPM: autocorrelate, then parabolic-interpolate the peak so the grid
  // matches the true tempo (a rounded BPM makes the grid slowly slide off the beats).
  const minB = 70, maxB = 180, minLag = Math.floor(60 * fps / maxB), maxLag = Math.min(nf - 2, Math.ceil(60 * fps / minB));
  let mean = 0; for (let f = 0; f < nf; f++) mean += on[f]; mean /= nf;
  const oc = new Float32Array(nf); for (let f = 0; f < nf; f++) oc[f] = on[f] - mean;
  const ac = new Float32Array(maxLag + 2);
  for (let lag = minLag; lag <= maxLag; lag++) { let s = 0; for (let f = lag; f < nf; f++) s += oc[f] * oc[f - lag]; ac[lag] = s; }
  let centerLag;
  if (knownBpm > 0) centerLag = Math.round(60 * fps / knownBpm);
  else { let bl = minLag, best = -Infinity; for (let lag = minLag; lag <= maxLag; lag++) if (ac[lag] > best) { best = ac[lag]; bl = lag; } centerLag = bl; }
  centerLag = Math.max(minLag + 1, Math.min(maxLag - 1, centerLag));
  // FINE comb-fit: jointly search the fractional beat period AND phase that best
  // align a beat-comb to the onsets over the WHOLE window.  This minimizes the
  // long-range drift you get from even a tiny BPM error (grid sliding off beats).
  const lo = Math.max(minLag + 1, centerLag - 2.2), hi = Math.min(maxLag - 1, centerLag + 2.2);
  let bestLagF = centerLag, bestP = 0, bestScore = -Infinity;
  for (let lagF = lo; lagF <= hi; lagF += 0.03) {
    const L = Math.round(lagF);
    for (let ph = 0; ph < L; ph++) {
      let s = 0; for (let pos = ph; pos < nf; pos += lagF) s += on[pos | 0];
      if (s > bestScore) { bestScore = s; bestLagF = lagF; bestP = ph; }
    }
  }
  let bpm = 60 * fps / bestLagF;
  while (bpm < minB) bpm *= 2; while (bpm > maxB) bpm /= 2;
  if (knownBpm > 0 && Math.abs(bpm - knownBpm) > 4) bpm = knownBpm;   // sanity: keep near analyzed value
  const lag = bestLagF;                          // fractional beat length (frames)
  // Down-beat: of the 4 beats in a bar, pick the most-accented as "1" so the
  // measure numbering lands on the down-beat (heuristic; tweak with ⊞ if wrong).
  let bestM = 0, bestE = -Infinity;
  for (let m = 0; m < 4; m++) { let e = 0; for (let f = bestP + m * lag; f < nf; f += 4 * lag) e += on[f | 0] || 0; if (e > bestE) { bestE = e; bestM = m; } }
  const beat = 60 / bpm, bar = 4 * beat;
  let offset = ((start + (bestP + bestM * lag) * hop) / sr) % bar; if (offset < 0) offset += bar;
  return { bpm, offset };
}

// Toggle beat sync for deck `n`.  ON: match the other deck's BPM + beat phase.
// OFF: just disengage — the tempo it was synced to STAYS (no revert).
function syncDeck(n) {
  const dks = ensureDecks();
  const me = dks[n - 1], other = dks[n === 1 ? 1 : 0];
  const btn = root && root.querySelector('#dj-sync-' + n);
  if (me.synced) {                       // turn OFF, keep current tempo
    me.synced = false;
    if (btn) btn.classList.remove('on');
    return;
  }
  const myBpm = _bpm(me), otherBpm = _bpm(other);
  if (!myBpm || !otherBpm) { flashSync(n, 'no BPM'); return; }
  // 1) Tempo: set my rate so my effective BPM equals the other's effective BPM.
  const otherEff = otherBpm * other.baseRate;
  let rate = otherEff / myBpm;
  while (rate > 1.5) rate /= 2;          // fold octave-off BPM detections (e.g. 75 vs 150)
  while (rate < 0.67) rate *= 2;
  rate = Math.max(0.5, Math.min(2, rate));
  me.setRate(rate);
  if (root) { const sl = root.querySelector('#dj-tempo-' + n); if (sl) sl.value = Math.max(-100, Math.min(100, Math.round((rate - 1) / TEMPO_RANGE * 100))); }
  // 2) Phase: align my beat to the other deck's beat, measured from each deck's
  //    beat grid (the manually-set down-beat) so they actually line up.
  if (me.buffer && other.buffer) {
    const myBeat = 60 / (myBpm * rate);              // effective sec/beat
    const otherBeat = 60 / otherEff;
    const ph = (pos, beat, off) => { let p = ((pos - off) % beat) / beat; return p < 0 ? p + 1 : p; };
    const otherPhase = ph(other.position(), otherBeat, other.gridOffset || 0);
    const myPhase = ph(me.position(), myBeat, me.gridOffset || 0);
    let dphase = otherPhase - myPhase;
    if (dphase > 0.5) dphase -= 1; if (dphase < -0.5) dphase += 1;   // shift to nearest beat
    me.head = Math.max(0, Math.min(me.buffer.length - 1, me.head + dphase * myBeat * me.buffer.sampleRate));
  }
  me.synced = true;
  other.synced = false;                 // single follower — the other deck is the master
  me._syncI = 0;
  if (btn) btn.classList.add('on');
  const obtn = root && root.querySelector('#dj-sync-' + (n === 1 ? 2 : 1));
  if (obtn) obtn.classList.remove('on');
  render();
}
function flashSync(n, ok) {
  if (!root) return;
  const b = root.querySelector('#dj-sync-' + n);
  if (!b) return;
  b.classList.toggle('on', ok === true);
  if (ok !== true) { b.textContent = 'SYNC ' + ok; setTimeout(() => { b.textContent = 'SYNC'; }, 1200); }
}

// ── Inline UI ────────────────────────────────────────────────────────────────
let root = null;
const JOG_R = 38;
const JOG_C = 2 * Math.PI * JOG_R;

// One deck "side" — laid out like the FLX4: top button row, big jog, then
// SHIFT/CUE/PLAY + an 8-pad grid + tempo fader.  Mixer knobs live in the centre.
function deckSide(n) {
  const pads = [0, 1, 2, 3, 4, 5, 6, 7].map(i => `<button class="dj-pad" data-i="${i}">${i + 1}</button>`).join('');
  return `
  <div class="dj-side" data-deck="${n}">
    <div class="dj-disp">
      <div class="dj-disp-txt"><span class="dj-d-title" id="dj-title-${n}">— empty —</span>
        <span class="dj-d-meta" id="dj-meta-${n}"></span></div>
      <div class="dj-gridctl" title="Beat grid">
        <button class="dj-gbtn" id="dj-gridset-${n}" title="Set down-beat to playhead">⊞</button>
        <button class="dj-gbtn" id="dj-gridl-${n}" title="Nudge grid earlier">‹</button>
        <button class="dj-gbtn" id="dj-gridr-${n}" title="Nudge grid later">›</button>
      </div>
    </div>
    <div class="dj-toprow">
      <button class="dj-mini" id="dj-in-${n}" title="Loop IN">IN</button>
      <button class="dj-mini" id="dj-out-${n}" title="Loop OUT (press again to exit)">OUT</button>
      <button class="dj-mini" id="dj-exit-${n}" title="Exit loop">EXIT</button>
      <button class="dj-mini" id="dj-call-prev-${n}" title="Loop shorter">◄</button>
      <span class="dj-looplen" id="dj-looplen-${n}" title="Loop length (beats)">4</span>
      <button class="dj-mini" id="dj-call-next-${n}" title="Loop longer">►</button>
      <button class="dj-mini dj-sync" id="dj-sync-${n}" title="Beat sync to the other deck">SYNC</button>
      ${n === 1 ? '<button class="dj-mini dj-q on" id="dj-quantize" title="Quantize — snap hot cues & loop points to the beat grid">Q</button>' : ''}
    </div>
    <div class="dj-jog" id="dj-jog-${n}" title="Drag to scratch">
      <svg viewBox="0 0 ${JOG_R * 2 + 12} ${JOG_R * 2 + 12}"><circle cx="${JOG_R + 6}" cy="${JOG_R + 6}" r="${JOG_R}" class="dj-jog-track"/>
        <circle cx="${JOG_R + 6}" cy="${JOG_R + 6}" r="${JOG_R}" class="dj-jog-prog" id="dj-prog-${n}"/></svg>
      <div class="dj-jog-hub"></div>
      <div class="dj-bpm" id="dj-bpm-${n}">—</div>
      <input class="dj-bpmedit" id="dj-bpmedit-${n}" type="text" inputmode="decimal" title="Type BPM, Enter to set">
      <div class="dj-jog-dot" id="dj-dot-${n}"></div>
    </div>
    <canvas class="dj-ovw" id="dj-ovw-${n}" title="Whole track — click or drag to jump"></canvas>
    <div class="dj-deckbottom">
      <div class="dj-pcol">
        <button class="dj-shift" id="dj-shift-${n}" title="SHIFT (hold; + hot-cue pad clears it)">SHIFT</button>
        <button class="dj-cue" id="dj-cue-${n}">CUE</button>
        <button class="dj-play" id="dj-play-${n}">▶</button>
      </div>
      <div class="dj-pads" id="dj-pads-${n}" title="Hot cues — click set/jump, right-click (or SHIFT) clears">${pads}</div>
      <label class="dj-tempocol">TEMPO<input type="range" class="dj-tempo" id="dj-tempo-${n}" min="-100" max="100" step="1" value="0"></label>
    </div>
  </div>`;
}

// Centre mixer — two knob columns (TRIM/HI/MID/LOW/CFX per deck), channel CUE +
// faders, crossfader, master.  Mirrors the FLX4's centre section.
function centerMixer() {
  const kn = (band, n, label) => `<div class="dj-kn"><div class="dj-dial" id="dj-${band}-${n}"><i></i></div><label>${label}</label></div>`;
  const col = (n) => `<div class="dj-kcol">${kn('trim', n, 'TRIM')}${kn('hi', n, 'HI')}${kn('mid', n, 'MID')}${kn('low', n, 'LOW')}${kn('cfx', n, 'CFX')}</div>`;
  const ch = (n) => `<div class="dj-ch"><button class="dj-chcue" id="dj-chcue-${n}" title="Channel cue (monitor)">CUE</button>
      <input type="range" class="dj-vol" id="dj-vol-${n}" min="0" max="100" step="1" value="80"></div>`;
  return `
  <div class="dj-center">
    <button class="dj-keylock on" id="dj-keylock" title="Key Lock — change tempo without changing pitch (time-stretch)">♪ KEY LOCK</button>
    <label class="dj-mstr" title="Master level">MSTR<input type="range" id="dj-master" min="0" max="100" step="1" value="90"></label>
    <div class="dj-knobcols">${col(1)}${col(2)}</div>
    <div class="dj-chrow">${ch(1)}${ch(2)}</div>
    <div class="dj-xfrow"><span>A</span><input type="range" class="dj-xf" id="dj-xf" min="0" max="100" step="1" value="50"><span>B</span></div>
  </div>`;
}

function mount() {
  const host = document.getElementById('dj-mount');
  if (!host) { setTimeout(mount, 300); return; }   // wait for music.js to build the panel
  if (root) return;                                 // already mounted
  injectCSS();
  host.innerHTML = `
    <div class="dj-inline">
      <canvas class="dj-dual" id="dj-dual" height="120" title="A (top) / B (bottom) — line up the beats to match"></canvas>
      <div class="dj-board">
        ${deckSide(1)}
        ${centerMixer()}
        ${deckSide(2)}
      </div>
    </div>`;
  root = host.querySelector('.dj-inline');

  for (const n of [1, 2]) {
    const d = ensureDecks()[n - 1];
    root.querySelector('#dj-play-' + n).addEventListener('click', () => d.toggle());
    root.querySelector('#dj-cue-' + n).addEventListener('click', () => d.cuePress());
    root.querySelector('#dj-sync-' + n).addEventListener('click', () => syncDeck(n));
    setupKnob(root.querySelector('#dj-trim-' + n), 0, 2, 1, v => d.setTrim(v));
    setupKnob(root.querySelector('#dj-hi-' + n), -26, 6, 0, v => d.setEQ('high', v));
    setupKnob(root.querySelector('#dj-mid-' + n), -26, 6, 0, v => d.setEQ('mid', v));
    setupKnob(root.querySelector('#dj-low-' + n), -26, 6, 0, v => d.setEQ('low', v));
    setupKnob(root.querySelector('#dj-cfx-' + n), -1, 1, 0, v => d.setCFX(v));
    root.querySelector('#dj-shift-' + n).addEventListener('click', () => d.toggleShift());
    root.querySelector('#dj-in-' + n).addEventListener('click', () => d.loopIn());
    root.querySelector('#dj-out-' + n).addEventListener('click', () => d.loopOut());
    root.querySelector('#dj-exit-' + n).addEventListener('click', () => d.loopExit());
    root.querySelector('#dj-call-prev-' + n).addEventListener('click', () => d.loopShorter());
    root.querySelector('#dj-call-next-' + n).addEventListener('click', () => d.loopLonger());
    root.querySelector('#dj-gridset-' + n).addEventListener('click', () => d.setGrid());
    root.querySelector('#dj-gridl-' + n).addEventListener('click', () => d.nudgeGrid(-0.012));
    root.querySelector('#dj-gridr-' + n).addEventListener('click', () => d.nudgeGrid(0.012));
    root.querySelector('#dj-chcue-' + n).addEventListener('click', e => e.currentTarget.classList.toggle('on'));
    root.querySelectorAll('#dj-pads-' + n + ' .dj-pad').forEach(p => {
      const i = +p.dataset.i;
      p.addEventListener('click', () => d.hotcue(i));
      p.addEventListener('contextmenu', e => { e.preventDefault(); d.clearHotcue(i); });
    });
    root.querySelector('#dj-vol-' + n).addEventListener('input', e => { d.vol.gain.value = e.target.value / 100; });
    root.querySelector('#dj-tempo-' + n).addEventListener('input', e => {
      if (d.synced) { d.synced = false; d._syncI = 0; const b = root.querySelector('#dj-sync-' + n); if (b) b.classList.remove('on'); }  // manual override
      d.setRate(1 + (e.target.value / 100) * TEMPO_RANGE);
    });
    setupJog(n, d);
    setupOverview(n, d);
  }
  root.querySelector('#dj-xf').addEventListener('input', e => { xfPos = e.target.value / 100; applyCrossfader(); });
  root.querySelector('#dj-master').addEventListener('input', e => { master().gain.value = e.target.value / 100; });
  root.querySelector('#dj-keylock').addEventListener('click', e => { KEYLOCK = !KEYLOCK; e.currentTarget.classList.toggle('on', KEYLOCK); if (decks) decks.forEach(d => d._tsReset()); });
  root.querySelector('#dj-quantize').addEventListener('click', e => { QUANTIZE = !QUANTIZE; e.currentTarget.classList.toggle('on', QUANTIZE); });

  // Drag the dual waveform to scrub/scratch a deck (top lane = Deck 1, bottom = Deck 2).
  const dual = root.querySelector('#dj-dual');
  let dd = null, dLastX = 0, dLastT = 0;
  dual.addEventListener('pointerdown', (e) => {
    const r = dual.getBoundingClientRect();
    const d = decks[(e.clientY - r.top) < r.height / 2 ? 0 : 1];
    if (!d.buffer) return;
    dd = d; d.scratchStart(); dLastX = e.clientX; dLastT = performance.now();
    dual.setPointerCapture(e.pointerId); e.preventDefault();
  });
  dual.addEventListener('pointermove', (e) => {
    if (!dd) return;
    const dx = e.clientX - dLastX; dLastX = e.clientX;
    const rate = (dd.synced && dd._matchRate) ? dd._matchRate : (dd.baseRate || 1);
    dd.scratchBy(-dx * (rate / DUAL_PXPS) * dd.buffer.sampleRate);   // drag right = pull track back (vinyl)
  });
  dual.addEventListener('pointerup', () => { if (dd) { dd.scratchEnd(); dd = null; } });

  applyCrossfader();
  render();
  requestAnimationFrame(tick);
  setInterval(syncPLL, 25);   // sync correction on a fixed timer (immune to rAF throttling when unfocused)
}

function renderShift(n) { const d = decks && decks[n - 1], b = root && root.querySelector('#dj-shift-' + n); if (b && d) b.classList.toggle('on', d.shift); }
function renderLoop(n) {
  const d = decks && decks[n - 1]; if (!root || !d) return;
  const inb = root.querySelector('#dj-in-' + n), out = root.querySelector('#dj-out-' + n);
  if (out) out.classList.toggle('on', d.loopOn);
  if (inb) inb.classList.toggle('on', !d.loopOn && d.loopStart >= 0);
  const len = root.querySelector('#dj-looplen-' + n);
  if (len) {
    const b = d.loopBeats || 4;
    len.textContent = (b >= 1 ? (Math.round(b * 4) / 4) : ('1/' + Math.round(1 / b)));
    len.classList.toggle('on', d.loopOn);
  }
}

const HOTCUE_COLORS = ['#ff3b30','#ff9a3a','#ffd60a','#34c759','#32d0d0','#3a78ff','#a050ff','#ff4fa0'];
function renderPads(n) {
  const d = decks && decks[n - 1];
  if (!root || !d) return;
  root.querySelectorAll('#dj-pads-' + n + ' .dj-pad').forEach(p => {
    const i = +p.dataset.i, set = d.hotcues[i] != null;
    p.classList.toggle('set', set);
    p.style.background = set ? HOTCUE_COLORS[i] : '';
    p.style.color = set ? '#0a0a0a' : '';
  });
}

// Rotary knob: neutral value sits at 12 o'clock (centred); drag up/down to turn,
// double-click to reset to neutral.  Asymmetric ranges (e.g. -26..+6) map their
// neutral to centre so the cut/boost sides feel balanced like a real EQ knob.
function setupKnob(el, min, max, neutral, onChange) {
  const ind = el.querySelector('i');
  let val = neutral;
  const angleFor = (v) => v >= neutral
    ? (v - neutral) / (max - neutral) * 135
    : (v - neutral) / (neutral - min) * 135;
  const valFor = (a) => {
    a = Math.max(-135, Math.min(135, a));
    return a >= 0 ? neutral + a / 135 * (max - neutral) : neutral + a / 135 * (neutral - min);
  };
  const apply = () => { ind.style.transform = 'rotate(' + angleFor(val) + 'deg)'; el.classList.toggle('active', Math.abs(val - neutral) > 0.5); onChange(val); };
  let dragging = false, startY = 0, startA = 0;
  el.addEventListener('pointerdown', (e) => { dragging = true; startY = e.clientY; startA = angleFor(val); el.setPointerCapture(e.pointerId); e.preventDefault(); });
  el.addEventListener('pointermove', (e) => { if (!dragging) return; val = Math.max(min, Math.min(max, valFor(startA + (startY - e.clientY) * 1.6))); apply(); });
  el.addEventListener('pointerup', () => { dragging = false; });
  el.addEventListener('dblclick', () => { val = neutral; apply(); });
  el.__setVal = (v) => { val = Math.max(min, Math.min(max, v)); apply(); };
  apply();
}

const JOG_REV_SEC = 2.6;  // seconds of audio moved per full platter revolution (position-following)
const SCRATCH_EASE = 0.0016;  // how fast the head chases the pointer target (per sample); smooths the scratch sound
const NUDGE_SENS = 0.28;  // ring nudge sensitivity (turns/sec → tempo bend)
const JOG_MIDI_SAMPLES = 22;  // samples moved per hardware jog tick (lower = more precise scrub)
// Two zones, like a real jog: the INNER PLATTER scratches (and holds/pauses the
// track while pressed); the OUTER RING pitch-bends (nudges the whole track
// slightly forward/back) for fine beat-matching without stopping playback.
function setupJog(n, d) {
  const jog = root.querySelector('#dj-jog-' + n);
  let mode = null, lastA = 0, lastT = 0;
  const geom = (e) => {
    const r = jog.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const dx = e.clientX - cx, dy = e.clientY - cy;
    let a = Math.atan2(dx, -dy); if (a < 0) a += Math.PI * 2;
    return { a, rad: Math.hypot(dx, dy) / (r.width / 2) };
  };
  jog.addEventListener('pointerdown', (e) => {
    if (!d.buffer) return;
    const { a, rad } = geom(e);
    mode = rad < 0.62 ? 'scratch' : 'nudge';          // centre platter vs outer ring
    lastA = a; lastT = performance.now();
    if (mode === 'scratch') d.scratchStart();         // grab platter → head follows finger
    jog.setPointerCapture(e.pointerId); e.preventDefault();
  });
  jog.addEventListener('pointermove', (e) => {
    if (!mode) return;
    const { a } = geom(e), now = performance.now();
    let da = a - lastA; if (da > Math.PI) da -= 2 * Math.PI; if (da < -Math.PI) da += 2 * Math.PI;
    const dt = Math.max(0.004, (now - lastT) / 1000); lastA = a; lastT = now;
    if (mode === 'scratch') {                          // rotate → move the track directly
      d.scratchBy((da / (2 * Math.PI)) * JOG_REV_SEC * d.buffer.sampleRate);
    } else {
      const turnsPerSec = (da / (2 * Math.PI)) / dt;
      d.bend = Math.max(-0.6, Math.min(0.6, turnsPerSec * NUDGE_SENS));   // nudge forward/back
    }
  });
  jog.addEventListener('pointerup', () => {
    if (mode === 'scratch') d.scratchEnd();           // release → resume normal play
    else if (mode === 'nudge') d.bend = 0;
    mode = null;
  });
  // Double-click the platter centre → inline editable BPM box (no popup).
  const edit = root.querySelector('#dj-bpmedit-' + n);
  const bpmEl = root.querySelector('#dj-bpm-' + n);
  const commit = (save) => {
    if (save) {
      const targetBpm = parseFloat(edit.value), intr = _bpm(d);
      if (isFinite(targetBpm) && targetBpm > 0 && intr > 0) {
        let rate = Math.max(0.25, Math.min(4, targetBpm / intr));   // change actual playback tempo
        if (d.synced) { d.synced = false; d._syncI = 0; const b = root.querySelector('#dj-sync-' + n); if (b) b.classList.remove('on'); }
        d.setRate(rate);
        const sl = root.querySelector('#dj-tempo-' + n);            // mirror on the tempo fader (clamped)
        if (sl) sl.value = Math.max(-100, Math.min(100, Math.round((rate - 1) / TEMPO_RANGE * 100)));
      }
    }
    edit.classList.remove('on'); if (bpmEl) bpmEl.style.visibility = ''; render();
  };
  jog.addEventListener('dblclick', (e) => {
    if (!d.buffer) return;
    const { rad } = geom(e); if (rad >= 0.62) return;
    const eff = _bpm(d) * (d.baseRate || 1);                        // current playing BPM
    edit.value = eff ? eff.toFixed(2) : '';
    if (bpmEl) bpmEl.style.visibility = 'hidden';
    edit.classList.add('on'); edit.focus(); edit.select();
    e.preventDefault();
  });
  edit.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { commit(true); e.preventDefault(); }
    else if (e.key === 'Escape') { commit(false); e.preventDefault(); }
    e.stopPropagation();
  });
  edit.addEventListener('blur', () => commit(true));
  edit.addEventListener('pointerdown', (e) => e.stopPropagation());   // don't start a scratch
}

// Split the track into low/mid/high band amplitudes at ~200 columns/sec, used
// by the dual scrolling waveform (low=yellow, mid=blue, high=red).
function buildBands(buffer) {
  const sr = buffer.sampleRate, data = buffer.getChannelData(0), n = data.length;
  const aLow = Math.exp(-2 * Math.PI * 220 / sr);     // one-pole cutoffs (cheap, overlapping)
  const aHi = Math.exp(-2 * Math.PI * 2600 / sr);
  const colSamp = Math.max(1, Math.round(sr / 420));   // ~420 cols/sec → finer transient detail
  const cols = Math.ceil(n / colSamp) + 1;
  const L = new Float32Array(cols), Md = new Float32Array(cols), H = new Float32Array(cols);
  let lp = 0, lp2 = 0, accL = 0, accM = 0, accH = 0, cnt = 0, idx = 0;
  for (let i = 0; i < n; i++) {
    const x = data[i];
    lp = aLow * lp + (1 - aLow) * x;                  // low band
    lp2 = aHi * lp2 + (1 - aHi) * x;
    const low = lp, high = x - lp2, mid = x - low - high;
    accL += low * low; accM += mid * mid; accH += high * high; cnt++;
    if (cnt >= colSamp) { L[idx] = Math.sqrt(accL / cnt); Md[idx] = Math.sqrt(accM / cnt); H[idx] = Math.sqrt(accH / cnt); idx++; accL = accM = accH = 0; cnt = 0; }
  }
  // Normalize by the ~88th-percentile column energy (not the max) so loud and
  // quiet tracks render at consistent brightness — keeps Deck A and B's palette
  // matched regardless of mastering level.
  const tots = new Float32Array(idx);
  for (let i = 0; i < idx; i++) tots[i] = L[i] + Md[i] + H[i];
  const sorted = Array.prototype.slice.call(tots).sort((a, b) => a - b);
  const ref = sorted[Math.floor(idx * 0.88)] || sorted[idx - 1] || 1;
  const norm = ref > 0 ? 1 / ref : 1;
  for (let i = 0; i < idx; i++) { L[i] *= norm; Md[i] *= norm; H[i] *= norm; }
  return { L, M: Md, H, cps: sr / colSamp, len: idx };
}

const DUAL_PXPS = 130;   // dual-waveform zoom: pixels per second (tunable)
function drawDual() {
  const cv = root && root.querySelector('#dj-dual');
  if (!cv || !decks) return;
  const W = cv.clientWidth | 0; if (!W) return;
  const H = 150; if (cv.width !== W) cv.width = W; if (cv.height !== H) cv.height = H;
  const g = cv.getContext('2d');
  g.fillStyle = '#070708'; g.fillRect(0, 0, W, H);
  const cx = W / 2, laneH = H / 2;
  for (let di = 0; di < 2; di++) {
    const d = decks[di]; const laneTop = di * laneH, laneMid = laneTop + laneH / 2, half = laneH * 0.46;
    if (!d || !d.buffer) continue;
    const sr = d.buffer.sampleRate, curSec = d.head / sr;
    // Draw in REAL time, scaled by a STABLE playback rate (the synced target, not
    // the per-frame PLL correction).  So the grid stays glued to the waveform AND
    // two synced decks share the same px scale → their grids stay locked together.
    const rate = (d.synced && d._matchRate) ? d._matchRate : (d.baseRate || 1);
    const secPerPx = rate / DUAL_PXPS;
    const xOf = (ts) => cx + (ts - curSec) / secPerPx;     // track-seconds → pixel
    const w = d._wave;
    if (w) {
      for (let px = 0; px < W; px++) {
        const t = curSec + (px - cx) * secPerPx;
        if (t < 0) continue;
        let c0 = (t * w.cps) | 0; if (c0 >= w.len) continue;
        let c1 = ((curSec + (px + 1 - cx) * secPerPx) * w.cps) | 0; if (c1 <= c0) c1 = c0 + 1;
        // PEAK over every analysis column that falls under this pixel → transients survive
        let L = 0, Md = 0, Hi = 0;
        for (let c = c0; c < c1 && c < w.len; c++) { if (w.L[c] > L) L = w.L[c]; if (w.M[c] > Md) Md = w.M[c]; if (w.H[c] > Hi) Hi = w.H[c]; }
        const tot = L + Md + Hi || 1e-6;
        const amp = Math.min(1, tot * 0.95), h = amp * half;
        const r = ((Hi + L * 0.85) / tot * 255) | 0, gg = (L * 0.8 / tot * 255) | 0, b = (Md / tot * 255) | 0;
        g.fillStyle = 'rgb(' + r + ',' + gg + ',' + b + ')';
        g.fillRect(px, laneMid - h, 1, h * 2);
        g.fillStyle = 'rgba(255,255,255,0.16)';                 // bright peak caps for definition
        g.fillRect(px, laneMid - h, 1, 1); g.fillRect(px, laneMid + h - 1, 1, 1);
      }
    }
    const bpm = _bpm(d);
    if (bpm) {
      const beat = 60 / bpm, off = d.gridOffset || 0, eff = bpm * rate;
      const tLeft = curSec - cx * secPerPx;
      let k = Math.ceil((tLeft - off) / beat);
      for (; ; k++) {
        const x = xOf(off + k * beat);
        if (x > W) break; if (x < -20) continue;
        const down = ((((k % 4) + 4) % 4) === 0);
        if (down) {                                   // MEASURE line — bold, bright, numbered
          g.fillStyle = 'rgba(130,215,255,0.95)'; g.fillRect(x - 1, laneTop, 3, laneH);
          g.fillRect(x + 2, laneTop, 16, 13);
          g.fillStyle = '#04121a'; g.font = 'bold 10px system-ui'; g.textBaseline = 'top';
          g.fillText(Math.floor(k / 4) + 1, x + 4, laneTop + 2);
        } else {                                      // beat line — lighter mark + tick caps
          g.fillStyle = 'rgba(255,255,255,0.40)'; g.fillRect(x, laneTop, 1, laneH);
          g.fillStyle = 'rgba(170,225,255,0.85)';                 // bright cap top & bottom
          g.fillRect(x - 1, laneTop, 3, 5); g.fillRect(x - 1, laneTop + laneH - 5, 3, 5);
        }
      }
      const cb = Math.floor((curSec - off) / beat), bt = (((cb % 4) + 4) % 4) + 1;
      g.fillStyle = '#9fb0c0'; g.font = '10px system-ui'; g.textBaseline = 'top';
      g.fillText('DECK ' + (di + 1) + '   bar ' + (Math.floor(cb / 4) + 1) + '.' + bt + '   ' + Math.round(eff) + ' BPM', 7, laneTop + 5);
    }
    if (d.hotcues) {                                  // hot-cue markers
      for (let i = 0; i < d.hotcues.length; i++) {
        const s = d.hotcues[i]; if (s == null) continue;
        const x = xOf(s / sr); if (x < 0 || x > W) continue;
        g.fillStyle = HOTCUE_COLORS[i]; g.fillRect(x - 1, laneTop, 2, laneH); g.fillRect(x - 1, laneTop, 13, 11);
        g.fillStyle = '#0a0a0a'; g.font = 'bold 9px system-ui'; g.textBaseline = 'top'; g.fillText(i + 1, x + 2, laneTop + 1);
      }
    }
    if (d.loopStart >= 0 || d.loopEnd >= 0) {         // loop IN/OUT markers + region
      const x1 = d.loopStart >= 0 ? xOf(d.loopStart / sr) : null;
      const x2 = d.loopEnd >= 0 ? xOf(d.loopEnd / sr) : null;
      if (d.loopOn && x1 != null && x2 != null) { const a = Math.max(0, x1), b2 = Math.min(W, x2); if (b2 > a) { g.fillStyle = 'rgba(80,200,255,0.16)'; g.fillRect(a, laneTop, b2 - a, laneH); } }
      g.font = 'bold 8px system-ui'; g.textBaseline = 'top';
      if (x1 != null && x1 >= 0 && x1 <= W) { g.fillStyle = '#3ad08a'; g.fillRect(x1, laneTop, 2, laneH); g.fillRect(x1, laneTop, 13, 10); g.fillStyle = '#04140c'; g.fillText('IN', x1 + 2, laneTop + 1); }
      if (x2 != null && x2 >= 0 && x2 <= W) { g.fillStyle = '#ff5a5a'; g.fillRect(x2 - 2, laneTop, 2, laneH); g.fillRect(x2 - 15, laneTop, 15, 10); g.fillStyle = '#1a0404'; g.fillText('OUT', x2 - 14, laneTop + 1); }
    }
  }
  g.fillStyle = '#1b1b20'; g.fillRect(0, laneH - 0.5, W, 1);          // lane divider
  g.fillStyle = '#ff7a1a'; g.fillRect(cx - 1, 0, 2, H);              // center playhead
}

// Build a per-column amplitude array (0..1) for the waveform display.
function buildPeaks(buf, cols) {
  const data = buf.getChannelData(0);
  const block = Math.max(1, Math.floor(data.length / cols));
  const peaks = new Float32Array(cols);
  for (let x = 0; x < cols; x++) {
    let mx = 0; const s = x * block, e = Math.min(data.length, s + block);
    const step = Math.max(1, Math.floor((e - s) / 80));
    for (let i = s; i < e; i += step) { const v = Math.abs(data[i]); if (v > mx) mx = v; }
    peaks[x] = mx;
  }
  return peaks;
}

function drawWave(n, d) {
  const cv = root && root.querySelector('#dj-wave-' + n);
  if (!cv) return;
  const W = cv.clientWidth | 0; if (!W) return;            // hidden / not laid out yet
  const H = 44;
  if (cv.width !== W) cv.width = W;
  if (cv.height !== H) cv.height = H;
  const g = cv.getContext('2d'); g.clearRect(0, 0, W, H);
  if (!d._peaks || !d.buffer) return;
  const peaks = d._peaks, cols = peaks.length, mid = H / 2;
  const playX = (d.head / d.buffer.length) * W;
  for (let x = 0; x < W; x++) {
    const amp = peaks[(x / W * cols) | 0] || 0;
    const h = Math.max(1, amp * (H - 4));
    g.fillStyle = x <= playX ? '#ff9a3a' : '#54545c';      // played = orange, upcoming = grey
    g.fillRect(x, mid - h / 2, 1, h);
  }
  g.fillStyle = '#fff'; g.fillRect(Math.max(0, playX - 1), 0, 2, H);   // playhead
}

function paintJog(n, frac) {
  if (!root) return;
  const prog = root.querySelector('#dj-prog-' + n);
  const dot = root.querySelector('#dj-dot-' + n);
  if (prog) prog.style.strokeDashoffset = (JOG_C * (1 - (frac || 0))).toFixed(1);
  if (dot) dot.style.transform = 'rotate(' + ((frac || 0) * 360) + 'deg)';
}

// Whole-track overview strip: the entire song scaled to fit, with a playhead,
// loop region and hot-cue ticks.  Click / drag it to jump anywhere instantly.
function drawOverview(n) {
  const cv = root && root.querySelector('#dj-ovw-' + n); if (!cv) return;
  const d = decks && decks[n - 1];
  const cssW = cv.clientWidth | 0; if (!cssW) return;
  const dpr = Math.min(3, window.devicePixelRatio || 1);          // render at native res → finer detail
  const W = (cssW * dpr) | 0, H = (38 * dpr) | 0;
  if (cv.width !== W) cv.width = W; if (cv.height !== H) cv.height = H;
  const g = cv.getContext('2d');
  g.fillStyle = '#070708'; g.fillRect(0, 0, W, H);
  if (!d || !d.buffer || !d._wave) return;
  const w = d._wave, len = w.len, mid = H / 2, half = H * 0.46;
  for (let px = 0; px < W; px++) {
    const c0 = (px / W * len) | 0, c1 = Math.max(c0 + 1, ((px + 1) / W * len) | 0);
    let L = 0, Md = 0, Hi = 0;
    for (let c = c0; c < c1 && c < len; c++) { if (w.L[c] > L) L = w.L[c]; if (w.M[c] > Md) Md = w.M[c]; if (w.H[c] > Hi) Hi = w.H[c]; }
    const tot = L + Md + Hi || 1e-6, amp = Math.min(1, tot * 0.95), h = amp * half;
    const r = ((Hi + L * 0.85) / tot * 255) | 0, gg = (L * 0.8 / tot * 255) | 0, b = (Md / tot * 255) | 0;
    g.fillStyle = 'rgb(' + r + ',' + gg + ',' + b + ')';
    g.fillRect(px, mid - h, 1, h * 2);
  }
  const total = d.buffer.length;
  const xAt = (samp) => (samp / total) * W;
  if (d.loopOn && d.loopStart >= 0 && d.loopEnd >= 0) {           // loop region
    const x1 = xAt(d.loopStart), x2 = xAt(d.loopEnd);
    g.fillStyle = 'rgba(255,180,40,0.18)'; g.fillRect(x1, 0, Math.max(1, x2 - x1), H);
  }
  if (d.hotcues) for (let i = 0; i < d.hotcues.length; i++) {     // hot-cue ticks
    const s = d.hotcues[i]; if (s == null) continue;
    g.fillStyle = HOTCUE_COLORS[i]; g.fillRect(xAt(s), 0, dpr, H);
  }
  const px = xAt(d.head);                                          // playhead
  g.fillStyle = '#fff'; g.fillRect(Math.max(0, px - dpr), 0, 2 * dpr, H);
}

// Click / drag the overview strip to seek that deck anywhere in the song.
function setupOverview(n, d) {
  const cv = root.querySelector('#dj-ovw-' + n); if (!cv) return;
  let dragging = false;
  const seek = (e) => {
    if (!d.buffer) return;
    const r = cv.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    d.head = frac * (d.buffer.length - 1);
    d.scratchTarget = d.head; d._tsReset && d._tsReset();
  };
  cv.addEventListener('pointerdown', (e) => { dragging = true; cv.setPointerCapture(e.pointerId); seek(e); e.preventDefault(); });
  cv.addEventListener('pointermove', (e) => { if (dragging) seek(e); });
  cv.addEventListener('pointerup', () => { dragging = false; });
}

function render() {
  if (!root || !decks) return;
  for (const n of [1, 2]) {
    const d = decks[n - 1];
    const t = d.trackId && M.byId[d.trackId];
    const a = (d.trackId && M.analysis[d.trackId]) || {};
    const title = root.querySelector('#dj-title-' + n);
    const meta = root.querySelector('#dj-meta-' + n);
    if (title) title.textContent = t ? t.title : '— empty —';
    if (meta) meta.textContent = t ? ((a.camelot ? a.camelot + '  ' : '') + (a.key || '') + (a.bpm ? '  ' + a.bpm : '')) : '';
    const playBtn = root.querySelector('#dj-play-' + n);
    if (playBtn) { playBtn.textContent = d.playing ? '⏸' : '▶'; playBtn.classList.toggle('on', d.playing); }
    renderPads(n); renderShift(n); renderLoop(n);
  }
}

// Phase-locked loop: while a deck is synced, continuously nudge its rate to keep
// BOTH its tempo and beat phase locked to the master deck — otherwise rounded
// BPMs drift apart over time.  PI controller on the beat-phase error.
function syncPLL() {
  if (!decks) return;
  const now = performance.now(); const dt = Math.min(0.1, (now - (syncPLL._t || now)) / 1000); syncPLL._t = now;
  for (let i = 0; i < 2; i++) {
    const d = decks[i], o = decks[1 - i];
    if (!(d.synced && d.playing && o.playing && !o.synced)) { if (!d.synced) d._syncI = 0; continue; }
    const db = _bpm(d), ob = _bpm(o); if (db <= 0 || ob <= 0) continue;
    const masterEff = ob * (o._matchRate && o.synced ? o._matchRate : o.baseRate);
    let matchRate = masterEff / db;
    while (matchRate > 1.5) matchRate /= 2; while (matchRate < 0.67) matchRate *= 2;   // octave fold
    matchRate = Math.max(0.5, Math.min(2, matchRate));
    d._matchRate = matchRate;                                  // stable target (for the BPM display)
    // position() is TRACK seconds, so phase must use each deck's INTRINSIC beat
    // length (60/bpm), not the rate-scaled one — otherwise the lock target is
    // wrong whenever the rate ≠ 1 and the decks slowly drift.
    const phOf = (deck, bpm) => { const b = 60 / bpm; let p = ((deck.position() - (deck.gridOffset || 0)) % b) / b; return p < 0 ? p + 1 : p; };
    let err = phOf(o, ob) - phOf(d, db);
    if (err > 0.5) err -= 1; if (err < -0.5) err += 1;          // signed beat-phase error
    // Overdamped PI: strong-ish P (first-order, can't oscillate) + a TINY integral
    // to remove residual tempo offset.  Keeping integral gain ≪ (Kp/2)² avoids the
    // back-and-forth tempo modulation that a hot integral causes.
    d._syncI = Math.max(-0.08, Math.min(0.08, (d._syncI || 0) + err * dt * 0.02));   // faster trim, still overdamped (Kp=0.35)
    const corr = Math.max(-0.08, Math.min(0.08, 0.35 * err + d._syncI));
    const target = matchRate * (1 + corr);
    d.baseRate += (target - d.baseRate) * 0.2;                 // light low-pass for smooth pitch
  }
}

function tick() {
  requestAnimationFrame(tick);
  if (!root || !decks) return;
  drawDual();
  for (const n of [1, 2]) {
    const d = decks[n - 1];
    if (d.buffer) paintJog(n, d.head / d.buffer.length);   // live head incl. scratching
    drawOverview(n);
    const bp = _bpm(d);
    const el = root.querySelector('#dj-bpm-' + n);
    if (el) {
      // Show the STABLE tempo: the synced target rate (not the per-frame PLL correction).
      const rate = (d.synced && d._matchRate) ? d._matchRate : d.baseRate;
      el.textContent = bp ? (bp * rate).toFixed(1) : '—';
    }
  }
}

async function load(num, trackId) { await ensureDecks()[num - 1].load(trackId); }
function stopAll() { if (decks) decks.forEach(d => { d.pause(); }); }

// ── CSS (compact FLX4: matte black + Pioneer orange) ─────────────────────────
function injectCSS() {
  const css = `
  #dj-mount{width:100%}
  .dj-inline{display:flex;flex-direction:column;gap:10px}
  /* ── FLX4-style 3-column board: Deck 1 | centre mixer | Deck 2 ── */
  .dj-board{display:flex;gap:8px;align-items:stretch}
  .dj-side{flex:1;min-width:0;background:#0e0e10;border:1px solid #242428;border-radius:10px;
    padding:8px;display:flex;flex-direction:column;align-items:center;gap:7px}
  .dj-disp{width:100%;background:#000;border-radius:6px;padding:4px 7px;min-height:28px;
    display:flex;align-items:center;gap:6px;border:1px solid #222}
  .dj-disp-txt{flex:1;min-width:0;display:flex;flex-direction:column}
  .dj-d-title{font-size:11px;color:#9fe7ff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .dj-d-meta{font-size:10px;color:#ff9a4a;font-variant-numeric:tabular-nums}
  .dj-gridctl{display:flex;gap:2px;flex:0 0 auto}
  .dj-gbtn{width:20px;height:20px;border-radius:4px;border:1px solid #33333a;background:#16161a;
    color:#9fe7ff;font:700 11px system-ui;cursor:pointer;line-height:1}
  .dj-gbtn:hover{border-color:#4f8fcf;color:#fff}
  .dj-toprow{display:flex;gap:3px;width:100%;justify-content:center;flex-wrap:wrap}
  .dj-mini{height:22px;min-width:24px;padding:0 6px;border-radius:5px;border:1px solid #33333a;
    background:#17171b;color:#bdbdc4;font:700 9px system-ui;letter-spacing:.03em;cursor:pointer}
  .dj-mini:hover{border-color:#55555f;color:#fff}
  .dj-mini.dj-sync{border-color:#2f4f6f;color:#8fd0ff;background:#16202c}
  .dj-mini.on{background:#1f8fff;color:#06121f;border-color:#5fb0ff;box-shadow:0 0 7px rgba(40,150,255,0.5)}
  .dj-mini.dj-q{border-color:#2f6f4f;color:#9fe9b4;background:#16261c;font-weight:700}
  .dj-mini.dj-q.on{background:rgba(110,220,140,0.28);color:#baffce;border-color:rgba(110,220,140,0.6);box-shadow:0 0 7px rgba(110,220,140,0.5)}
  .dj-looplen{min-width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;
    border-radius:5px;background:#0a0a0c;border:1px solid #33333a;color:#9a9aa2;
    font:700 9px system-ui;font-variant-numeric:tabular-nums;padding:0 3px}
  .dj-looplen.on{color:#5fb0ff;border-color:#2f6f9f}
  .dj-jog{position:relative;width:210px;height:210px;cursor:grab;touch-action:none;margin:6px 0}
  .dj-jog:active{cursor:grabbing}
  .dj-jog svg{position:absolute;inset:0;width:100%;height:100%;transform:rotate(-90deg)}
  .dj-jog-track{fill:none;stroke:#2a2a2e;stroke-width:5}
  .dj-jog-prog{fill:none;stroke:#ff7a1a;stroke-width:5;stroke-linecap:round;
    stroke-dasharray:${JOG_C.toFixed(1)};stroke-dashoffset:${JOG_C.toFixed(1)}}
  .dj-jog-hub{position:absolute;inset:36px;border-radius:50%;
    background:radial-gradient(circle at 50% 38%,#2e2e33,#121214 78%);border:1px solid #3a3a40}
  .dj-jog-dot{position:absolute;top:7px;left:50%;width:5px;height:20px;margin-left:-2.5px;
    background:#ff7a1a;border-radius:2px;transform-origin:2.5px 98px}
  .dj-bpm{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);text-align:center;
    color:#ffcf8a;font:700 20px system-ui;font-variant-numeric:tabular-nums;pointer-events:none;
    text-shadow:0 1px 3px #000}
  .dj-bpm::after{content:'BPM';display:block;font-size:7px;color:#9a8a6a;letter-spacing:.1em;margin-top:1px}
  .dj-bpmedit{display:none;position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);
    width:62px;text-align:center;background:#0c0c0e;color:#ffcf8a;border:1px solid #ff9a4a;border-radius:5px;
    font:700 18px system-ui;font-variant-numeric:tabular-nums;padding:2px 0;outline:none;z-index:5}
  .dj-bpmedit.on{display:block}
  .dj-dual{width:100%;height:150px;display:block;background:#070708;border:1px solid #1f1f24;
    border-radius:8px;cursor:grab;touch-action:none}
  .dj-dual:active{cursor:grabbing}
  .dj-ovw{width:100%;height:38px;display:block;background:#070708;border:1px solid #1f1f24;
    border-radius:6px;margin-top:6px;cursor:pointer;touch-action:none}
  .dj-deckbottom{display:flex;gap:7px;width:100%;align-items:flex-end;justify-content:center;margin-top:auto}
  .dj-pcol{display:flex;flex-direction:column;gap:5px;align-items:center;flex:0 0 auto;justify-content:flex-end}
  .dj-cue,.dj-play{width:38px;height:38px;border-radius:50%;border:2px solid #3a3a40;
    background:#1a1a1e;color:#ddd;font:700 11px system-ui;cursor:pointer}
  .dj-play{font-size:15px}
  .dj-play.on{background:#ff7a1a;color:#111;border-color:#ff9a4a;box-shadow:0 0 12px rgba(255,122,26,0.6)}
  .dj-shift{height:20px;width:42px;border-radius:5px;border:1px solid #33333a;background:#17171b;
    color:#9a9aa2;font:700 8px system-ui;letter-spacing:.05em;cursor:pointer}
  .dj-shift.on{background:#cfcf36;color:#1a1a06;border-color:#e6e64a}
  .dj-pads{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;flex:1;min-width:0;align-self:flex-end}
  .dj-pad{height:42px;border-radius:6px;border:1px solid #2c2c32;background:#16161a;
    color:#6a6a72;font:700 13px system-ui;cursor:pointer}
  .dj-pad.set{border-color:transparent;color:#0a0a0a;box-shadow:0 0 8px rgba(255,255,255,0.15)}
  .dj-pad:hover{border-color:#55555f}
  .dj-tempocol{display:flex;flex-direction:column;align-items:center;gap:3px;font-size:8px;color:#9a9aa0;flex:0 0 auto}
  .dj-tempocol input[type=range]{-webkit-appearance:slider-vertical;width:16px;height:92px;accent-color:#9fe7ff}
  /* centre mixer */
  .dj-center{flex:0 0 152px;display:flex;flex-direction:column;align-items:center;gap:9px;
    background:#0c0c0e;border:1px solid #242428;border-radius:10px;padding:8px}
  .dj-keylock{width:100%;border-radius:6px;border:1px solid #33333a;background:#17171b;
    color:#9a9aa2;font:700 9px system-ui;letter-spacing:.04em;padding:5px;cursor:pointer}
  .dj-keylock.on{background:rgba(110,220,140,0.2);border-color:rgba(110,220,140,0.5);color:#9fe9b4}
  .dj-mstr{display:flex;flex-direction:column;align-items:center;gap:2px;font:700 8px system-ui;color:#9a9aa0}
  .dj-mstr input{width:80px;accent-color:#ff7a1a}
  .dj-knobcols{display:flex;gap:18px;justify-content:center}
  .dj-kcol{display:flex;flex-direction:column;gap:9px;align-items:center}
  .dj-kn{display:flex;flex-direction:column;align-items:center;gap:3px}
  .dj-kn label{font:700 8px system-ui;color:#8a8a92;letter-spacing:.04em}
  .dj-dial{width:34px;height:34px;border-radius:50%;background:radial-gradient(circle at 50% 38%,#34343a,#161619);
    border:2px solid #44444c;position:relative;cursor:ns-resize;touch-action:none;
    box-shadow:0 2px 4px rgba(0,0,0,0.5),inset 0 1px 1px rgba(255,255,255,0.08)}
  .dj-dial.active{border-color:#ff9a4a;box-shadow:0 0 8px rgba(255,122,26,0.5)}
  .dj-dial i{position:absolute;left:50%;top:4px;width:2px;height:11px;margin-left:-1px;
    background:#ffcf8a;border-radius:1px;transform-origin:50% 13px;display:block}
  .dj-chrow{display:flex;gap:18px;justify-content:center;align-items:flex-end;margin-top:2px}
  .dj-ch{display:flex;flex-direction:column;align-items:center;gap:5px}
  .dj-chcue{width:34px;height:20px;border-radius:4px;border:1px solid #33333a;background:#17171b;
    color:#ff9a4a;font:700 9px system-ui;cursor:pointer}
  .dj-chcue.on{background:#ff7a1a;color:#160d05;border-color:#ff9a4a}
  .dj-ch input[type=range]{-webkit-appearance:slider-vertical;width:18px;height:88px;accent-color:#ff7a1a}
  .dj-xfrow{display:flex;align-items:center;gap:6px;width:100%}
  .dj-xfrow>span{font:700 10px system-ui;color:#ff9a4a}
  .dj-xf{flex:1;height:18px;accent-color:#ff7a1a}
  `;
  const s = document.createElement('style'); s.textContent = css; document.head.appendChild(s);
}

// ── DDJ-FLX4 MIDI map → decks (called from music.js MIDI bridge) ────────────
// Confirmed against the controller's rekordbox MIDI output.
function _eqDb(d2) { return d2 <= 64 ? -26 + (d2 / 64) * 26 : (d2 - 64) / 63 * 6; }
function _setSlider(id, val) { if (!root) return; const e = root.querySelector(id); if (e) e.value = val; }
function _setKnob(id, val) { if (!root) return; const e = root.querySelector(id); if (e && e.__setVal) e.__setVal(val); }

window.ArcaneMixerMIDI = function (status, d1, d2) {
  if (!M.djMode) return;                 // only steer the decks in DJ mode
  const hi = status & 0xf0, ch = status & 0x0f;
  const dks = ensureDecks();
  if (hi === 0xb0) {                      // Control Change (faders / knobs / jog)
    if (ch === 6 && d1 === 31) { xfPos = d2 / 127; applyCrossfader(); _setSlider('#dj-xf', Math.round(xfPos * 100)); return; }
    if (ch === 6 && d1 === 23) { _setKnob('#dj-cfx-1', (d2 - 64) / 63); return; }   // CFX deck 1
    if (ch === 6 && d1 === 24) { _setKnob('#dj-cfx-2', (d2 - 64) / 63); return; }   // CFX deck 2
    if (ch > 1) return;
    const d = dks[ch], dn = ch + 1;
    if (d1 === 19) { d.vol.gain.value = d2 / 127; _setSlider('#dj-vol-' + dn, Math.round(d2 / 127 * 100)); }
    else if (d1 === 0) { const pct = (d2 - 64) / 64 * 100; d.setRate(1 + (pct / 100) * TEMPO_RANGE); _setSlider('#dj-tempo-' + dn, Math.round(pct)); }
    else if (d1 === 4) { _setKnob('#dj-trim-' + dn, d2 / 127 * 2); }   // TRIM
    else if (d1 === 15) { _setKnob('#dj-hi-' + dn, _eqDb(d2)); }       // EQ (knob __setVal applies it)
    else if (d1 === 11) { _setKnob('#dj-mid-' + dn, _eqDb(d2)); }
    else if (d1 === 7) { _setKnob('#dj-low-' + dn, _eqDb(d2)); }
    else if (d1 === 34 || d1 === 33) {    // jog: position-following scratch (signed ticks, 64 = no move)
      if (d.buffer) {
        let t = d2 - 64; if (t > 64) t -= 128;          // wrap to signed −63..+64
        if (!d.scratching) d.scratchStart();            // resume ctx + anchor target on first tick
        d.scratchBy(t * JOG_MIDI_SAMPLES);              // each platter tick → fixed sample step (precise)
        clearTimeout(d._jogTO); d._jogTO = setTimeout(() => d.scratchEnd(), 90);
      }
    }
  } else if (hi === 0x90) {              // Note On / Off
    if (ch <= 1 && d1 === 63) { dks[ch].shift = d2 > 0; renderShift(ch + 1); return; }   // SHIFT (momentary)
    if (d2 === 0) return;                 // ignore other note-offs
    if (ch <= 1) {                        // transport / loop on deck channels
      const d = dks[ch];
      if (d1 === 11) d.toggle();          // PLAY
      else if (d1 === 12) d.cuePress();   // CUE
      else if (d1 === 88) syncDeck(ch + 1); // BEAT SYNC
      else if (d1 === 16) d.loopIn();     // LOOP IN
      else if (d1 === 17) d.loopOut();    // LOOP OUT
      else if (d1 === 77) d.fourBeatOrExit(); // 4 BEAT / EXIT
      else if (d1 === 81) d.loopShorter(); // CUE/LOOP CALL ◄  (½)
      else if (d1 === 83) d.loopLonger();  // CUE/LOOP CALL ►  (×2)
    } else if (ch === 7 && d1 <= 3) {     // performance pads (ch8) → Deck 1 hot cues
      dks[0].hotcue(d1);
    } else if (ch === 9 && d1 <= 3) {     // (guess) Deck 2 pads on ch10 — verify with capture
      dks[1].hotcue(d1);
    }
  }
};

window.ArcaneMixer = { load, mount, stopAll };
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
else mount();
})();
