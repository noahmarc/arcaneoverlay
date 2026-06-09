// avatar.js — layered top-down 8-bit paper-doll avatars for tokens.
// Players build a character look from swappable layers (skin, hair, armor,
// weapon, cloak, shield) with colors; the DM can also apply a monster "skin".
// Items can carry an `override` that patches layers (see ArcaneAvatar.merge).
(function () {
  'use strict';
  if (window.ArcaneAvatar) return;

  const DEFAULT = {
    skin: 'none',           // monster skin override; 'none' = humanoid paper-doll
    race: 'human',          // racial features (ears / tusks / horns / build)
    skinColor: '#e0b48c',   // body/flesh tone
    hair: 'short', hairColor: '#3a2410',
    beard: 'none',
    armor: 'leather', armorColor: '#4a6a8a',
    weapon: 'sword', metalColor: '#cfd6df',
    cloak: 'none', cloakColor: '#7a2020',
    shield: 'none',
  };

  // Per-race feature flags applied as overlays in the renderer.
  const RACES = {
    human:      {},
    elf:        { ears: 'pointed' },
    'half-elf': { ears: 'pointed' },
    dwarf:      { short: true, stocky: true, beardForce: 'full' },
    halfling:   { short: true, ears: 'round' },
    gnome:      { short: true, ears: 'pointed', bigNose: true },
    'half-orc': { tusks: true, skinTint: '#86a060' },
    orc:        { tusks: true, bigTusks: true, stocky: true, skinTint: '#5f8f44' },
    dragonborn: { snout: true, horns: 'ridge', noHair: true, scale: '#3a8a6a' },
    tiefling:   { horns: 'curved', skinTint: '#b8564a', tail: true },
  };

  const OPTIONS = {
    skin:   [['none', 'Humanoid'], ['slime', 'Slime'], ['goblin', 'Goblin'], ['skeleton', 'Skeleton'], ['wolf', 'Wolf'], ['dragon', 'Dragon'], ['beholder', 'Beholder']],
    race:   [['human', 'Human'], ['elf', 'Elf'], ['half-elf', 'Half-Elf'], ['dwarf', 'Dwarf'], ['halfling', 'Halfling'], ['gnome', 'Gnome'], ['half-orc', 'Half-Orc'], ['orc', 'Orc'], ['dragonborn', 'Dragonborn'], ['tiefling', 'Tiefling']],
    hair:   [['none', 'Bald'], ['buzz', 'Buzzed'], ['short', 'Short'], ['long', 'Long'], ['spiky', 'Spiky'], ['mohawk', 'Mohawk'], ['ponytail', 'Ponytail'], ['braids', 'Braids'], ['curly', 'Curly'], ['afro', 'Afro'], ['topknot', 'Top-knot']],
    beard:  [['none', 'None'], ['stubble', 'Stubble'], ['goatee', 'Goatee'], ['full', 'Full'], ['long', 'Long'], ['braided', 'Braided']],
    armor:  [['cloth', 'Cloth'], ['leather', 'Leather'], ['plate', 'Plate'], ['robe', 'Robe']],
    weapon: [['none', 'None'], ['sword', 'Sword'], ['greatsword', 'Greatsword'], ['axe', 'Axe'], ['mace', 'Mace'], ['hammer', 'Warhammer'], ['spear', 'Spear'], ['staff', 'Staff'], ['wand', 'Wand'], ['bow', 'Bow'], ['crossbow', 'Crossbow'], ['dagger', 'Dagger'], ['rapier', 'Rapier'], ['scythe', 'Scythe']],
    cloak:  [['none', 'None'], ['cloak', 'Cloak']],
    shield: [['none', 'None'], ['round', 'Round'], ['kite', 'Kite']],
  };

  function merge(base, override) {
    return Object.assign({}, DEFAULT, base || {}, override || {});
  }
  function _lighten(hex, f) {
    const n = parseInt(hex.slice(1), 16); let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    r = Math.min(255, r + (255 - r) * f) | 0; g = Math.min(255, g + (255 - g) * f) | 0; b = Math.min(255, b + (255 - b) * f) | 0;
    return `rgb(${r},${g},${b})`;
  }
  function _darken(hex, f) {
    const n = parseInt(hex.slice(1), 16); let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    r = (r * (1 - f)) | 0; g = (g * (1 - f)) | 0; b = (b * (1 - f)) | 0;
    return `rgb(${r},${g},${b})`;
  }


  // ── Renderer (24×24 front-facing RPG sprite — far more legible) ──────────────
  const G = 24;
  function render(ctx, x, y, size, avRaw, opts) {
    const av = merge(avRaw);
    const PX = size / G;
    const D = _darken, L = _lighten;
    const px = (gx, gy, col, w, h) => {
      if (gx < 0 || gy < 0 || gx >= G || gy >= G) return;
      ctx.fillStyle = col;
      ctx.fillRect(x + Math.round(gx * PX), y + Math.round(gy * PX), Math.max(1, Math.ceil((w || 1) * PX)), Math.max(1, Math.ceil((h || 1) * PX)));
    };
    if (!(opts && opts.noShadow)) {   // the board draws its own token shadow
      ctx.fillStyle = 'rgba(0,0,0,0.28)';
      ctx.beginPath(); ctx.ellipse(x + 12 * PX, y + 22.4 * PX, 7 * PX, 1.8 * PX, 0, 0, Math.PI * 2); ctx.fill();
    }

    if (av.skin && av.skin !== 'none') { _renderMonster(av.skin, px); return; }

    const feat = RACES[av.race] || {};
    const skin = feat.scale || feat.skinTint || av.skinColor;
    const hair = av.hairColor, armor = av.armorColor, metal = av.metalColor, cloak = av.cloakColor;
    const OUT = 'rgba(0,0,0,0.5)';
    // Per-race build: scale the whole figure (width/height) and shift it so each
    // race has a distinct silhouette (dwarf short&wide, elf tall&slim, etc.).
    const X = _raceXform(av.race), CX = 12, CY = 13;
    const tpx = (gx, gy, col, w, h) => px(CX + (gx - CX) * X.sx + (X.ox || 0), CY + (gy - CY) * X.sy + (X.oy || 0), col, (w || 1) * X.sx, (h || 1) * X.sy);
    const headBig = X.headBig || 1;   // extra head growth for small folk
    // tail (tiefling) — behind the body
    if (feat.tail) { tpx(17, 16, skin, 1, 5); tpx(18, 20, skin, 1, 2); tpx(17, 16, D(skin, 0.3), 1, 1); }
    if (av.cloak === 'cloak') { tpx(6, 9, cloak, 12, 12); tpx(5, 11, cloak, 1, 8); tpx(18, 11, cloak, 1, 8); tpx(6, 9, D(cloak, 0.3), 12, 1); tpx(6, 20, D(cloak, 0.35), 12, 1); }
    const leg = D(armor, 0.5), boot = D(armor, 0.72);
    tpx(9, 18, leg, 2, 4); tpx(13, 18, leg, 2, 4);
    tpx(9, 21, boot, 2, 2); tpx(13, 21, boot, 2, 2);
    _wpn(tpx, av.weapon, metal, D, L);
    // torso
    tpx(8, 10, armor, 8, 8);
    tpx(8, 10, L(armor, 0.22), 8, 1);
    tpx(8, 16, D(armor, 0.35), 8, 1);
    tpx(7, 10, OUT, 1, 8); tpx(16, 10, OUT, 1, 8);
    if (av.armor === 'plate') { tpx(9, 11, L(metal, 0.05), 6, 5); tpx(11, 11, L(metal, 0.25), 2, 5); }
    else if (av.armor === 'robe') { tpx(7, 16, armor, 10, 6); tpx(8, 20, armor, 8, 2); tpx(7, 16, L(armor, 0.1), 10, 1); }
    else if (av.armor === 'leather') { tpx(8, 12, D(armor, 0.22), 8, 1); tpx(8, 14, D(armor, 0.22), 8, 1); }
    else if (av.armor === 'cloth') { tpx(11, 11, D(armor, 0.2), 2, 6); }
    // arms + hands
    tpx(6, 11, armor, 2, 5); tpx(16, 11, armor, 2, 5);
    tpx(6, 15, skin, 2, 2); tpx(16, 15, skin, 2, 2);
    // head — grow for small races (big-head look), shrink width for elf already via X
    const hw = 6 * headBig, hh = 7 * headBig, hx = 12 - hw / 2, hyT = 9 - hh;
    tpx(hx, hyT, skin, hw, hh); tpx(hx - 1, hyT + 1, skin, 1, hh - 2); tpx(hx + hw, hyT + 1, skin, 1, hh - 2);
    const eRow = hyT + 3, eL = hx + 1, eR = hx + hw - 2, mRow = hyT + 5;
    // ears (racial)
    if (feat.ears === 'pointed') { tpx(hx - 1, eRow - 1, skin, 1, 2); tpx(hx - 2, eRow - 2, skin, 1, 1); tpx(hx + hw, eRow - 1, skin, 1, 2); tpx(hx + hw + 1, eRow - 2, skin, 1, 1); }
    else if (feat.ears === 'round') { tpx(hx - 1, eRow, skin, 1, 1); tpx(hx + hw, eRow, skin, 1, 1); }
    else { tpx(hx - 1, eRow, skin, 1, 2); tpx(hx + hw, eRow, skin, 1, 2); }
    tpx(hx, hyT + hh - 1, D(skin, 0.25), hw, 1);
    tpx(eL, eRow, '#fff', 1, 1); tpx(eR, eRow, '#fff', 1, 1);
    tpx(eL, eRow, '#20180f', 1, 1); tpx(eR, eRow, '#20180f', 1, 1);
    tpx(11, mRow, D(skin, 0.35), 2, 1);
    if (feat.bigNose) tpx(11, mRow - 1, D(skin, 0.12), 2, 1);
    // snout (dragonborn)
    if (feat.snout) { tpx(10, mRow, skin, 4, 2); tpx(11, mRow + 1, D(skin, 0.3), 2, 1); tpx(eL, eRow, '#f5d000', 1, 1); tpx(eR, eRow, '#f5d000', 1, 1); }
    // tusks (orc / half-orc) — bigger for full orc
    if (feat.tusks) { const th = feat.bigTusks ? 2 : 1; tpx(eL, mRow + 1, '#fff', 1, th); tpx(eR, mRow + 1, '#fff', 1, th); }
    // beard (dwarves force a big one)
    let beard = av.beard; if ((!beard || beard === 'none') && feat.beardForce) beard = feat.beardForce;
    _beard(tpx, beard, hair, D, L, hyT, hh, hx, hw);
    // hair
    if (!feat.noHair) _hair(tpx, av.hair, hair, D, L, hyT, hx, hw);
    // horns
    if (feat.horns === 'curved') { tpx(hx, hyT - 2, '#241a1a', 1, 2); tpx(hx - 1, hyT - 3, '#241a1a', 1, 1); tpx(hx + hw - 1, hyT - 2, '#241a1a', 1, 2); tpx(hx + hw, hyT - 3, '#241a1a', 1, 1); }
    else if (feat.horns === 'ridge') { tpx(hx + 1, hyT - 1, D(skin, 0.3), hw - 2, 1); tpx(11, hyT - 2, D(skin, 0.3), 2, 1); }
    // plate helmet
    if (av.armor === 'plate') { tpx(hx, hyT - 1, L(metal, 0.12), hw, 3); tpx(hx, hyT - 1, L(metal, 0.35), hw, 1); tpx(11, hyT + 1, D(metal, 0.2), 2, 4); }
    if (av.shield !== 'none') _shield(tpx, av.shield, metal, D, L);
  }
  function _raceXform(race) {
    switch (race) {
      case 'elf': case 'half-elf': return { sx: 0.86, sy: 1.05, oy: -0.5 };
      case 'dwarf':               return { sx: 1.18, sy: 0.82, oy: 2.2, headBig: 1.05 };
      case 'halfling':            return { sx: 0.74, sy: 0.74, oy: 3.2, headBig: 1.25 };
      case 'gnome':               return { sx: 0.76, sy: 0.78, oy: 2.8, headBig: 1.3 };
      case 'half-orc':            return { sx: 1.12, sy: 1.04, oy: -0.4 };
      case 'orc':                 return { sx: 1.28, sy: 1.08, oy: -0.8 };
      case 'dragonborn':          return { sx: 1.12, sy: 1.06, oy: -0.4 };
      case 'tiefling':            return { sx: 1.0, sy: 1.03, oy: 0 };
      default:                    return { sx: 1, sy: 1, oy: 0 };
    }
  }
  function _hair(px, style, hair, D, L, top, hx, hw) {
    if (!style || style === 'none') return;
    const HL = L(hair, 0.18), x0 = hx, w = hw, x1 = hx + hw - 1, t = top;
    if (style === 'buzz') { px(x0, t - 1, D(hair, 0.1), w, 1); px(x0, t, D(hair, 0.1), 1, 2); px(x1, t, D(hair, 0.1), 1, 2); }
    else if (style === 'short') { px(x0, t - 1, hair, w, 2); px(x0, t + 1, hair, 1, 2); px(x1, t + 1, hair, 1, 2); px(x0 + 1, t - 1, HL, w - 2, 1); }
    else if (style === 'long') { px(x0, t - 1, hair, w, 2); px(x0 - 1, t, hair, 1, 8); px(x1 + 1, t, hair, 1, 8); px(x0, t - 1, HL, w, 1); }
    else if (style === 'spiky') { px(x0, t - 1, hair, w, 1); px(x0, t - 2, hair, 1, 1); px(x0 + 2, t - 3, hair, 1, 2); px(x0 + 4, t - 2, hair, 1, 1); px(x1, t - 3, hair, 1, 2); px(x0, t + 1, hair, 1, 2); px(x1, t + 1, hair, 1, 2); }
    else if (style === 'mohawk') { px(11, t - 3, hair, 2, 4); px(11, t - 3, L(hair, 0.2), 1, 4); }
    else if (style === 'ponytail') { px(x0, t - 1, hair, w, 2); px(x0, t + 1, hair, 1, 2); px(x1, t + 1, hair, 1, 2); px(x1 + 1, t + 1, hair, 1, 7); px(x1 + 2, t + 3, hair, 1, 3); }
    else if (style === 'braids') { px(x0, t - 1, hair, w, 2); px(x0 - 1, t, hair, 1, 7); px(x1 + 1, t, hair, 1, 7); px(x0 - 1, t + 7, '#e8c850', 1, 1); px(x1 + 1, t + 7, '#e8c850', 1, 1); }
    else if (style === 'curly') { px(x0 - 1, t - 2, hair, w + 2, 3); px(x0 - 1, t + 1, hair, 1, 3); px(x1 + 1, t + 1, hair, 1, 3); px(x0, t - 2, HL, 2, 1); px(x1 - 1, t - 2, HL, 2, 1); }
    else if (style === 'afro') { px(x0 - 2, t - 3, hair, w + 4, 5); px(x0 - 2, t + 1, hair, 1, 2); px(x1 + 2, t + 1, hair, 1, 2); px(x0, t - 3, HL, 3, 1); }
    else if (style === 'topknot') { px(x0, t - 1, hair, w, 2); px(11, t - 3, hair, 2, 2); }
  }
  function _beard(px, style, hair, D, L, top, hh, hx, hw) {
    if (!style || style === 'none') return;
    const x0 = hx, w = hw, chin = top + hh - 2;
    if (style === 'stubble') { const d = D(hair, 0.1); px(x0 + 1, chin, d, 1, 1); px(x0 + 3, chin, d, 1, 1); px(x0 + 4, chin, d, 1, 1); px(x0 + 1, chin + 1, d, w - 2, 1); }
    else if (style === 'goatee') { px(11, chin, hair, 2, 3); }
    else if (style === 'full') { px(x0, chin - 1, hair, w, 3); px(x0, chin - 1, L(hair, 0.15), w, 1); px(x0 + 1, chin + 2, hair, w - 2, 1); }
    else if (style === 'long') { px(x0, chin - 1, hair, w, 3); px(x0 + 1, chin + 2, hair, w - 2, 3); px(11, chin + 5, hair, 2, 1); px(x0, chin - 1, L(hair, 0.15), w, 1); }
    else if (style === 'braided') { px(x0, chin - 1, hair, w, 3); px(x0 + 1, chin + 2, hair, w - 2, 2); px(x0 + 1, chin + 4, hair, 1, 3); px(x0 + w - 2, chin + 4, hair, 1, 3); px(x0 + 1, chin + 7, '#e8c850', 1, 1); px(x0 + w - 2, chin + 7, '#e8c850', 1, 1); }
  }
  function _wpn(px, w, metal, D, L) {
    if (!w || w === 'none') return;
    const wood = '#5a3a1a', steel = metal || '#cfd6df', gold = '#e8c850', dark = '#3a3f47';
    const blade = (a, b, col) => { for (let gy = a; gy <= b; gy++) px(5, gy, col); };
    if (w === 'sword') { blade(3, 13, steel); px(5, 3, '#fff'); px(4, 14, gold); px(5, 14, gold); px(6, 14, gold); px(5, 15, wood); px(5, 16, wood); }
    else if (w === 'greatsword') { for (let gy = 1; gy <= 14; gy++) { px(5, gy, steel); px(6, gy, L(steel, 0.2)); } px(5, 1, '#fff'); px(3, 15, gold, 5, 1); px(5, 16, wood); px(5, 17, wood); }
    else if (w === 'rapier') { blade(2, 13, steel); px(5, 2, '#fff'); px(4, 14, gold); px(6, 14, gold); px(3, 13, gold); px(7, 13, gold); px(5, 15, wood); }
    else if (w === 'dagger') { blade(9, 13, steel); px(4, 14, gold); px(5, 14, gold); px(6, 14, gold); px(5, 15, wood); }
    else if (w === 'axe') { for (let gy = 7; gy <= 17; gy++) px(5, gy, wood); px(2, 5, steel, 4, 4); px(2, 5, L(steel, 0.25), 4, 1); px(2, 8, D(steel, 0.3), 4, 1); }
    else if (w === 'mace') { for (let gy = 8; gy <= 17; gy++) px(5, gy, wood); px(3, 4, dark, 4, 4); px(4, 3, dark, 2, 1); px(4, 8, dark, 2, 1); px(2, 5, dark, 1, 2); px(6, 5, dark, 1, 2); px(4, 5, L(dark, 0.4), 1, 1); }
    else if (w === 'hammer') { for (let gy = 8; gy <= 17; gy++) px(5, gy, wood); px(2, 4, steel, 6, 4); px(2, 4, L(steel, 0.25), 6, 1); px(2, 7, D(steel, 0.3), 6, 1); }
    else if (w === 'spear') { for (let gy = 6; gy <= 20; gy++) px(5, gy, wood); px(4, 3, steel); px(6, 3, steel); px(5, 2, steel); px(5, 3, steel); px(5, 4, steel); px(5, 5, steel); }
    else if (w === 'staff') { for (let gy = 3; gy <= 17; gy++) px(5, gy, wood); px(4, 3, '#7fd0ff'); px(6, 3, '#7fd0ff'); px(5, 2, '#7fd0ff'); px(5, 3, '#cdeeff'); }
    else if (w === 'wand') { for (let gy = 11; gy <= 16; gy++) px(5, gy, wood); px(5, 10, '#c060ff'); px(4, 10, '#e0a0ff'); }
    else if (w === 'bow') { for (let gy = 4; gy <= 16; gy++) px(4, gy, wood); px(5, 4, wood); px(5, 16, wood); for (let gy = 5; gy <= 15; gy++) px(5, gy, 'rgba(240,240,240,0.5)'); }
    else if (w === 'crossbow') { for (let gy = 10; gy <= 15; gy++) px(5, gy, wood); px(2, 11, dark, 7, 1); px(2, 10, dark, 1, 3); px(8, 10, dark, 1, 3); px(5, 9, steel); }
    else if (w === 'scythe') { for (let gy = 4; gy <= 18; gy++) px(6, gy, wood); px(2, 4, steel); px(3, 4, steel); px(4, 4, steel); px(5, 4, steel); px(2, 5, steel); px(2, 6, steel); px(2, 4, L(steel, 0.3), 1, 1); }
  }
  function _shield(px, s, metal, D, L) {
    const m = metal, rim = D(metal, 0.4), boss = L(metal, 0.3);
    if (s === 'round') { px(17, 11, m, 4, 6); px(18, 10, m, 2, 1); px(18, 17, m, 2, 1); px(17, 11, rim, 4, 1); px(17, 16, rim, 4, 1); px(18, 13, boss, 2, 2); }
    else { px(17, 10, m, 4, 5); px(18, 15, m, 2, 2); px(17, 10, rim, 4, 1); px(19, 16, boss, 1, 1); px(17, 10, rim, 1, 6); }
  }
  function _renderMonster(skin, px) {
    const D = _darken, L = _lighten;
    if (skin === 'slime') {
      const g = '#3aa83a';
      px(7, 10, g, 10, 12); px(6, 13, g, 12, 8); px(8, 9, g, 8, 2);
      px(7, 10, L(g, 0.3), 8, 1); px(9, 11, L(g, 0.4), 3, 2);
      px(9, 14, '#fff', 2, 3); px(13, 14, '#fff', 2, 3); px(9, 16, '#0c1a0c', 2, 1); px(13, 16, '#0c1a0c', 2, 1);
      px(10, 19, D(g, 0.45), 4, 1);
    } else if (skin === 'goblin') {
      const sk = '#5a8a3a';
      px(9, 14, '#3a2a18', 6, 7); px(8, 15, '#3a2a18', 1, 4); px(15, 15, '#3a2a18', 1, 4);
      px(8, 4, sk, 8, 8); px(7, 5, sk, 1, 5); px(16, 5, sk, 1, 5);
      px(5, 5, sk, 2, 2); px(4, 6, sk, 1, 1); px(17, 5, sk, 2, 2); px(19, 6, sk, 1, 1);
      px(10, 7, '#e02020', 1, 2); px(13, 7, '#e02020', 1, 2);
      px(10, 10, '#241a10', 4, 1); px(11, 9, '#fff', 1, 1); px(12, 9, '#fff', 1, 1);
    } else if (skin === 'skeleton') {
      const b = '#e8e8e0';
      px(8, 3, b, 8, 8); px(7, 5, b, 1, 4); px(16, 5, b, 1, 4);
      px(10, 6, '#0c0c0c', 2, 2); px(12, 6, '#0c0c0c', 2, 2); px(11, 9, '#0c0c0c', 2, 1);
      px(9, 12, b, 6, 8); px(11, 12, b, 2, 9);
      px(8, 13, '#0c0c0c', 8, 1); px(8, 15, '#0c0c0c', 8, 1); px(8, 17, '#0c0c0c', 8, 1);
      px(6, 13, b, 2, 1); px(16, 13, b, 2, 1);
    } else if (skin === 'wolf') {
      const f = '#7a7a82';
      px(6, 11, f, 12, 9); px(8, 5, f, 8, 7);
      px(7, 3, f, 2, 3); px(15, 3, f, 2, 3); px(7, 3, D(f, 0.3), 2, 1); px(15, 3, D(f, 0.3), 2, 1);
      px(10, 12, L(f, 0.2), 4, 3); px(11, 13, '#1a1a1a', 2, 2);
      px(9, 8, '#f5c542', 2, 1); px(13, 8, '#f5c542', 2, 1);
      px(7, 20, D(f, 0.3), 2, 2); px(15, 20, D(f, 0.3), 2, 2);
    } else if (skin === 'dragon') {
      const r = '#a83020';
      px(2, 8, D(r, 0.3), 6, 8); px(16, 8, D(r, 0.3), 6, 8); px(2, 8, D(r, 0.45), 6, 1); px(16, 8, D(r, 0.45), 6, 1);
      px(8, 9, r, 8, 11); px(9, 4, r, 6, 6); px(8, 5, r, 1, 4); px(15, 5, r, 1, 4);
      px(8, 2, D(r, 0.4), 2, 3); px(14, 2, D(r, 0.4), 2, 3);
      px(10, 7, '#f5d000', 1, 2); px(13, 7, '#f5d000', 1, 2);
      px(10, 10, D(r, 0.4), 4, 1);
      px(11, 19, r, 2, 4); px(12, 22, D(r, 0.4), 2, 1);
      px(10, 12, L(r, 0.25), 4, 5);
    } else if (skin === 'beholder') {
      const p = '#9a5ab0';
      px(7, 7, p, 10, 10); px(6, 9, p, 12, 6); px(7, 7, L(p, 0.2), 10, 1);
      px(9, 9, '#ffe9a0', 6, 6); px(11, 11, '#0c0c0c', 2, 2); px(9, 9, '#fff', 1, 1);
      const st = [[11, 2], [4, 5], [18, 5], [4, 15], [18, 15], [11, 20]];
      for (const [gx, gy] of st) { px(gx, gy, '#7a3a90', 2, 2); px(gx, gy + (gy < 11 ? 2 : -1), '#ffe9a0', 2, 1); }
    }
  }

  // ── Builder UI ───────────────────────────────────────────────────────────────
  function _css() {
    if (document.getElementById('avatar-css')) return;
    const st = document.createElement('style'); st.id = 'avatar-css';
    st.textContent = `
    #avatar-modal{position:fixed;inset:0;background:rgba(0,0,0,.6);display:none;align-items:center;justify-content:center;z-index:12000}
    #avatar-modal.on{display:flex}
    #avatar-modal .av-box{width:560px;max-width:94vw;max-height:90vh;overflow:auto;background:#15131e;border:1px solid #34313f;border-radius:14px;padding:18px;color:#e8e8ee;font:13px system-ui;box-shadow:0 20px 60px rgba(0,0,0,.7)}
    #avatar-modal h3{margin:0 0 12px;font-size:15px;color:#ffd27a}
    #avatar-modal .av-main{display:flex;gap:16px}
    #avatar-modal .av-prev{flex:0 0 auto;width:160px;height:160px;background:#0c0a14;border:1px solid #2a2733;border-radius:10px;image-rendering:pixelated}
    #avatar-modal .av-controls{flex:1;display:grid;grid-template-columns:1fr 1fr;gap:10px 12px;align-content:start}
    #avatar-modal .av-f{display:flex;flex-direction:column;gap:4px}
    #avatar-modal .av-f.full{grid-column:1 / -1}
    #avatar-modal label{font-size:11px;font-weight:700;letter-spacing:.04em;color:#9a97a6}
    #avatar-modal select{background:#211e2b;border:1px solid #38343f;color:#fff;border-radius:6px;padding:6px 8px;font-size:12px}
    #avatar-modal .av-color{display:flex;align-items:center;gap:8px}
    #avatar-modal input[type=color]{width:38px;height:28px;border:none;background:none;cursor:pointer}
    #avatar-modal .av-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}
    #avatar-modal .av-btn{border:none;border-radius:7px;padding:9px 14px;font-weight:700;cursor:pointer}
    #avatar-modal .av-btn.save{background:#1f8fff;color:#04121f}
    #avatar-modal .av-btn.cancel{background:#2a2733;color:#cfcfe0}`;
    document.head.appendChild(st);
  }
  let _el = null, _cur = null, _onSave = null;
  function _opt(sel) { return OPTIONS[sel].map(([v, l]) => `<option value="${v}">${l}</option>`).join(''); }
  function openEditor(initial, onSave) {
    _css();
    _cur = merge(initial); _onSave = onSave;
    if (!_el) {
      _el = document.createElement('div'); _el.id = 'avatar-modal';
      _el.innerHTML = `<div class="av-box">
        <h3>🧙 Avatar Builder</h3>
        <div class="av-main">
          <canvas class="av-prev" id="av-prev" width="160" height="160"></canvas>
          <div class="av-controls">
            <div class="av-f full"><label>Monster skin (overrides everything)</label><select id="av-skin">${_opt('skin')}</select></div>
            <div class="av-f"><label>Race</label><select id="av-race">${_opt('race')}</select></div>
            <div class="av-f"><label>Skin / flesh</label><div class="av-color"><input type="color" id="av-skinColor"></div></div>
            <div class="av-f"><label>Hair</label><select id="av-hair">${_opt('hair')}</select></div>
            <div class="av-f"><label>Hair color</label><div class="av-color"><input type="color" id="av-hairColor"></div></div>
            <div class="av-f"><label>Beard</label><select id="av-beard">${_opt('beard')}</select></div>
            <div class="av-f"><label>Armor</label><select id="av-armor">${_opt('armor')}</select></div>
            <div class="av-f"><label>Armor color</label><div class="av-color"><input type="color" id="av-armorColor"></div></div>
            <div class="av-f"><label>Weapon</label><select id="av-weapon">${_opt('weapon')}</select></div>
            <div class="av-f"><label>Metal color</label><div class="av-color"><input type="color" id="av-metalColor"></div></div>
            <div class="av-f"><label>Cloak</label><select id="av-cloak">${_opt('cloak')}</select></div>
            <div class="av-f"><label>Cloak color</label><div class="av-color"><input type="color" id="av-cloakColor"></div></div>
            <div class="av-f"><label>Shield</label><select id="av-shield">${_opt('shield')}</select></div>
          </div>
        </div>
        <div class="av-actions"><button class="av-btn cancel" id="av-cancel">Cancel</button><button class="av-btn save" id="av-save">Save</button></div>
      </div>`;
      document.body.appendChild(_el);
      _el.addEventListener('click', (e) => { if (e.target === _el) _el.classList.remove('on'); });
      _el.querySelector('#av-cancel').addEventListener('click', () => _el.classList.remove('on'));
      _el.querySelector('#av-save').addEventListener('click', () => { _el.classList.remove('on'); if (_onSave) _onSave(Object.assign({}, _cur)); });
      ['skin', 'race', 'hair', 'beard', 'armor', 'weapon', 'cloak', 'shield'].forEach(k => _el.querySelector('#av-' + k).addEventListener('change', e => { _cur[k] = e.target.value; _preview(); }));
      ['skinColor', 'hairColor', 'armorColor', 'metalColor', 'cloakColor'].forEach(k => _el.querySelector('#av-' + k).addEventListener('input', e => { _cur[k] = e.target.value; _preview(); }));
    }
    ['skin', 'race', 'hair', 'beard', 'armor', 'weapon', 'cloak', 'shield', 'skinColor', 'hairColor', 'armorColor', 'metalColor', 'cloakColor'].forEach(k => { const el = _el.querySelector('#av-' + k); if (el) el.value = _cur[k]; });
    _preview();
    _el.classList.add('on');
  }
  function _preview() {
    const cv = _el.querySelector('#av-prev'); const g = cv.getContext('2d');
    g.clearRect(0, 0, cv.width, cv.height);
    g.fillStyle = '#0c0a14'; g.fillRect(0, 0, cv.width, cv.height);
    render(g, 8, 8, 144, _cur);
  }

  window.ArcaneAvatar = { DEFAULT, OPTIONS, render, merge, openEditor };
})();
