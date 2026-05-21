// ============================================================
// D&D 4e Battle Grid — grid.js
// ============================================================

// ── Effect definitions ──────────────────────────────────────
const EFFECTS = {
  fire:      { r:232, g:90,  b:40,  glow:'#FF6030', inkR:'255,110,40'  },
  poison:    { r:80,  g:160, b:20,  glow:'#70CC20', inkR:'100,200,30'  },
  ice:       { r:50,  g:140, b:220, glow:'#50BBFF', inkR:'60,160,250'  },
  lightning: { r:140, g:100, b:255, glow:'#8060FF', inkR:'160,120,255' },
  holy:      { r:180, g:170, b:255, glow:'#D0CCFF', inkR:'200,190,255' },
  erase:     { r:220, g:60,  b:60,  glow:'#FF4040', inkR:'220,70,70'   },
  water:     { r:30,  g:110, b:200, glow:'#1090FF', inkR:'40,130,220'  },
  grass:     { r:60,  g:160, b:40,  glow:'#50CC28', inkR:'70,180,45'   },
  lava:      { r:255, g:80,  b:10,  glow:'#FF5500', inkR:'255,90,20'   },
  stone:     { r:120, g:110, b:100, glow:'#C8B896', inkR:'140,130,115' },
  difficult: { r:200, g:180, b:60,  glow:'#D4B820', inkR:'200,180,60'  },
  blood:     { r:160, g:20,  b:30,  glow:'#A01020', inkR:'160,25,35'   },
};

const TOKEN_COLORS = [
  '#E74C3C','#E67E22','#F1C40F','#2ECC71',
  '#1ABC9C','#3498DB','#9B59B6','#E91E63',
  '#FFFFFF','#95A5A6'
];

// ── Canvas setup ─────────────────────────────────────────────
const canvas  = document.getElementById('grid');
const ctx     = canvas.getContext('2d');
const cellCvs = document.createElement('canvas');
const cctx    = cellCvs.getContext('2d');


// Global error reporter — surfaces any uncaught error in the browser
// console with a clear tag so we can spot it during multiplayer sessions.
window.addEventListener('error', e => {
  try { console.error('[arcane:uncaught]', e.message, 'at', e.filename, e.lineno + ':' + e.colno, e.error); } catch(_){}
});
window.addEventListener('unhandledrejection', e => {
  try { console.error('[arcane:unhandledrejection]', e.reason); } catch(_){}
});

let cols = 20, rows = 20, CELL = 28;

// ── 8-bit sprite sheets ───────────────────────────────────────
const _sheets = {};
const _spritev = 3;
['fire','ice','poison','holy','lightning'].forEach(k => {
  const img = new Image();
  img.src = k + '-8bit.png?v=' + _spritev;
  _sheets[k] = img;
});
const SFW = 16, SFH = 16; // frame size within each sheet

// ── Combo sprite sheets (one per 2-effect intersection) ──────
const _comboSheets = {};
['fire-holy','fire-ice','fire-lightning','fire-poison',
 'holy-ice','holy-lightning','holy-poison',
 'ice-lightning','ice-poison','lightning-poison'].forEach(k => {
  const img = new Image();
  img.src = `combo-${k}-8bit.png?v=${_spritev}`;
  _comboSheets[k] = img;
});

function comboKey(effs) { return effs.slice().sort().join('-'); }

function drawSprite(c2, effect, frameIdx, x, y) {
  const img = _sheets[effect];
  if (!img || !img.complete || !img.naturalWidth) return false;
  const fx = (frameIdx % 4) * SFW;
  const fy = Math.floor(frameIdx / 4) * SFH;
  c2.save();
  c2.globalCompositeOperation = 'lighter';
  c2.drawImage(img, fx, fy, SFW, SFH, x, y, CELL, CELL);
  c2.restore();
  return true;
}
let grid   = {};   // "r,c" → string[] of effectNames
let tokens = [];
let tokenIdSeq = 1;

// Helper used by the Bestiary IIFE to push a token built from a creature.
// Kept at top level so it can read `tokens` and `tokenIdSeq` directly.
window.__pushTokenForBestiary = function (cr, r, c) {
  const SIZE_TO_GRID = { tiny:1, small:1, medium:1, large:2, huge:3, gargantuan:4 };
  const sz = SIZE_TO_GRID[cr.size] || 1;
  // Avoid overlapping existing tokens at that cell
  if (tokens.find(t => t.r === r && t.c === c)) {
    // Find nearest empty cell in a small spiral
    outer:
    for (let radius = 1; radius <= 5; radius++) {
      for (let dr = -radius; dr <= radius; dr++) {
        for (let dc = -radius; dc <= radius; dc++) {
          const nr = r + dr, nc = c + dc;
          if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
          if (!tokens.find(t => t.r === nr && t.c === nc)) {
            r = nr; c = nc; break outer;
          }
        }
      }
    }
  }
  pushUndo();
  tokens.push({
    id: tokenIdSeq++,
    r, c,
    name: cr.name,
    color: cr.color || '#B47028',   // override per creature; default = copper
    size: sz,
    speed: cr.speed || 6,
    hp: cr.hp || 0,
    maxHp: cr.hp || 0,
    vision: cr.vision || null,      // null = no auto-reveal; else 'normal' | 'lowlight' | 'darkvision'
    ownerSheetId: cr.ownerSheetId || null,
    equippedLight: null,            // {radius,name} once a torch is picked up + equipped
    conditions: [],
    concentrating: false,
    exhaustion: 0,
    lightRadius: 0,
    lightDim: 0,
    deathSaves: { successes: 0, failures: 0 },
    // Custom fields surfaced from the bestiary, useful for tooltips/inspect:
    bestiary: {
      ac: cr.ac, cr: cr.cr, type: cr.type,
      saves: cr.saves,
      resistances: cr.resistances, immunities: cr.immunities,
      vulnerabilities: cr.vulnerabilities, condImmunities: cr.condImmunities,
      senses: cr.senses, languages: cr.languages, notes: cr.notes,
    },
  });
};

// ── Undo / Redo ──────────────────────────────────────────────
let undoStack = [], redoStack = [];
const MAX_UNDO = 40;

function cloneState() {
  return {
    grid: Object.fromEntries(Object.entries(grid).map(([k,v])=>[k,[...v]])),
    tokens: tokens.map(t => ({
      ...t,
      conditions: [...(t.conditions||[])],
      deathSaves: { ...(t.deathSaves || {successes:0,failures:0}) },
      concentrating: !!t.concentrating,
      exhaustion: t.exhaustion||0,
      lightRadius: t.lightRadius||0,
      lightDim: t.lightDim||0,
    })),
    walls: walls.map(w => ({ ...w })),
    labels: labels.map(l => ({ ...l })),
    lights: lights.map(l => ({ ...l })),
    covers: Object.fromEntries(Object.entries(covers)),
    traps: Object.fromEntries(Object.entries(traps).map(([k,v])=>[k,{...v}])),
  };
}
function pushUndo()   {
  undoStack.push(cloneState());
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  redoStack = [];
  if (window.__mpScheduleSync) window.__mpScheduleSync();
}
function applyState(s) {
  grid = Object.fromEntries(Object.entries(s.grid).map(([k,v])=>[k,[...v]]));
  tokens = s.tokens.map(t => ({
    ...t,
    conditions: [...(t.conditions||[])],
    deathSaves: { ...(t.deathSaves || {successes:0,failures:0}) },
    concentrating: !!t.concentrating,
    exhaustion: t.exhaustion||0,
    lightRadius: t.lightRadius||0,
    lightDim: t.lightDim||0,
  }));
  walls = s.walls ? s.walls.map(w => ({ ...w })) : [];
  labels = s.labels ? s.labels.map(l => ({ ...l })) : [];
  lights = s.lights ? s.lights.map(l => ({ ...l })) : [];
  covers = s.covers ? {...s.covers} : {};
  traps = s.traps ? Object.fromEntries(Object.entries(s.traps).map(([k,v])=>[k,{...v}])) : {};
  rebuildCells();
  // Push the new state to mirrored players (undo/redo by the DM).
  if (window.__mpScheduleSync) window.__mpScheduleSync();
}
function undo() { if (undoStack.length) { redoStack.push(cloneState()); applyState(undoStack.pop()); } }
function redo() { if (redoStack.length) { undoStack.push(cloneState()); applyState(redoStack.pop()); } }

// ── Resize ───────────────────────────────────────────────────
function resize() {
  const wrap = document.getElementById('canvas-wrap');
  // Both the 1" overlay AND the coords overlay snap cells to a physical
  // 1-inch grid using gridOverlayScale (CSS px per inch).
  CELL = (gridOverlayVisible || gridCoordsVisible)
    ? Math.max(16, gridOverlayScale)
    : Math.max(16, Math.floor((wrap.clientWidth || 600) / cols));
  const W = cols * CELL, H = rows * CELL;
  canvas.width = W;  canvas.height = H;
  cellCvs.width = W; cellCvs.height = H;
  rebuildCells();
}

// ── Coordinate helpers ────────────────────────────────────────
function cellFromXY(x, y) {
  return {
    r: Math.max(0, Math.min(rows - 1, Math.floor(y / CELL))),
    c: Math.max(0, Math.min(cols - 1, Math.floor(x / CELL))),
  };
}

// ── Shape math ───────────────────────────────────────────────
function bresenham(r0, c0, r1, c1, set) {
  let dr = Math.abs(r1-r0), dc = Math.abs(c1-c0), sr = r0<r1?1:-1, sc = c0<c1?1:-1, err = dr-dc;
  while (true) {
    set.add(r0+','+c0);
    if (r0===r1 && c0===c1) break;
    const e2 = 2*err;
    if (e2 > -dc) { err -= dc; r0 += sr; }
    if (e2 <  dr) { err += dr; c0 += sc; }
  }
}

function floodFill(outline) {
  let minR=rows,maxR=0,minC=cols,maxC=0;
  for (const k of outline) { const [r,c]=k.split(',').map(Number); if(r<minR)minR=r;if(r>maxR)maxR=r;if(c<minC)minC=c;if(c>maxC)maxC=c; }
  minR=Math.max(0,minR-1); maxR=Math.min(rows-1,maxR+1); minC=Math.max(0,minC-1); maxC=Math.min(cols-1,maxC+1);
  const outside=new Set(), q=[];
  function enq(r,c){ const k=r+','+c; if(r<minR||r>maxR||c<minC||c>maxC)return; if(outline.has(k)||outside.has(k))return; outside.add(k); q.push({r,c}); }
  for(let r=minR;r<=maxR;r++){enq(r,minC);enq(r,maxC);}
  for(let c=minC;c<=maxC;c++){enq(minR,c);enq(maxR,c);}
  let h=0; while(h<q.length){const{r,c}=q[h++];enq(r-1,c);enq(r+1,c);enq(r,c-1);enq(r,c+1);}
  const inside=new Set();
  for(let r=minR;r<=maxR;r++) for(let c=minC;c<=maxC;c++){const k=r+','+c;if(!outline.has(k)&&!outside.has(k))inside.add(k);}
  return inside;
}

function isClosed(cells) {
  if (cells.size < 6) return false;
  const arr=[...cells], [r0,c0]=arr[0].split(',').map(Number), [r1,c1]=arr[arr.length-1].split(',').map(Number);
  return Math.abs(r0-r1)<=3 && Math.abs(c0-c1)<=3;
}

function getConeCells(origin, tip) {
  const cells=new Set(), dr=tip.r-origin.r, dc=tip.c-origin.c, len=Math.max(Math.abs(dr),Math.abs(dc));
  if(len===0){cells.add(origin.r+','+origin.c);return cells;}
  const ang=Math.atan2(dr,dc), half=Math.PI/4;
  for(let r=0;r<rows;r++) for(let c=0;c<cols;c++){
    const cr=r-origin.r, cc=c-origin.c, dist=Math.sqrt(cr*cr+cc*cc);
    if(dist>len+0.5||dist<0.1)continue;
    let diff=Math.atan2(cr,cc)-ang;
    while(diff>Math.PI)diff-=2*Math.PI; while(diff<-Math.PI)diff+=2*Math.PI;
    if(Math.abs(diff)<=half+0.05)cells.add(r+','+c);
  }
  cells.add(origin.r+','+origin.c); return cells;
}

function getCircleCells(origin, rad) {
  const cells=new Set();
  for(let r=Math.max(0,origin.r-rad-1);r<=Math.min(rows-1,origin.r+rad+1);r++)
    for(let c=Math.max(0,origin.c-rad-1);c<=Math.min(cols-1,origin.c+rad+1);c++)
      if(Math.sqrt((r-origin.r)**2+(c-origin.c)**2)<=rad+0.5)cells.add(r+','+c);
  return cells;
}

function getSquareCells(origin, rad) {
  const cells=new Set();
  for(let r=Math.max(0,origin.r-rad);r<=Math.min(rows-1,origin.r+rad);r++)
    for(let c=Math.max(0,origin.c-rad);c<=Math.min(cols-1,origin.c+rad);c++)
      cells.add(r+','+c);
  return cells;
}

function initBounds() {
  projBounds = { x1: 0, y1: 0, x2: canvas.width, y2: canvas.height };
}

function getBoundsHandles() {
  const b = projBounds, mx = (b.x1+b.x2)/2, my = (b.y1+b.y2)/2;
  return [
    {id:'tl',x:b.x1,y:b.y1},{id:'tm',x:mx,y:b.y1},{id:'tr',x:b.x2,y:b.y1},
    {id:'mr',x:b.x2,y:my}, {id:'br',x:b.x2,y:b.y2},{id:'bm',x:mx,y:b.y2},
    {id:'bl',x:b.x1,y:b.y2},{id:'ml',x:b.x1,y:my}
  ];
}

function hitBoundsHandle(x, y) {
  if (!projBounds || !boundsMode) return null;
  for (const h of getBoundsHandles())
    if (Math.abs(x-h.x) <= HANDLE_R+5 && Math.abs(y-h.y) <= HANDLE_R+5) return h.id;
  if (x>projBounds.x1 && x<projBounds.x2 && y>projBounds.y1 && y<projBounds.y2) return 'move';
  return null;
}

function boundsHandleCursor(id) {
  if (!id) return 'default';
  return {tl:'nwse-resize',br:'nwse-resize',tr:'nesw-resize',bl:'nesw-resize',
          tm:'ns-resize',bm:'ns-resize',ml:'ew-resize',mr:'ew-resize',move:'move'}[id] || 'default';
}

function applyBoundsHandle(id, x, y) {
  const b = projBounds, MIN = CELL*3;
  const cx = Math.max(0,Math.min(canvas.width,x));
  const cy = Math.max(0,Math.min(canvas.height,y));
  if (id === 'move') {
    const dx = x-boundsDragStart.x, dy = y-boundsDragStart.y;
    const ob = boundsDragStart.b, w = ob.x2-ob.x1, h = ob.y2-ob.y1;
    b.x1 = Math.max(0, Math.min(canvas.width-w,  ob.x1+dx));
    b.y1 = Math.max(0, Math.min(canvas.height-h, ob.y1+dy));
    b.x2 = b.x1+w; b.y2 = b.y1+h;
    return;
  }
  if (id.includes('l')) b.x1 = Math.min(cx, b.x2-MIN);
  if (id.includes('r')) b.x2 = Math.max(cx, b.x1+MIN);
  if (id.includes('t')) b.y1 = Math.min(cy, b.y2-MIN);
  if (id.includes('b')) b.y2 = Math.max(cy, b.y1+MIN);
}

// ── Cell drawing ─────────────────────────────────────────────
const cellPhase = {};
function getPhase(r,c){const k=r+','+c;if(!cellPhase[k])cellPhase[k]=Math.random()*Math.PI*2;return cellPhase[k];}

const _effectSpeeds = {fire:120, poison:140, ice:160, lightning:60, holy:130};
const _effectBg = {fire:[30,5,0], poison:[5,15,3], ice:[3,8,20], lightning:[4,2,18], holy:[8,4,18]};
_effectBg['difficult'] = [18,16,4];
_effectBg['blood'] = [20,2,3];
const _borderColors = {fire:'#E85020',poison:'#50A010',ice:'#3080C0',lightning:'#7050EE',holy:'#C0A020'};
_borderColors['difficult'] = '#C8A000';
_borderColors['blood'] = '#801020';

function drawCell(c2, r, c, eff, ts) {
  // eff may be a string (legacy) or string[]
  const effs = Array.isArray(eff) ? eff : [eff];
  const x=c*CELL, y=r*CELL, ph=getPhase(r,c);
  c2.save(); c2.beginPath(); c2.rect(x,y,CELL,CELL); c2.clip();

  // ── Separate terrain (floor) from status (overlay) effects ──────
  const _TERRAIN_SET = new Set(['water','grass','lava','stone']);
  const terrainEffs = effs.filter(e => _TERRAIN_SET.has(e));
  const statusEffs  = effs.filter(e => !_TERRAIN_SET.has(e));
  const hasTerrain  = terrainEffs.length > 0;
  const hasStatus   = statusEffs.length > 0;

  // ── Layer 1: Terrain (always drawn first as the floor) ───────────
  if (hasTerrain) {
    const te = terrainEffs[0]; // only one terrain at a time
    if (te === 'water') {
      const pat = getWaterPattern();
      if (pat) {
        const scrollY = ts ? (ts * 0.025) % CELL : 0;
        if (pat.setTransform) pat.setTransform(new DOMMatrix().translate(0, scrollY));
        c2.fillStyle = pat;
        c2.fillRect(x, y, CELL, CELL);
      } else {
        c2.fillStyle = '#0d2d50'; c2.fillRect(x, y, CELL, CELL);
        c2.globalAlpha = .5; c2.strokeStyle = '#42b8f8'; c2.lineWidth = .8;
        const wOff = ts ? (ts * 0.025) % CELL : 0;
        for (let i = 0; i < 3; i++) {
          const wy = y + ((i * CELL / 3 + wOff) % CELL);
          c2.beginPath(); c2.moveTo(x + 1, wy); c2.lineTo(x + CELL - 1, wy); c2.stroke();
        }
        c2.globalAlpha = 1;
      }
    } else if (te === 'grass') {
      const pat = getGrassPattern();
      if (pat) {
        c2.fillStyle = pat;
        c2.fillRect(x, y, CELL, CELL);
      } else {
        c2.fillStyle = '#2d6e14'; c2.fillRect(x, y, CELL, CELL);
      }
    } else if (te === 'lava') {
      const pat = getLavaPattern();
      if (pat) {
        const scrollY = ts ? (ts * 0.018) % CELL : 0;
        if (pat.setTransform) pat.setTransform(new DOMMatrix().translate(0, scrollY));
        c2.fillStyle = pat;
        c2.fillRect(x, y, CELL, CELL);
      } else {
        c2.fillStyle = '#3d0800'; c2.fillRect(x, y, CELL, CELL);
        c2.globalAlpha = .5; c2.strokeStyle = '#ff5500'; c2.lineWidth = .8;
        const lOff = ts ? (ts * 0.018) % CELL : 0;
        for (let i = 0; i < 3; i++) {
          const ly = y + ((i * CELL / 3 + lOff) % CELL);
          c2.beginPath(); c2.moveTo(x + 1, ly); c2.lineTo(x + CELL - 1, ly); c2.stroke();
        }
        c2.globalAlpha = 1;
      }
    } else if (te === 'stone') {
      const pat = getStoneFloorPattern();
      if (pat) {
        c2.fillStyle = pat;
        c2.fillRect(x, y, CELL, CELL);
      } else {
        c2.fillStyle = '#4e4640'; c2.fillRect(x, y, CELL, CELL);
      }
    }
  }

  // ── Layer 2: Status effects (overlaid on terrain if present) ─────
  // When layered over terrain, backgrounds are semi-transparent so the
  // terrain shows through; sprites/gradients retain their natural look.
  if (hasStatus) {
    // bgA: opacity of the solid dark background behind each status effect
    // When terrain is beneath, we drop it so the floor shows through.
    const bgA = hasTerrain ? 0.62 : 0.95;
    const phOff = Math.floor(ph * 8 / (Math.PI*2));

    if (statusEffs.length > 1) {
      // ── Multiple status effects ─────────────────────────────────
      let br=0,bg_=0,bb=0;
      for (const e of statusEffs) { const [er,eg,eb]=_effectBg[e]||[5,5,5]; br+=er;bg_+=eg;bb+=eb; }
      br=Math.round(br/statusEffs.length); bg_=Math.round(bg_/statusEffs.length); bb=Math.round(bb/statusEffs.length);
      c2.fillStyle=`rgba(${br},${bg_},${bb},${bgA})`; c2.fillRect(x,y,CELL,CELL);

      const key = comboKey(statusEffs);
      const avgSpd = Math.round(statusEffs.reduce((s,e)=>s+(_effectSpeeds[e]||120),0)/statusEffs.length);
      const fIdxCombo = ts ? (Math.floor(ts/avgSpd) + phOff) % 8 : phOff % 8;

      if (statusEffs.length === 2 && _comboSheets[key]?.complete && _comboSheets[key]?.naturalWidth) {
        const img = _comboSheets[key];
        const fx=(fIdxCombo%4)*SFW, fy=Math.floor(fIdxCombo/4)*SFH;
        c2.save(); c2.globalCompositeOperation='lighter';
        c2.drawImage(img, fx, fy, SFW, SFH, x, y, CELL, CELL);
        c2.restore();
      } else {
        let drawn = null;
        for (let i=0; i<statusEffs.length && !drawn; i++) {
          for (let j=i+1; j<statusEffs.length && !drawn; j++) {
            const pk=[statusEffs[i],statusEffs[j]].sort().join('-');
            const ci=_comboSheets[pk];
            if (ci?.complete && ci?.naturalWidth) {
              const fx=(fIdxCombo%4)*SFW, fy=Math.floor(fIdxCombo/4)*SFH;
              c2.save(); c2.globalCompositeOperation='lighter';
              c2.drawImage(ci, fx, fy, SFW, SFH, x, y, CELL, CELL);
              c2.restore(); drawn=[statusEffs[i],statusEffs[j]];
            }
          }
        }
        const remaining = drawn ? statusEffs.filter(e=>!drawn.includes(e)) : statusEffs;
        for (const e of remaining) {
          const fIdx2 = ts ? (Math.floor(ts/(_effectSpeeds[e]||120)) + phOff) % 8 : phOff % 8;
          drawSprite(c2, e, fIdx2, x, y);
        }
      }

      // Cycling multi-colour border
      const bcs = statusEffs.map(e => _borderColors[e]||'#888');
      c2.globalAlpha = 0.7;
      c2.lineWidth = 1.5;
      for (let i = 0; i < bcs.length; i++) {
        const t2 = (ts || 0) * 0.0008;
        const offset = (i / bcs.length + t2) % 1;
        c2.strokeStyle = bcs[i];
        c2.beginPath();
        const perim = 2*(CELL-1.2);
        c2.setLineDash([perim/bcs.length * 0.7, perim - perim/bcs.length * 0.7]);
        c2.lineDashOffset = -(offset * perim);
        c2.strokeRect(x+.6,y+.6,CELL-1.2,CELL-1.2);
      }
      c2.setLineDash([]);
      c2.globalAlpha = 1;
      c2.restore();
      return;

    } else {
      // ── Single status effect ────────────────────────────────────
      const se = statusEffs[0];
      if (se==='fire') {
        c2.fillStyle=`rgba(30,5,0,${bgA})`; c2.fillRect(x,y,CELL,CELL);
        const fIdx = ts ? (Math.floor(ts/120) + phOff) % 8 : phOff % 8;
        if (!drawSprite(c2, 'fire', fIdx, x, y)) {
          const fl=ts?0.75+0.25*Math.sin(ts*.006+ph):1;
          const g=c2.createLinearGradient(x,y+CELL,x,y);
          g.addColorStop(0,`rgba(255,60,0,${.85*fl})`); g.addColorStop(.4,`rgba(255,140,10,${.6*fl})`);
          g.addColorStop(.75,`rgba(255,220,40,${.28*fl})`); g.addColorStop(1,`rgba(255,255,180,${.06*fl})`);
          c2.fillStyle=g; c2.fillRect(x,y,CELL,CELL);
        }
      } else if (se==='poison') {
        c2.fillStyle=`rgba(5,15,3,${bgA})`; c2.fillRect(x,y,CELL,CELL);
        const fIdx2 = ts ? (Math.floor(ts/140) + phOff) % 8 : phOff % 8;
        if (!drawSprite(c2, 'poison', fIdx2, x, y)) {
          const p=ts?0.7+0.3*Math.sin(ts*.004+ph):1;
          const g=c2.createRadialGradient(x+CELL/2,y+CELL/2,0,x+CELL/2,y+CELL/2,CELL*.7);
          g.addColorStop(0,`rgba(120,230,20,${.5*p})`); g.addColorStop(.5,`rgba(50,140,10,${.38*p})`); g.addColorStop(1,'rgba(10,40,0,0)');
          c2.fillStyle=g; c2.fillRect(x,y,CELL,CELL);
          c2.globalAlpha=.22; c2.strokeStyle='rgba(80,200,10,0.8)'; c2.lineWidth=1;
          for(let i=0;i<3;i++){const ci=x+CELL*(.25+i*.25);c2.beginPath();c2.moveTo(ci,y+2);c2.lineTo(ci,y+CELL*.6+Math.sin(ph+i)*CELL*.2);c2.stroke();}
          c2.globalAlpha=1;
        }
      } else if (se==='ice') {
        c2.fillStyle=`rgba(3,8,20,${bgA})`; c2.fillRect(x,y,CELL,CELL);
        const fIdx3 = ts ? (Math.floor(ts/160) + phOff) % 8 : phOff % 8;
        if (!drawSprite(c2, 'ice', fIdx3, x, y)) {
          const g=c2.createLinearGradient(x,y,x+CELL,y+CELL);
          g.addColorStop(0,'rgba(150,210,255,0.55)'); g.addColorStop(.5,'rgba(60,130,220,0.4)'); g.addColorStop(1,'rgba(20,60,160,0.6)');
          c2.fillStyle=g; c2.fillRect(x,y,CELL,CELL);
          c2.globalAlpha=.2; c2.strokeStyle='rgba(200,240,255,0.9)'; c2.lineWidth=.8;
          const cx2=x+CELL/2, cy2=y+CELL/2, s=CELL*.36;
          c2.beginPath();c2.moveTo(cx2,cy2-s);c2.lineTo(cx2+s,cy2);c2.lineTo(cx2,cy2+s);c2.lineTo(cx2-s,cy2);c2.closePath();c2.stroke();
          c2.beginPath();c2.moveTo(cx2-s*.58,cy2-s*.58);c2.lineTo(cx2+s*.58,cy2+s*.58);c2.stroke();
          c2.beginPath();c2.moveTo(cx2+s*.58,cy2-s*.58);c2.lineTo(cx2-s*.58,cy2+s*.58);c2.stroke();
          c2.globalAlpha=1;
          const sh=c2.createLinearGradient(x,y,x+CELL*.4,y+CELL*.4);sh.addColorStop(0,'rgba(255,255,255,0.16)');sh.addColorStop(1,'rgba(255,255,255,0)');c2.fillStyle=sh;c2.fillRect(x,y,CELL,CELL);
        }
      } else if (se==='lightning') {
        c2.fillStyle=`rgba(4,2,18,${bgA})`; c2.fillRect(x,y,CELL,CELL);
        const fIdx5 = ts ? (Math.floor(ts/60) + phOff) % 8 : phOff % 8;
        if (!drawSprite(c2, 'lightning', fIdx5, x, y)) {
          const fl=ts?0.5+0.5*Math.sin(ts*.012+ph):1;
          const g=c2.createRadialGradient(x+CELL/2,y+CELL/2,0,x+CELL/2,y+CELL/2,CELL*.65);
          g.addColorStop(0,`rgba(200,230,255,${.5*fl})`); g.addColorStop(.4,`rgba(100,160,255,${.28*fl})`); g.addColorStop(1,'rgba(30,50,150,0)');
          c2.fillStyle=g; c2.fillRect(x,y,CELL,CELL);
        }
      } else if (se==='holy') {
        c2.fillStyle=`rgba(8,4,18,${bgA})`; c2.fillRect(x,y,CELL,CELL);
        const fIdx4 = ts ? (Math.floor(ts/130) + phOff) % 8 : phOff % 8;
        if (!drawSprite(c2, 'holy', fIdx4, x, y)) {
          const p=ts?0.65+0.35*Math.abs(Math.sin(ts*.003+ph)):1;
          const g=c2.createRadialGradient(x+CELL/2,y+CELL/2,0,x+CELL/2,y+CELL/2,CELL*.72);
          g.addColorStop(0,`rgba(255,255,220,${.55*p})`); g.addColorStop(.45,`rgba(200,185,255,${.33*p})`); g.addColorStop(1,'rgba(80,60,180,0)');
          c2.fillStyle=g; c2.fillRect(x,y,CELL,CELL);
          c2.globalAlpha=.28*p; c2.strokeStyle='rgba(255,255,200,0.9)'; c2.lineWidth=.8;
          const cx2=x+CELL/2, cy2=y+CELL/2, r2=CELL*.32;
          for(let a=0;a<4;a++){const ag=a*Math.PI/2;c2.beginPath();c2.moveTo(cx2,cy2);c2.lineTo(cx2+Math.cos(ag)*r2,cy2+Math.sin(ag)*r2);c2.stroke();}
          for(let a=0;a<4;a++){const ag=a*Math.PI/2+Math.PI/4;c2.beginPath();c2.moveTo(cx2,cy2);c2.lineTo(cx2+Math.cos(ag)*r2*.65,cy2+Math.sin(ag)*r2*.65);c2.stroke();}
          c2.globalAlpha=1;
        }
      } else if (se==='difficult') {
        c2.fillStyle=`rgba(180,150,30,${bgA*0.45})`; c2.fillRect(x,y,CELL,CELL);
        c2.save();
        c2.strokeStyle='rgba(200,170,20,0.65)';
        c2.lineWidth=Math.max(0.8, CELL*0.04);
        const hSpacing=Math.max(4, CELL/4);
        for(let offset=-CELL; offset<CELL*2; offset+=hSpacing){
          c2.beginPath(); c2.moveTo(x+offset, y); c2.lineTo(x+offset+CELL, y+CELL); c2.stroke();
        }
        c2.restore();
      } else if (se==='blood') {
        if (!hasTerrain) { c2.fillStyle=`rgba(20,2,5,${bgA})`; c2.fillRect(x,y,CELL,CELL); }
        const _bpx=Math.max(1,Math.round(CELL/12));
        const bpositions=[[0.2,0.3],[0.5,0.18],[0.72,0.5],[0.3,0.65],[0.62,0.75],[0.15,0.52],[0.82,0.28]];
        for(const [fx,fy] of bpositions){
          const bx=x+Math.floor(fx*CELL/_bpx)*_bpx, by=y+Math.floor(fy*CELL/_bpx)*_bpx;
          c2.fillStyle='#6b0e18'; c2.fillRect(bx, by, 3*_bpx, 2*_bpx);
          c2.fillStyle='#c01828'; c2.fillRect(bx+_bpx, by+_bpx, _bpx, _bpx);
        }
      }
    }
  }

  // ── Border: status colour takes priority; fall back to terrain ───
  const _bcMap = {fire:'#E85020',poison:'#50A010',ice:'#3080C0',lightning:'#7050EE',holy:'#C0A020',erase:'#A02020',water:'#1870C0',grass:'#3a8818',lava:'#CC3300',stone:'#8a7a6a',difficult:'#C8A000',blood:'#801020'};
  const borderEff = hasStatus ? statusEffs[0] : (hasTerrain ? terrainEffs[0] : null);
  if (borderEff) {
    c2.globalAlpha=.5; c2.strokeStyle=_bcMap[borderEff]||'#888'; c2.lineWidth=1.2;
    c2.strokeRect(x+.6,y+.6,CELL-1.2,CELL-1.2);
  }
  c2.restore();
}

function rebuildCells() {
  cctx.clearRect(0,0,cellCvs.width,cellCvs.height);
  for (const [k,effs] of Object.entries(grid)) {
    const [r,c]=k.split(',').map(Number); drawCell(cctx,r,c,effs,0);
  }
}

// Terrain effects are mutually exclusive with each other (only one terrain per cell),
// but they can coexist with status effects (fire/ice/etc.) which layer on top.
const TERRAIN_EFFECTS = new Set(['water', 'grass', 'lava', 'stone']);

function putCells(cells, eff) {
  pushUndo();
  for (const k of cells) {
    const [r,c]=k.split(',').map(Number);
    if (eff==='erase') {
      delete grid[k]; cctx.clearRect(c*CELL,r*CELL,CELL,CELL);
      const ti=tokens.findIndex(t=>t.r===r&&t.c===c); if(ti!==-1) tokens.splice(ti,1);
    } else {
      if (!grid[k]) grid[k] = [];
      // Terrain effects are mutually exclusive — remove any other terrain effect first
      if (TERRAIN_EFFECTS.has(eff)) grid[k] = grid[k].filter(e => !TERRAIN_EFFECTS.has(e));
      if (!grid[k].includes(eff)) grid[k].push(eff);
      cctx.clearRect(c*CELL,r*CELL,CELL,CELL);
      drawCell(cctx,r,c,grid[k],0);
    }
  }
  if (eff === 'erase') eraseWallsNearCells(cells);
}

function eraseAt(r,c) {
  const k=r+','+c;
  if (grid[k]) { delete grid[k]; cctx.clearRect(c*CELL,r*CELL,CELL,CELL); }
  const ti = tokens.findIndex(t=>t.r===r && t.c===c);
  if (ti !== -1) tokens.splice(ti, 1);
  // Erase cover markers on all edges of this cell
  ['n','s','e','w'].forEach(edge => delete covers[r+','+c+','+edge]);
  // Also erase any walls near this cell
  eraseWallsNearCells(new Set([k]));
}

function eraseWallsNearCells(cells) {
  if (!walls.length) return;
  const toDelete = new Set();
  for (const k of cells) {
    const [r, c] = k.split(',').map(Number);
    const cx = (c + 0.5) * CELL, cy = (r + 0.5) * CELL;
    for (const w of walls) {
      if (toDelete.has(w.id)) continue;
      const wx1 = w.fx1 * canvas.width,  wy1 = w.fy1 * canvas.height;
      const wx2 = w.fx2 * canvas.width,  wy2 = w.fy2 * canvas.height;
      const dx = wx2 - wx1, dy = wy2 - wy1, len2 = dx*dx + dy*dy;
      let d;
      if (len2 === 0) {
        d = Math.hypot(cx - wx1, cy - wy1);
      } else {
        const tt = Math.max(0, Math.min(1, ((cx-wx1)*dx + (cy-wy1)*dy) / len2));
        d = Math.hypot(cx - (wx1 + tt*dx), cy - (wy1 + tt*dy));
      }
      if (d < CELL * 1.0) toDelete.add(w.id);
    }
  }
  if (toDelete.size) walls = walls.filter(w => !toDelete.has(w.id));
}

function fogReset() {
  for (const k in fogVis)    delete fogVis[k];
  for (const k in fogTarget) delete fogTarget[k];
}

function fogSetCells(cells, reveal) {
  for (const k of cells) {
    if (!(k in fogVis)) fogVis[k] = reveal ? 0 : 1;
    fogTarget[k] = reveal ? 1 : 0;
  }
}

function fogFill(reveal) {
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const k = r+','+c;
      if (!(k in fogVis)) fogVis[k] = reveal ? 0 : 1;
      fogTarget[k] = reveal ? 1 : 0;
    }
}

function cellEffects(k) { return grid[k] || []; }

// ── Token helpers ─────────────────────────────────────────────
function lighten(hex,a){const r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16);return`rgb(${Math.min(255,r+(a*255)|0)},${Math.min(255,g+(a*255)|0)},${Math.min(255,b+(a*255)|0)})`;}
function isDark(hex){const r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16);return(r*.299+g*.587+b*.114)<160;}

function tokenAt(x,y){
  const cell=cellFromXY(x,y);
  for(let i=tokens.length-1;i>=0;i--){
    const t=tokens[i], s=t.size||1;
    if(cell.r>=t.r&&cell.r<t.r+s&&cell.c>=t.c&&cell.c<t.c+s) return t;
  }
  return null;
}

function getMoveCells(tok) {
  const s=tok.size||1, spd=tok.speed??6, cells=new Set();
  for(let r=0;r<rows;r++) for(let c=0;c<cols;c++){
    const dr=Math.max(0,Math.max(tok.r-r, r-(tok.r+s-1)));
    const dc=Math.max(0,Math.max(tok.c-c, c-(tok.c+s-1)));
    if(Math.max(dr,dc)<=spd) cells.add(r+','+c);
  }
  for(let r=tok.r;r<tok.r+s;r++) for(let c=tok.c;c<tok.c+s;c++) cells.delete(r+','+c);
  return cells;
}

function drawToken(tok) {
  const s=tok.size||1;
  const x=tok.c*CELL+s*CELL/2, y=tok.r*CELL+s*CELL/2, rad=s*CELL*.38;
  ctx.save();
  // Shadow
  ctx.globalAlpha=.32; ctx.fillStyle='rgba(0,0,0,0.8)';
  ctx.beginPath(); ctx.ellipse(x,y+rad*.55,rad*.65,rad*.25,0,0,Math.PI*2); ctx.fill();
  ctx.globalAlpha=1;
  // Body
  const grad=ctx.createRadialGradient(x-rad*.28,y-rad*.28,0,x,y,rad);
  grad.addColorStop(0,lighten(tok.color,.38)); grad.addColorStop(1,tok.color);
  ctx.fillStyle=grad; ctx.beginPath(); ctx.arc(x,y,rad,0,Math.PI*2); ctx.fill();
  // Bloodied overlay (bottom half, red)
  const hp=tok.hp, maxHp=tok.maxHp;
  if(hp!=null&&maxHp!=null&&maxHp>0&&hp<=maxHp/2){
    ctx.save(); ctx.globalAlpha=.5; ctx.fillStyle='#CC1020';
    ctx.beginPath(); ctx.arc(x,y,rad,0,Math.PI); ctx.closePath(); ctx.fill();
    ctx.globalAlpha=.92; ctx.fillStyle='#fff';
    ctx.font=`bold ${Math.max(7,Math.round(rad*.5))}px system-ui`;
    ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText('B',x,y+rad*.55); ctx.restore();
  }
  // Rim
  ctx.strokeStyle='rgba(255,255,255,0.32)'; ctx.lineWidth=1;
  ctx.beginPath(); ctx.arc(x,y,rad,0,Math.PI*2); ctx.stroke();
  // Highlight
  const hl=ctx.createRadialGradient(x-rad*.32,y-rad*.38,0,x-rad*.2,y-rad*.2,rad*.6);
  hl.addColorStop(0,'rgba(255,255,255,0.42)'); hl.addColorStop(1,'rgba(255,255,255,0)');
  ctx.fillStyle=hl; ctx.beginPath(); ctx.arc(x,y,rad,0,Math.PI*2); ctx.fill();
  // Label
  const label=tok.name?(tok.name.length>3?tok.name.slice(0,3):tok.name):'?';
  ctx.fillStyle=isDark(tok.color)?'#fff':'#111';
  ctx.font=`bold ${Math.max(8,Math.floor(s*CELL*.28))}px system-ui,sans-serif`;
  ctx.textAlign='center'; ctx.textBaseline='middle'; ctx.fillText(label,x,y);
  // HP bar
  if(hp!=null&&maxHp!=null&&maxHp>0&&hp>0){
    const ratio=Math.max(0,Math.min(1,hp/maxHp));
    const bw=s*CELL*.78, bh=Math.max(3,CELL*.07);
    const bx=x-bw/2, by=y+rad+2;
    const bc=ratio>.5?'rgba(40,200,60,.9)':ratio>.25?'rgba(220,160,20,.9)':'rgba(220,40,40,.9)';
    ctx.save(); ctx.globalAlpha=.82;
    ctx.fillStyle='rgba(0,0,0,.55)'; ctx.fillRect(bx,by,bw,bh);
    ctx.fillStyle=bc; ctx.fillRect(bx,by,bw*ratio,bh);
    ctx.restore();
  }
  // Death save pips (when hp <= 0 and maxHp > 0)
  if(hp!=null&&maxHp!=null&&maxHp>0&&hp<=0){
    const ds=tok.deathSaves||{successes:0,failures:0};
    const sq=Math.max(4,Math.floor(CELL*.12));
    const gap=2;
    const rowW=3*(sq+gap)-gap;
    const dsBaseY=y+rad+4;
    const sStartX=x-rowW/2;
    ctx.save();
    // Successes row label
    ctx.fillStyle='rgba(255,255,255,0.5)'; ctx.font=`bold ${Math.max(5,sq-1)}px system-ui`;
    ctx.textAlign='right'; ctx.textBaseline='middle';
    ctx.fillText('S',sStartX-3,dsBaseY+sq/2);
    // Success squares
    for(let i=0;i<3;i++){
      const sx=sStartX+i*(sq+gap), sy=dsBaseY;
      ctx.fillStyle=i<ds.successes?'#2ECC71':'rgba(0,0,0,0.55)';
      ctx.fillRect(sx,sy,sq,sq);
      ctx.strokeStyle='rgba(46,204,113,0.7)'; ctx.lineWidth=1;
      ctx.strokeRect(sx+.5,sy+.5,sq-1,sq-1);
    }
    const fBaseY=dsBaseY+sq+3;
    ctx.fillStyle='rgba(255,255,255,0.5)'; ctx.textAlign='right'; ctx.textBaseline='middle';
    ctx.fillText('F',sStartX-3,fBaseY+sq/2);
    // Failure squares
    for(let i=0;i<3;i++){
      const sx=sStartX+i*(sq+gap), sy=fBaseY;
      ctx.fillStyle=i<ds.failures?'#E74C3C':'rgba(0,0,0,0.55)';
      ctx.fillRect(sx,sy,sq,sq);
      ctx.strokeStyle='rgba(231,76,60,0.7)'; ctx.lineWidth=1;
      ctx.strokeRect(sx+.5,sy+.5,sq-1,sq-1);
    }
    ctx.restore();
  }
  // Initiative badge
  const ie=initiative.find(i=>i.tokenId===tok.id);
  if(ie){
    const bx=x+rad*.65, by=y-rad*.65, br=Math.max(CELL*.18,s*CELL*.18);
    ctx.fillStyle='rgba(12,10,24,0.9)'; ctx.beginPath(); ctx.arc(bx,by,br,0,Math.PI*2); ctx.fill();
    ctx.strokeStyle=tok.color; ctx.lineWidth=1; ctx.stroke();
    ctx.fillStyle='#fff'; ctx.font=`bold ${Math.max(6,Math.floor(br*1.1))}px system-ui`;
    ctx.textAlign='center'; ctx.textBaseline='middle'; ctx.fillText(ie.score,bx,by);
  }
  // Concentration badge (bottom-left)
  if(tok.concentrating){
    const cbr=Math.max(CELL*.16,s*CELL*.16);
    const cbx=x-rad*.65, cby=y+rad*.65;
    ctx.fillStyle='rgba(80,30,160,0.92)'; ctx.beginPath(); ctx.arc(cbx,cby,cbr,0,Math.PI*2); ctx.fill();
    ctx.strokeStyle='#9B59B6'; ctx.lineWidth=1; ctx.stroke();
    ctx.fillStyle='#fff'; ctx.font=`bold ${Math.max(6,Math.floor(cbr*1.1))}px system-ui`;
    ctx.textAlign='center'; ctx.textBaseline='middle'; ctx.fillText('C',cbx,cby);
  }
  // Exhaustion badge (bottom-right area, below condition dots)
  if(tok.exhaustion>0){
    const ex=tok.exhaustion;
    const ecol=ex<=2?'#F1C40F':ex<=4?'#E67E22':'#E74C3C';
    const ebr=Math.max(CELL*.15,s*CELL*.15);
    const ebx=x+rad*.65, eby=y+rad*.65;
    ctx.fillStyle='rgba(12,10,24,0.88)'; ctx.beginPath(); ctx.arc(ebx,eby,ebr,0,Math.PI*2); ctx.fill();
    ctx.strokeStyle=ecol; ctx.lineWidth=1; ctx.stroke();
    ctx.fillStyle=ecol; ctx.font=`bold ${Math.max(5,Math.floor(ebr*1.0))}px system-ui`;
    ctx.textAlign='center'; ctx.textBaseline='middle'; ctx.fillText('E'+ex,ebx,eby);
  }
  // Condition dots
  const conds=tok.conditions||[];
  if(conds.length>0){
    const dr=Math.max(3,CELL*.09);
    const startX=x-((Math.min(conds.length,8))*(dr*2+1.5))/2+dr;
    const dotY=y+rad+(hp!=null&&maxHp!=null&&hp>0?CELL*.14+3:4);
    ctx.save();
    conds.slice(0,8).forEach((ck,i)=>{
      ctx.fillStyle=COND_COLORS[ck]||'#aaa'; ctx.globalAlpha=.9;
      ctx.beginPath(); ctx.arc(startX+i*(dr*2+1.5),dotY,dr,0,Math.PI*2); ctx.fill();
    });
    if(conds.length>8){
      ctx.fillStyle='rgba(255,255,255,.6)'; ctx.font=`bold ${dr*2}px system-ui`;
      ctx.textAlign='center'; ctx.fillText('+',startX+8*(dr*2+1.5),dotY+1);
    }
    ctx.restore();
  }
  ctx.restore();
}

function drawMovementRange(tok) {
  const cells=getMoveCells(tok);
  ctx.save();
  ctx.fillStyle='rgba(60,180,255,0.10)'; ctx.strokeStyle='rgba(60,180,255,0.32)';
  ctx.lineWidth=0.8; ctx.setLineDash([2,2]);
  for(const k of cells){const[r,c]=k.split(',').map(Number);ctx.fillRect(c*CELL,r*CELL,CELL,CELL);ctx.strokeRect(c*CELL+.5,r*CELL+.5,CELL-1,CELL-1);}
  ctx.setLineDash([]);
  const s=tok.size||1, spd=tok.speed??6;
  const cx2=(tok.c+s/2)*CELL, cy2=(tok.r-.22)*CELL;
  ctx.fillStyle='rgba(60,180,255,.9)'; ctx.font=`bold ${Math.max(8,CELL*.22)}px system-ui`;
  ctx.textAlign='center'; ctx.fillText(spd+' sq',cx2,cy2);
  ctx.restore();
}

function getCobblestonePattern() {
  if (_cobblePattern && _cobbleCELL === CELL) return _cobblePattern;
  _cobbleCELL = CELL;

  // Each stone is ~half a cell; 2×2 grid of stones per tile
  const ss  = Math.max(8, Math.floor(CELL * 0.52));   // stone size (px)
  const mg  = Math.max(2, Math.floor(ss * 0.14));      // mortar gap
  const T   = ss * 2 + mg * 3;                         // tile width/height

  const tc  = document.createElement('canvas');
  tc.width  = T; tc.height = T;
  const tx  = tc.getContext('2d');

  // ── Mortar fill ──────────────────────────────────────────────
  tx.fillStyle = '#16130f';
  tx.fillRect(0, 0, T, T);

  // ── Stone palette (4 slightly varied grays) ──────────────────
  const STONES = ['#72706a', '#676460', '#7a7772', '#5e5c58'];

  const positions = [
    [mg,          mg,          0],
    [mg*2+ss,     mg,          1],
    [mg,          mg*2+ss,     2],
    [mg*2+ss,     mg*2+ss,     3],
  ];

  for (const [sx, sy, ci] of positions) {
    // Base stone
    tx.fillStyle = STONES[ci];
    tx.fillRect(sx, sy, ss, ss);

    const hl = Math.max(1, Math.floor(ss * 0.09));  // highlight thickness
    const sh = Math.max(1, Math.floor(ss * 0.09));  // shadow thickness

    // Top-left highlight (bright pixel row/col)
    tx.fillStyle = 'rgba(255,252,210,0.22)';
    tx.fillRect(sx,      sy,      ss, hl);   // top edge
    tx.fillRect(sx,      sy,      hl, ss);   // left edge

    // Bottom-right shadow
    tx.fillStyle = 'rgba(0,0,0,0.38)';
    tx.fillRect(sx,      sy+ss-sh, ss, sh);  // bottom edge
    tx.fillRect(sx+ss-sh,sy,       sh, ss);  // right edge

    // Inner texture: darker recessed area (3/8 from top-left)
    const rx = sx + Math.floor(ss*0.30), ry = sy + Math.floor(ss*0.32);
    const rw = Math.max(2, Math.floor(ss*0.22)), rh = Math.max(2, Math.floor(ss*0.20));
    tx.fillStyle = 'rgba(0,0,0,0.16)';
    tx.fillRect(rx, ry, rw, rh);

    // Small bright chip (8-bit sparkle, top-right area)
    const chipS = Math.max(1, Math.floor(ss*0.11));
    tx.fillStyle = 'rgba(255,252,210,0.14)';
    tx.fillRect(sx + Math.floor(ss*0.60), sy + Math.floor(ss*0.13), chipS, chipS);
  }

  _cobblePattern = ctx.createPattern(tc, 'repeat');
  return _cobblePattern;
}

// ── 8-bit top-down flowing water (1"×1" tile = exactly CELL×CELL) ──
function getWaterPattern() {
  if (_waterPattern && _waterCELL === CELL) return _waterPattern;
  _waterCELL = CELL;

  const S  = Math.max(8, CELL);                  // tile = 1 grid cell
  const px = Math.max(1, Math.round(S / 14));    // pixel block size

  const tc = document.createElement('canvas');
  tc.width = S; tc.height = S;
  const tx = tc.getContext('2d');

  // ── Palette ──────────────────────────────────────────────────
  const DEEP  = '#071828';   // deep trough
  const DARK  = '#0d2d50';   // dark transition
  const MID   = '#1460a8';   // main water body
  const LIGHT = '#1e88d8';   // lighter downstream face
  const CREST = '#42b8f8';   // wave crest highlight
  const FOAM  = '#b0e4ff';   // foam sparkle

  // ── Base fill ────────────────────────────────────────────────
  tx.fillStyle = MID;
  tx.fillRect(0, 0, S, S);

  // ── 2 wave cycles per tile (seamless vertical repeat) ────────
  const numWaves = 2;
  const wH = S / numWaves;

  for (let wi = 0; wi < numWaves; wi++) {
    const wy = wi * wH;

    // Trough: deep dark band at the bottom of each cycle
    const troughH = Math.max(px, Math.round(wH * 0.28));
    tx.fillStyle = DEEP;
    tx.fillRect(0, wy + wH - troughH, S, troughH);

    // Dark transition just above trough
    const darkH = Math.max(px, Math.round(wH * 0.26));
    tx.fillStyle = DARK;
    tx.fillRect(0, wy + wH - troughH - darkH, S, darkH);

    // Crest: bright undulating band near the top of each cycle
    const crestY = wy + Math.round(wH * 0.08);
    const crestH = Math.max(px * 2, Math.round(wH * 0.26));

    for (let bx = 0; bx < S; bx += px) {
      // Sine undulation — 2 humps across the tile width
      const sine = Math.sin((bx / S) * Math.PI * 4);
      const off  = Math.round(sine * px);

      // Lighter body of crest
      tx.fillStyle = LIGHT;
      tx.fillRect(bx, crestY + off, px, crestH);

      // Bright leading edge of crest
      tx.fillStyle = CREST;
      tx.fillRect(bx, crestY + off, px, Math.max(px, Math.round(crestH * 0.38)));
    }

    // Foam sparkle pixels at the very peak of the crest
    tx.fillStyle = FOAM;
    for (let bx = 0; bx < S; bx += px * 5) {
      const sine = Math.sin((bx / S) * Math.PI * 4);
      const off  = Math.round(sine * px);
      tx.fillRect(bx + px, crestY + off - px, px, px);
    }
  }

  _waterPattern = ctx.createPattern(tc, 'repeat');
  return _waterPattern;
}

// ── 8-bit top-down grass tile (1"×1" = CELL×CELL) ───────────
function getGrassPattern() {
  if (_grassPattern && _grassCELL === CELL) return _grassPattern;
  _grassCELL = CELL;

  const S  = Math.max(8, CELL);
  const px = Math.max(1, Math.round(S / 14));  // pixel block size

  const tc = document.createElement('canvas');
  tc.width = S; tc.height = S;
  const tx = tc.getContext('2d');

  // ── Palette ──────────────────────────────────────────────────
  const BASE   = '#2d6e14';   // main grass body
  const DARK   = '#1e4a0c';   // shadow / depth
  const MID    = '#3d9020';   // lighter patch
  const LIGHT  = '#56b82c';   // bright face
  const TIP    = '#7ed43e';   // blade tip highlight
  const BRIGHT = '#a0e860';   // sunlit specks

  // ── Base fill ────────────────────────────────────────────────
  tx.fillStyle = BASE;
  tx.fillRect(0, 0, S, S);

  // ── Checkerboard shadow patches for depth variation ──────────
  const ck = px * 3;
  for (let ry = 0; ry < S; ry += ck) {
    for (let cx = 0; cx < S; cx += ck) {
      if (((ry / ck | 0) + (cx / ck | 0)) % 2 === 0) {
        tx.fillStyle = DARK;
        tx.fillRect(cx, ry, px * 2, px * 2);
      }
    }
  }

  // ── Mid-tone patches (light areas between blades) ────────────
  tx.fillStyle = MID;
  for (let ry = px; ry < S; ry += px * 4) {
    for (let cx = px * 2; cx < S; cx += px * 4) {
      tx.fillRect(cx, ry, px, px);
    }
  }

  // ── Grass blade clusters ─────────────────────────────────────
  // Pseudo-random positions anchored by pixel math (no Math.random — deterministic)
  const blades = [
    [0.08, 0.04], [0.32, 0.07], [0.62, 0.02], [0.84, 0.11],
    [0.18, 0.30], [0.50, 0.25], [0.76, 0.38], [0.06, 0.52],
    [0.42, 0.58], [0.68, 0.62], [0.28, 0.74], [0.90, 0.70],
    [0.14, 0.86], [0.58, 0.90], [0.80, 0.95],
  ];

  for (const [fx, fy] of blades) {
    const bx = Math.floor(fx * S / px) * px;
    const by = Math.floor(fy * S / px) * px;
    const h  = Math.max(px * 2, Math.round(px * (2 + Math.abs(Math.sin(bx * 1.3)) * 2)));

    // Blade body — light face
    tx.fillStyle = LIGHT;
    tx.fillRect(bx, by, px, h);

    // Bright tip (top pixel)
    tx.fillStyle = TIP;
    tx.fillRect(bx, by, px, px);

    // Shadow pixel to the right of blade
    if (bx + px < S) {
      tx.fillStyle = DARK;
      tx.fillRect(bx + px, by + px, px, Math.max(px, h - px));
    }
  }

  // ── Sunlit bright specks ─────────────────────────────────────
  tx.fillStyle = BRIGHT;
  for (let ry = 0; ry < S; ry += px * 7) {
    for (let cx = px * 3; cx < S; cx += px * 6) {
      tx.fillRect(cx, ry, px, px);
    }
  }

  _grassPattern = ctx.createPattern(tc, 'repeat');
  return _grassPattern;
}

// ── 8-bit top-down lava tile (1"×1" = CELL×CELL) ────────────
function getLavaPattern() {
  if (_lavaPattern && _lavaCELL === CELL) return _lavaPattern;
  _lavaCELL = CELL;

  const S  = Math.max(8, CELL);
  const px = Math.max(1, Math.round(S / 14));

  const tc = document.createElement('canvas');
  tc.width = S; tc.height = S;
  const tx = tc.getContext('2d');

  const DEEP   = '#1a0400';
  const DARK   = '#3d0800';
  const MID    = '#8b1800';
  const HOT    = '#cc3000';
  const CREST  = '#ff5500';
  const BRIGHT = '#ff9900';

  // Base fill
  tx.fillStyle = DEEP;
  tx.fillRect(0, 0, S, S);

  // Dark crust patches
  tx.fillStyle = DARK;
  for (let ry = 0; ry < S; ry += px * 4) {
    for (let cx = 0; cx < S; cx += px * 5) {
      if (((ry / (px*4) | 0) + (cx / (px*5) | 0)) % 3 !== 0) {
        tx.fillRect(cx, ry, px * 3, px * 2);
      }
    }
  }

  // Two horizontal lava river bands
  const numBands = 2;
  const bH = S / numBands;
  for (let bi = 0; bi < numBands; bi++) {
    const by = bi * bH;
    const riverH = Math.max(px, Math.round(bH * 0.35));
    const riverY = by + Math.round(bH * 0.3);
    // MID outer
    tx.fillStyle = MID;
    tx.fillRect(0, riverY, S, riverH);
    // HOT inner
    const innerH = Math.max(px, Math.round(riverH * 0.55));
    tx.fillStyle = HOT;
    tx.fillRect(0, riverY + Math.round(riverH * 0.22), S, innerH);
    // CREST center line
    tx.fillStyle = CREST;
    tx.fillRect(0, riverY + Math.round(riverH * 0.44), S, Math.max(px, Math.round(riverH * 0.18)));
  }

  // BRIGHT hotspot pixels
  tx.fillStyle = BRIGHT;
  for (let ry = px; ry < S; ry += px * 7) {
    for (let cx = px * 2; cx < S; cx += px * 5) {
      tx.fillRect(cx, ry, px, px);
    }
  }

  // Small dark crater squares with CREST rim
  const craters = [[0.15,0.12],[0.6,0.08],[0.35,0.55],[0.78,0.62],[0.08,0.72]];
  for (const [fx, fy] of craters) {
    const crx = Math.floor(fx * S / px) * px;
    const cry = Math.floor(fy * S / px) * px;
    tx.fillStyle = DEEP;
    tx.fillRect(crx, cry, px*2, px*2);
    tx.fillStyle = CREST;
    tx.fillRect(crx - px, cry, px, px);
    tx.fillRect(crx, cry - px, px, px);
  }

  _lavaPattern = ctx.createPattern(tc, 'repeat');
  return _lavaPattern;
}

// ── 8-bit cobblestone floor tile (static) ────────────────────
function getStoneFloorPattern() {
  if (_stoneFloorPattern && _stoneFloorCELL === CELL) return _stoneFloorPattern;
  _stoneFloorCELL = CELL;

  const S  = Math.max(8, CELL);
  const px = Math.max(1, Math.round(S / 14));

  const MORTAR   = '#1a1714';
  const STONE2   = '#4e4640';
  const STONE3   = '#625850';
  const STONE_HI = '#7a6e65';
  const STONE_SH = '#3c3630';

  // Brick layout: bW = brick width, bH = brick height, mortar = 1px
  const bW = Math.max(4, Math.round(S * 0.52));
  const bH = Math.max(3, Math.round(S * 0.28));
  const mg = Math.max(1, px);

  const tileW = S;
  const tileH = (bH + mg) * 2;

  const tc = document.createElement('canvas');
  tc.width = tileW; tc.height = tileH;
  const tx = tc.getContext('2d');

  tx.fillStyle = MORTAR;
  tx.fillRect(0, 0, tileW, tileH);

  for (let row = 0; row < 2; row++) {
    const oy = row * (bH + mg);
    const offsetX = row % 2 === 0 ? 0 : Math.round(bW / 2);
    for (let bx = -bW; bx < tileW + bW; bx += bW + mg) {
      const sx = bx + offsetX;
      const ex = Math.min(sx + bW, tileW);
      const startX = Math.max(sx, 0);
      if (ex <= 0 || startX >= tileW) continue;
      const w = ex - startX;
      // Base stone
      tx.fillStyle = STONE2;
      tx.fillRect(startX, oy, w, bH);
      // Inner face
      if (w > px * 2 && bH > px * 2) {
        tx.fillStyle = STONE3;
        tx.fillRect(startX + px, oy + px, Math.max(0, w - px*2), Math.max(0, bH - px*2));
      }
      // Top-left highlight
      tx.fillStyle = STONE_HI;
      tx.fillRect(startX, oy, w, px);
      tx.fillRect(startX, oy, px, bH);
      // Bottom-right shadow
      tx.fillStyle = STONE_SH;
      tx.fillRect(startX, oy + bH - px, w, px);
      tx.fillRect(startX + w - px, oy, px, bH);
    }
  }

  _stoneFloorPattern = ctx.createPattern(tc, 'repeat');
  return _stoneFloorPattern;
}

function drawWalls() {
  if (!walls.length && !(wallActive && wallStart)) return;

  const pat       = getCobblestonePattern();
  const thickness = Math.max(10, CELL * 0.52);

  for (const w of walls) {
    const x1=w.fx1*canvas.width, y1=w.fy1*canvas.height;
    const x2=w.fx2*canvas.width, y2=w.fy2*canvas.height;
    if (Math.hypot(x2-x1, y2-y1) < 1) continue;

    ctx.save();
    // Cobblestone fill
    ctx.strokeStyle = pat;
    ctx.lineWidth   = thickness;
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';
    ctx.beginPath();
    ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
    ctx.stroke();
    // Dark mortar outline on top
    ctx.strokeStyle = 'rgba(10,8,5,0.82)';
    ctx.lineWidth   = 1.5;
    ctx.stroke();
    ctx.restore();
  }

  // Ghost preview while drawing
  if (wallActive && wallStart) {
    ctx.save();
    ctx.strokeStyle = 'rgba(100,85,55,0.48)';
    ctx.lineWidth   = thickness;
    ctx.lineCap     = 'round';
    ctx.setLineDash([Math.ceil(thickness * 0.9), Math.ceil(thickness * 0.55)]);
    ctx.beginPath();
    ctx.moveTo(wallStart.x, wallStart.y); ctx.lineTo(mouseX, mouseY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }
}

function deleteNearestWall(x, y, skipUndo=false) {
  let best=null, bd=CELL*2;
  for(const w of walls){
    const wx1=w.fx1*canvas.width,wy1=w.fy1*canvas.height,wx2=w.fx2*canvas.width,wy2=w.fy2*canvas.height;
    const dx=wx2-wx1,dy=wy2-wy1,len2=dx*dx+dy*dy;
    let d;
    if(len2===0){d=Math.hypot(x-wx1,y-wy1);}
    else{const tt=Math.max(0,Math.min(1,((x-wx1)*dx+(y-wy1)*dy)/len2));d=Math.hypot(x-(wx1+tt*dx),y-(wy1+tt*dy));}
    if(d<bd){bd=d;best=w;}
  }
  if(best){if(!skipUndo)pushUndo();walls=walls.filter(w=>w.id!==best.id);}
}

function drawLabels() {
  if(!labels.length) return;
  ctx.save();
  for(const lbl of labels){
    const lx=(lbl.c+.5)*CELL, ly=(lbl.r+.5)*CELL;
    const fs=Math.max(8,Math.min(Math.round(CELL*.28),16));
    ctx.font=`bold ${fs}px system-ui,sans-serif`; ctx.textAlign='center'; ctx.textBaseline='middle';
    const tw=ctx.measureText(lbl.text).width;
    ctx.fillStyle='rgba(0,0,0,.68)'; ctx.fillRect(lx-tw/2-3,ly-fs/2-2,tw+6,fs+4);
    if(labelMode){
      const hc=cellFromXY(mouseX,mouseY);
      if(hc.r===lbl.r&&hc.c===lbl.c){ctx.strokeStyle='rgba(255,200,60,.8)';ctx.lineWidth=1;ctx.strokeRect(lx-tw/2-3,ly-fs/2-2,tw+6,fs+4);}
    }
    ctx.fillStyle='rgba(255,240,180,.95)'; ctx.fillText(lbl.text,lx,ly);
  }
  ctx.restore();
}


// ── Drag ─────────────────────────────────────────────────────
let draggingToken = null;   // { tok, dragX, dragY }  pixel coords while dragging
let dragHasMoved  = false;
let dragStartCell = null;

let boundsMode = false;
let projBounds = null; // { x1, y1, x2, y2 } canvas px — null = not set
let boundsHandle = null; // handle id being dragged, or 'move'
let boundsDragStart = null; // { x, y, b: snapshot of projBounds }
const HANDLE_R = 7;

// ── Cursor / preview ─────────────────────────────────────────
const TRAIL=[], TRAIL_MAX=24;
let mouseInside=false, mouseX=0, mouseY=0, t=0, lastAnim=0;

function drawCursor() {
  if (boundsMode) return;
  if (!mouseInside) return;
  const effKey = tokenMode ? 'fire' : currentEffect;
  const e = EFFECTS[effKey];
  if (!e) return;  // no effect selected — browser cursor (crosshair) shows instead
  const dotColor = tokenMode ? selectedColor : e.glow;
  const rgb = tokenMode
    ? (()=>{const r=parseInt(selectedColor.slice(1,3),16),g=parseInt(selectedColor.slice(3,5),16),b=parseInt(selectedColor.slice(5,7),16);return`${r},${g},${b}`;})()
    : `${e.r},${e.g},${e.b}`;

  for (let i=0;i<TRAIL.length;i++) {
    const pt=TRAIL[i], prog=(i+1)/TRAIL.length, rad=1+prog*3.5;
    ctx.save(); ctx.globalAlpha=prog*.4;
    const tg=ctx.createRadialGradient(pt.x,pt.y,0,pt.x,pt.y,rad);
    tg.addColorStop(0,dotColor); tg.addColorStop(1,'rgba(0,0,0,0)');
    ctx.fillStyle=tg; ctx.beginPath(); ctx.arc(pt.x,pt.y,rad,0,Math.PI*2); ctx.fill(); ctx.restore();
  }
  const halo=ctx.createRadialGradient(mouseX,mouseY,0,mouseX,mouseY,CELL*.8);
  halo.addColorStop(0,`rgba(${rgb},0.12)`); halo.addColorStop(1,'rgba(0,0,0,0)');
  ctx.save(); ctx.fillStyle=halo; ctx.beginPath(); ctx.arc(mouseX,mouseY,CELL*.8,0,Math.PI*2); ctx.fill(); ctx.restore();
  ctx.save(); ctx.globalAlpha=.38; ctx.strokeStyle=dotColor; ctx.lineWidth=.8;
  ctx.beginPath(); ctx.arc(mouseX,mouseY,5.5,0,Math.PI*2); ctx.stroke(); ctx.restore();
  const core=ctx.createRadialGradient(mouseX,mouseY,0,mouseX,mouseY,4.5);
  core.addColorStop(0,'rgba(255,255,255,1)'); core.addColorStop(.35,`rgba(${rgb},0.95)`); core.addColorStop(1,'rgba(0,0,0,0)');
  ctx.save(); ctx.fillStyle=core; ctx.beginPath(); ctx.arc(mouseX,mouseY,4.5,0,Math.PI*2); ctx.fill(); ctx.restore();

  if (!tokenMode && currentEffect==='erase' && currentShape==='draw') {
    const cell=cellFromXY(mouseX,mouseY), x=cell.c*CELL, y=cell.r*CELL;
    ctx.save(); ctx.globalAlpha=.45; ctx.strokeStyle='#FF5050'; ctx.lineWidth=1.5; ctx.setLineDash([3,3]);
    ctx.strokeRect(x+1,y+1,CELL-2,CELL-2); ctx.setLineDash([]);
    ctx.globalAlpha=.10; ctx.fillStyle='rgba(220,50,50,0.4)'; ctx.fillRect(x,y,CELL,CELL); ctx.restore();
  }

  if (tokenMode) {
    const cell=cellFromXY(mouseX,mouseY), tx=cell.c*CELL+CELL/2, ty=cell.r*CELL+CELL/2, tr=CELL*.38;
    ctx.save(); ctx.globalAlpha=.42;
    const grad=ctx.createRadialGradient(tx-tr*.28,ty-tr*.28,0,tx,ty,tr);
    grad.addColorStop(0,lighten(selectedColor,.38)); grad.addColorStop(1,selectedColor);
    ctx.fillStyle=grad; ctx.beginPath(); ctx.arc(tx,ty,tr,0,Math.PI*2); ctx.fill();
    ctx.strokeStyle='rgba(255,255,255,0.5)'; ctx.lineWidth=1; ctx.stroke(); ctx.restore();
  }

  if (!tokenMode && currentShape==='circle') {
    const cell=cellFromXY(mouseX,mouseY);
    ctx.save(); ctx.globalAlpha=.22; ctx.strokeStyle=e.glow; ctx.lineWidth=1.2; ctx.setLineDash([3,3]);
    ctx.beginPath(); ctx.arc(cell.c*CELL+CELL/2,cell.r*CELL+CELL/2,circleRadius*CELL,0,Math.PI*2); ctx.stroke();
    ctx.setLineDash([]); ctx.restore();
  }

  if (!tokenMode && currentShape==='square') {
    const cell=cellFromXY(mouseX,mouseY);
    const sx=(cell.c-circleRadius)*CELL, sy=(cell.r-circleRadius)*CELL, sw=(circleRadius*2+1)*CELL, sh=sw;
    ctx.save(); ctx.globalAlpha=.22; ctx.strokeStyle=e.glow; ctx.lineWidth=1.2; ctx.setLineDash([3,3]);
    ctx.strokeRect(sx,sy,sw,sh); ctx.setLineDash([]); ctx.restore();
  }

  if (!tokenMode && currentShape==='cone' && !coneActive) {
    ctx.save(); ctx.globalAlpha=.22; ctx.strokeStyle=e.glow; ctx.lineWidth=1; ctx.setLineDash([3,3]);
    ctx.beginPath(); ctx.moveTo(mouseX,mouseY); ctx.lineTo(mouseX+CELL*2.5,mouseY-CELL); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(mouseX,mouseY); ctx.lineTo(mouseX+CELL*2.5,mouseY+CELL); ctx.stroke();
    ctx.setLineDash([]); ctx.restore();
  }
}

function previewCells(cells, eff, alpha) {
  const fc={fire:'rgba(232,90,40,',poison:'rgba(80,160,20,',ice:'rgba(50,140,220,',lightning:'rgba(250,180,10,',holy:'rgba(170,160,245,',erase:'rgba(200,50,50,'};
  const e=EFFECTS[eff];
  ctx.save(); ctx.globalAlpha=alpha; ctx.fillStyle=fc[eff]+'0.38)';
  for(const k of cells){const[r,c]=k.split(',').map(Number);ctx.fillRect(c*CELL,r*CELL,CELL,CELL);}
  ctx.globalAlpha=alpha*.65; ctx.strokeStyle=e.glow; ctx.lineWidth=1;
  for(const k of cells){const[r,c]=k.split(',').map(Number);ctx.strokeRect(c*CELL+1,r*CELL+1,CELL-2,CELL-2);}
  ctx.restore();
}

function _spline(c2, pts) {
  if(pts.length<2)return;
  c2.beginPath(); c2.moveTo(pts[0].x,pts[0].y);
  if(pts.length===2){c2.lineTo(pts[1].x,pts[1].y);return;}
  for(let i=1;i<pts.length-1;i++){const mx=(pts[i].x+pts[i+1].x)/2,my=(pts[i].y+pts[i+1].y)/2;c2.quadraticCurveTo(pts[i].x,pts[i].y,mx,my);}
  c2.lineTo(pts[pts.length-1].x,pts[pts.length-1].y);
}

function drawLiveStroke() {
  if(!drawing||rawPts.length<2)return;
  const e=EFFECTS[currentEffect];
  ctx.save(); ctx.lineCap='round'; ctx.lineJoin='round';
  ctx.globalAlpha=.13; ctx.strokeStyle=e.glow; ctx.lineWidth=CELL*.62; _spline(ctx,rawPts); ctx.stroke();
  ctx.globalAlpha=.60; ctx.strokeStyle=`rgba(${e.inkR},0.9)`; ctx.lineWidth=CELL*.20; _spline(ctx,rawPts); ctx.stroke();
  ctx.globalAlpha=.90; ctx.strokeStyle=`rgba(${e.inkR},1)`; ctx.lineWidth=CELL*.075; _spline(ctx,rawPts); ctx.stroke();
  ctx.globalAlpha=.45; ctx.strokeStyle='rgba(255,255,255,0.88)'; ctx.lineWidth=CELL*.028; _spline(ctx,rawPts); ctx.stroke();
  ctx.restore();
  if(isClosed(strokeCells)) previewCells(floodFill(strokeCells),currentEffect,.26);
}

// ── Main render loop ──────────────────────────────────────────
function render(ts) {
  t = ts;
  if (ts - lastAnim > 55) {
    lastAnim = ts;
    const animated = new Set(['fire','holy','lightning','poison','ice','water','lava']);
    for (const [k,effs] of Object.entries(grid)) {
      if (effs.some(e => animated.has(e))) {
        const [r,c]=k.split(',').map(Number); cctx.clearRect(c*CELL,r*CELL,CELL,CELL); drawCell(cctx,r,c,effs,ts);
      }
    }
  }

  // Fog of war — animate visibility toward targets
  if (fogEnabled) {
    for (const k of Object.keys(fogTarget)) {
      const tgt = fogTarget[k];
      const cur = fogVis[k] ?? 0;
      const newV = cur + (tgt - cur) * 0.06;
      fogVis[k] = Math.abs(tgt - newV) < 0.005 ? tgt : newV;
    }
  }

  ctx.clearRect(0,0,canvas.width,canvas.height);

  // Background map image
  if (bgImage) {
    ctx.drawImage(bgImage, 0, 0, canvas.width, canvas.height);
  }

  ctx.save(); ctx.strokeStyle = bgImage ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.05)'; ctx.lineWidth=.5;
  for(let c=0;c<=cols;c++){ctx.beginPath();ctx.moveTo(c*CELL,0);ctx.lineTo(c*CELL,rows*CELL);ctx.stroke();}
  for(let r=0;r<=rows;r++){ctx.beginPath();ctx.moveTo(0,r*CELL);ctx.lineTo(cols*CELL,r*CELL);ctx.stroke();}
  ctx.restore();

  ctx.drawImage(cellCvs,0,0);

  // Walls (below tokens)
  drawWalls();

  // Movement range highlight (behind tokens)
  if(tokenMode && moveRangeToken) drawMovementRange(moveRangeToken);

  // Token lights (under tokens)
  drawTokenLights();

  if (!tokenMode) {
    if (currentShape==='draw' && currentEffect!=='erase') drawLiveStroke();
    if (currentShape==='cone' && coneActive && coneOrigin) {
      const tip=cellFromXY(mouseX,mouseY); previewCells(getConeCells(coneOrigin,tip),currentEffect,.45);
      const e=EFFECTS[currentEffect], ox=coneOrigin.c*CELL+CELL/2, oy=coneOrigin.r*CELL+CELL/2;
      ctx.save();ctx.globalAlpha=.9;ctx.strokeStyle=e.glow;ctx.lineWidth=2;ctx.beginPath();ctx.arc(ox,oy,CELL*.35,0,Math.PI*2);ctx.stroke();
      ctx.globalAlpha=.22;ctx.setLineDash([3,3]);ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(ox,oy);ctx.lineTo(mouseX,mouseY);ctx.stroke();ctx.setLineDash([]);ctx.restore();
    }
    if (currentShape==='circle' && mouseInside) previewCells(getCircleCells(cellFromXY(mouseX,mouseY),circleRadius),currentEffect,.45);
    if (currentShape==='square' && mouseInside) previewCells(getSquareCells(cellFromXY(mouseX,mouseY),circleRadius),currentEffect,.45);
  }

  // Tokens
  for (const tok of tokens) drawToken(tok);

  // Drag ghost
  if (draggingToken && dragHasMoved) {
    const tok=draggingToken.tok, rad=CELL*.38;
    const tx=mouseX, ty=mouseY;
    ctx.save(); ctx.globalAlpha=.55;
    const grad=ctx.createRadialGradient(tx-rad*.28,ty-rad*.28,0,tx,ty,rad);
    grad.addColorStop(0,lighten(tok.color,.38)); grad.addColorStop(1,tok.color);
    ctx.fillStyle=grad; ctx.beginPath(); ctx.arc(tx,ty,rad,0,Math.PI*2); ctx.fill();
    ctx.strokeStyle='rgba(255,255,255,0.5)'; ctx.lineWidth=1.5; ctx.stroke();
    ctx.restore();
  }

  // Initiative highlight
  if (initCurrent>=0 && initCurrent<initiative.length) {
    const entry=initiative[initCurrent], tok=tokens.find(t=>t.id===entry.tokenId);
    if (tok) {
      const x=tok.c*CELL+CELL/2, y=tok.r*CELL+CELL/2, rad=CELL*.44;
      ctx.save(); ctx.globalAlpha=.55+.45*Math.sin(t*.006); ctx.strokeStyle='#FFD700'; ctx.lineWidth=2;
      ctx.beginPath(); ctx.arc(x,y,rad,0,Math.PI*2); ctx.stroke(); ctx.restore();
    }
  }

  // Labels (above tokens)
  drawLabels();

  // Cover indicators
  drawCovers();

  // Traps (only revealed ones on main canvas)
  drawTraps(false);

  // Line of sight
  drawLoS();

  // Teleport selected token ring
  if (teleportMode && teleportToken) {
    const st = teleportToken, ss = st.size || 1;
    const tx2 = st.c * CELL + ss * CELL / 2, ty2 = st.r * CELL + ss * CELL / 2;
    const trad = ss * CELL * 0.44;
    ctx.save();
    ctx.globalAlpha = 0.7 + 0.3 * Math.sin(t * 0.008);
    ctx.strokeStyle = '#9B59B6'; ctx.lineWidth = 2.5;
    ctx.setLineDash([5, 4]);
    ctx.lineDashOffset = -(t * 0.05 % 9);
    ctx.beginPath(); ctx.arc(tx2, ty2, trad, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]); ctx.restore();
  }

  // Ruler
  drawRuler();

  // Grid coordinates
  drawGridCoords();

  // DM reference — capture fog-free state before fog is drawn
  if (dmRefVisible) {
    const rc = document.getElementById('dm-ref-canvas');
    rc.width = canvas.width; rc.height = canvas.height;
    const rctx = rc.getContext('2d');
    rctx.drawImage(canvas, 0, 0);
    // Draw all traps (including unrevealed) on DM ref
    const prevCtx = ctx;
    // Temporarily redirect ctx draws to dm-ref-canvas by drawing traps there
    const savedCtx = ctx;
    // We draw traps on rc canvas by saving/restoring ctx state trick:
    // Instead, draw directly on rctx using a standalone approach
    for (const [k, trap] of Object.entries(traps)) {
      const [r2, c2] = k.split(',').map(Number);
      const cx2b = (c2 + 0.5) * CELL, cy2b = (r2 + 0.5) * CELL;
      const sz2 = CELL * 0.35;
      rctx.save();
      if (!trap.revealed) rctx.globalAlpha = 0.55;
      rctx.fillStyle = '#FF8C00';
      rctx.beginPath();
      rctx.moveTo(cx2b, cy2b - sz2); rctx.lineTo(cx2b + sz2, cy2b);
      rctx.lineTo(cx2b, cy2b + sz2); rctx.lineTo(cx2b - sz2, cy2b);
      rctx.closePath(); rctx.fill();
      if (!trap.revealed) {
        rctx.setLineDash([3, 3]); rctx.strokeStyle = 'rgba(255,255,255,0.6)';
        rctx.lineWidth = 1.5; rctx.stroke(); rctx.setLineDash([]);
      }
      rctx.fillStyle = '#fff';
      rctx.font = `bold ${Math.max(7, Math.round(sz2 * 1.0))}px system-ui`;
      rctx.textAlign = 'center'; rctx.textBaseline = 'middle';
      rctx.fillText(trap.revealed ? '!' : 'T', cx2b, cy2b);
      rctx.restore();
    }
  }

  // Fog of war overlay
  if (fogEnabled) {
    // Pre-compute squares auto-revealed by token vision (Chebyshev distance
    // from the token's footprint, so diagonals count as 1 — D&D convention).
    // Squares cleared around the token's footprint (Chebyshev / D&D 5ft rule).
    //   normal     → 0  (only the token's own square)
    //   lowlight   → 6
    //   darkvision → 12
    const VISION_RADIUS = { normal: 0, lowlight: 6, darkvision: 12 };
    const visionReveal  = new Set();
    for (const tok of tokens) {
      // Effective radius = max(natural vision, equipped torch).
      // A torch only helps when its radius would exceed your natural sight;
      // a Darkvision dwarf doesn't shrink to torch range by holding one.
      const visionR = VISION_RADIUS[tok.vision];
      const equipR  = tok.equippedLight && Number(tok.equippedLight.radius) || 0;
      if (visionR === undefined && equipR === 0) continue;
      const R = Math.max(visionR ?? 0, equipR);
      const sz = tok.size || 1;
      const r0 = tok.r, r1 = tok.r + sz - 1;
      const c0 = tok.c, c1 = tok.c + sz - 1;
      for (let rr = r0 - R; rr <= r1 + R; rr++) {
        if (rr < 0 || rr >= rows) continue;
        for (let cc = c0 - R; cc <= c1 + R; cc++) {
          if (cc < 0 || cc >= cols) continue;
          const dr = Math.max(0, r0 - rr, rr - r1);
          const dc = Math.max(0, c0 - cc, cc - c1);
          if (Math.max(dr, dc) <= R) visionReveal.add(rr + ',' + cc);
        }
      }
    }
    // Light sources also reveal fog within their radius.
    for (const lit of lights) {
      const R = Number(lit.radius) || 0;
      if (R <= 0) continue;
      for (let rr = lit.r - R; rr <= lit.r + R; rr++) {
        if (rr < 0 || rr >= rows) continue;
        for (let cc = lit.c - R; cc <= lit.c + R; cc++) {
          if (cc < 0 || cc >= cols) continue;
          if (Math.max(Math.abs(rr - lit.r), Math.abs(cc - lit.c)) <= R) {
            visionReveal.add(rr + ',' + cc);
          }
        }
      }
    }

    ctx.save();
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const k = r+','+c;
        if (visionReveal.has(k)) continue;     // visible thanks to a token's vision
        const vis = fogVis[k] ?? 0;
        if (vis < 0.999) {
          ctx.fillStyle = `rgba(8,6,20,${1 - vis})`;
          ctx.fillRect(c*CELL, r*CELL, CELL, CELL);
          // Amber shimmer at the reveal edge
          if (vis > 0.01 && vis < 0.99) {
            const shimmer = Math.sin(vis * Math.PI) * 0.22;
            ctx.fillStyle = `rgba(120,55,10,${shimmer})`;
            ctx.fillRect(c*CELL, r*CELL, CELL, CELL);
          }
        }
      }
    }
    // Soft glow ring at the outer edge of each vision radius — helps the
    // player see the limit of their own sight. Uses the same effective
    // radius (max of natural vision and any equipped torch).
    for (const tok of tokens) {
      const visionR = VISION_RADIUS[tok.vision];
      const equipR  = tok.equippedLight && Number(tok.equippedLight.radius) || 0;
      if (visionR === undefined && equipR === 0) continue;
      const R = Math.max(visionR ?? 0, equipR);
      const sz = tok.size || 1;
      const cx = (tok.c + sz/2) * CELL;
      const cy = (tok.r + sz/2) * CELL;
      const radiusPx = (R + sz/2) * CELL;
      const grad = ctx.createRadialGradient(cx, cy, radiusPx*0.8, cx, cy, radiusPx);
      grad.addColorStop(0, 'rgba(255,210,90,0)');
      grad.addColorStop(1, 'rgba(255,210,90,0.18)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cy, radiusPx, 0, Math.PI*2);
      ctx.fill();
    }
    // Outer halo / amber pool has been removed by request — light sources
    // simply punch their squares through the fog (via `visionReveal` above).
    // The map underneath shows through cleanly, no decorative overlay.
    ctx.restore();
  }

  // ── Light source icons (always visible, even when fog is off) ──────
  if (lights.length) {
    ctx.save();
    const sprite = getTorchSprite();
    for (const lit of lights) {
      const cx = (lit.c + 0.5) * CELL;
      const cy = (lit.r + 0.5) * CELL;
      // Organic per-torch flicker — drives both glow alpha and a tiny
      // sprite "leap" so the flame appears to dance.
      const flick = torchFlicker(t, lit.id);
      const radInner = CELL * (0.50 + 0.12 * flick);
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, radInner);
      g.addColorStop(0,    `rgba(255,210,100,${0.55 * flick})`);
      g.addColorStop(0.55, `rgba(255,140,40,${0.26 * flick})`);
      g.addColorStop(1,    'rgba(255,80,10,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, radInner, 0, Math.PI*2);
      ctx.fill();
      // 8-bit torch sprite — drawn pixel-perfect and *stationary*. Smaller
      // than the cell so it reads as an object on the tile rather than
      // filling it. Only the inner glow flickers.
      if (sprite && sprite.complete && sprite.naturalWidth) {
        const size = CELL * 0.60;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(sprite, cx - size/2, cy - size/2, size, size);
        ctx.imageSmoothingEnabled = true;
      } else {
        // Fallback while the sprite hasn't loaded yet
        ctx.font = `${Math.max(12, CELL * 0.5)}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('🔦', cx, cy);
      }
      // Highlight when lightMode is on and this is hovered
      if (lightMode) {
        const hover = cellFromXY(mouseX, mouseY);
        if (hover.r === lit.r && hover.c === lit.c) {
          ctx.strokeStyle = 'rgba(255,210,90,0.85)';
          ctx.lineWidth = 2;
          ctx.strokeRect(lit.c*CELL + 1, lit.r*CELL + 1, CELL - 2, CELL - 2);
        }
      }
    }
    ctx.restore();
  }

  // Projection bounds
  if (projBounds) {
    const b = projBounds;
    ctx.save();
    // Editing mode: semi-transparent so you can see outside; projection mode: fully opaque
    ctx.fillStyle = boundsMode ? 'rgba(0,0,0,0.52)' : 'rgba(0,0,0,1)';
    ctx.fillRect(0, 0, canvas.width, b.y1);
    ctx.fillRect(0, b.y2, canvas.width, canvas.height-b.y2);
    ctx.fillRect(0, b.y1, b.x1, b.y2-b.y1);
    ctx.fillRect(b.x2, b.y1, canvas.width-b.x2, b.y2-b.y1);
    ctx.restore();
    if (boundsMode) {
      // Editing: show animated red border + resize handles
      ctx.save();
      ctx.strokeStyle = '#FF2020';
      ctx.lineWidth = 2;
      ctx.setLineDash([6,4]);
      ctx.lineDashOffset = -(t*0.04 % 10);
      ctx.strokeRect(b.x1+1, b.y1+1, b.x2-b.x1-2, b.y2-b.y1-2);
      ctx.setLineDash([]); ctx.lineDashOffset = 0;
      ctx.restore();
      ctx.save();
      for (const h of getBoundsHandles()) {
        ctx.fillStyle = '#fff'; ctx.strokeStyle = '#FF2020'; ctx.lineWidth = 1.5;
        ctx.fillRect(h.x-HANDLE_R, h.y-HANDLE_R, HANDLE_R*2, HANDLE_R*2);
        ctx.strokeRect(h.x-HANDLE_R, h.y-HANDLE_R, HANDLE_R*2, HANDLE_R*2);
      }
      ctx.restore();
    }
  }

  // Bright 1-inch grid lines — used by both the 1" overlay and the
  // coords overlay. Inch labels are drawn only in 1" overlay mode.
  if (gridOverlayVisible || gridCoordsVisible) drawGridOverlay();

  // Mirror to projection window before cursor is drawn
  if (projWindow && !projWindow.closed) {
    const pc = projWindow.__projCanvas;
    if (pc) {
      if (pc.width !== canvas.width || pc.height !== canvas.height) {
        pc.width = canvas.width; pc.height = canvas.height;
      }
      pc.getContext('2d').drawImage(canvas, 0, 0);
    }
  }

  drawCursor();
  requestAnimationFrame(render);
}

// ── 1-inch grid overlay ───────────────────────────────────────
let gridOverlayVisible = false;
let gridOverlayScale = 96; // CSS px per grid square (default = 1 physical inch at 96dpi)

function drawGridOverlay() {
  const rect = canvas.getBoundingClientRect();
  // scale user value (CSS px) → canvas px
  const inchPx = gridOverlayScale * (canvas.width / rect.width);

  ctx.save();

  // grid lines
  ctx.strokeStyle = 'rgba(255,255,255,0.30)';
  ctx.lineWidth = 0.9;
  for (let x = 0; x < canvas.width + inchPx; x += inchPx) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke();
  }
  for (let y = 0; y < canvas.height + inchPx; y += inchPx) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke();
  }

  // Inch labels along top/left edges — only when 1" overlay mode is on.
  // (Coords mode draws its own A1, B2 labels via drawGridCoords.)
  if (gridOverlayVisible) {
    const fontSize = Math.max(8, Math.round(inchPx * 0.16));
    ctx.font = `bold ${fontSize}px system-ui,sans-serif`;
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'center';
    let i = 1;
    for (let x = inchPx; x < canvas.width; x += inchPx, i++) {
      ctx.fillText(i + '"', x, 3);
    }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    i = 1;
    for (let y = inchPx; y < canvas.height; y += inchPx, i++) {
      ctx.fillText(i + '"', 3, y);
    }
  }

  ctx.restore();
}

// ── Ruler (Feature 5) ─────────────────────────────────────────
function drawRuler() {
  if (!rulerMode || !rulerStart) return;
  const x1=rulerStart.x, y1=rulerStart.y, x2=mouseX, y2=mouseY;
  ctx.save();
  ctx.setLineDash([5,3]);
  ctx.strokeStyle='#FFD700'; ctx.lineWidth=1.5;
  ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle='#FFD700';
  ctx.beginPath(); ctx.arc(x1,y1,4,0,Math.PI*2); ctx.fill();
  ctx.beginPath(); ctx.arc(x2,y2,4,0,Math.PI*2); ctx.fill();
  const distSq=Math.hypot(x2-x1,y2-y1)/CELL;
  const distFt=Math.round(distSq*5);
  const lbl=`${distSq.toFixed(1)} sq · ${distFt} ft`;
  const mx=(x1+x2)/2, my=(y1+y2)/2;
  ctx.font='bold 11px system-ui,sans-serif';
  ctx.textAlign='center'; ctx.textBaseline='middle';
  const tw=ctx.measureText(lbl).width;
  ctx.fillStyle='rgba(0,0,0,0.72)'; ctx.fillRect(mx-tw/2-4,my-8,tw+8,16);
  ctx.fillStyle='#FFD700'; ctx.fillText(lbl,mx,my);
  ctx.restore();
}

// ── Grid coords (Feature 7) ───────────────────────────────────
function drawGridCoords() {
  if (!gridCoordsVisible) return;
  const fs=Math.max(7,Math.min(11,CELL*0.24));
  ctx.save();
  ctx.fillStyle='rgba(255,255,255,0.4)';
  ctx.font=`bold ${fs}px system-ui,sans-serif`;
  ctx.textAlign='center'; ctx.textBaseline='top';
  for (let c=0; c<cols; c++) {
    ctx.fillText(String.fromCharCode(65+c), c*CELL+CELL/2, 3);
  }
  ctx.textAlign='left'; ctx.textBaseline='middle';
  for (let r=0; r<rows; r++) {
    ctx.fillText(String(r+1), 3, r*CELL+CELL/2);
  }
  ctx.restore();
}

// ── Cover (Feature 9) ─────────────────────────────────────────
function drawCovers() {
  if (!Object.keys(covers).length) return;
  ctx.save();
  for (const [key, cval] of Object.entries(covers)) {
    const parts=key.split(',');
    const r=parseInt(parts[0]), c=parseInt(parts[1]), edge=parts[2];
    const x=c*CELL, y=r*CELL;
    let x1,y1,x2,y2,lx,ly;
    const inset20=CELL*0.2, inset80=CELL*0.8;
    if (edge==='n')      { x1=x+inset20;y1=y;      x2=x+inset80;y2=y;      lx=(x1+x2)/2;ly=y-4; }
    else if (edge==='s') { x1=x+inset20;y1=y+CELL; x2=x+inset80;y2=y+CELL; lx=(x1+x2)/2;ly=y+CELL+4; }
    else if (edge==='e') { x1=x+CELL;   y1=y+inset20;x2=x+CELL; y2=y+inset80;lx=x+CELL+4;ly=(y1+y2)/2; }
    else                 { x1=x;        y1=y+inset20;x2=x;       y2=y+inset80;lx=x-4;     ly=(y1+y2)/2; }
    const colors={'half':'rgba(255,220,0,0.85)','three-quarter':'rgba(255,120,0,0.85)','full':'rgba(220,40,40,0.9)'};
    const lws={'half':3,'three-quarter':3.5,'full':4};
    ctx.strokeStyle=colors[cval]||'#fff';
    ctx.lineWidth=lws[cval]||3;
    ctx.lineCap='round';
    ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke();
    const lbl={'half':'½','three-quarter':'¾','full':'█'};
    ctx.font=`bold ${Math.max(7,Math.round(CELL*0.22))}px system-ui,sans-serif`;
    ctx.fillStyle=colors[cval]||'#fff';
    ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText(lbl[cval]||'', lx, ly);
  }
  ctx.restore();
}

// ── Token Lights ──────────────────────────────────────────────
function drawTokenLights() {
  for (const tok of tokens) {
    if (!tok.lightRadius || tok.lightRadius <= 0) continue;
    const s = tok.size || 1;
    const cx = tok.c * CELL + s * CELL / 2;
    const cy = tok.r * CELL + s * CELL / 2;
    const brightR = tok.lightRadius * CELL;
    const dimR = (tok.lightDim || 0) * CELL;
    ctx.save();
    if (dimR > brightR) {
      const gd = ctx.createRadialGradient(cx, cy, 0, cx, cy, dimR);
      gd.addColorStop(0, 'rgba(255,180,60,0.13)');
      gd.addColorStop(brightR / dimR, 'rgba(255,200,80,0.13)');
      gd.addColorStop(1, 'rgba(255,180,60,0.06)');
      ctx.fillStyle = gd;
      ctx.beginPath(); ctx.arc(cx, cy, dimR, 0, Math.PI * 2); ctx.fill();
    } else {
      const gb = ctx.createRadialGradient(cx, cy, 0, cx, cy, brightR);
      gb.addColorStop(0, 'rgba(255,200,80,0.18)');
      gb.addColorStop(0.7, 'rgba(255,200,80,0.13)');
      gb.addColorStop(1, 'rgba(255,180,60,0)');
      ctx.fillStyle = gb;
      ctx.beginPath(); ctx.arc(cx, cy, brightR, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }
}

// ── Traps ─────────────────────────────────────────────────────
function drawTraps(dmOnly) {
  for (const [k, trap] of Object.entries(traps)) {
    const showUnrevealed = dmOnly;
    if (!showUnrevealed && !trap.revealed) continue;
    const [r, c] = k.split(',').map(Number);
    const cx2 = (c + 0.5) * CELL, cy2 = (r + 0.5) * CELL;
    const sz = CELL * 0.35;
    ctx.save();
    if (!trap.revealed && dmOnly) ctx.globalAlpha = 0.55;
    // Draw diamond shape
    ctx.fillStyle = '#FF8C00';
    ctx.beginPath();
    ctx.moveTo(cx2, cy2 - sz);
    ctx.lineTo(cx2 + sz, cy2);
    ctx.lineTo(cx2, cy2 + sz);
    ctx.lineTo(cx2 - sz, cy2);
    ctx.closePath();
    ctx.fill();
    if (!trap.revealed && dmOnly) {
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = 'rgba(255,255,255,0.6)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.fillStyle = trap.revealed ? '#fff' : 'rgba(255,255,255,0.9)';
    ctx.font = `bold ${Math.max(7, Math.round(sz * 1.0))}px system-ui`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(trap.revealed ? '!' : 'T', cx2, cy2);
    ctx.restore();
  }
}

// ── Line of Sight ─────────────────────────────────────────────
function segmentsIntersect(p1, p2, p3, p4) {
  const d1x = p2.x - p1.x, d1y = p2.y - p1.y;
  const d2x = p4.x - p3.x, d2y = p4.y - p3.y;
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-10) return false;
  const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / denom;
  const u = ((p3.x - p1.x) * d1y - (p3.y - p1.y) * d1x) / denom;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

function drawLoS() {
  if (!losMode || !losStart) return;
  const p1 = losStart, p2 = { x: mouseX, y: mouseY };
  const hitWalls = [];
  for (const w of walls) {
    const wx1 = w.fx1 * canvas.width, wy1 = w.fy1 * canvas.height;
    const wx2 = w.fx2 * canvas.width, wy2 = w.fy2 * canvas.height;
    if (segmentsIntersect(p1, p2, { x: wx1, y: wy1 }, { x: wx2, y: wy2 })) {
      hitWalls.push(w);
    }
  }
  // Draw hit walls highlighted
  ctx.save();
  for (const w of hitWalls) {
    const wx1 = w.fx1 * canvas.width, wy1 = w.fy1 * canvas.height;
    const wx2 = w.fx2 * canvas.width, wy2 = w.fy2 * canvas.height;
    ctx.shadowColor = '#FF2020'; ctx.shadowBlur = 8;
    ctx.strokeStyle = '#FF2020'; ctx.lineWidth = 4; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(wx1, wy1); ctx.lineTo(wx2, wy2); ctx.stroke();
  }
  ctx.shadowBlur = 0;
  // Draw LoS line
  const lineColor = hitWalls.length > 0 ? 'rgba(255,220,60,0.7)' : 'rgba(60,255,60,0.7)';
  ctx.strokeStyle = lineColor; ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 3]);
  ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

// ── Conditions ────────────────────────────────────────────────
const CONDITIONS = [
  {key:'blinded',   label:'Blind'}, {key:'dazed',      label:'Dazed'},
  {key:'deafened',  label:'Deaf'},  {key:'dominated',   label:'Dom'},
  {key:'dying',     label:'Dying'}, {key:'grabbed',     label:'Grab'},
  {key:'immob',     label:'Immob'}, {key:'marked',      label:'Mark'},
  {key:'prone',     label:'Prone'}, {key:'restrained',  label:'Rest'},
  {key:'slowed',    label:'Slow'},  {key:'stunned',     label:'Stun'},
  {key:'uncon',     label:'Uncon'}, {key:'weakened',    label:'Weak'},
];
const COND_COLORS = {
  blinded:'#aaaaaa', dazed:'#FFD700', deafened:'#777777', dominated:'#FF69B4',
  dying:'#FF2020',   grabbed:'#FF8C00', immob:'#4169E1',  marked:'#FF4500',
  prone:'#CD853F',   restrained:'#8B008B', slowed:'#20B2AA', stunned:'#FFD700',
  uncon:'#808080',   weakened:'#DC143C',
};

// ── Walls / Labels ────────────────────────────────────────────
let walls = [], wallIdSeq = 1;
let labels = [], labelIdSeq = 1;
let lights = [], lightIdSeq = 1;
// Lazy-loaded torch sprite. Same image is reused by every light icon.
let _torchSprite = null;
function getTorchSprite() {
  if (!_torchSprite) {
    _torchSprite = new Image();
    _torchSprite.src = 'torch-8bit.png';
  }
  return _torchSprite;
}

// Organic torch flicker — multi-frequency sine combination plus rare
// "gust" dips, returns a value roughly in [0.25 .. 1.05]. Each torch's
// `seed` (its id) keeps its waveform out of phase with the others so a
// row of torches doesn't pulse in lock-step.
function torchFlicker(ts, seed) {
  const t = ts || 0;
  // All rates dialled down ~4× so the breath is slow and meditative.
  const a = Math.sin(t * 0.0012 + seed * 1.71);    // slow, body
  const b = Math.sin(t * 0.0048 + seed * 3.07);    // medium hiss
  const c = Math.sin(t * 0.0170 + seed * 7.31);    // gentle high jitter
  let v = 0.62 + 0.18 * a + 0.12 * b + 0.10 * c;
  // Occasional "wind" — even rarer now, deeper dim
  const gust = Math.sin(t * 0.0028 + seed * 5.13);
  if (gust > 0.96) v -= 0.30;
  return Math.max(0.25, Math.min(1.08, v));
}

// ── Presets ───────────────────────────────────────────────────
let presets = [];
// ── Scenes ───────────────────────────────────────────────────
let scenes = [];
// ── Traps ────────────────────────────────────────────────────
let traps = {};
let trapMode = false;
// ── Line of Sight ─────────────────────────────────────────────
let losMode = false, losStart = null;
// ── Teleport ─────────────────────────────────────────────────
let teleportMode = false, teleportToken = null;

// ── Turn timer ────────────────────────────────────────────────
let timerDuration = 30, timerLeft = 30, timerRunning = false, _timerInterval = null, timerVisible = false;

// ── Input state ───────────────────────────────────────────────
let currentEffect='fire', currentShape='draw', circleRadius=3, tokenMode=false, inspectMode=false;
let fogEnabled = false, fogMode = false, fogDrawing = false, fogPrevCell = null, shiftHeld = false;
let bgImage = null, _mapObjectURL = null;
let dmRefVisible = false;
let projWindow = null, _projCheckInterval = null;
const fogVis = {}, fogTarget = {};
let drawing=false, rawPts=[], strokeCells=new Set(), prevCell=null;
let erasing=false, erasePrevCell=null;
let coneActive=false, coneOrigin=null;
let wallMode=false, wallActive=false, wallStart=null, wallErasing=false;
let _cobblePattern=null, _cobbleCELL=-1;
let _waterPattern=null,  _waterCELL=-1;
let _grassPattern=null,  _grassCELL=-1;
let _lavaPattern=null,   _lavaCELL=-1;
let _stoneFloorPattern=null, _stoneFloorCELL=-1;
const _effectKeys={'1':'fire','2':'poison','3':'ice','4':'lightning','5':'holy','6':'erase','7':'water','8':'grass'};
// Feature 5 — Ruler
let rulerMode=false, rulerStart=null;
// Feature 7 — Grid coords
let gridCoordsVisible=false;
// Feature 9 — Cover
let covers={}, coverMode=false;
let labelMode=false, pendingLabelCell=null, editingLabelId=null;
let lightMode=false, editingLightId=null, lightPlaceRadius=5;
let draggingLabel=null, labelDragMoved=false;
let moveRangeToken=null;
let selectedSize=1, selectedSpeed=6, selectedHp=null, selectedMaxHp=null, selectedConditions=[];

// ── Input helpers ─────────────────────────────────────────────
function getXY(e) {
  const rect=canvas.getBoundingClientRect(), sx=canvas.width/rect.width, sy=canvas.height/rect.height;
  if(e.touches)return{x:(e.touches[0].clientX-rect.left)*sx,y:(e.touches[0].clientY-rect.top)*sy};
  return{x:(e.clientX-rect.left)*sx,y:(e.clientY-rect.top)*sy};
}

const _tooltip = document.getElementById('cell-tooltip');
const _ttColors = {fire:'#E85020',poison:'#50A010',ice:'#3D8FD4',lightning:'#8060FF',holy:'#C0A020'};
const _ttLabels = {fire:'Fire',poison:'Poison',ice:'Ice',lightning:'Lightning',holy:'Holy'};

function updateTooltip(canvasX, canvasY) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = rect.width / canvas.width;
  const scaleY = rect.height / canvas.height;
  const cell = cellFromXY(canvasX, canvasY);
  const k = cell.r+','+cell.c;
  const effs = grid[k] || [];

  // Fog status for this cell
  let fogRow = '';
  if (fogEnabled) {
    const vis = fogVis[k] ?? 0;
    if (vis < 0.02) {
      fogRow = `<div class="tt-effect"><span class="tt-dot" style="background:#334"></span>Fogged</div>`;
    } else if (vis < 0.98) {
      const pct = Math.round(vis * 100);
      fogRow = `<div class="tt-effect"><span class="tt-dot" style="background:rgba(80,60,120,0.9)"></span>Revealing… ${pct}%</div>`;
    } else {
      fogRow = `<div class="tt-effect"><span class="tt-dot" style="background:#446"></span>Revealed</div>`;
    }
  }

  if (effs.length === 0 && !fogRow) { _tooltip.classList.remove('visible'); return; }

  // Screen position: offset so tooltip doesn't cover cursor
  const screenX = rect.left + canvasX * scaleX;
  const screenY = rect.top  + canvasY * scaleY;
  const margin = 14;
  const rows = effs.length + (fogRow ? 1 : 0);
  const tw = 150, th = 28 + rows * 22;
  let tx = screenX + margin, ty = screenY + margin;
  if (tx + tw > window.innerWidth  - 8) tx = screenX - tw - margin;
  if (ty + th > window.innerHeight - 8) ty = screenY - th - margin;

  _tooltip.style.left = tx + 'px';
  _tooltip.style.top  = ty + 'px';

  const hasEffects = effs.length > 0;
  _tooltip.innerHTML =
    (hasEffects ? `<div class="tt-title">Status Effects</div>` +
      effs.map(e => `<div class="tt-effect">
        <span class="tt-dot" style="background:${_ttColors[e]||'#888'}"></span>
        ${_ttLabels[e]||e}
      </div>`).join('') : '') +
    (fogRow && hasEffects ? `<div class="tt-divider"></div>` : '') +
    fogRow;
  _tooltip.classList.add('visible');
}

function movePos(x,y) {
  TRAIL.push({x:mouseX,y:mouseY}); if(TRAIL.length>TRAIL_MAX)TRAIL.shift();
  mouseX=x; mouseY=y;
  if (inspectMode) updateTooltip(x, y); else _tooltip.classList.remove('visible');

  // Bounds handle drag
  if (boundsHandle) {
    applyBoundsHandle(boundsHandle, x, y);
    return;
  }

  // Token drag
  if (draggingToken) {
    const dx=x-draggingToken.startX, dy=y-draggingToken.startY;
    if (!dragHasMoved && Math.sqrt(dx*dx+dy*dy)>8) dragHasMoved=true;
    return;
  }

  // Cursor logic
  if (boundsHandle) {
    canvas.style.cursor = boundsHandleCursor(boundsHandle);
  } else if (boundsMode) {
    canvas.style.cursor = boundsHandleCursor(hitBoundsHandle(x,y));
  } else {
    canvas.style.cursor = tokenAt(x,y) ? 'grab' : 'none';
  }

  // Label drag in label mode
  if (labelMode && draggingLabel) {
    const cur = cellFromXY(x, y);
    if (cur.r !== draggingLabel.r || cur.c !== draggingLabel.c) {
      if (!labelDragMoved) pushUndo();
      draggingLabel.r = cur.r;
      draggingLabel.c = cur.c;
      labelDragMoved = true;
    }
    return;
  }

  // Wall sweep-erase during drag
  if(wallMode && wallErasing){ deleteNearestWall(x,y,true); return; }

  // Movement range hover
  if(tokenMode) moveRangeToken = tokenAt(x,y); else moveRangeToken=null;

  // Fog brush during drag
  if (fogMode && fogDrawing) {
    const cur = cellFromXY(x, y);
    const vs = new Set();
    if (fogPrevCell) bresenham(fogPrevCell.r, fogPrevCell.c, cur.r, cur.c, vs);
    else vs.add(cur.r+','+cur.c);
    fogSetCells(vs, !shiftHeld);
    fogPrevCell = cur;
    return;
  }

  if (tokenMode) return;

  if (currentEffect==='erase' && erasing) {
    const cur=cellFromXY(x,y);
    if (erasePrevCell) {
      const vs=new Set();
      bresenham(erasePrevCell.r,erasePrevCell.c,cur.r,cur.c,vs);
      for(const k of vs){const[r,c]=k.split(',').map(Number);eraseAt(r,c);}
    } else eraseAt(cur.r,cur.c);
    erasePrevCell=cur;
  } else if (drawing && currentEffect!=='erase') {
    const last=rawPts[rawPts.length-1], dx=x-last.x, dy=y-last.y;
    if(dx*dx+dy*dy>3){rawPts.push({x,y});const cur=cellFromXY(x,y);if(prevCell)bresenham(prevCell.r,prevCell.c,cur.r,cur.c,strokeCells);else strokeCells.add(cur.r+','+cur.c);prevCell=cur;}
  }
}

function pointerDown(x,y) {
  // ── Bestiary placement (intercepts before any other mode) ─────
  if (window.__bestiaryPending) {
    const cell = cellFromXY(x, y);
    if (window.__bestiaryPlaceAt && window.__bestiaryPlaceAt(cell.r, cell.c)) {
      return;
    }
  }

  // LoS mode
  if (losMode) { losStart={x,y}; return; }

  // Trap mode
  if (trapMode) {
    const cell = cellFromXY(x, y);
    const k = cell.r + ',' + cell.c;
    pushUndo();
    if (traps[k]) {
      if (!traps[k].revealed) { traps[k].revealed = true; }
      else { delete traps[k]; }
    } else {
      traps[k] = { label: '', revealed: false };
    }
    return;
  }

  // Teleport mode
  if (teleportMode) {
    if (!teleportToken) {
      const tok = tokenAt(x, y);
      if (tok) { teleportToken = tok; }
    } else {
      const dest = cellFromXY(x, y);
      const occupied = tokens.find(t => t.id !== teleportToken.id && t.r === dest.r && t.c === dest.c);
      if (!occupied) {
        pushUndo();
        teleportToken.r = dest.r; teleportToken.c = dest.c;
      }
      teleportToken = null;
    }
    return;
  }

  // Ruler mode — record start
  if (rulerMode) { rulerStart={x,y}; return; }

  // Cover mode — cycle cover on nearest edge
  if (coverMode) {
    const cell=cellFromXY(x,y);
    const r=cell.r, c=cell.c;
    const cx2=c*CELL, cy2=r*CELL;
    const distN=Math.abs(y-(cy2)), distS=Math.abs(y-(cy2+CELL));
    const distW=Math.abs(x-(cx2)), distE=Math.abs(x-(cx2+CELL));
    const minD=Math.min(distN,distS,distW,distE);
    if (minD < CELL*0.25) {
      let edge='n';
      if (minD===distS) edge='s';
      else if (minD===distE) edge='e';
      else if (minD===distW) edge='w';
      const key=r+','+c+','+edge;
      const cur=covers[key];
      pushUndo();
      if(shiftHeld) { delete covers[key]; }      // Shift+click = instant erase
      else if(!cur) covers[key]='half';
      else if(cur==='half') covers[key]='three-quarter';
      else if(cur==='three-quarter') covers[key]='full';
      else delete covers[key];
    }
    return;
  }

  if (boundsMode) {
    const h = hitBoundsHandle(x,y);
    if (h) {
      boundsHandle = h;
      boundsDragStart = { x, y, b: { ...projBounds } };
      canvas.style.cursor = boundsHandleCursor(h);
    }
    return;
  }
  // Allow dragging tokens in any mode except erase, and except fog brush
  // mode where clicks are meant to paint fog, not move tokens.
  const existing=tokenAt(x,y);
  if (existing && currentEffect!=='erase' && !fogMode) {
    draggingToken={ tok:existing, startX:x, startY:y };
    dragHasMoved=false;
    dragStartCell={ r:existing.r, c:existing.c };
    canvas.style.cursor='grabbing';
    return;
  }
  // Wall mode
  if(wallMode){
    if(shiftHeld){pushUndo();wallErasing=true;deleteNearestWall(x,y,true);}
    else{wallActive=true;wallStart={x,y};}
    return;
  }

  // Label mode
  if(labelMode){
    const cell=cellFromXY(x,y);
    const existing=labels.find(l=>l.r===cell.r&&l.c===cell.c);
    if (existing) {
      // Start a potential drag — open modal on mouseup if no movement
      draggingLabel = existing;
      labelDragMoved = false;
      canvas.style.cursor = 'grabbing';
      return;
    }
    // No existing label → open modal to create a new one
    pendingLabelCell=cell; editingLabelId=null;
    document.getElementById('label-text-in').value='';
    document.getElementById('label-delete').style.display='none';
    document.getElementById('label-modal').classList.add('open');
    setTimeout(()=>document.getElementById('label-text-in').focus(),50);
    return;
  }

  // Light source mode
  if (lightMode) {
    const cell = cellFromXY(x, y);
    const existing = lights.find(l => l.r === cell.r && l.c === cell.c);
    if (existing) {
      if (shiftHeld) {
        // Shift-click → instant delete
        pushUndo();
        lights = lights.filter(l => l.id !== existing.id);
      } else {
        // Click existing → open edit modal
        openLightModal(existing);
      }
    } else {
      // Click empty cell → place new light at the chosen radius
      pushUndo();
      lights.push({
        id:     lightIdSeq++,
        r:      cell.r,
        c:      cell.c,
        radius: Math.max(1, Math.min(30, parseInt(lightPlaceRadius) || 5)),
        name:   'Torch',
        color:  '#FFA040',
      });
    }
    return;
  }

  if (fogMode) {
    if (currentShape==='circle') {
      fogSetCells(getCircleCells(cellFromXY(x,y), circleRadius), !shiftHeld);
    } else if (currentShape==='square') {
      fogSetCells(getSquareCells(cellFromXY(x,y), circleRadius), !shiftHeld);
    } else if (currentShape==='cone') {
      coneActive=true; coneOrigin=cellFromXY(x,y);
    } else {
      fogDrawing=true; fogPrevCell=cellFromXY(x,y);
      fogSetCells(new Set([fogPrevCell.r+','+fogPrevCell.c]), !shiftHeld);
    }
    return;
  }

  if (tokenMode) {
    pendingTokenCell=cellFromXY(x,y); editingTokenId=null; openTokenModal(null);
    return;
  }
  if (!currentEffect) return;  // no effect selected — canvas is read-only
  if (currentShape==='draw') {
    if (currentEffect==='erase') {
      pushUndo(); erasing=true; erasePrevCell=null;
      const cur=cellFromXY(x,y); eraseAt(cur.r,cur.c); erasePrevCell=cur;
    } else {
      drawing=true; rawPts=[{x,y}]; strokeCells=new Set();
      prevCell=cellFromXY(x,y); strokeCells.add(prevCell.r+','+prevCell.c);
    }
  } else if (currentShape==='cone') {
    coneActive=true; coneOrigin=cellFromXY(x,y);
  } else if (currentShape==='circle') {
    putCells(getCircleCells(cellFromXY(x,y),circleRadius),currentEffect);
  } else if (currentShape==='square') {
    putCells(getSquareCells(cellFromXY(x,y),circleRadius),currentEffect);
  }
}

function pointerUp() {
  if (losMode) { losStart=null; return; }
  if (rulerMode) { rulerStart=null; return; }
  if (boundsHandle) {
    boundsHandle = null; boundsDragStart = null;
    canvas.style.cursor = boundsHandleCursor(hitBoundsHandle(mouseX, mouseY));
    return;
  }
  // Label drag release
  if (draggingLabel) {
    const lbl = draggingLabel;
    const moved = labelDragMoved;
    draggingLabel = null; labelDragMoved = false;
    canvas.style.cursor = 'none';
    if (!moved) {
      // Treat as a click → open edit modal
      pendingLabelCell = { r: lbl.r, c: lbl.c };
      editingLabelId   = lbl.id;
      document.getElementById('label-text-in').value = lbl.text;
      document.getElementById('label-delete').style.display = '';
      document.getElementById('label-modal').classList.add('open');
      setTimeout(()=>document.getElementById('label-text-in').focus(),50);
    }
    return;
  }
  // Finish drag or open edit modal
  if (draggingToken) {
    if (dragHasMoved) {
      pushUndo();
      const target=cellFromXY(mouseX,mouseY);
      const occupied=tokens.find(t=>t.id!==draggingToken.tok.id && t.r===target.r && t.c===target.c);
      if (!occupied) { draggingToken.tok.r=target.r; draggingToken.tok.c=target.c; }
    } else if (tokenMode) {
      // Short click in token mode = edit modal
      editingTokenId=draggingToken.tok.id; openTokenModal(draggingToken.tok);
    }
    draggingToken=null; dragHasMoved=false; dragStartCell=null;
    canvas.style.cursor='none';
    return;
  }
  // Finish wall draw or erase
  if(wallMode){
    if(wallErasing){wallErasing=false;return;}
    if(wallActive && wallStart){
      const dx=mouseX-wallStart.x,dy=mouseY-wallStart.y;
      if(Math.hypot(dx,dy)>5){pushUndo();walls.push({id:wallIdSeq++,fx1:wallStart.x/canvas.width,fy1:wallStart.y/canvas.height,fx2:mouseX/canvas.width,fy2:mouseY/canvas.height});}
      wallActive=false;wallStart=null;
    }
    return;
  }

  if (fogMode) {
    if (fogDrawing) { fogDrawing=false; fogPrevCell=null; }
    if (coneActive) {
      coneActive=false;
      fogSetCells(getConeCells(coneOrigin, cellFromXY(mouseX,mouseY)), !shiftHeld);
      coneOrigin=null;
    }
    return;
  }

  if (tokenMode) return;
  if (!currentEffect) { erasing=false; drawing=false; coneActive=false; return; }
  if (currentEffect==='erase' && erasing) { erasing=false; erasePrevCell=null; }
  else if (currentShape==='draw' && drawing) {
    drawing=false;
    let final=new Set(strokeCells);
    if(isClosed(strokeCells)){const inside=floodFill(strokeCells);for(const k of inside)final.add(k);}
    putCells(final,currentEffect); rawPts=[]; strokeCells=new Set(); prevCell=null;
  } else if (currentShape==='cone' && coneActive) {
    coneActive=false; putCells(getConeCells(coneOrigin,cellFromXY(mouseX,mouseY)),currentEffect); coneOrigin=null;
  }
}

canvas.addEventListener('mouseenter',()=>{mouseInside=true;TRAIL.length=0;});
canvas.addEventListener('mouseleave',()=>{mouseInside=false;TRAIL.length=0;canvas.style.cursor='none';pointerUp();_tooltip.classList.remove('visible');});
canvas.addEventListener('mousemove',e=>{const{x,y}=getXY(e);movePos(x,y);});
canvas.addEventListener('mousedown',e=>{const{x,y}=getXY(e);mouseInside=true;mouseX=x;mouseY=y;pointerDown(x,y);e.preventDefault();});
canvas.addEventListener('mouseup',e=>{pointerUp();e.preventDefault();});

// ── Right-click: remove a single layer from a multi-effect cell ──────────────
const _layerMenu = document.getElementById('layer-menu');
const _layerItems = document.getElementById('layer-menu-items');
const _EFFECT_LABELS = {fire:'🔥 Fire',poison:'☠️ Poison',ice:'❄️ Ice',lightning:'⚡ Lightning',holy:'✨ Holy',water:'💧 Water',grass:'🌿 Grass',lava:'🌋 Lava',stone:'🪨 Stone',difficult:'⚠️ Difficult',blood:'🩸 Blood'};
const _EFFECT_DOT = {fire:'#E85020',poison:'#50A010',ice:'#3080C0',lightning:'#7050EE',holy:'#C0A020',water:'#1870C0',grass:'#3a8818',lava:'#CC3300',stone:'#8a7a6a',difficult:'#C8A000',blood:'#801020'};

function openLayerMenu(screenX, screenY, cellKey) {
  const effs = grid[cellKey];
  if (!effs || effs.length < 2) return;
  _layerItems.innerHTML = '';
  for (const eff of effs) {
    const btn = document.createElement('button');
    btn.className = 'layer-item';
    btn.innerHTML = `<span class="layer-dot" style="background:${_EFFECT_DOT[eff]||'#888'}"></span><span class="layer-name">${_EFFECT_LABELS[eff]||eff}</span><span class="layer-x">✕</span>`;
    btn.addEventListener('click', () => {
      pushUndo();
      const [r,c] = cellKey.split(',').map(Number);
      grid[cellKey] = grid[cellKey].filter(e => e !== eff);
      if (grid[cellKey].length === 0) delete grid[cellKey];
      cctx.clearRect(c*CELL, r*CELL, CELL, CELL);
      if (grid[cellKey]) drawCell(cctx, r, c, grid[cellKey], 0);
      closeLayerMenu();
    });
    _layerItems.appendChild(btn);
  }
  // Position the menu, keeping it on-screen
  _layerMenu.classList.add('open');
  const mw = _layerMenu.offsetWidth || 170, mh = _layerMenu.offsetHeight || 120;
  const px = Math.min(screenX, window.innerWidth - mw - 8);
  const py = Math.min(screenY, window.innerHeight - mh - 8);
  _layerMenu.style.left = px + 'px';
  _layerMenu.style.top  = py + 'px';
}

function closeLayerMenu() { _layerMenu.classList.remove('open'); }

canvas.addEventListener('contextmenu', e => {
  e.preventDefault();
  const {x, y} = getXY(e);
  const cell = cellFromXY(x, y);
  const key = cell.r + ',' + cell.c;
  if (grid[key] && grid[key].length >= 2) {
    openLayerMenu(e.clientX, e.clientY, key);
  } else {
    closeLayerMenu();
  }
});

document.addEventListener('mousedown', e => {
  if (!_layerMenu.contains(e.target)) closeLayerMenu();
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeLayerMenu(); });
canvas.addEventListener('touchstart',e=>{const{x,y}=getXY(e);mouseInside=true;TRAIL.length=0;mouseX=x;mouseY=y;pointerDown(x,y);e.preventDefault();},{passive:false});
canvas.addEventListener('touchmove',e=>{const{x,y}=getXY(e);movePos(x,y);e.preventDefault();},{passive:false});
canvas.addEventListener('touchend',e=>{pointerUp();mouseInside=false;e.preventDefault();},{passive:false});

document.addEventListener('keydown',e=>{
  if(e.key==='Shift') shiftHeld=true;
  if(e.key==='Escape') {
    if(teleportMode && teleportToken) { teleportToken=null; }
    closeLayerMenu();
  }
  if((e.ctrlKey||e.metaKey)&&!e.shiftKey&&e.key==='z'){e.preventDefault();undo();}
  if((e.ctrlKey||e.metaKey)&&(e.key==='y'||(e.shiftKey&&e.key==='z'))){e.preventDefault();redo();}
  // Effect shortcuts 1-7 (only when not typing in an input)
  if(!e.ctrlKey&&!e.metaKey&&!e.altKey&&document.activeElement.tagName!=='INPUT'){
    const eff=_effectKeys[e.key];
    if(eff){setActiveEffect(eff);exitDrawModes();}
  }
});
document.addEventListener('keyup',e=>{ if(e.key==='Shift') shiftHeld=false; });

// ── Token modal ────────────────────────────────────────────────
let pendingTokenCell=null, editingTokenId=null, selectedColor=TOKEN_COLORS[0];

function buildSwatches() {
  const row=document.getElementById('color-swatches'); row.innerHTML='';
  for (const c of TOKEN_COLORS) {
    const sw=document.createElement('div');
    sw.className='color-swatch'+(c===selectedColor?' sel':'');
    sw.style.background=c;
    sw.addEventListener('click',()=>{selectedColor=c;buildSwatches();});
    row.appendChild(sw);
  }
}

function buildSizeButtons(){
  document.querySelectorAll('.size-btn').forEach(b=>b.classList.toggle('sel',parseInt(b.dataset.size)===selectedSize));
}

function buildConditions(){
  const grid2=document.getElementById('tok-conditions'); grid2.innerHTML='';
  CONDITIONS.forEach(cond=>{
    const btn=document.createElement('button'); btn.className='cond-btn'+(selectedConditions.includes(cond.key)?' sel':'');
    btn.textContent=cond.label; btn.dataset.cond=cond.key;
    btn.addEventListener('click',()=>{
      if(selectedConditions.includes(cond.key))selectedConditions=selectedConditions.filter(c=>c!==cond.key);
      else selectedConditions.push(cond.key);
      btn.classList.toggle('sel',selectedConditions.includes(cond.key));
    });
    grid2.appendChild(btn);
  });
}

function openTokenModal(existing) {
  document.getElementById('tok-name').value=existing?existing.name:'';
  selectedColor=existing?existing.color:TOKEN_COLORS[0];
  selectedSize=existing?(existing.size||1):1;
  selectedSpeed=existing?(existing.speed??6):6;
  selectedHp=existing?existing.hp:null;
  selectedMaxHp=existing?existing.maxHp:null;
  selectedConditions=existing?[...(existing.conditions||[])]:[];
  buildSwatches(); buildSizeButtons(); buildConditions();
  document.getElementById('tok-speed').value=selectedSpeed;
  document.getElementById('tok-hp').value=selectedHp!=null?selectedHp:'';
  document.getElementById('tok-maxhp').value=selectedMaxHp!=null?selectedMaxHp:'';
  // Concentration
  document.getElementById('tok-conc').checked=existing?!!existing.concentrating:false;
  // Exhaustion
  document.getElementById('tok-exhaustion').value=existing?(existing.exhaustion||0):0;
  // Light
  document.getElementById('tok-light-bright').value=existing?(existing.lightRadius||0):0;
  document.getElementById('tok-light-dim').value=existing?(existing.lightDim||0):0;
  // Death saves section — show only when HP is 0
  const ds=existing?(existing.deathSaves||{successes:0,failures:0}):{successes:0,failures:0};
  const showDs=existing&&existing.hp!=null&&existing.hp<=0&&existing.maxHp>0;
  document.getElementById('death-saves-section').style.display=showDs?'':'none';
  document.querySelectorAll('.ds-success').forEach(cb=>{cb.checked=parseInt(cb.dataset.i)<ds.successes;});
  document.querySelectorAll('.ds-fail').forEach(cb=>{cb.checked=parseInt(cb.dataset.i)<ds.failures;});
  document.getElementById('tok-delete').style.display=existing?'':'none';
  document.getElementById('modal-title').textContent=existing?'EDIT TOKEN':'PLACE TOKEN';
  document.getElementById('tok-ok').textContent=existing?'Update':'Place';
  document.getElementById('token-modal').classList.add('open');
  setTimeout(()=>document.getElementById('tok-name').focus(),50);
}

// Show/hide death saves section when HP input changes
document.getElementById('tok-hp').addEventListener('input', function() {
  const hpVal = parseInt(this.value);
  const maxVal = parseInt(document.getElementById('tok-maxhp').value);
  const show = !isNaN(hpVal) && hpVal <= 0 && !isNaN(maxVal) && maxVal > 0;
  document.getElementById('death-saves-section').style.display = show ? '' : 'none';
});

function closeTokenModal() {
  document.getElementById('token-modal').classList.remove('open');
  pendingTokenCell=null; editingTokenId=null;
}

document.querySelectorAll('.size-btn').forEach(b=>b.addEventListener('click',()=>{selectedSize=parseInt(b.dataset.size);buildSizeButtons();}));

document.getElementById('tok-ok').addEventListener('click',()=>{
  const name=document.getElementById('tok-name').value.trim()||'?';
  const speed=parseInt(document.getElementById('tok-speed').value)||6;
  const hpVal=document.getElementById('tok-hp').value;
  const maxVal=document.getElementById('tok-maxhp').value;
  const hp=hpVal!==''?parseInt(hpVal):null;
  const maxHp=maxVal!==''?parseInt(maxVal):null;
  const concentrating=document.getElementById('tok-conc').checked;
  const exhaustion=parseInt(document.getElementById('tok-exhaustion').value)||0;
  const lightRadius=parseInt(document.getElementById('tok-light-bright').value)||0;
  const lightDim=parseInt(document.getElementById('tok-light-dim').value)||0;
  // Death saves
  let dsSuccesses=0, dsFailures=0;
  document.querySelectorAll('.ds-success').forEach(cb=>{if(cb.checked)dsSuccesses++;});
  document.querySelectorAll('.ds-fail').forEach(cb=>{if(cb.checked)dsFailures++;});
  const deathSaves={successes:dsSuccesses,failures:dsFailures};
  pushUndo();
  if (editingTokenId!==null) {
    const tok=tokens.find(t=>t.id===editingTokenId);
    if(tok){tok.name=name;tok.color=selectedColor;tok.size=selectedSize;tok.speed=speed;tok.hp=hp;tok.maxHp=maxHp;tok.conditions=[...selectedConditions];tok.concentrating=concentrating;tok.exhaustion=exhaustion;tok.lightRadius=lightRadius;tok.lightDim=lightDim;tok.deathSaves=deathSaves;}
    const ie=initiative.find(i=>i.tokenId===editingTokenId);
    if(ie){ie.color=selectedColor;ie.name=name;}
    renderInitiative();
  } else if (pendingTokenCell) {
    tokens.push({id:tokenIdSeq++,r:pendingTokenCell.r,c:pendingTokenCell.c,name,color:selectedColor,size:selectedSize,speed,hp,maxHp,conditions:[...selectedConditions],concentrating,exhaustion,lightRadius,lightDim,deathSaves});
  }
  closeTokenModal();
});

document.getElementById('tok-delete').addEventListener('click',()=>{
  if(editingTokenId===null)return;
  pushUndo();
  tokens=tokens.filter(t=>t.id!==editingTokenId);
  initiative=initiative.filter(i=>i.tokenId!==editingTokenId);
  renderInitiative(); closeTokenModal();
});

document.getElementById('tok-cancel').addEventListener('click',closeTokenModal);
document.getElementById('token-modal').addEventListener('click',e=>{if(e.target===e.currentTarget)closeTokenModal();});

// ── Initiative ─────────────────────────────────────────────────
let initiative=[], initCurrent=-1, roundNum=1, initIdSeq=1;

function renderInitiative() {
  const list=document.getElementById('init-list'); list.innerHTML='';
  document.getElementById('round-label').textContent=initiative.length?`Round ${roundNum}`:'';
  initiative.forEach((entry,idx)=>{
    const div=document.createElement('div'); div.className='init-entry'+(idx===initCurrent?' current':'');
    const row=document.createElement('div'); row.className='init-entry-row';
    const dot=document.createElement('div'); dot.className='init-dot'; dot.style.background=entry.color||'#aaa';
    const name=document.createElement('span'); name.className='init-name'; name.textContent=entry.name;
    const scoreWrap=document.createElement('div'); scoreWrap.className='init-score';
    const scoreIn=document.createElement('input'); scoreIn.type='number'; scoreIn.value=entry.score;
    scoreIn.addEventListener('change',()=>{entry.score=parseInt(scoreIn.value)||0;});
    scoreWrap.appendChild(scoreIn);
    const del=document.createElement('span'); del.className='init-del'; del.textContent='✕';
    del.addEventListener('click',()=>{initiative.splice(idx,1);if(initCurrent>=initiative.length)initCurrent=Math.max(-1,initiative.length-1);renderInitiative();});
    row.append(dot,name,scoreWrap,del); div.appendChild(row);
    // HP bar if linked token has HP
    const tok=tokens.find(t=>t.id===entry.tokenId);
    if(tok&&tok.maxHp!=null&&tok.maxHp>0){
      const ratio=tok.hp!=null?Math.max(0,Math.min(1,tok.hp/tok.maxHp)):1;
      const bc=ratio>.5?'#28C83C':ratio>.25?'#DCA014':'#DC2828';
      const bar=document.createElement('div'); bar.className='init-hp-bar';
      bar.innerHTML=`<div class="init-hp-fill" style="width:${ratio*100}%;background:${bc}"></div>`;
      div.appendChild(bar);
    }
    list.appendChild(div);
  });
}

document.getElementById('init-add-btn').addEventListener('click',()=>{
  const nameIn=document.getElementById('init-name-in').value.trim();
  const scoreIn=parseInt(document.getElementById('init-score-in').value)||10;
  if(!nameIn)return;
  const tok=tokens.find(t=>t.name.toLowerCase()===nameIn.toLowerCase());
  initiative.push({id:initIdSeq++,name:nameIn,color:tok?tok.color:'#aaa',score:scoreIn,tokenId:tok?tok.id:null});
  document.getElementById('init-name-in').value='';
  document.getElementById('init-score-in').value='';
  renderInitiative();
});
document.getElementById('init-name-in').addEventListener('keydown',e=>{if(e.key==='Enter')document.getElementById('init-add-btn').click();});
document.getElementById('init-score-in').addEventListener('keydown',e=>{if(e.key==='Enter')document.getElementById('init-add-btn').click();});
document.getElementById('init-sort-btn').addEventListener('click',()=>{initiative.sort((a,b)=>b.score-a.score);initCurrent=-1;renderInitiative();});
document.getElementById('init-next-btn').addEventListener('click',()=>{
  if(!initiative.length)return;
  initCurrent=(initCurrent+1)%initiative.length;
  if(initCurrent===0)roundNum++;
  document.getElementById('round-label').textContent=`Round ${roundNum}`;
  renderInitiative();
  document.querySelectorAll('.init-entry')[initCurrent]?.scrollIntoView({block:'nearest'});
});
document.getElementById('init-reset-btn').addEventListener('click',()=>{initCurrent=-1;roundNum=1;renderInitiative();});

// ── Toolbar ────────────────────────────────────────────────────
function setActiveEffect(eff) {
  currentEffect=eff; tokenMode=false;
  boundsMode=false; document.getElementById('bounds-btn').classList.remove('active');
  canvas.style.cursor='none';
  document.getElementById('token-btn').classList.remove('active');
  document.querySelectorAll('.effect-pill').forEach(p=>p.classList.remove('active'));
  document.getElementById('pill-'+eff).classList.add('active');
  document.querySelectorAll('.effect-main').forEach(b=>b.setAttribute('aria-pressed', b.dataset.effect===eff ? 'true' : 'false'));
  // Open the category containing this effect and mark it
  document.querySelectorAll('.effect-cat').forEach(cat=>cat.classList.remove('has-active'));
  const activePill=document.getElementById('pill-'+eff);
  if(activePill){
    const cat=activePill.closest('.effect-cat');
    if(cat){ cat.classList.add('open','has-active'); cat.querySelector('.cat-toggle')?.setAttribute('aria-expanded','true'); }
  }
  updateHint();
}

function clearActiveEffect() {
  currentEffect=null;
  canvas.style.cursor='crosshair';
  document.querySelectorAll('.effect-pill').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.effect-main').forEach(b=>b.setAttribute('aria-pressed','false'));
  document.querySelectorAll('.effect-cat').forEach(cat=>cat.classList.remove('has-active'));
  updateHint();
}

function setShape(eff, shape) {
  currentShape=shape;
  document.querySelectorAll('.shape-item').forEach(i=>i.classList.toggle('selected',i.dataset.effect===eff&&i.dataset.shape===shape));
  document.getElementById('radius-panel').classList.toggle('visible',shape==='circle'||shape==='square');
  updateHint();
}

function updateHint() {
  if(rulerMode){document.getElementById('hint').textContent='Click & drag to measure · 1 sq = 5 ft';return;}
  if(coverMode){document.getElementById('hint').textContent='Click near a cell edge to cycle cover: ½ → ¾ → full → clear · Shift-click to erase immediately';return;}
  if(wallMode){document.getElementById('hint').textContent='Click & drag to draw a wall · Shift-drag to erase walls · Keys 1-8 switch effects';return;}
  if(labelMode){document.getElementById('hint').textContent='Click a cell to place a text label · Click existing label to edit or delete';return;}
  if(lightMode){document.getElementById('hint').textContent='Click a cell to place a light source · Click existing light to edit · Shift-click to delete · Adjust radius with the slider above';return;}
  if(losMode){document.getElementById('hint').textContent='Click and drag to check line of sight · Walls that block are highlighted red';return;}
  if(trapMode){document.getElementById('hint').textContent='Click a cell to place a trap marker · Click again to reveal · Click revealed trap to remove';return;}
  if(teleportMode){document.getElementById('hint').textContent=teleportToken?'Click destination to teleport · Esc to cancel':'Click a token to select it · Click destination to teleport · Esc to cancel';return;}
  if (fogMode) { document.getElementById('hint').textContent='Fog brush — drag to reveal · Shift+drag to hide · Effects are ignored while in brush mode · Click FOG to paint effects · Shift-click FOG to turn off'; return; }
  if (fogEnabled) { document.getElementById('hint').textContent='Fog visible — painting effects normally · Click FOG to enter uncover brush · Shift-click FOG to turn off'; return; }
  if (boundsMode) { document.getElementById('hint').textContent='Drag handles to resize · Drag inside to move · Click TABLE to lock projection'; return; }
  if (projBounds) { document.getElementById('hint').textContent='Projection active — inner area only · Click TABLE again to clear'; return; }
  if (inspectMode) { document.getElementById('hint').textContent='Hover over a cell to see its status effects · Hover toolbar buttons for descriptions · Click INSPECT to exit'; return; }
  if(tokenMode){document.getElementById('hint').textContent='Click empty cell to place · Click token to edit/drag to move · Hover token to see movement range';return;}
  if (!currentEffect) { document.getElementById('hint').textContent='No tool selected — click an effect or press 1-8'; return; }
  const h={draw:currentEffect==='erase'?'Click & drag to erase · Keys 1-8 switch effects':'Draw freely · Close a shape to auto-fill · Keys 1-8 switch effects',cone:'Click origin · Drag to aim · Release to place',circle:`Click to place · Radius: ${circleRadius} sq`,square:`Click to place · Half-size: ${circleRadius} sq (${circleRadius*2+1}×${circleRadius*2+1})`};
  document.getElementById('hint').textContent=h[currentShape]||'';
}

function closeAllDDs(){
  document.querySelectorAll('.shape-dropdown').forEach(d=>d.classList.remove('open'));
  document.querySelectorAll('.arrow-btn').forEach(b=>b.setAttribute('aria-expanded','false'));
}

document.querySelectorAll('.effect-main').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();if(currentEffect===b.dataset.effect){clearActiveEffect();}else{setActiveEffect(b.dataset.effect);}closeAllDDs();}));
document.querySelectorAll('.arrow-btn').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();const dd=document.getElementById('dd-'+b.dataset.toggle);const was=dd.classList.contains('open');closeAllDDs();if(!was){dd.classList.add('open');b.setAttribute('aria-expanded','true');}}));
document.querySelectorAll('.shape-item').forEach(item=>item.addEventListener('click',e=>{e.stopPropagation();setActiveEffect(item.dataset.effect);setShape(item.dataset.effect,item.dataset.shape);closeAllDDs();}));
document.addEventListener('click',closeAllDDs);

// Category accordion toggles
document.querySelectorAll('.cat-toggle').forEach(btn=>{
  btn.addEventListener('click', e=>{
    e.stopPropagation();
    closeAllDDs();
    const cat=btn.closest('.effect-cat');
    const opening=!cat.classList.contains('open');
    cat.classList.toggle('open', opening);
    btn.setAttribute('aria-expanded', opening ? 'true' : 'false');
  });
});

document.getElementById('undo-btn').addEventListener('click',undo);
document.getElementById('redo-btn').addEventListener('click',redo);

document.getElementById('token-btn').addEventListener('click',()=>{
  tokenMode=!tokenMode;
  boundsMode=false; document.getElementById('bounds-btn').classList.remove('active');
  document.getElementById('token-btn').classList.toggle('active',tokenMode);
  if(tokenMode)document.querySelectorAll('.effect-pill').forEach(p=>p.classList.remove('active'));
  else if(currentEffect) document.getElementById('pill-'+currentEffect)?.classList.add('active');
  // Open/close the bestiary panel alongside token mode (merged feature).
  const beOv = document.getElementById('bestiary-overlay');
  if (beOv) {
    if (tokenMode) {
      if (typeof window.__bestiaryOpen === 'function') window.__bestiaryOpen();
      else beOv.classList.add('open');
    } else {
      beOv.classList.remove('open');
    }
  }
  updateHint();
});

document.getElementById('init-btn').addEventListener('click',()=>{document.getElementById('init-panel').classList.toggle('open');});

document.getElementById('bounds-btn').addEventListener('click',()=>{
  if (!projBounds) {
    // State 0→1: enter editing mode
    boundsMode = true;
    initBounds();
    tokenMode = false;
    document.getElementById('token-btn').classList.remove('active');
    document.querySelectorAll('.effect-pill').forEach(p=>p.classList.remove('active'));
    if(currentEffect) document.getElementById('pill-'+currentEffect)?.classList.add('active');
  } else if (boundsMode) {
    // State 1→2: lock bounds as solid projection mask
    boundsMode = false;
    canvas.style.cursor = 'none';
  } else {
    // State 2→0: clear bounds entirely
    projBounds = null;
    canvas.style.cursor = 'none';
  }
  const _bb = document.getElementById('bounds-btn');
  _bb.classList.toggle('active', !!projBounds);
  _bb.classList.toggle('projection-locked', !!projBounds && !boundsMode);
  updateHint();
});

document.getElementById('inspect-btn').addEventListener('click', () => {
  inspectMode = !inspectMode;
  document.getElementById('inspect-btn').classList.toggle('active', inspectMode);
  if (!inspectMode) _tooltip.classList.remove('visible');
  canvas.style.cursor = inspectMode ? 'crosshair' : 'none';
  updateHint();
});

document.getElementById('map-btn').addEventListener('click', () => {
  document.getElementById('map-input').click();
});

document.getElementById('map-input').addEventListener('change', function() {
  const file = this.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    const img = new Image();
    img.onload = () => {
      bgImage = img;
      window._bgImageDataUrl = ev.target.result;   // serializable form for sync
      document.getElementById('map-btn').classList.add('active');
      document.getElementById('map-panel').style.display = 'flex';
      if (window.__mpScheduleSync) window.__mpScheduleSync();
    };
    img.onerror = () => alert('Map image failed to load.');
    img.src = ev.target.result;
  };
  reader.onerror = () => alert('Could not read the map file.');
  reader.readAsDataURL(file);
  this.value = '';
});

document.getElementById('map-clear-btn').addEventListener('click', () => {
  bgImage = null;
  window._bgImageDataUrl = null;
  if (_mapObjectURL) { URL.revokeObjectURL(_mapObjectURL); _mapObjectURL = null; }
  document.getElementById('map-btn').classList.remove('active');
  document.getElementById('map-panel').style.display = 'none';
  if (window.__mpScheduleSync) window.__mpScheduleSync();
});

document.getElementById('fog-btn').addEventListener('click', (e) => {
  const btn = document.getElementById('fog-btn');
  if (e.shiftKey) {
    // Shift-click → turn fog off entirely
    fogEnabled = false; fogMode = false;
    fogDrawing = false; fogPrevCell = null;
  } else if (!fogEnabled) {
    // Off → turn on with brush mode (ready to uncover)
    fogEnabled = true; fogMode = true;
    if (Object.keys(fogTarget).length === 0) fogFill(false);
  } else {
    // On → toggle brush mode (uncover ↔ paint effects with fog visible)
    fogMode = !fogMode;
    if (!fogMode) { fogDrawing = false; fogPrevCell = null; }
  }
  btn.classList.toggle('active', fogEnabled);
  btn.classList.toggle('fog-brush-active', fogMode);
  document.getElementById('fog-panel').style.display = fogEnabled ? 'flex' : 'none';
  updateHint();
});

document.getElementById('fog-cover-btn').addEventListener('click', () => fogFill(false));
document.getElementById('fog-uncover-btn').addEventListener('click', () => fogFill(true));

// Combined Grid button — cycles: Off → Coords → 1" overlay → Off
document.getElementById('grid-overlay-btn').addEventListener('click', () => {
  const btn   = document.getElementById('grid-overlay-btn');
  const label = document.getElementById('grid-overlay-label');
  const scalePanel = document.getElementById('grid-scale-panel');
  // Determine next state from current
  if (!gridCoordsVisible && !gridOverlayVisible) {
    // Off → Coords
    gridCoordsVisible = true;  gridOverlayVisible = false;
  } else if (gridCoordsVisible && !gridOverlayVisible) {
    // Coords → 1" overlay
    gridCoordsVisible = false; gridOverlayVisible = true;
  } else {
    // 1" overlay (or any other state) → Off
    gridCoordsVisible = false; gridOverlayVisible = false;
  }
  // Update UI
  btn.classList.toggle('active', gridCoordsVisible || gridOverlayVisible);
  if (label) {
    label.textContent = gridOverlayVisible ? '1"'
                       : gridCoordsVisible ? 'A1'
                       : 'GRID';
  }
  // Scale slider is useful in both modes (both use 1" cells)
  scalePanel.style.display = (gridOverlayVisible || gridCoordsVisible) ? 'flex' : 'none';
  resize();
});

document.getElementById('grid-scale-input').addEventListener('input', function() {
  gridOverlayScale = parseInt(this.value);
  document.getElementById('grid-scale-val').value = gridOverlayScale;
  resize();
});

document.getElementById('grid-scale-val').addEventListener('input', function() {
  const v = Math.max(32, Math.min(150, parseInt(this.value) || 96));
  gridOverlayScale = v;
  document.getElementById('grid-scale-input').value = v;
  resize();
});

document.getElementById('radius-input').addEventListener('input',function(){circleRadius=parseInt(this.value);document.getElementById('radius-val-display').textContent=circleRadius;updateHint();});
document.getElementById('col-slider').addEventListener('input',function(){cols=parseInt(this.value);document.getElementById('col-val').textContent=cols;grid={};tokens=[];projBounds=null;walls=[];labels=[];fogReset();resize();});
document.getElementById('row-slider').addEventListener('input',function(){rows=parseInt(this.value);document.getElementById('row-val').textContent=rows;grid={};tokens=[];projBounds=null;walls=[];labels=[];fogReset();resize();});
document.getElementById('clear-btn').addEventListener('click',()=>{
  pushUndo();
  grid={};tokens=[];projBounds=null;walls=[];labels=[];
  drawing=false;rawPts=[];strokeCells=new Set();prevCell=null;
  erasing=false;erasePrevCell=null;coneActive=false;coneOrigin=null;
  cctx.clearRect(0,0,cellCvs.width,cellCvs.height);
});

// ── Projection window ─────────────────────────────────────────
function openProjectionWindow() {
  if (projWindow && !projWindow.closed) { projWindow.focus(); return; }
  projWindow = window.open('about:blank', 'dnd-projection',
    'width=1024,height=768,menubar=no,toolbar=no,location=no,status=no');
  if (!projWindow) { alert('Pop-up blocked — please allow pop-ups for this page.'); return; }
  projWindow.document.write(`<!DOCTYPE html><html><head>
<meta charset="UTF-8"><title>D&D Battle Grid — Projection</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#000;display:flex;align-items:center;justify-content:center;height:100vh;overflow:hidden}
  canvas{max-width:100vw;max-height:100vh;object-fit:contain;cursor:none}
  #hint{position:fixed;bottom:14px;left:50%;transform:translateX(-50%);color:rgba(255,255,255,0.25);font:11px system-ui;letter-spacing:.05em;pointer-events:none;text-align:center}
  #fs{position:fixed;top:10px;right:10px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.18);color:rgba(255,255,255,0.6);padding:5px 12px;border-radius:6px;cursor:pointer;font:700 11px system-ui;letter-spacing:.04em}
  #fs:hover{background:rgba(255,255,255,0.18);color:#fff}
</style></head><body>
<canvas id="proj-canvas"></canvas>
<button id="fs" onclick="document.documentElement.requestFullscreen()">⛶ FULLSCREEN</button>
<div id="hint">Move this window to your projector · click FULLSCREEN · Bluetooth: connect projector as extended display first</div>
</body></html>`);
  projWindow.document.close();
  projWindow.__projCanvas = projWindow.document.getElementById('proj-canvas');
  document.getElementById('project-btn').classList.add('active');
  if (_projCheckInterval) clearInterval(_projCheckInterval);
  _projCheckInterval = setInterval(() => {
    if (projWindow.closed) {
      projWindow = null;
      document.getElementById('project-btn').classList.remove('active');
      clearInterval(_projCheckInterval);
      _projCheckInterval = null;
    }
  }, 1000);
}

// ── Save / Load ───────────────────────────────────────────────
function getSaveData() {
  return {
    version:3, rows, cols, grid, tokens,
    fogEnabled, fogVis:{...fogVis}, fogTarget:{...fogTarget},
    projBounds, initiative, initCurrent, roundNum,
    walls, labels, lights, presets,
    covers: {...covers},
    traps: {...traps},
  };
}

function saveGame() {
  const json = JSON.stringify(getSaveData(), null, 2);
  // Prefer the native Swift bridge (WKWebView ignores <a download>)
  if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.saveFile) {
    window.webkit.messageHandlers.saveFile.postMessage({
      filename: 'battle-grid.json',
      content:  json
    });
  } else {
    // Browser fallback
    const blob = new Blob([json], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = 'battle-grid.json'; a.click();
    URL.revokeObjectURL(url);
  }
  autoSave();
}

function loadGame(json) {
  try {
    const s=JSON.parse(json);
    cols=s.cols||20; rows=s.rows||20;
    document.getElementById('col-slider').value=cols; document.getElementById('col-val').textContent=cols;
    document.getElementById('row-slider').value=rows; document.getElementById('row-val').textContent=rows;
    grid=s.grid||{};
    tokens=(s.tokens||[]).map(t=>({...t,conditions:t.conditions||[],size:t.size||1,speed:t.speed??6,deathSaves:t.deathSaves||{successes:0,failures:0},concentrating:!!t.concentrating,exhaustion:t.exhaustion||0,lightRadius:t.lightRadius||0,lightDim:t.lightDim||0}));
    fogEnabled=s.fogEnabled||false;
    for(const k in fogVis)delete fogVis[k]; for(const k in fogTarget)delete fogTarget[k];
    Object.assign(fogVis,s.fogVis||{}); Object.assign(fogTarget,s.fogTarget||{});
    projBounds=s.projBounds||null;
    initiative=s.initiative||[]; initCurrent=s.initCurrent??-1; roundNum=s.roundNum||1;
    walls=s.walls||[]; wallIdSeq=walls.length?Math.max(...walls.map(w=>w.id))+1:1;
    labels=s.labels||[]; labelIdSeq=labels.length?Math.max(...labels.map(l=>l.id))+1:1;
    lights=s.lights||[]; lightIdSeq=lights.length?Math.max(...lights.map(l=>l.id))+1:1;
    covers=s.covers||{};
    traps=s.traps||{};
    if(s.presets) presets=s.presets;
    const fb=document.getElementById('fog-btn');
    fb.classList.toggle('active',fogEnabled); fb.classList.toggle('fog-brush-active',fogMode);
    document.getElementById('fog-panel').style.display=fogEnabled?'flex':'none';
    const bb=document.getElementById('bounds-btn');
    bb.classList.toggle('active',!!projBounds); bb.classList.toggle('projection-locked',!!projBounds&&!boundsMode);
    resize(); renderInitiative(); renderPresets(); updateHint();
  } catch(e){ alert('Could not load file: '+e.message); }
}

// ── AutoSave ──────────────────────────────────────────────────
function autoSave() {
  try {
    localStorage.setItem('dnd-autosave', JSON.stringify(getSaveData()));
    localStorage.setItem('dnd-autosave-ts', Date.now());
  } catch(e) {}
}

setInterval(autoSave, 60000);

// ── Scenes ────────────────────────────────────────────────────
function saveScene(name) {
  const idx = scenes.findIndex(s => s.name === name);
  if (idx >= 0) scenes[idx].data = getSaveData();
  else scenes.push({ name, data: getSaveData() });
  try { localStorage.setItem('dnd-scenes', JSON.stringify(scenes)); } catch(e) {}
  renderScenes();
}

function loadScene(idx) {
  loadGame(JSON.stringify(scenes[idx].data));
}

function renderScenes() {
  const list = document.getElementById('scene-list'); list.innerHTML = '';
  if (!scenes.length) {
    const e = document.createElement('div'); e.className = 'scene-empty';
    e.textContent = 'No scenes saved'; list.appendChild(e); return;
  }
  scenes.forEach((sc, i) => {
    const row = document.createElement('div'); row.className = 'scene-entry';
    const nm = document.createElement('span'); nm.className = 'scene-name'; nm.textContent = sc.name;
    const lb = document.createElement('button'); lb.className = 'scene-load-btn'; lb.textContent = '▶ Load';
    lb.addEventListener('click', () => loadScene(i));
    const db = document.createElement('button'); db.className = 'scene-del-btn'; db.textContent = '✕';
    db.addEventListener('click', () => { scenes.splice(i, 1); try{localStorage.setItem('dnd-scenes',JSON.stringify(scenes));}catch(e){} renderScenes(); });
    row.append(nm, lb, db); list.appendChild(row);
  });
}

function loadScenesFromStorage() {
  try { const s = localStorage.getItem('dnd-scenes'); if(s) scenes = JSON.parse(s); } catch(e) {}
}

// ── Presets ───────────────────────────────────────────────────
function renderPresets() {
  const list=document.getElementById('preset-list'); list.innerHTML='';
  if(!presets.length){const e=document.createElement('div');e.className='preset-empty';e.textContent='No presets saved';list.appendChild(e);return;}
  presets.forEach((p,i)=>{
    const row=document.createElement('div'); row.className='preset-entry';
    const nm=document.createElement('span'); nm.className='preset-name'; nm.textContent=p.name;
    const lb=document.createElement('button'); lb.className='preset-load-btn'; lb.textContent='▶ Load';
    lb.addEventListener('click',()=>loadGame(JSON.stringify(p.data)));
    const db=document.createElement('button'); db.className='preset-del-btn'; db.textContent='✕';
    db.addEventListener('click',()=>{presets.splice(i,1);savePresetsToStorage();renderPresets();});
    row.append(nm,lb,db); list.appendChild(row);
  });
}

function savePresetsToStorage(){ try{localStorage.setItem('dnd-presets',JSON.stringify(presets));}catch(e){} }
function loadPresetsFromStorage(){ try{const p=localStorage.getItem('dnd-presets');if(p)presets=JSON.parse(p);}catch(e){} }

// ── Turn timer ────────────────────────────────────────────────
function updateTimerDisplay(){
  const m=Math.floor(timerLeft/60), s2=timerLeft%60;
  const d=document.getElementById('timer-display');
  if(d){d.textContent=`${m}:${s2.toString().padStart(2,'0')}`;d.classList.toggle('urgent',timerLeft<=5&&timerLeft>0);d.style.animation=timerLeft<=5&&timerLeft>0?'timer-pulse .5s ease-in-out infinite':'';}
}

function startTimer(){
  if(_timerInterval)return; timerRunning=true;
  document.getElementById('timer-toggle').textContent='⏸';
  _timerInterval=setInterval(()=>{timerLeft--;updateTimerDisplay();if(timerLeft<=0){stopTimer();}},1000);
}

function stopTimer(){
  clearInterval(_timerInterval);_timerInterval=null;timerRunning=false;
  const t=document.getElementById('timer-toggle');if(t)t.textContent='▶';
}

function resetTimer(){ stopTimer();timerLeft=timerDuration;updateTimerDisplay(); }

// ── DM Reference panel drag ───────────────────────────────────
(function() {
  const panel = document.getElementById('dm-ref-panel');
  const header = document.getElementById('dm-ref-header');
  let dx = 0, dy = 0, dragging = false;
  header.addEventListener('mousedown', e => {
    dragging = true;
    dx = e.clientX - panel.getBoundingClientRect().left;
    dy = e.clientY - panel.getBoundingClientRect().top;
    e.preventDefault();
  });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    panel.style.right = 'auto';
    panel.style.left = (e.clientX - dx) + 'px';
    panel.style.top  = (e.clientY - dy) + 'px';
  });
  document.addEventListener('mouseup', () => { dragging = false; });
})();

document.getElementById('dm-ref-btn').addEventListener('click', () => {
  dmRefVisible = !dmRefVisible;
  document.getElementById('dm-ref-panel').style.display = dmRefVisible ? 'flex' : 'none';
  document.getElementById('dm-ref-btn').classList.toggle('active', dmRefVisible);
});

document.getElementById('dm-ref-close').addEventListener('click', () => {
  dmRefVisible = false;
  document.getElementById('dm-ref-panel').style.display = 'none';
  document.getElementById('dm-ref-btn').classList.remove('active');
});

document.getElementById('project-btn').addEventListener('click', () => {
  if (projWindow && !projWindow.closed) { projWindow.focus(); return; }
  document.getElementById('projector-modal').style.display = 'flex';
});

document.getElementById('proj-open-btn').addEventListener('click', () => {
  document.getElementById('projector-modal').style.display = 'none';
  openProjectionWindow();
});

document.getElementById('proj-cancel-btn').addEventListener('click', () => {
  document.getElementById('projector-modal').style.display = 'none';
});

// ── Inspect: tool descriptions ────────────────────────────────
const TOOL_INFO = {
  'pill-fire':        { title: '🔥 Fire',        desc: 'Paint burning tiles. Use ▾ to switch between Freehand, Cone, Circle, or Square shape.' },
  'pill-poison':      { title: '☠️ Poison',      desc: 'Paint toxic tiles. Use ▾ to choose a shape.' },
  'pill-ice':         { title: '❄️ Ice',          desc: 'Paint frozen tiles. Use ▾ to choose a shape.' },
  'pill-lightning':   { title: '⚡ Lightning',    desc: 'Paint electrified tiles. Use ▾ to choose a shape.' },
  'pill-holy':        { title: '✨ Holy',         desc: 'Paint radiant tiles. Use ▾ to choose a shape.' },
  'pill-grass':       { title: '🌿 Grass',         desc: 'Paint grass terrain tiles with 8-bit top-down texture. Use ▾ to switch Freehand, Cone, Circle, or Square shape.' },
  'pill-water':       { title: '💧 Water',         desc: 'Paint water terrain tiles with 8-bit ripple texture. Use ▾ to switch Freehand, Cone, Circle, or Square shape.' },
  'pill-erase':       { title: '🧹 Erase',        desc: 'Remove effects and walls from tiles. Works with all shapes: Freehand, Cone, Circle, or Square.' },
  'cat-elemental':    { title: '🔥 Elemental',     desc: 'Click to expand/collapse Fire, Ice, and Lightning effects.' },
  'cat-arcane':       { title: '⚗️ Arcane',        desc: 'Click to expand/collapse Poison and Holy effects.' },
  'cat-terrain':      { title: '🌊 Terrain',       desc: 'Click to expand/collapse terrain effects like Water.' },
  'cat-tools':        { title: '🛠️ Tools',          desc: 'Click to expand/collapse utility tools like Erase.' },
  'undo-btn':         { title: '↩️ Undo',         desc: 'Step back through effect and token changes. Shortcut: Ctrl+Z.' },
  'redo-btn':         { title: '↪️ Redo',         desc: 'Step forward through history. Shortcut: Ctrl+Shift+Z.' },
  'token-btn':        { title: '🪙 Token & Bestiary', desc: 'Opens your bestiary panel and enables token mode. Drag a creature card onto the grid to place it as a token, click an empty cell for a quick generic token, or click an existing token to edit / drag it.' },
  'bounds-btn':       { title: '🖼️ Table',        desc: '1st click: enter edit mode and drag handles to define the table surface. 2nd click: lock — only the inner area is projected, outside goes black. 3rd click: clear.' },
  'init-btn':         { title: '⚔️ Initiative',   desc: 'Open the initiative tracker. Add combatants with a name and roll, sort, then use Next Turn to advance. Tokens with matching names get an initiative badge.' },
  'inspect-btn':      { title: '🔍 Inspect',      desc: 'Hover over cells to see status effects and fog state. Hover over toolbar buttons to see what they do. (You\'re using it right now!)' },
  'dm-ref-btn':       { title: '👁️ DM Reference', desc: 'Opens a floating fog-free view of the full map for the DM only. Drag it by its header to reposition. Never mirrored to the projector.' },
  'project-btn':      { title: '🖥️ Project',      desc: 'Opens a separate window to mirror the battle grid on a projector. Set the projector as an extended display, drag the window to it, then click FULLSCREEN.' },
  'map-btn':          { title: '🗺️ Map',           desc: 'Import a dungeon map image from your computer as the background. The image scales to fill the entire grid.' },
  'map-clear-btn':    { title: '✕ Clear Map',     desc: 'Remove the background map image and return to a plain dark grid.' },
  'fog-btn':          { title: '🌫️ Fog of War',   desc: '1st click: brush mode — drag to reveal tiles, Shift+drag to hide. 2nd click: keep fog visible but paint effects normally. 3rd click: turn fog off entirely.' },
  'fog-cover-btn':    { title: '⬛ Cover',         desc: 'Cover the entire map with fog of war instantly.' },
  'fog-uncover-btn':  { title: '⬜ Uncover',       desc: 'Remove all fog and reveal the full map instantly.' },
  'grid-overlay-btn': { title: '📏 1" Overlay',   desc: 'Draw a calibrated 1-inch physical grid over the map. Adjust the SCALE slider until the lines match your table surface. This also sets the effect tile size.' },
  'clear-btn':        { title: 'CLR Clear',        desc: 'Remove all status effects and tokens from the grid. This action can be undone with Ctrl+Z.' },
  'radius-input':     { title: '⭕ Radius',        desc: 'Set the size (in grid squares) for Circle and Square effect stamps. Also controls fog brush size.' },
  'col-slider':       { title: 'W Width',          desc: 'Adjust the number of grid columns. Changing this resets the grid.' },
  'row-slider':       { title: 'H Height',         desc: 'Adjust the number of grid rows. Changing this resets the grid.' },
  'wall-btn':         { title: '🧱 Wall',          desc: 'Draw walls — click and drag to place a line segment. Shift-drag to sweep-erase nearby walls. Walls are rendered on the projection.' },
  'label-btn':        { title: '🏷️ Label',         desc: 'Place text labels on the map — click any cell to type a name. Click an existing label to edit or delete it.' },
  'save-btn':         { title: '💾 Save',           desc: 'Export the full battle state (grid, tokens, fog, walls, labels, initiative) to a JSON file on your computer.' },
  'load-btn':         { title: '📂 Load',           desc: 'Import a previously saved battle-grid.json file to restore a session.' },
  'preset-btn':       { title: '📋 Presets',        desc: 'Save named snapshots of the current battle state and restore them instantly — useful for prepping encounters.' },
  'timer-btn':        { title: '⏱ Timer',          desc: 'Toggle a per-turn countdown timer in the initiative panel. Helps keep combat moving.' },
};

function showToolTooltip(el, clientX, clientY) {
  const info = TOOL_INFO[el.id];
  if (!info) return false;
  const margin = 14, tw = 240, th = 80;
  let tx = clientX + margin, ty = clientY + margin;
  if (tx + tw > window.innerWidth  - 8) tx = clientX - tw - margin;
  if (ty + th > window.innerHeight - 8) ty = clientY - th - margin;
  _tooltip.style.left = tx + 'px';
  _tooltip.style.top  = ty + 'px';
  _tooltip.style.minWidth = '200px';
  _tooltip.innerHTML = `<div class="tt-title">${info.title}</div><div class="tt-desc">${info.desc}</div>`;
  _tooltip.classList.add('visible');
  return true;
}

(function() {
  const toolbar = document.getElementById('toolbar');
  toolbar.addEventListener('mouseover', e => {
    if (!inspectMode) return;
    let el = e.target;
    while (el && el !== toolbar) {
      if (showToolTooltip(el, e.clientX, e.clientY)) return;
      el = el.parentElement;
    }
    _tooltip.classList.remove('visible');
  });
  toolbar.addEventListener('mousemove', e => {
    if (!inspectMode || !_tooltip.classList.contains('visible')) return;
    const margin = 14, tw = 240, th = 80;
    let tx = e.clientX + margin, ty = e.clientY + margin;
    if (tx + tw > window.innerWidth  - 8) tx = e.clientX - tw - margin;
    if (ty + th > window.innerHeight - 8) ty = e.clientY - th - margin;
    _tooltip.style.left = tx + 'px';
    _tooltip.style.top  = ty + 'px';
  });
  toolbar.addEventListener('mouseleave', () => {
    if (inspectMode) _tooltip.classList.remove('visible');
  });
})();

// ── Wall / Label toolbar ─────────────────────────────────────
function exitDrawModes(){
  wallMode=false; labelMode=false; lightMode=false;
  losMode=false; losStart=null; trapMode=false; teleportMode=false; teleportToken=null;
  wallActive=false; wallStart=null; wallErasing=false;
  ['wall-btn','label-btn','light-btn','los-btn','trap-btn','teleport-btn'].forEach(id=>{
    const el=document.getElementById(id); if(el) el.classList.remove('active');
  });
  const lp=document.getElementById('light-panel'); if(lp) lp.style.display='none';
}

document.getElementById('wall-btn').addEventListener('click',()=>{
  const on=!wallMode; exitDrawModes(); if(on){wallMode=true;document.getElementById('wall-btn').classList.add('active');}
  updateHint();
});
document.getElementById('label-btn').addEventListener('click',()=>{
  const on=!labelMode; exitDrawModes(); if(on){labelMode=true;document.getElementById('label-btn').classList.add('active');}
  updateHint();
});
document.getElementById('light-btn').addEventListener('click',()=>{
  const on=!lightMode; exitDrawModes();
  if(on){
    lightMode=true;
    document.getElementById('light-btn').classList.add('active');
    document.getElementById('light-panel').style.display='flex';
  }
  updateHint();
});

// ── Light source: radius slider + modal handlers ─────────────
(function () {
  const slider = document.getElementById('light-radius-input');
  const valIn  = document.getElementById('light-radius-val');
  function setRadius(v) {
    lightPlaceRadius = Math.max(1, Math.min(20, parseInt(v) || 5));
    if (slider) slider.value = lightPlaceRadius;
    if (valIn)  valIn.value  = lightPlaceRadius;
  }
  if (slider) slider.addEventListener('input', () => setRadius(slider.value));
  if (valIn)  valIn.addEventListener('input',  () => setRadius(valIn.value));
})();

// Open the light-edit modal pre-filled with the given light's values
function openLightModal(light) {
  editingLightId = light.id;
  const modal = document.getElementById('light-modal');
  document.getElementById('light-name-in').value      = light.name || 'Torch';
  document.getElementById('light-edit-radius').value  = light.radius || 5;
  document.getElementById('light-preset').value       = '';
  document.getElementById('light-delete').style.display = '';
  modal.classList.add('open');
  setTimeout(()=>document.getElementById('light-name-in').focus(), 50);
}
// Light preset → fills name + radius
document.getElementById('light-preset').addEventListener('change', e => {
  const map = {
    candle:   { name:'Candle',         r:2  },
    torch:    { name:'Torch',          r:5  },
    lantern:  { name:'Lantern',        r:8  },
    sunrod:   { name:'Sunrod',         r:12 },
    daylight: { name:'Daylight Spell', r:20 },
  };
  const p = map[e.target.value];
  if (!p) return;
  document.getElementById('light-name-in').value     = p.name;
  document.getElementById('light-edit-radius').value = p.r;
});
document.getElementById('light-save').addEventListener('click', () => {
  const lit = lights.find(l => l.id === editingLightId);
  if (!lit) return;
  pushUndo();
  lit.name   = (document.getElementById('light-name-in').value || '').trim().slice(0, 32) || 'Light';
  lit.radius = Math.max(1, Math.min(30, parseInt(document.getElementById('light-edit-radius').value) || 5));
  document.getElementById('light-modal').classList.remove('open');
  editingLightId = null;
});
document.getElementById('light-delete').addEventListener('click', () => {
  if (!editingLightId) return;
  if (!confirm('Delete this light source?')) return;
  pushUndo();
  lights = lights.filter(l => l.id !== editingLightId);
  document.getElementById('light-modal').classList.remove('open');
  editingLightId = null;
});
document.getElementById('light-cancel').addEventListener('click', () => {
  document.getElementById('light-modal').classList.remove('open');
  editingLightId = null;
});

// ── Label modal ───────────────────────────────────────────────
document.getElementById('label-ok').addEventListener('click',()=>{
  const txt=document.getElementById('label-text-in').value.trim(); if(!txt)return;
  pushUndo();
  if(editingLabelId!=null){
    const l=labels.find(l=>l.id===editingLabelId);if(l)l.text=txt;
  }else if(pendingLabelCell){
    labels.push({id:labelIdSeq++,r:pendingLabelCell.r,c:pendingLabelCell.c,text:txt});
  }
  document.getElementById('label-modal').classList.remove('open');
  pendingLabelCell=null;editingLabelId=null;
});
document.getElementById('label-delete').addEventListener('click',()=>{
  if(editingLabelId==null)return;
  pushUndo(); labels=labels.filter(l=>l.id!==editingLabelId);
  document.getElementById('label-modal').classList.remove('open');
  pendingLabelCell=null;editingLabelId=null;
});
document.getElementById('label-cancel').addEventListener('click',()=>{
  document.getElementById('label-modal').classList.remove('open');
  pendingLabelCell=null;editingLabelId=null;
});
document.getElementById('label-modal').addEventListener('click',e=>{if(e.target===e.currentTarget)document.getElementById('label-modal').classList.remove('open');});

// ── Save / Load buttons ───────────────────────────────────────
document.getElementById('save-btn').addEventListener('click', saveGame);
document.getElementById('load-btn').addEventListener('click',()=>document.getElementById('load-input').click());
document.getElementById('load-input').addEventListener('change',function(){
  const f=this.files[0]; if(!f)return;
  const r=new FileReader(); r.onload=e=>loadGame(e.target.result); r.readAsText(f); this.value='';
});

// ── Presets ───────────────────────────────────────────────────
document.getElementById('preset-btn').addEventListener('click',()=>{
  const p=document.getElementById('preset-panel');
  const on=p.style.display==='none'; p.style.display=on?'flex':'none';
  document.getElementById('preset-btn').classList.toggle('active',on);
});
document.getElementById('preset-save-btn').addEventListener('click',()=>{
  const name=document.getElementById('preset-name-in').value.trim(); if(!name)return;
  presets.push({name,data:getSaveData()}); savePresetsToStorage(); renderPresets();
  document.getElementById('preset-name-in').value='';
});
document.getElementById('preset-name-in').addEventListener('keydown',e=>{if(e.key==='Enter')document.getElementById('preset-save-btn').click();});

// ── Turn timer ────────────────────────────────────────────────
document.getElementById('timer-btn').addEventListener('click',()=>{
  timerVisible=!timerVisible;
  document.getElementById('turn-timer').style.display=timerVisible?'flex':'none';
  document.getElementById('timer-btn').classList.toggle('active',timerVisible);
  if(timerVisible)updateTimerDisplay();
});
document.getElementById('timer-toggle').addEventListener('click',()=>{if(timerRunning)stopTimer();else startTimer();});
document.getElementById('timer-reset').addEventListener('click',resetTimer);

// ── Feature 5: Ruler ─────────────────────────────────────────
document.getElementById('ruler-btn').addEventListener('click',()=>{
  rulerMode=!rulerMode;
  rulerStart=null;
  canvas.style.cursor=rulerMode?'crosshair':'none';
  document.getElementById('ruler-btn').classList.toggle('active',rulerMode);
  updateHint();
});

// ── Feature 9: Cover ─────────────────────────────────────────
document.getElementById('cover-btn').addEventListener('click',()=>{
  coverMode=!coverMode;
  document.getElementById('cover-btn').classList.toggle('active',coverMode);
  canvas.style.cursor=coverMode?'crosshair':'none';
  updateHint();
});

// ── LoS button ────────────────────────────────────────────────
document.getElementById('los-btn').addEventListener('click',()=>{
  const on=!losMode; exitDrawModes();
  if(on){ losMode=true; document.getElementById('los-btn').classList.add('active'); canvas.style.cursor='crosshair'; }
  else canvas.style.cursor='none';
  updateHint();
});

// ── Trap button ───────────────────────────────────────────────
document.getElementById('trap-btn').addEventListener('click',()=>{
  const on=!trapMode; exitDrawModes();
  if(on){ trapMode=true; document.getElementById('trap-btn').classList.add('active'); canvas.style.cursor='crosshair'; }
  else canvas.style.cursor='none';
  updateHint();
});

// ── Teleport button ───────────────────────────────────────────
document.getElementById('teleport-btn').addEventListener('click',()=>{
  const on=!teleportMode; exitDrawModes();
  if(on){ teleportMode=true; document.getElementById('teleport-btn').classList.add('active'); canvas.style.cursor='crosshair'; }
  else canvas.style.cursor='none';
  updateHint();
});

// ── Scenes button ─────────────────────────────────────────────
document.getElementById('scenes-btn').addEventListener('click',()=>{
  const p=document.getElementById('scenes-panel');
  const on=p.style.display==='none'||p.style.display===''; p.style.display=on?'flex':'none';
  document.getElementById('scenes-btn').classList.toggle('active',on);
});
document.getElementById('scene-save-btn').addEventListener('click',()=>{
  const name=document.getElementById('scene-name-in').value.trim(); if(!name)return;
  saveScene(name); document.getElementById('scene-name-in').value='';
});
document.getElementById('scene-name-in').addEventListener('keydown',e=>{if(e.key==='Enter')document.getElementById('scene-save-btn').click();});

// ── Feature 10: Undo history panel ───────────────────────────
document.getElementById('undo-history-btn').addEventListener('click',()=>{
  const p=document.getElementById('undo-panel');
  const on=p.style.display==='none'||p.style.display==='';
  p.style.display=on?'flex':'none';
  document.getElementById('undo-history-btn').classList.toggle('active',on);
  document.getElementById('undo-count').textContent=undoStack.length+' change'+(undoStack.length!==1?'s':'')+' to undo';
});
document.getElementById('undo-all-btn').addEventListener('click',()=>{
  while(undoStack.length) undo();
  document.getElementById('undo-panel').style.display='none';
  document.getElementById('undo-history-btn').classList.remove('active');
  rebuildCells();
});

// ── Boot ──────────────────────────────────────────────────────
window.addEventListener('resize',()=>resize());
loadPresetsFromStorage();
renderPresets();
loadScenesFromStorage();
renderScenes();
updateHint();
resize();
requestAnimationFrame(render);

// ── Autosave recovery notice ───────────────────────────────────
(function() {
  const saved = localStorage.getItem('dnd-autosave');
  if (!saved) return;
  const ts = parseInt(localStorage.getItem('dnd-autosave-ts')||'0');
  let timeStr = 'previously';
  if (ts) {
    const diff = Date.now() - ts;
    const mins = Math.round(diff / 60000);
    timeStr = mins < 2 ? 'just now' : mins < 60 ? mins + ' minutes ago' : Math.round(mins/60) + ' hours ago';
  }
  const notice = document.getElementById('autosave-notice');
  document.getElementById('autosave-msg').textContent = 'Auto-save found from ' + timeStr + '. Restore?';
  notice.classList.add('visible');
  let dismissTimer = setTimeout(() => notice.classList.remove('visible'), 15000);
  document.getElementById('autosave-restore').addEventListener('click', () => {
    clearTimeout(dismissTimer);
    notice.classList.remove('visible');
    loadGame(saved);
  });
  document.getElementById('autosave-dismiss').addEventListener('click', () => {
    clearTimeout(dismissTimer);
    notice.classList.remove('visible');
  });
})();

// ══════════════════════════════════════════════════════════════════════
// MULTIPLAYER — room creation, join, and chat (HTTP polling)
// ══════════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  // State
  let myId = null, myName = null, isDM = false;
  let roomCode = null, players = {}, dmId = null;
  let activeTab = 'all';
  let messages = {};   // tab -> [{from,text,ts,isMine,isDM,isPM,type}]
  let unread = {};     // tab -> count
  let panelOpen = false;
  let pollTs = 0;      // last event timestamp seen
  let pollTimer = null;
  let heartbeatTimer = null;

  // DOM refs
  const panel = document.getElementById('mp-panel');
  const tabBtn = document.getElementById('mp-tab-btn');
  const badge = document.getElementById('mp-badge');
  const setupDiv = document.getElementById('mp-setup');
  const roomDiv = document.getElementById('mp-room');
  const codeWrap = document.getElementById('mp-code-wrap');
  const codeDisplay = document.getElementById('mp-code-display');
  const playersList = document.getElementById('mp-players-list');
  const chatTabs = document.getElementById('mp-chat-tabs');
  const messagesEl = document.getElementById('mp-messages');
  const msgInput = document.getElementById('mp-msg-in');
  const joinErr = document.getElementById('mp-join-error');

  // Panel toggle
  function openPanel() {
    panelOpen = true;
    panel.classList.add('open');
    tabBtn.classList.add('shifted');
    clearUnread(activeTab);
    updateBadge();
  }
  function closePanel() {
    panelOpen = false;
    panel.classList.remove('open');
    tabBtn.classList.remove('shifted');
  }
  tabBtn.addEventListener('click', () => panelOpen ? closePanel() : openPanel());
  document.getElementById('mp-panel-close').addEventListener('click', closePanel);

  // HTTP helpers
  // Resolve initial SERVER URL.
  //   1. ?server=https://… in the page URL wins (used by hosted players to
  //      point at a DM's Cloudflare/ngrok tunnel)
  //   2. localStorage 'arcane_mp_server' (remembers your last manual entry)
  //   3. fallback to localhost (the bundled Mac app default)
  // Permanent hosted server on Render — the default for everyone.
  const HOSTED_SERVER = 'https://arcaneoverlay-server.onrender.com';
  function _resolveInitialServer() {
    try {
      const q = new URLSearchParams(window.location.search);
      const fromQ = q.get('server');
      if (fromQ) {
        const v = fromQ.replace(/\/$/, '');
        try { localStorage.setItem('arcane_mp_server', v); } catch (e) {}
        return v;
      }
      const fromLS = localStorage.getItem('arcane_mp_server');
      if (fromLS) return fromLS.replace(/\/$/, '');
    } catch (e) {}
    return HOSTED_SERVER;
  }
  let SERVER = _resolveInitialServer();
  async function api(path, body) {
    const opts = body
      ? { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) }
      : { method: 'GET' };
    const r = await fetch(SERVER + path, opts);
    return r.json();
  }

  // Polling
  function startPoll() {
    pollTimer = setInterval(poll, 1500);
    heartbeatTimer = setInterval(heartbeat, 10000);
  }
  function stopPoll() {
    clearInterval(pollTimer);
    clearInterval(heartbeatTimer);
    pollTimer = heartbeatTimer = null;
  }
  async function poll() {
    if (!roomCode || !myId) return;
    try {
      const data = await api(`/api/poll?room=${encodeURIComponent(roomCode)}&player_id=${encodeURIComponent(myId)}&since=${pollTs}`);
      if (!data.events) return;
      data.events.forEach(handleEvent);
      if (data.ts) pollTs = data.ts;
    } catch(e) {}
  }
  async function heartbeat() {
    if (!roomCode || !myId) return;
    try { await api('/api/heartbeat', {room: roomCode, player_id: myId}); } catch(e) {}
  }

  // Event handler
  function handleEvent(ev) {
    switch(ev.type) {
      case 'player_joined':
        players = ev.players;
        if (isDM && !messages[ev.id]) { messages[ev.id] = []; unread[ev.id] = 0; }
        renderPlayers();
        renderTabs();
        addSysMsg('all', `⚔️ ${ev.name} joined the room.`);
        if (isDM) addSysMsg(ev.id, `🗡️ Private channel with ${ev.name}.`);
        break;
      case 'player_left':
        players = ev.players;
        renderPlayers();
        if (activeTab === ev.id) switchTab('all');
        renderTabs();
        addSysMsg('all', `${ev.name} left the room.`);
        break;
      case 'chat':
        receiveChat(ev);
        break;
      case 'grid_state':
        // Everyone (DM included) applies the merged snapshot so that
        // a player moving their own token shows up on the DM's grid too.
        // The server merges per-role: DM pushes overwrite the full state,
        // player pushes only touch tokens/labels — so applying a received
        // snapshot doesn't disturb DM-controlled fields.
        if (ev.state && typeof window.__applyMpGridState === 'function') {
          try { window.__applyMpGridState(ev.state); } catch(e) {}
        }
        break;
    }
  }

  // Enter room after create/join
  function enterRoom() {
    setupDiv.style.display = 'none';
    roomDiv.style.display = 'block';
    messages = { all: [] };
    unread = { all: 0 };
    if (!isDM) { messages.dm = []; unread.dm = 0; }
    if (isDM) {
      Object.keys(players).forEach(id => {
        if (id !== myId) { messages[id] = []; unread[id] = 0; }
      });
      codeWrap.style.display = 'block';
      codeDisplay.textContent = roomCode;
    } else {
      codeWrap.style.display = 'none';
    }
    activeTab = 'all';
    renderPlayers();
    renderTabs();
    renderMessages();
    openPanel();
    // Show / hide DM-only Roll-Request tools
    const dmTools = document.getElementById('mp-dm-roll-tools');
    if (dmTools) dmTools.classList.toggle('visible', isDM);
    // Lock down the toolbar for players — only token / LoS / inspect
    document.body.classList.toggle('player-restricted', !isDM);
    // Refresh the DM player-link preview now that the room code exists
    if (typeof window.__mpRefreshPlayerLink === 'function') {
      window.__mpRefreshPlayerLink();
    }
    // Initialise the "Playing as" picker for this session
    refreshActiveSheetPicker();
    addSysMsg('all', isDM
      ? `Room created! Share code "${roomCode}" with your players.`
      : `You joined as ${myName}.`);
    if (!isDM) addSysMsg('dm', 'Private channel with the DM only.');
    startPoll();
  }

  // Callbacks that fire whenever the players list changes
  const _onPlayersChangedHooks = [];
  function firePlayersChanged() {
    _onPlayersChangedHooks.forEach(fn => { try { fn(); } catch(e) {} });
  }

  // Players list
  function renderPlayers() {
    playersList.innerHTML = '';
    Object.entries(players).forEach(([id, name]) => {
      const el = document.createElement('div');
      el.className = 'mp-player' + (id===dmId?' is-dm':'') + (id===myId?' is-you':'');
      const hint = id===myId ? '' : (id===dmId ? '💬 private' : '💬 whisper');
      el.innerHTML = `<div class="mp-dot"></div><span class="mp-player-name">${escHtml(name)}</span><span class="mp-whisper-hint">${hint}</span>`;
      if (id !== myId) {
        el.addEventListener('click', () => {
          const tab = (isDM || id !== dmId) ? id : 'dm';
          if (!messages[tab]) { messages[tab] = []; unread[tab] = 0; }
          switchTab(tab);
          renderTabs();
          openPanel();
        });
      }
      playersList.appendChild(el);
    });
    firePlayersChanged();
  }

  // Tabs
  function renderTabs() {
    chatTabs.innerHTML = '';
    const tabs = [{ key:'all', label:'🎲 Party' }];
    if (!isDM) tabs.push({ key:'dm', label:'👑 DM', cls:'dm-tab' });
    Object.keys(messages).forEach(k => {
      if (k!=='all' && k!=='dm' && players[k]) {
        tabs.push({ key:k, label: isDM ? `🗡️ ${players[k]}` : `💬 ${players[k]}`, cls:'pm-tab' });
      }
    });
    tabs.forEach(({ key, label, cls }) => {
      const btn = document.createElement('button');
      btn.className = 'mp-tab' + (cls ? ' '+cls : '') + (activeTab===key ? ' active' : '');
      btn.textContent = label;
      if ((unread[key]||0) > 0) {
        const dot = document.createElement('span');
        dot.className = 'mp-tab-unread';
        btn.appendChild(dot);
      }
      btn.addEventListener('click', () => switchTab(key));
      chatTabs.appendChild(btn);
    });
  }

  function switchTab(key) {
    activeTab = key;
    clearUnread(key);
    renderTabs();
    renderMessages();
    if (panelOpen) msgInput.focus();
  }

  // Messages
  function renderMessages() {
    messagesEl.innerHTML = '';
    (messages[activeTab] || []).forEach(m => messagesEl.appendChild(buildMsgEl(m)));
    messagesEl.scrollTop = messagesEl.scrollHeight;
    if (activeTab === 'all') msgInput.placeholder = 'Message the whole party…';
    else if (activeTab === 'dm') msgInput.placeholder = 'Private message to DM only…';
    else msgInput.placeholder = isDM ? `Private message to ${players[activeTab]||''}…` : `Whisper to ${players[activeTab]||''}…`;
  }

  function buildMsgEl(m) {
    const div = document.createElement('div');
    div.className = 'mp-msg' + (m.type==='sys'?' sys-msg':'') + (m.isMine?' my-msg':'') + (m.isDM?' dm-msg':'') + (m.isPM?' pm-msg':'');
    if (m.type === 'sys') {
      div.innerHTML = `<div class="mp-msg-body">${escHtml(m.text)}</div>`;
      return div;
    }
    const t = new Date(m.ts).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
    const meta = `<div class="mp-msg-meta"><span class="mp-msg-name${m.isMine?' is-me':m.isDM?' is-dm':''}">${escHtml(m.from)}</span><span class="mp-msg-time">${t}</span></div>`;
    // ── Special: DM roll request card ─────────────────────────────────
    if (typeof m.text === 'string' && m.text.startsWith('__ROLLREQ__:')) {
      let req = {};
      try { req = JSON.parse(m.text.slice('__ROLLREQ__:'.length)); } catch(e) {}
      const skill = req.skill || 'Skill';
      // Only non-DMs see a Roll button (and only if the request lands in
      // a tab they can act on — receiveChat already routed it).
      const showRollBtn = !isDM && !m.isMine;
      div.innerHTML = meta +
        `<div class="mp-rollreq-card">
          <div class="mp-rollreq-title">🎲 ROLL REQUEST</div>
          <div class="mp-rollreq-skill">${escHtml(skill)} check</div>` +
          (showRollBtn ? `<button class="mp-rollreq-roll-btn" data-skill="${escHtml(skill)}">Roll ${escHtml(skill)}</button>` : '') +
        `</div>`;
      if (showRollBtn) {
        setTimeout(() => {
          const b = div.querySelector('.mp-rollreq-roll-btn');
          if (b) b.addEventListener('click', () => {
            if (!window.arcaneAutoRollRequest || !window.arcaneSendRollResult) return;
            const r = window.arcaneAutoRollRequest(skill, true);
            window.arcaneSendRollResult(r, 'all');
            b.disabled = true; b.textContent = '✓ Rolled: ' + r.total;
          });
        }, 0);
      }
      return div;
    }
    // ── Special: item-drop card ──────────────────────────────────────
    if (typeof m.text === 'string' && m.text.startsWith('__GIVEITEM__:')) {
      let it = {};
      try { it = JSON.parse(m.text.slice('__GIVEITEM__:'.length)); } catch(e) {}
      const qty = Number(it.qty) || 1;
      const wt  = Number(it.weight) || 0;
      const meta_parts = [];
      meta_parts.push(`×${qty}`);
      if (wt > 0) meta_parts.push(`${(wt * qty).toFixed(1)} lb`);
      if (it.notes) meta_parts.push(escHtml(it.notes));
      div.innerHTML = meta +
        `<div class="mp-itemdrop-card">
          <div class="mp-itemdrop-title">🎁 ITEM GRANTED</div>
          <div class="mp-itemdrop-name">${escHtml(it.name || 'Item')}</div>
          <div class="mp-itemdrop-meta">${meta_parts.join(' · ')}</div>
        </div>`;
      return div;
    }
    // ── Special: roll result card ─────────────────────────────────────
    if (typeof m.text === 'string' && m.text.startsWith('__ROLLRES__:')) {
      let res = {};
      try { res = JSON.parse(m.text.slice('__ROLLRES__:'.length)); } catch(e) {}
      div.innerHTML = meta +
        `<div class="mp-rollres-card">
          <div class="mp-rollres-title">🎲 ${escHtml(res.skill || 'Check')} — ${escHtml(res.name || m.from)}</div>
          <div><span class="mp-rollres-total">${Number(res.total)||0}</span></div>
          <div class="mp-rollres-breakdown">${escHtml(res.breakdown || '')}</div>
        </div>`;
      return div;
    }
    div.innerHTML = meta + `<div class="mp-msg-body">${escHtml(m.text)}</div>`;
    return div;
  }

  function addSysMsg(tab, text) {
    if (!messages[tab]) messages[tab] = [];
    const m = { type:'sys', text, ts: Date.now() };
    messages[tab].push(m);
    if (activeTab === tab && panelOpen) {
      messagesEl.appendChild(buildMsgEl(m));
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  }

  function receiveChat(msg) {
    let tab;
    if (msg.to === 'all') tab = 'all';
    else if (msg.to === 'dm') tab = isDM ? msg.from_id : 'dm';
    else tab = msg.from_id === myId ? msg.to : msg.from_id;
    if (!messages[tab]) { messages[tab] = []; unread[tab] = 0; }
    const entry = { from:msg.from_name, text:msg.text, ts:msg.ts, isMine:msg.from_id===myId, isDM:msg.is_dm, isPM:msg.to!=='all' };
    messages[tab].push(entry);
    if (activeTab === tab && panelOpen) {
      messagesEl.appendChild(buildMsgEl(entry));
      messagesEl.scrollTop = messagesEl.scrollHeight;
    } else {
      unread[tab] = (unread[tab]||0) + 1;
      renderTabs();
      updateBadge();
    }
    // Auto-pop the dice-roll modal when *we* (a player, not the sender) are
    // the target of a DM roll request. Whether it's the Party-broadcast (to=all)
    // or a specific whisper (to=myId), the modal opens with the requested skill.
    if (!isDM && !entry.isMine
        && typeof msg.text === 'string'
        && msg.text.startsWith('__ROLLREQ__:')
        && (msg.to === 'all' || msg.to === myId)
        && typeof window.arcaneOpenRollRequest === 'function') {
      try {
        const req = JSON.parse(msg.text.slice('__ROLLREQ__:'.length));
        if (req && req.skill) window.arcaneOpenRollRequest(req.skill, msg.from_name);
      } catch (e) {}
    }

    // Auto-deposit an item into our inventory when DM sends one to us
    // (or to the whole party). The DM should not receive a copy — they're
    // the sender.
    if (!isDM && !entry.isMine
        && typeof msg.text === 'string'
        && msg.text.startsWith('__GIVEITEM__:')
        && (msg.to === 'all' || msg.to === myId)) {
      try {
        const it = JSON.parse(msg.text.slice('__GIVEITEM__:'.length));
        if (it && it.name && typeof window.arcaneAddItemToActive === 'function') {
          const sh = window.arcaneAddItemToActive(it);
          if (typeof window.arcaneShowItemToast === 'function') {
            window.arcaneShowItemToast(it, msg.from_name, sh && sh.name);
          }
          // Pop the sheet panel open so the player visibly sees the item
          // land in the right inventory. Defer one tick so the toast renders.
          if (sh && typeof window.arcaneOpenSheetTo === 'function') {
            setTimeout(() => window.arcaneOpenSheetTo(sh.id), 80);
          }
        } else if (it && it.name) {
          alert('Item received but no character sheet was found. ' +
                'Open 🎭 to set up a character.');
        }
      } catch (e) {
        alert('Failed to receive item: ' + e.message);
      }
    }
  }

  function clearUnread(tab) { unread[tab] = 0; }
  function updateBadge() {
    const total = Object.values(unread).reduce((a,b)=>a+b,0);
    badge.style.display = total > 0 ? 'inline' : 'none';
  }

  // Send message
  async function sendMessage() {
    const text = msgInput.value.trim();
    if (!text || !roomCode) return;
    const to = activeTab==='all' ? 'all' : activeTab==='dm' ? 'dm' : activeTab;
    msgInput.value = '';
    try {
      await api('/api/send_message', { room:roomCode, player_id:myId, to, text });
    } catch(e) {
      joinErr.textContent = 'Failed to send message.';
      joinErr.style.display = 'block';
    }
  }
  document.getElementById('mp-send-btn').addEventListener('click', sendMessage);
  msgInput.addEventListener('keydown', e => { if (e.key==='Enter') sendMessage(); });

  // Copy code
  codeDisplay.addEventListener('click', () => {
    navigator.clipboard?.writeText(roomCode).catch(()=>{});
  });

  // ── DM-only: tunnel URL + shareable "Player Link" ────────────
  const HOSTED_CLIENT_URL = 'https://noahmarc.github.io/arcaneoverlay/';
  const TUNNEL_KEY = 'arcane_mp_tunnel_url';
  const tunnelIn   = document.getElementById('mp-tunnel-url');
  const copyLinkBtn= document.getElementById('mp-copy-link-btn');
  const linkPreview= document.getElementById('mp-link-preview');

  function normaliseTunnel(s) {
    s = (s || '').trim().replace(/\/+$/, '');
    if (s && !/^https?:\/\//i.test(s)) s = 'https://' + s;
    return s;
  }
  function buildPlayerLink() {
    const t = normaliseTunnel(tunnelIn.value);
    const u = new URL(HOSTED_CLIENT_URL);
    if (t) u.searchParams.set('server', t);
    if (roomCode) u.searchParams.set('room', roomCode);
    return u.toString();
  }
  function updateLinkPreview() {
    if (!linkPreview) return;
    const url = buildPlayerLink();
    linkPreview.textContent = url;
  }

  // Restore last-used tunnel URL
  try {
    const saved = localStorage.getItem(TUNNEL_KEY);
    if (saved && tunnelIn) tunnelIn.value = saved;
  } catch (e) {}

  if (tunnelIn) {
    tunnelIn.addEventListener('input', () => {
      try { localStorage.setItem(TUNNEL_KEY, tunnelIn.value.trim()); } catch (e) {}
      updateLinkPreview();
    });
    tunnelIn.addEventListener('blur', () => {
      const n = normaliseTunnel(tunnelIn.value);
      if (n !== tunnelIn.value) tunnelIn.value = n;
      try { localStorage.setItem(TUNNEL_KEY, n); } catch (e) {}
      updateLinkPreview();
    });
  }

  // ── One-click tunnel start/stop (DM only) ─────────────────────
  // Talks to the Swift wrapper via window.webkit.messageHandlers.tunnel.
  // Swift launches cloudflared, reads its stdout, and calls back into JS
  // via arcaneOnTunnelUrl(url) / arcaneOnTunnelStatus({starting,error}).
  const tunnelToggleBtn = document.getElementById('mp-tunnel-toggle-btn');
  const tunnelStatusEl  = document.getElementById('mp-tunnel-status');

  function tunnelBridge() {
    return window.webkit && window.webkit.messageHandlers
      && window.webkit.messageHandlers.tunnel
      ? window.webkit.messageHandlers.tunnel
      : null;
  }
  function setTunnelButton(state, text) {
    if (!tunnelToggleBtn) return;
    tunnelToggleBtn.classList.remove('active', 'starting');
    if (state === 'active')   tunnelToggleBtn.classList.add('active');
    if (state === 'starting') tunnelToggleBtn.classList.add('starting');
    tunnelToggleBtn.textContent = text;
  }
  if (tunnelToggleBtn) {
    if (!tunnelBridge()) {
      // Running in a regular browser (hosted page) — there's no Swift
      // wrapper to launch cloudflared. Hide the button and let the DM
      // paste a URL manually.
      tunnelToggleBtn.style.display = 'none';
      if (tunnelIn) tunnelIn.placeholder = 'https://example.trycloudflare.com';
    } else {
      tunnelToggleBtn.addEventListener('click', () => {
        const isActive = tunnelToggleBtn.classList.contains('active');
        const isStarting = tunnelToggleBtn.classList.contains('starting');
        if (isStarting) return;
        if (isActive) {
          tunnelBridge().postMessage({ action: 'stop' });
        } else {
          setTunnelButton('starting', '⏳ Starting…');
          if (tunnelStatusEl) {
            tunnelStatusEl.classList.remove('error');
            tunnelStatusEl.textContent = 'Connecting to Cloudflare… this can take 5-15 seconds.';
          }
          tunnelBridge().postMessage({ action: 'start' });
        }
      });
    }
  }

  // Called by Swift when cloudflared prints a fresh trycloudflare URL.
  window.arcaneOnTunnelUrl = (url) => {
    if (!tunnelIn) return;
    if (url) {
      tunnelIn.value = url;
      try { localStorage.setItem(TUNNEL_KEY, url); } catch (e) {}
      setTunnelButton('active', '⏹ Stop Tunnel');
      if (tunnelStatusEl) {
        tunnelStatusEl.classList.remove('error');
        tunnelStatusEl.textContent = '✓ Tunnel live — click Copy Player Link to share';
      }
    } else {
      // Tunnel was stopped
      setTunnelButton('', '▶ Start Tunnel');
      if (tunnelStatusEl) {
        tunnelStatusEl.classList.remove('error');
        tunnelStatusEl.textContent = '';
      }
    }
    updateLinkPreview();
  };
  // Called by Swift to report start failures or "starting…" state.
  window.arcaneOnTunnelStatus = (info) => {
    if (!info) return;
    if (info.error) {
      setTunnelButton('', '▶ Start Tunnel');
      if (tunnelStatusEl) {
        tunnelStatusEl.classList.add('error');
        tunnelStatusEl.textContent = info.error;
      }
    } else if (info.starting) {
      setTunnelButton('starting', '⏳ Starting…');
    }
  };

  if (copyLinkBtn) {
    copyLinkBtn.addEventListener('click', async () => {
      const url = buildPlayerLink();
      try {
        await navigator.clipboard.writeText(url);
        const orig = copyLinkBtn.textContent;
        copyLinkBtn.textContent = '✓ Copied';
        setTimeout(() => { copyLinkBtn.textContent = orig; }, 1500);
      } catch (e) {
        // Fallback: select + execCommand
        const ta = document.createElement('textarea');
        ta.value = url; document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); } catch (_) {}
        document.body.removeChild(ta);
        copyLinkBtn.textContent = '✓ Copied';
        setTimeout(() => { copyLinkBtn.textContent = '📋 Copy Player Link'; }, 1500);
      }
    });
  }

  // Refresh the preview whenever a room is entered
  const _origUpdatePreview = updateLinkPreview;
  window.__mpRefreshPlayerLink = _origUpdatePreview;

  // Create room
  document.getElementById('mp-create-btn').addEventListener('click', () => {
    document.getElementById('mp-dm-modal').classList.add('open');
    setTimeout(() => document.getElementById('mp-dm-name').focus(), 50);
  });
  document.getElementById('mp-dm-ok').addEventListener('click', async () => {
    const roomName = document.getElementById('mp-room-name').value.trim() || 'Adventure';
    const name     = document.getElementById('mp-dm-name').value.trim()  || 'Dungeon Master';
    document.getElementById('mp-dm-modal').classList.remove('open');
    joinErr.textContent = 'Creating room…';
    joinErr.style.display = 'block';
    try {
      const data = await api('/api/create_room', { name, room_name: roomName });
      if (!data.ok) throw new Error(data.error || 'Failed');
      myId = data.player_id; myName = data.name; isDM = true;
      roomCode = data.room; players = data.players; dmId = data.dm_id;
      document.getElementById('mp-panel-title').textContent = '⚔️ ' + escHtml(data.room_name || roomName);
      joinErr.style.display = 'none';
      enterRoom();
    } catch(e) {
      joinErr.textContent = 'Could not reach server. Is server.py running? Error: ' + e.message;
      joinErr.style.display = 'block';
    }
  });
  document.getElementById('mp-room-name').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('mp-dm-name').focus();
  });
  document.getElementById('mp-dm-name').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('mp-dm-ok').click();
  });
  document.getElementById('mp-dm-cancel').addEventListener('click', () => {
    document.getElementById('mp-dm-modal').classList.remove('open');
  });

  // ── LAN discovery ──────────────────────────────────────────────────
  function fetchTimeout(url, ms) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(t));
  }

  async function getLocalIP() {
    return new Promise(resolve => {
      try {
        const pc = new RTCPeerConnection({ iceServers: [] });
        pc.createDataChannel('');
        pc.createOffer().then(o => pc.setLocalDescription(o));
        const timer = setTimeout(() => { pc.close(); resolve(null); }, 2000);
        pc.onicecandidate = e => {
          if (!e.candidate) return;
          const m = e.candidate.candidate.match(/(\d+\.\d+\.\d+)\.\d+/);
          if (m && !e.candidate.candidate.includes('host') === false) {
            clearTimeout(timer); pc.close(); resolve(m[1]);
          }
        };
      } catch(e) { resolve(null); }
    });
  }

  async function scanSubnet(subnet, code) {
    const batch = [];
    for (let i = 1; i <= 254; i++) {
      const url = `http://${subnet}.${i}:8765/api/find_room?code=${encodeURIComponent(code)}`;
      batch.push(
        fetchTimeout(url, 600)
          .then(r => r.json())
          .then(d => d.ok ? `http://${subnet}.${i}:8765` : null)
          .catch(() => null)
      );
    }
    const results = await Promise.all(batch);
    return results.find(r => r) || null;
  }

  async function discoverServer(code, onStatus) {
    // 0. Configured server first — the hosted Render URL by default, or
    //    a ?server=… URL param / saved localStorage value when set.
    if (SERVER && SERVER !== 'http://localhost:8765') {
      const isHosted = SERVER === HOSTED_SERVER;
      onStatus(isHosted
        ? 'Connecting… (server may take ~30s to wake up)'
        : 'Trying configured server…');
      try {
        // Render free tier can sleep for up to a minute before responding.
        const r = await fetchTimeout(
          `${SERVER}/api/find_room?code=${encodeURIComponent(code)}`, 70000);
        const d = await r.json();
        if (d.ok) return SERVER;
      } catch(e) { /* fall through to LAN discovery */ }
    }

    // 1. Same machine (legacy fallback for local-only sessions)
    onStatus('Searching… (localhost)');
    try {
      const r = await fetchTimeout(`http://localhost:8765/api/find_room?code=${encodeURIComponent(code)}`, 800);
      const d = await r.json();
      if (d.ok) return 'http://localhost:8765';
    } catch(e) {}

    // 2. Detect local subnet via WebRTC
    onStatus('Detecting network…');
    const subnet = await getLocalIP();
    if (subnet) {
      onStatus(`Scanning ${subnet}.0/24…`);
      const found = await scanSubnet(subnet, code);
      if (found) return found;
    }

    // 3. Common subnets fallback
    for (const s of ['192.168.1','192.168.0','10.0.0','10.0.1','172.16.0']) {
      if (s === subnet) continue;
      onStatus(`Scanning ${s}.0/24…`);
      const found = await scanSubnet(s, code);
      if (found) return found;
    }
    return null;
  }

  // Join room
  document.getElementById('mp-join-btn').addEventListener('click', async () => {
    const code = document.getElementById('mp-code-in').value.trim().toUpperCase();
    const name = document.getElementById('mp-name-in').value.trim() || 'Adventurer';
    joinErr.style.color = '';
    joinErr.style.display = 'none';
    if (!code) { joinErr.textContent = 'Enter a room code.'; joinErr.style.display='block'; return; }

    joinErr.textContent = 'Searching for room…';
    joinErr.style.display = 'block';

    const serverUrl = await discoverServer(code, msg => {
      joinErr.textContent = msg;
      joinErr.style.display = 'block';
    });

    if (!serverUrl) {
      joinErr.textContent = '❌ Room not found on this network. Make sure you\'re on the same WiFi as the DM.';
      joinErr.style.display = 'block';
      return;
    }

    SERVER = serverUrl;
    joinErr.textContent = 'Joining…';
    try {
      const data = await api('/api/join_room', { room:code, name });
      if (!data.ok) throw new Error(data.error || 'Failed');
      myId = data.player_id; myName = data.name; isDM = false;
      roomCode = data.room; players = data.players; dmId = data.dm_id;
      document.getElementById('mp-panel-title').textContent = '⚔️ ' + escHtml(data.room_name || code);
      joinErr.style.display = 'none';
      enterRoom();
      // Mirror whatever the DM is currently projecting
      if (data.grid_state && typeof window.__applyMpGridState === 'function') {
        try { window.__applyMpGridState(data.grid_state); } catch(e) {}
      }
    } catch(e) {
      joinErr.textContent = '❌ Error joining: ' + e.message;
      joinErr.style.display = 'block';
    }
  });
  document.getElementById('mp-code-in').addEventListener('keydown', e => { if(e.key==='Enter') document.getElementById('mp-name-in').focus(); });
  document.getElementById('mp-name-in').addEventListener('keydown', e => { if(e.key==='Enter') document.getElementById('mp-join-btn').click(); });

  // Pre-fill the room code from ?room=… in the URL (used by the DM's
  // shareable player link). Auto-opens the MP panel so the player can
  // just type a name and press Enter to join.
  try {
    const q = new URLSearchParams(window.location.search);
    const roomFromUrl = (q.get('room') || '').trim().toUpperCase();
    if (roomFromUrl) {
      const codeIn = document.getElementById('mp-code-in');
      const nameIn = document.getElementById('mp-name-in');
      if (codeIn) codeIn.value = roomFromUrl;
      // Defer panel-open until the page is ready
      setTimeout(() => {
        if (typeof openPanel === 'function') openPanel();
        if (nameIn) nameIn.focus();
      }, 200);
    }
  } catch (e) {}

  // Leave room
  document.getElementById('mp-leave-btn').addEventListener('click', async () => {
    stopPoll();
    if (roomCode && myId) {
      try { await api('/api/leave', {room:roomCode, player_id:myId}); } catch(e) {}
    }
    myId = myName = roomCode = dmId = null;
    players = {}; isDM = false; messages = {}; unread = {};
    roomDiv.style.display = 'none';
    setupDiv.style.display = 'block';
    updateBadge();
    // Restore full toolbar on leave
    document.body.classList.remove('player-restricted');
  });

  function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── Expose to dice roller ──────────────────────────────────────────
  // ── "Playing as" picker (which character handles your rolls) ──
  const activeSheetSel = document.getElementById('mp-active-sheet');
  function refreshActiveSheetPicker() {
    if (!activeSheetSel || !window.arcaneSheets) return;
    const sheets = window.arcaneSheets();
    const curId  = window.arcaneMpSheetId ? window.arcaneMpSheetId() : null;
    activeSheetSel.innerHTML = '';
    sheets.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id;
      const cls = (s.cls || '').trim();
      const nm  = (s.name || '').trim() || 'Unnamed';
      opt.textContent = cls ? `${nm} (Lv${s.level} ${cls})` : `${nm} (Lv${s.level})`;
      activeSheetSel.appendChild(opt);
    });
    // Default selection: stored MP id, or first sheet
    if (curId && sheets.some(s => s.id === curId)) {
      activeSheetSel.value = curId;
    } else if (sheets[0]) {
      activeSheetSel.value = sheets[0].id;
      if (window.arcaneSetMpSheetId) window.arcaneSetMpSheetId(sheets[0].id);
    }
  }
  if (activeSheetSel) {
    activeSheetSel.addEventListener('change', () => {
      if (window.arcaneSetMpSheetId) window.arcaneSetMpSheetId(activeSheetSel.value);
    });
  }
  // Refresh whenever the character-sheet store changes (new/delete/save)
  if (window.arcaneOnSheetsChanged) window.arcaneOnSheetsChanged(refreshActiveSheetPicker);
  // Initial population (in case the panel is opened before joining a room)
  refreshActiveSheetPicker();

  // Expose helpers for the grid-sync IIFE
  window.__mpApi    = api;
  window.__mpRoom   = () => roomCode;
  window.__mpMyId   = () => myId;
  window.__mpIsDM   = () => isDM;
  window.mpInRoom    = () => !!roomCode;
  window.mpIsDM      = () => isDM;
  window.mpActiveTab = () => {
    if (activeTab === 'all') return 'all';
    if (activeTab === 'dm')  return 'dm';
    return activeTab; // a player-id
  };
  // Programmatically switch chat tabs (used by DM roll-request feedback)
  window.mpSwitchTab = (tab) => {
    if (typeof switchTab !== 'function') return;
    if (!messages[tab]) { messages[tab] = []; unread[tab] = 0; }
    switchTab(tab);
    renderTabs();
    openPanel?.();
  };
  // Snapshot of the current room state for the sheet IIFE
  window.mpPlayers = () => {
    const out = {};
    Object.entries(players).forEach(([id, name]) => { out[id] = name; });
    return { dmId, myId, players: out };
  };
  // Hook the sheet IIFE can register a callback into to refresh its dropdown
  window.mpOnPlayersChanged = (fn) => { _onPlayersChangedHooks.push(fn); };
  window.mpSend = (text, to) => {
    if (!roomCode || !myId) return false;
    api('/api/send_message', { room: roomCode, player_id: myId, to: to || 'all', text });
    // Echo locally
    const tab = to === 'all' ? 'all' : to === 'dm' ? (isDM ? 'all' : 'dm') : to;
    if (!messages[tab]) { messages[tab] = []; unread[tab] = 0; }
    const entry = { from: myName, text, ts: Date.now(), isMine: true, isDM, isPM: to !== 'all' };
    messages[tab].push(entry);
    if (activeTab === tab && panelOpen) {
      messagesEl.appendChild(buildMsgEl(entry));
      messagesEl.scrollTop = messagesEl.scrollHeight;
    } else if (activeTab !== tab) {
      unread[tab] = (unread[tab] || 0) + 1;
      renderTabs(); updateBadge();
    }
    return true;
  };

})();

// ══════════════════════════════════════════════════════════════════════
// DICE ROLLER
// ══════════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  let sides    = 20;
  let count    = 1;
  let mod      = 0;
  let rolling  = false;
  let lastRoll = null;

  // ── Presets (persisted in localStorage) ───────────────────────────
  const PRESET_KEY = 'arcane_dice_presets';
  let presets = (() => {
    try { return JSON.parse(localStorage.getItem(PRESET_KEY)) || []; } catch(e) { return []; }
  })();
  if (!presets[0]) presets[0] = { name: 'Enchantment 1', value: 0, active: false };
  if (!presets[1]) presets[1] = { name: 'Enchantment 2', value: 0, active: false };

  function savePresets() { localStorage.setItem(PRESET_KEY, JSON.stringify(presets)); }

  function renderPreset(idx) {
    const p   = presets[idx];
    const el  = document.getElementById(`dr-preset-${idx}`);
    const nameEl = el.querySelector('.dr-preset-name');
    const valEl  = el.querySelector('.dr-preset-val');
    nameEl.textContent = p.name;
    valEl.textContent  = (p.value >= 0 ? '+' : '') + p.value;
    el.classList.toggle('active', p.active);
  }

  function initPresets() {
    [0, 1].forEach(idx => {
      renderPreset(idx);
      const el = document.getElementById(`dr-preset-${idx}`);

      // Toggle active by clicking the card (not the edit/save buttons)
      el.querySelector('.dr-preset-view').addEventListener('click', e => {
        if (e.target.classList.contains('dr-preset-edit')) return;
        presets[idx].active = !presets[idx].active;
        savePresets();
        renderPreset(idx);
      });

      // Edit button — show inline form
      el.querySelector('.dr-preset-edit').addEventListener('click', e => {
        e.stopPropagation();
        const view = el.querySelector('.dr-preset-view');
        const form = el.querySelector('.dr-preset-form');
        el.querySelector('.dr-preset-name-in').value = presets[idx].name;
        el.querySelector('.dr-preset-val-in').value  = presets[idx].value;
        view.style.display = 'none';
        form.style.display = 'flex';
        el.querySelector('.dr-preset-name-in').focus();
      });

      // Save button
      el.querySelector('.dr-preset-save').addEventListener('click', () => {
        const nameIn = el.querySelector('.dr-preset-name-in');
        const valIn  = el.querySelector('.dr-preset-val-in');
        presets[idx].name  = nameIn.value.trim() || `Enchantment ${idx + 1}`;
        presets[idx].value = parseInt(valIn.value) || 0;
        savePresets();
        el.querySelector('.dr-preset-view').style.display = 'flex';
        el.querySelector('.dr-preset-form').style.display = 'none';
        renderPreset(idx);
      });

      // Enter to save
      el.querySelector('.dr-preset-name-in').addEventListener('keydown', e => {
        if (e.key === 'Enter') el.querySelector('.dr-preset-val-in').focus();
      });
      el.querySelector('.dr-preset-val-in').addEventListener('keydown', e => {
        if (e.key === 'Enter') el.querySelector('.dr-preset-save').click();
      });
    });
  }

  const overlay  = document.getElementById('dice-overlay');
  const diceBtn  = document.getElementById('dice-btn');
  const rollsEl  = document.getElementById('dr-rolls');
  const totalEl  = document.getElementById('dr-total');
  const formulaEl= document.getElementById('dr-formula');
  const shareEl  = document.getElementById('dr-share');
  const countEl  = document.getElementById('dr-count');
  const labelEl  = document.getElementById('dr-label');
  const modInput = document.getElementById('dr-mod');

  initPresets();

  // Open / close
  diceBtn.addEventListener('click', () => overlay.classList.toggle('open'));
  document.getElementById('dr-close').addEventListener('click', () => overlay.classList.remove('open'));
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.classList.remove('open'); });

  // Die selection
  document.querySelectorAll('.dr-die').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.dr-die').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      sides = parseInt(btn.dataset.sides);
      labelEl.textContent = 'd' + sides;
    });
  });

  // Count
  document.getElementById('dr-dec').addEventListener('click', () => {
    if (count > 1) { count--; countEl.textContent = count; }
  });
  document.getElementById('dr-inc').addEventListener('click', () => {
    if (count < 20) { count++; countEl.textContent = count; }
  });

  // Modifier
  modInput.addEventListener('input', () => { mod = parseInt(modInput.value) || 0; });

  // Roll
  function doRoll() {
    if (rolling) return;
    rolling = true;
    shareEl.style.display = 'none';

    const rolled     = Array.from({ length: count }, () => Math.floor(Math.random() * sides) + 1);
    const sum        = rolled.reduce((a, b) => a + b, 0);
    const presetMod  = presets.filter(p => p.active).reduce((a, p) => a + p.value, 0);
    const totalMod   = mod + presetMod;
    const total      = sum + totalMod;
    lastRoll = { rolled, sum, total, sides, count, mod: totalMod, presets: presets.filter(p => p.active) };

    // Animate
    const result = document.getElementById('dr-result');
    result.classList.remove('done');
    totalEl.textContent   = '?';
    rollsEl.textContent   = '';
    formulaEl.textContent = '';

    let ticks = 0;
    const anim = setInterval(() => {
      const fake = Array.from({ length: count }, () => Math.floor(Math.random() * sides) + 1);
      totalEl.textContent = fake.reduce((a,b)=>a+b,0) + totalMod;
      ticks++;
      if (ticks >= 14) {
        clearInterval(anim);
        totalEl.textContent = total;
        rollsEl.textContent = count > 1 ? rolled.join('  +  ') : '';

        // Build formula line
        let f = `${count}d${sides}`;
        if (mod !== 0) f += (mod > 0 ? ` + ${mod}` : ` − ${Math.abs(mod)}`);
        presets.filter(p => p.active).forEach(p => {
          f += p.value >= 0 ? ` + ${p.value}` : ` − ${Math.abs(p.value)}`;
          f += ` (${p.name})`;
        });
        if (totalMod !== 0 || count > 1) f += `  =  ${total}`;
        formulaEl.textContent = f;

        result.classList.add('done');
        rolling = false;
        shareEl.style.display = (window.mpInRoom && window.mpInRoom()) ? 'flex' : 'none';
      }
    }, 55);
  }

  document.getElementById('dr-roll').addEventListener('click', doRoll);

  // Keyboard shortcut: Enter inside overlay
  overlay.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.target.matches('input')) doRoll(); });

  // Share helpers
  function rollText() {
    const { rolled, total, sides, count, mod, presets: activePresets } = lastRoll;
    let msg = `🎲 ${count}d${sides}`;
    if (mod !== 0) msg += (mod > 0 ? `+${mod}` : `${mod}`);
    if (activePresets && activePresets.length) {
      msg += ' (' + activePresets.map(p => `${p.name}: ${p.value >= 0 ? '+' : ''}${p.value}`).join(', ') + ')';
    }
    if (count > 1) msg += ` [${rolled.join(', ')}]`;
    msg += ` → ${total}`;
    return msg;
  }

  document.getElementById('dr-send-party').addEventListener('click', () => {
    if (!lastRoll || !window.mpSend) return;
    window.mpSend(rollText(), 'all');
    overlay.classList.remove('open');
  });
  document.getElementById('dr-send-dm').addEventListener('click', () => {
    if (!lastRoll || !window.mpSend) return;
    window.mpSend(rollText(), 'dm');
    overlay.classList.remove('open');
  });

})();

// ═══════════════════════════════════════════════════════════════════
// 4e CHARACTER SHEET — player stats, skill rolling, DM roll requests
// ═══════════════════════════════════════════════════════════════════
(function () {
  // 4e skill list with their key ability
  const SKILLS_4E = [
    ['Acrobatics',   'DEX'],
    ['Arcana',       'INT'],
    ['Athletics',    'STR'],
    ['Bluff',        'CHA'],
    ['Diplomacy',    'CHA'],
    ['Dungeoneering','WIS'],
    ['Endurance',    'CON'],
    ['Heal',         'WIS'],
    ['History',      'INT'],
    ['Insight',      'WIS'],
    ['Intimidate',   'CHA'],
    ['Nature',       'WIS'],
    ['Perception',   'WIS'],
    ['Religion',     'INT'],
    ['Stealth',      'DEX'],
    ['Streetwise',   'CHA'],
    ['Thievery',     'DEX'],
  ];
  const ABILS = ['STR','CON','DEX','INT','WIS','CHA'];

  const STORAGE_KEY_OLD = 'arcane_4e_sheet_v1';     // legacy single sheet
  const STORAGE_KEY     = 'arcane_4e_sheets_v2';    // { sheets:{id:sheet}, activeId }
  const MP_SHEET_KEY    = 'arcane_4e_mp_sheet_id';  // which sheet is "active" in MP sessions

  function makeId() {
    return 'sh_' + Math.random().toString(36).slice(2, 9);
  }

  function defaultSheet(name) {
    return {
      id: makeId(),
      name: name || '', level: 1, cls: '', race: '',
      abilities: { STR:10, CON:10, DEX:10, INT:10, WIS:10, CHA:10 },
      defenses:  { AC:10, Fort:10, Ref:10, Will:10 },
      hp: 0, maxhp: 0, surges: 0,
      trained: [],     // skill names
      inventory: [],   // [{id, name, qty, weight, equipped, notes}]
      vision: 'normal', // 'normal' | 'lowlight' | 'darkvision'
    };
  }
  function makeItemId() { return 'it_' + Math.random().toString(36).slice(2, 9); }

  // ── Multi-sheet store ───────────────────────────────────────
  let store = loadStore();
  function loadStore() {
    // Try new format
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const obj = JSON.parse(raw);
        if (obj && obj.sheets && Object.keys(obj.sheets).length) {
          // Patch missing fields on each sheet
          Object.values(obj.sheets).forEach(s => {
            Object.assign(s, Object.assign(defaultSheet(), s));
          });
          if (!obj.activeId || !obj.sheets[obj.activeId]) {
            obj.activeId = Object.keys(obj.sheets)[0];
          }
          return obj;
        }
      }
    } catch (e) {}
    // Try migrating from legacy single-sheet
    try {
      const oldRaw = localStorage.getItem(STORAGE_KEY_OLD);
      if (oldRaw) {
        const oldSheet = Object.assign(defaultSheet(), JSON.parse(oldRaw));
        if (!oldSheet.id) oldSheet.id = makeId();
        const s = { sheets: { [oldSheet.id]: oldSheet }, activeId: oldSheet.id };
        return s;
      }
    } catch (e) {}
    // Fresh defaults
    const def = defaultSheet();
    return { sheets: { [def.id]: def }, activeId: def.id };
  }
  function saveStore() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(store)); } catch (e) {}
  }

  function activeSheet() { return store.sheets[store.activeId]; }
  // Backward-compatible alias the rest of the code uses
  let sheet = activeSheet();
  function setActive(id) {
    if (!store.sheets[id]) return;
    store.activeId = id;
    sheet = store.sheets[id];
    saveStore();
  }
  function saveSheet() { saveStore(); }

  // ── MP-active sheet selection ───────────────────────────────
  // Players pick which character handles their rolls in multiplayer
  // sessions. Persisted separately so it survives sheet switches in
  // the editor panel.
  function loadMpSheetId() {
    try { return localStorage.getItem(MP_SHEET_KEY) || null; }
    catch (e) { return null; }
  }
  function saveMpSheetId(id) {
    try {
      if (id) localStorage.setItem(MP_SHEET_KEY, id);
      else    localStorage.removeItem(MP_SHEET_KEY);
    } catch (e) {}
  }
  let mpSheetId = loadMpSheetId();
  function mpActiveSheet() {
    if (mpSheetId && store.sheets[mpSheetId]) return store.sheets[mpSheetId];
    return activeSheet(); // fallback: whatever's selected in the editor
  }
  // Use the MP-selected sheet whenever multiplayer code asks for "the sheet"
  window.arcaneSheet  = () => mpActiveSheet();
  window.arcaneSheets = () => Object.values(store.sheets);
  // Save the whole sheets store to localStorage (used by pickup flow).
  window.__arcaneSaveSheets = saveStore;
  // Refresh the inventory list in the open sheet panel (used by pickup flow).
  window.arcaneRefreshInventory = function () {
    try { if (typeof renderInventory === 'function') renderInventory(); } catch (e) {}
  };

  // Add a granted item to the player's MP-active sheet's inventory.
  // Used by the chat layer when a __GIVEITEM__ message arrives.
  window.arcaneAddItemToActive = function (item) {
    if (!item || !item.name) return null;
    const sh = mpActiveSheet();
    if (!sh) return null;
    if (!Array.isArray(sh.inventory)) sh.inventory = [];
    // Stack identical entries by name (same case, same weight, same notes)
    const stack = sh.inventory.find(x =>
      x.name === item.name &&
      (Number(x.weight) || 0) === (Number(item.weight) || 0) &&
      (x.notes || '') === (item.notes || '')
    );
    if (stack) {
      stack.qty = (Number(stack.qty) || 0) + (Number(item.qty) || 1);
    } else {
      sh.inventory.push({
        id: 'it_' + Math.random().toString(36).slice(2, 9),
        name:     String(item.name).slice(0, 80),
        qty:      Math.max(1, Number(item.qty) || 1),
        weight:   Math.max(0, Number(item.weight) || 0),
        equipped: false,
        notes:    String(item.notes || '').slice(0, 400),
      });
    }
    saveStore();
    // Surface the new item: if the editor is open showing a different
    // sheet, switch it to the one that just received the item so the
    // player can actually see the inventory update.
    if (overlay && overlay.classList.contains('open')) {
      if (sh !== sheet) {
        try { pushFormToSheet?.(); } catch (e) {}
        setActive(sh.id);
        refreshSheetList?.();
        fillForm?.();
      } else {
        renderInventory?.();
      }
    }
    return sh;
  };
  window.arcaneSetMpSheetId = (id) => {
    if (id && store.sheets[id]) { mpSheetId = id; saveMpSheetId(id); }
    else { mpSheetId = null; saveMpSheetId(null); }
  };
  window.arcaneMpSheetId = () => mpSheetId;
  window.arcaneOnSheetsChanged = (fn) => { _onSheetsChanged.push(fn); };
  const _onSheetsChanged = [];
  function fireSheetsChanged() {
    _onSheetsChanged.forEach(fn => { try { fn(); } catch(e) {} });
  }

  // ── Math helpers ──────────────────────────────────────────────
  function modOf(score) { return Math.floor((Number(score) - 10) / 2); }
  function halfLevel(s) { return Math.floor(Number(s.level || 1) / 2); }
  function skillModFor(s, skillName) {
    const entry = SKILLS_4E.find(([n]) => n === skillName);
    if (!entry) return 0;
    const ability = entry[1];
    return modOf(s.abilities[ability]) + halfLevel(s) + (s.trained.includes(skillName) ? 5 : 0);
  }
  function rollSkill(s, skillName) {
    const d20 = Math.floor(Math.random() * 20) + 1;
    const mod = skillModFor(s, skillName);
    const entry = SKILLS_4E.find(([n]) => n === skillName);
    const ability = entry ? entry[1] : '';
    return {
      skill: skillName,
      ability,
      d20, mod,
      total: d20 + mod,
      breakdown: `d20[${d20}] + ${ability}(${modOf(s.abilities[ability]||10)}) + ½lvl(${halfLevel(s)})${s.trained.includes(skillName) ? ' + trained(5)' : ''} = ${d20+mod}`,
      name: s.name || 'Unknown',
    };
  }
  window.arcaneRollSkill = (skillName) => rollSkill(mpActiveSheet(), skillName);

  // ── DOM refs ──────────────────────────────────────────────────
  const btn       = document.getElementById('sheet-btn');
  const overlay   = document.getElementById('sheet-overlay');
  const closeBtn  = document.getElementById('sheet-close-btn');
  const saveBtn   = document.getElementById('sheet-save-btn');
  const resetBtn  = document.getElementById('sheet-reset-btn');
  const skillsBox = document.getElementById('sh-skills');
  const resultBox = document.getElementById('sh-result');

  function openOverlay() {
    refreshSheetList();
    fillForm();
    overlay.classList.add('open');
  }
  function closeOverlay() { overlay.classList.remove('open'); resultBox.style.display='none'; }
  btn.addEventListener('click', openOverlay);
  closeBtn.addEventListener('click', closeOverlay);
  overlay.addEventListener('click', e => { if (e.target === overlay) closeOverlay(); });

  // Open the sheet panel switched to a specific sheet (used by the chat
  // layer when an item is received so the player visibly sees the drop).
  window.arcaneOpenSheetTo = function (sheetId) {
    if (!sheetId || !store.sheets[sheetId]) return;
    // Save any pending edits to the currently-shown sheet
    try { if (overlay.classList.contains('open')) pushFormToSheet(); } catch (e) {}
    setActive(sheetId);
    openOverlay();
  };

  // ── Sheet-switcher UI ──────────────────────────────────────
  const selectEl   = document.getElementById('sh-active-select');
  const newBtn     = document.getElementById('sh-new-btn');
  const delBtn     = document.getElementById('sh-delete-btn');

  function sheetLabel(s) {
    const name = (s.name || '').trim() || 'Unnamed';
    const cls  = (s.cls  || '').trim();
    return cls ? `${name} (Lv${s.level} ${cls})` : `${name} (Lv${s.level})`;
  }
  function refreshSheetList() {
    selectEl.innerHTML = '';
    Object.values(store.sheets).forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = sheetLabel(s);
      if (s.id === store.activeId) opt.selected = true;
      selectEl.appendChild(opt);
    });
    delBtn.disabled = (Object.keys(store.sheets).length <= 1);
    delBtn.style.opacity = delBtn.disabled ? 0.4 : 1;
  }
  selectEl.addEventListener('change', () => {
    // Capture any pending edits to the *current* sheet first
    pushFormToSheet();
    saveStore();
    setActive(selectEl.value);
    fillForm();
  });
  newBtn.addEventListener('click', () => {
    const name = prompt('New character name?', 'New Hero');
    if (name === null) return; // cancelled
    pushFormToSheet();          // save edits to previous sheet
    const ns = defaultSheet(name.trim() || 'New Hero');
    store.sheets[ns.id] = ns;
    setActive(ns.id);
    refreshSheetList();
    fillForm();
    fireSheetsChanged();
  });
  delBtn.addEventListener('click', () => {
    if (Object.keys(store.sheets).length <= 1) return;
    const cur = activeSheet();
    if (!confirm(`Delete character "${cur.name || 'Unnamed'}"? This cannot be undone.`)) return;
    delete store.sheets[cur.id];
    // If this was the MP-active sheet, clear that pointer
    if (mpSheetId === cur.id) { mpSheetId = null; saveMpSheetId(null); }
    // Pick another sheet as active
    const nextId = Object.keys(store.sheets)[0];
    setActive(nextId);
    refreshSheetList();
    fillForm();
    fireSheetsChanged();
  });

  // ── Fill the form from current sheet ──────────────────────────
  function fillForm() {
    document.getElementById('sh-name').value = sheet.name || '';
    document.getElementById('sh-level').value = sheet.level || 1;
    document.getElementById('sh-class').value = sheet.cls || '';
    document.getElementById('sh-race').value = sheet.race || '';
    ABILS.forEach(a => {
      document.querySelector(`#sh-abilities input[data-abi="${a}"]`).value = sheet.abilities[a];
      document.querySelector(`#sh-abilities .sh-mod[data-mod="${a}"]`).textContent = fmtMod(modOf(sheet.abilities[a]));
    });
    document.getElementById('sh-AC').value   = sheet.defenses.AC;
    document.getElementById('sh-Fort').value = sheet.defenses.Fort;
    document.getElementById('sh-Ref').value  = sheet.defenses.Ref;
    document.getElementById('sh-Will').value = sheet.defenses.Will;
    document.getElementById('sh-hp').value    = sheet.hp;
    document.getElementById('sh-maxhp').value = sheet.maxhp;
    document.getElementById('sh-surges').value= sheet.surges;
    const visSel = document.getElementById('sh-vision');
    if (visSel) visSel.value = sheet.vision || 'normal';
    renderSkills();
    renderInventory();
  }

  function fmtMod(n) { return (n >= 0 ? '+' : '') + n; }

  // ── Skills list ───────────────────────────────────────────────
  function renderSkills() {
    skillsBox.innerHTML = '';
    SKILLS_4E.forEach(([name, abi]) => {
      const isTrained = sheet.trained.includes(name);
      const mod = skillModFor(sheet, name);
      const row = document.createElement('div');
      row.className = 'sh-skill';
      row.innerHTML =
        `<input type="checkbox" data-skill="${name}" ${isTrained?'checked':''}>` +
        `<span class="sh-skill-name">${name}</span>` +
        `<span class="sh-skill-abi">${abi}</span>` +
        `<span class="sh-skill-mod" data-skill-mod="${name}">${fmtMod(mod)}</span>` +
        `<button class="sh-skill-roll" data-roll-skill="${name}" title="Roll ${name}">🎲</button>`;
      skillsBox.appendChild(row);
    });

    skillsBox.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      cb.addEventListener('change', () => {
        const name = cb.dataset.skill;
        if (cb.checked) {
          if (!sheet.trained.includes(name)) sheet.trained.push(name);
        } else {
          sheet.trained = sheet.trained.filter(n => n !== name);
        }
        recomputeMods();
        saveStore();
      });
    });
    skillsBox.querySelectorAll('button[data-roll-skill]').forEach(b => {
      b.addEventListener('click', () => {
        pushFormToSheet();      // capture any edits before rolling
        const r = rollSkill(sheet, b.dataset.rollSkill);
        showLocalResult(r);
      });
    });
  }

  // ── Inventory ─────────────────────────────────────────────────
  const inventoryBox = document.getElementById('sh-inventory');
  const invNameIn    = document.getElementById('sh-inv-name');
  const invQtyIn     = document.getElementById('sh-inv-qty');
  const invWtIn      = document.getElementById('sh-inv-weight');
  const invAddBtn    = document.getElementById('sh-inv-add');
  const invTotalsEl  = document.getElementById('sh-inv-totals');

  function renderInventory() {
    if (!sheet.inventory) sheet.inventory = [];
    inventoryBox.innerHTML = '';
    if (sheet.inventory.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'sh-inv-empty';
      empty.textContent = 'No items yet — add one below.';
      inventoryBox.appendChild(empty);
    } else {
      sheet.inventory.forEach(item => inventoryBox.appendChild(buildInvRow(item)));
    }
    renderInvTotals();
  }

  function buildInvRow(item) {
    const row = document.createElement('div');
    row.className = 'sh-inv-row' + (item.equipped ? ' equipped' : '');

    // Equipped checkbox
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!item.equipped;
    cb.title = 'Equipped';
    cb.addEventListener('change', () => {
      item.equipped = cb.checked;
      row.classList.toggle('equipped', cb.checked);
      saveStore();
      // If this item is a light source, mirror its equipped state on the
      // owner's token(s) so the fog renderer picks up the change and the
      // new range is broadcast to other clients.
      if (item.lightRadius && typeof tokens !== 'undefined') {
        const myTokens = tokens.filter(t => t.ownerSheetId === sheet.id);
        for (const tok of myTokens) {
          if (cb.checked) {
            tok.equippedLight = { radius: Number(item.lightRadius) || 0, name: item.name };
          } else if (tok.equippedLight && tok.equippedLight.name === item.name) {
            tok.equippedLight = null;
          }
        }
        if (window.__mpScheduleSync) window.__mpScheduleSync();
      }
    });

    // Name (editable)
    const nameIn = document.createElement('input');
    nameIn.type = 'text';
    nameIn.className = 'sh-inv-name';
    nameIn.value = item.name || '';
    nameIn.title = 'Click to rename';
    nameIn.addEventListener('input', () => {
      item.name = nameIn.value;
      saveStore();
    });

    // Qty controls
    const qtyWrap = document.createElement('div');
    qtyWrap.className = 'sh-inv-qty-ctrl';
    const minus = document.createElement('button'); minus.textContent = '−'; minus.title = 'Decrease';
    const qtyVal = document.createElement('span'); qtyVal.className = 'sh-inv-qty-val';
    qtyVal.textContent = item.qty;
    const plus = document.createElement('button'); plus.textContent = '+'; plus.title = 'Increase';
    minus.addEventListener('click', () => {
      item.qty = Math.max(0, (item.qty || 0) - 1);
      if (item.qty === 0) {
        sheet.inventory = sheet.inventory.filter(x => x.id !== item.id);
        saveStore();
        renderInventory();
      } else {
        qtyVal.textContent = item.qty;
        saveStore();
        renderInvTotals();
      }
    });
    plus.addEventListener('click', () => {
      item.qty = (item.qty || 0) + 1;
      qtyVal.textContent = item.qty;
      saveStore();
      renderInvTotals();
    });
    qtyWrap.appendChild(minus); qtyWrap.appendChild(qtyVal); qtyWrap.appendChild(plus);

    // Weight display
    const wt = document.createElement('span');
    wt.className = 'sh-inv-wt';
    wt.textContent = ((Number(item.weight) || 0) * (item.qty || 0)).toFixed(1) + ' lb';

    // Delete
    const del = document.createElement('button');
    del.className = 'sh-inv-del';
    del.textContent = '🗑';
    del.title = 'Remove item';
    del.addEventListener('click', () => {
      if (!confirm(`Remove "${item.name || 'item'}"?`)) return;
      sheet.inventory = sheet.inventory.filter(x => x.id !== item.id);
      saveStore();
      renderInventory();
    });

    row.appendChild(cb);
    row.appendChild(nameIn);
    row.appendChild(qtyWrap);
    row.appendChild(wt);
    row.appendChild(del);
    return row;
  }

  function renderInvTotals() {
    const inv = sheet.inventory || [];
    const totalItems = inv.reduce((n, it) => n + (Number(it.qty) || 0), 0);
    const totalWt    = inv.reduce((n, it) => n + (Number(it.weight) || 0) * (Number(it.qty) || 0), 0);
    invTotalsEl.textContent = inv.length
      ? `${inv.length} entr${inv.length === 1 ? 'y' : 'ies'} · ${totalItems} item${totalItems === 1 ? '' : 's'} · ${totalWt.toFixed(1)} lb total`
      : '';
  }

  invAddBtn.addEventListener('click', () => {
    const name = invNameIn.value.trim();
    if (!name) { invNameIn.focus(); return; }
    const qty = Math.max(1, parseInt(invQtyIn.value) || 1);
    const wt  = Math.max(0, parseFloat(invWtIn.value) || 0);
    if (!sheet.inventory) sheet.inventory = [];
    sheet.inventory.push({
      id: makeItemId(),
      name, qty, weight: wt,
      equipped: false,
      notes: '',
    });
    saveStore();
    invNameIn.value = '';
    invQtyIn.value = '1';
    invWtIn.value  = '0';
    renderInventory();
    invNameIn.focus();
  });
  // Press Enter in any add-row field to submit
  [invNameIn, invQtyIn, invWtIn].forEach(el => {
    el.addEventListener('keydown', e => { if (e.key === 'Enter') invAddBtn.click(); });
  });

  function recomputeMods() {
    SKILLS_4E.forEach(([name]) => {
      const el = skillsBox.querySelector(`[data-skill-mod="${name}"]`);
      if (el) el.textContent = fmtMod(skillModFor(sheet, name));
    });
    ABILS.forEach(a => {
      const el = document.querySelector(`#sh-abilities .sh-mod[data-mod="${a}"]`);
      if (el) el.textContent = fmtMod(modOf(sheet.abilities[a]));
    });
  }

  // ── Capture form state into the sheet (does NOT persist yet) ──
  function pushFormToSheet() {
    sheet.name  = document.getElementById('sh-name').value.trim();
    sheet.level = Math.max(1, parseInt(document.getElementById('sh-level').value) || 1);
    sheet.cls   = document.getElementById('sh-class').value.trim();
    sheet.race  = document.getElementById('sh-race').value.trim();
    ABILS.forEach(a => {
      const v = parseInt(document.querySelector(`#sh-abilities input[data-abi="${a}"]`).value);
      sheet.abilities[a] = isNaN(v) ? 10 : v;
    });
    sheet.defenses.AC   = parseInt(document.getElementById('sh-AC').value)   || 10;
    sheet.defenses.Fort = parseInt(document.getElementById('sh-Fort').value) || 10;
    sheet.defenses.Ref  = parseInt(document.getElementById('sh-Ref').value)  || 10;
    sheet.defenses.Will = parseInt(document.getElementById('sh-Will').value) || 10;
    sheet.hp     = parseInt(document.getElementById('sh-hp').value)    || 0;
    sheet.maxhp  = parseInt(document.getElementById('sh-maxhp').value) || 0;
    sheet.surges = parseInt(document.getElementById('sh-surges').value)|| 0;
    const visSel = document.getElementById('sh-vision');
    if (visSel) sheet.vision = visSel.value || 'normal';
  }

  // Live recompute when any input changes
  document.getElementById('sheet-body').addEventListener('input', e => {
    if (e.target.matches('input')) {
      pushFormToSheet();
      recomputeMods();
    }
  });

  saveBtn.addEventListener('click', () => {
    pushFormToSheet();
    saveStore();
    refreshSheetList();
    fireSheetsChanged();   // label may have changed (name/level/class edited)
    saveBtn.textContent = '✓ Saved';
    setTimeout(() => { saveBtn.textContent = '💾 Save'; }, 1000);
  });
  resetBtn.addEventListener('click', () => {
    if (!confirm('Reset this character sheet to defaults? (Other sheets unaffected.)')) return;
    const keepId = sheet.id;
    const fresh = defaultSheet();
    fresh.id = keepId;
    store.sheets[keepId] = fresh;
    sheet = fresh;
    saveStore();
    refreshSheetList();
    fireSheetsChanged();
    fillForm();
  });

  // ── Show a roll result in the sheet panel (with share buttons) ─
  function showLocalResult(r) {
    const inRoom = window.mpInRoom && window.mpInRoom();
    resultBox.innerHTML =
      `<div><span class="sh-result-total">${r.total}</span>` +
      `<span style="font-weight:700;">${r.skill} check</span></div>` +
      `<div style="font-size:11px;color:rgba(255,255,255,0.55);margin-top:3px">${r.breakdown}</div>` +
      (inRoom ? `<div class="sh-result-share">
          <button class="sh-result-share-party">📢 Share with Party</button>
          <button class="sh-result-share-dm">🔒 Send to DM</button>
        </div>` : '');
    resultBox.style.display = 'block';
    if (inRoom) {
      resultBox.querySelector('.sh-result-share-party')?.addEventListener('click', () => sendRollResult(r, 'all'));
      resultBox.querySelector('.sh-result-share-dm')?.addEventListener('click', () => sendRollResult(r, 'dm'));
    }
  }

  // ── Multiplayer protocol: special markers embedded in chat text ─
  // Request:  __ROLLREQ__:{json}   e.g. {"skill":"Stealth"}
  // Response: __ROLLRES__:{json}   e.g. {"skill":"Stealth","total":17,...}
  function sendRollResult(r, to) {
    if (!window.mpSend) return;
    const payload = '__ROLLRES__:' + JSON.stringify({
      skill: r.skill, ability: r.ability,
      d20: r.d20, mod: r.mod, total: r.total,
      breakdown: r.breakdown, name: r.name,
    });
    window.mpSend(payload, to || 'all');
  }
  window.arcaneSendRollResult = sendRollResult;

  // Auto-respond hook: called by the chat layer when a request comes in.
  // Uses the MP-selected sheet (NOT the one being edited in the panel).
  window.arcaneAutoRollRequest = function (skill, fromDm) {
    // If we're editing the same sheet that's also the MP-active one,
    // capture any unsaved edits first.
    if (mpActiveSheet() === sheet) pushFormToSheet?.();
    const r = rollSkill(mpActiveSheet(), skill);
    return r;
  };

  // ── Dedicated DM-roll-request pop-up ─────────────────────────
  const reqOverlay   = document.getElementById('rollreq-overlay');
  const reqClose     = document.getElementById('rollreq-close');
  const reqRollBtn   = document.getElementById('rollreq-roll-btn');
  const reqFromEl    = document.getElementById('rollreq-from');
  const reqSkillEl   = document.getElementById('rollreq-skill');
  const reqBreakEl   = document.getElementById('rollreq-breakdown');
  const reqD20El     = document.getElementById('rollreq-d20');
  const reqTotalEl   = document.getElementById('rollreq-total');

  let _pendingReqSkill = null;

  function openRollRequest(skill, fromName) {
    if (!reqOverlay) return;
    // If the editor panel is open AND showing the MP-active sheet, capture
    // any unsaved edits so the modifier is current.
    if (overlay && overlay.classList.contains('open') && mpActiveSheet() === sheet) {
      pushFormToSheet?.();
    }
    const mpSh = mpActiveSheet();
    _pendingReqSkill = skill;
    const charLine = mpSh.name ? ` (as ${mpSh.name})` : '';
    reqFromEl.textContent  = `${fromName || 'DM'} is asking for${charLine}:`;
    reqSkillEl.textContent = `${skill} check`;
    const mod = skillModFor(mpSh, skill);
    const entry = SKILLS_4E.find(([n]) => n === skill);
    const abi = entry ? entry[1] : '';
    reqBreakEl.textContent =
      `Your modifier: ${(mod>=0?'+':'')}${mod}  ` +
      `( ${abi} ${(modOf(mpSh.abilities[abi]||10)>=0?'+':'')}${modOf(mpSh.abilities[abi]||10)} ` +
      `+ ½lvl ${halfLevel(mpSh)}` +
      (mpSh.trained.includes(skill) ? ' + trained 5' : '') + ' )';
    reqD20El.style.display = 'none';
    reqTotalEl.style.display = 'none';
    reqRollBtn.disabled = false;
    reqRollBtn.textContent = '🎲 ROLL';
    reqOverlay.classList.add('open');
  }
  function closeRollRequest() {
    reqOverlay && reqOverlay.classList.remove('open');
    _pendingReqSkill = null;
  }
  reqClose?.addEventListener('click', closeRollRequest);
  reqOverlay?.addEventListener('click', e => { if (e.target === reqOverlay) closeRollRequest(); });

  // After clicking ROLL we hold the result here until the player picks
  // a send target.
  let _pendingRollResult = null;
  const reqSendRow   = document.getElementById('rollreq-send-row');
  const reqSendParty = document.getElementById('rollreq-send-party');
  const reqSendDm    = document.getElementById('rollreq-send-dm');

  reqRollBtn?.addEventListener('click', () => {
    if (!_pendingReqSkill) return;
    const r = rollSkill(mpActiveSheet(), _pendingReqSkill);
    _pendingRollResult = r;
    // Reveal the result
    reqD20El.style.display = 'block';
    reqD20El.textContent = `d20 → ${r.d20}`;
    reqTotalEl.style.display = 'block';
    reqTotalEl.textContent = r.total;
    // Swap the Roll button out for the two send-target buttons
    reqRollBtn.style.display = 'none';
    if (reqSendRow) reqSendRow.classList.add('visible');
  });

  function sendAndClose(to) {
    if (_pendingRollResult && window.arcaneSendRollResult) {
      window.arcaneSendRollResult(_pendingRollResult, to);
    }
    // Brief acknowledgement, then close
    if (reqSendRow) reqSendRow.classList.remove('visible');
    reqRollBtn.style.display = 'block';
    reqRollBtn.disabled    = true;
    reqRollBtn.textContent = to === 'dm' ? '✓ Sent to DM' : '✓ Sent to Party';
    setTimeout(closeRollRequest, 1500);
  }
  reqSendParty?.addEventListener('click', () => sendAndClose('all'));
  reqSendDm?.addEventListener('click',    () => sendAndClose('dm'));

  // Reset the send-target picker every time the modal re-opens
  const _origOpenRollRequest = openRollRequest;
  function openRollRequestReset(skill, fromName) {
    _pendingRollResult = null;
    if (reqSendRow) reqSendRow.classList.remove('visible');
    if (reqRollBtn) reqRollBtn.style.display = 'block';
    _origOpenRollRequest(skill, fromName);
  }
  // Expose so the chat layer can fire it
  window.arcaneOpenRollRequest = openRollRequestReset;

  // ── DM Roll-Request UI (in mp panel) ──────────────────────────
  // Populate skill picker
  const dmSkillSel = document.getElementById('mp-dm-roll-skill');
  if (dmSkillSel) {
    SKILLS_4E.forEach(([n, a]) => {
      const opt = document.createElement('option');
      opt.value = n;
      opt.textContent = `${n} (${a})`;
      dmSkillSel.appendChild(opt);
    });
  }
  const dmTargetSel = document.getElementById('mp-dm-roll-target');
  function refreshDmTargets() {
    if (!dmTargetSel) return;
    const prev = dmTargetSel.value;
    dmTargetSel.innerHTML = '';
    const optAll = document.createElement('option');
    optAll.value = 'all'; optAll.textContent = '👥 Party';
    dmTargetSel.appendChild(optAll);
    if (window.mpPlayers) {
      const { dmId, myId, players } = window.mpPlayers();
      Object.entries(players).forEach(([id, name]) => {
        if (id === myId) return;                       // never request from self
        const o = document.createElement('option');
        o.value = id;
        // Mark the DM if (somehow) shown; otherwise treat as a player.
        o.textContent = (id === dmId ? '👑 ' : '🧙 ') + name;
        dmTargetSel.appendChild(o);
      });
    }
    if (prev && [...dmTargetSel.options].some(o => o.value === prev)) {
      dmTargetSel.value = prev;
    }
  }
  // Refresh whenever the roster changes
  if (window.mpOnPlayersChanged) window.mpOnPlayersChanged(refreshDmTargets);
  // Also refresh whenever the DM is about to interact with the picker —
  // belt-and-braces against any race between event delivery and rendering.
  if (dmTargetSel) {
    dmTargetSel.addEventListener('mousedown', refreshDmTargets);
    dmTargetSel.addEventListener('focus',     refreshDmTargets);
  }
  refreshDmTargets();

  const dmReqBtn = document.getElementById('mp-dm-roll-req');
  if (dmReqBtn) {
    dmReqBtn.addEventListener('click', () => {
      if (!window.mpSend || !window.mpInRoom || !window.mpInRoom()) {
        alert('Open or join a multiplayer room first.');
        return;
      }
      refreshDmTargets();           // make sure target is fresh at fire time
      const skill  = dmSkillSel.value || 'Perception';
      const target = (dmTargetSel && dmTargetSel.value) || 'all';
      const payload = '__ROLLREQ__:' + JSON.stringify({ skill });
      window.mpSend(payload, target);  // 'all' or specific player id

      // Visual feedback to the DM so they know it went out, AND jump to
      // the relevant tab so they can see the request card / future result.
      if (target !== 'all' && window.mpSwitchTab) {
        window.mpSwitchTab(target);
      } else if (window.mpSwitchTab) {
        window.mpSwitchTab('all');
      }
      // Brief in-button confirmation
      const orig = dmReqBtn.textContent;
      const sel  = dmTargetSel ? dmTargetSel.selectedOptions[0]?.textContent : 'Party';
      dmReqBtn.textContent = '✓ Sent → ' + (sel || 'Party');
      dmReqBtn.disabled = true;
      setTimeout(() => { dmReqBtn.textContent = orig; dmReqBtn.disabled = false; }, 1500);
    });
  }
})();

// ═══════════════════════════════════════════════════════════════════
// 📚 BESTIARY — searchable creature library + token placement
// ═══════════════════════════════════════════════════════════════════
(function () {
  const STORAGE_KEY = 'arcane_bestiary_v1';
  const SIZE_TO_GRID = {
    tiny: 1, small: 1, medium: 1,
    large: 2, huge: 3, gargantuan: 4,
  };

  // Roster of monster *names only* — provided by the user to seed the
  // library. Default stats are filled in (AC 10, HP 10, etc.) so each
  // creature is editable from the bestiary panel.
  const MONSTER_PRESETS = [
    // A
    'Aboleth','Abomination','Abyssal Ghoul','Angel of Battle','Angel of Protection',
    'Angel of Valor','Angel of Vengeance','Archon','Aspect of Orcus','Astral Stalker',
    'Atropal','Azer',
    // B
    'Balor','Barghest','Battle Wight','Beholder','Beholder Eye Tyrant',
    'Berserk Flesh Golem','Black Dragon','Blackspawn Raider','Blackspawn Stalker',
    'Blink Dog','Bloodfire Harpy','Blue Dragon','Bone Naga','Boneclaw','Bulette',
    // C
    'Cambion','Carrion Crawler','Cave Bear','Cave Fisher','Centipede Swarm',
    'Chaos Beast','Chuul','Clay Scout','Cloaker','Cockatrice','Couatl','Cyclops',
    // D
    'Dark Creeper','Dark One','Death Giant','Deathjump Spider','Deathlock Wight',
    'Demogorgon','Demon','Devil','Dire Bear','Dire Boar','Dire Rat','Dire Shark',
    'Displacer Beast','Doppelganger','Dragonborn Soldier','Dragonspawn','Drider',
    'Drow Arachnomancer','Drow Blademaster','Drow Priest','Duergar','Duergar Guard',
    'Duergar Theurge','Duergar Torturer',
    // E
    'Earth Archon','Efreet','Ettercap','Ettin','Eye of Gruumsh',
    // F
    'Feral Troll','Fire Archon','Fire Bat','Fire Giant','Flameskull','Flesh Golem',
    'Fomorian','Frost Giant',
    // G
    'Gargoyle','Gelatinous Cube','Ghast','Ghost','Ghoul','Giant Ant','Giant Crocodile',
    'Giant Rat','Giant Scorpion','Giant Spider','Gibbering Mouther','Gnoll',
    'Gnoll Claw Fighter','Gnoll Demonic Scourge','Goblin Archer','Goblin Blackblade',
    'Goblin Cutter','Goblin Hexer','Goblin Sharpshooter','Gorgon','Gravehound',
    'Gray Ooze','Green Dragon','Grell','Grimlock',
    // H
    'Halfling Slinger','Harpy','Hell Hound','Hezrou','Hill Giant','Hobgoblin Archer',
    'Hobgoblin Soldier','Hobgoblin Warcaster','Hook Horror','Human Bandit',
    'Human Guard','Human Mage','Hydra',
    // I
    'Ice Archon','Ice Mephit','Imp','Iron Cobra','Iron Defender',
    // K
    'Kenku Sneak','Kobold Dragonshield','Kobold Minion','Kobold Slinger',
    'Kobold Wyrmpriest','Kraken',
    // L
    'Lich','Lizardfolk Raider','Lizardfolk Render','Lolth',
    // M
    'Magma Beast','Manticore','Medusa Archer','Medusa Shifter','Mezzodemon',
    'Mind Flayer','Mind Flayer Mastermind','Minotaur','Mummy','Myconid',
    // N
    'Necromancer','Needlefang Drake Swarm','Night Hag','Nightmare','Nothic',
    // O
    'Ogre','Ogre Savage','Ogre Warhulk','Oni Night Haunter','Orc Archer',
    'Orc Berserker','Orc Bloodrager','Orc Eye of Gruumsh','Orcus','Otyugh',
    // P
    'Phantom Warrior','Pit Fiend','Pixie','Purple Worm',
    // Q
    'Quasit',
    // R
    'Rage Drake','Rakshasa','Red Dragon','Roper','Rust Monster',
    // S
    'Salamander','Satyr','Scarecrow','Shadow Hound','Shadowhunter Bat',
    'Shadar-kai Warrior','Shield Guardian','Skeleton','Slaad','Smoke Archon',
    'Specter','Spell Weaver','Spider Deathjump','Stone Giant','Storm Titan','Succubus',
    // T
    'Tarrasque','Tiefling Heretic','Tiefling Warlock','Tomb Guardian','Treant',
    'Troll','Troglodyte','Troupe Devil',
    // U
    'Umber Hulk','Unicorn',
    // V
    'Vampire Lord','Vampire Spawn','Vrock',
    // W
    'War Devil','Warforged Soldier','Water Archon','Wereboar','Werebear','Wererat',
    'Werewolf','White Dragon','Wight',"Will-o'-Wisp",'Winged Kobold','Wolf Pack','Wraith',
    // X
    'Xorn',
    // Y
    'Young Black Dragon','Young Blue Dragon','Young Green Dragon','Young Red Dragon',
    'Young White Dragon','Yuan-ti Abomination','Yuan-ti Malison','Yuan-ti Priest',
    // Z
    'Zombie','Zombie Hulk','Zombie Rotter',

    // ─── Batch 2 (additional roster) ─────────────────────────────
    // A
    'Aboleth Overseer','Abyssal Maw','Air Mephit','Allip','Angel of Light',
    'Angel of Destruction','Animated Statue','Arcanian','Ash Wraith',
    // B
    'Banderhobb','Basilisk','Bat Swarm','Beholder Eye of Flame','Behir',
    'Berbalang','Black Pudding','Blazing Skeleton','Bodak','Bone Collector',
    'Brain in a Jar','Bronze Warder','Broodmother Hydra',
    // C
    'Cadaver Collector','Cambion Hellfire Magus','Carrion Tribe Cannibal',
    'Cave Troll','Centaur Hunter','Chaos Roc','Choker','Corpse Jelly',
    'Crawling Claw',
    // D
    'Darkmantle','Death Knight','Death Titan','Deathdrinker','Deathlock',
    'Deathpriest Hextor','Deep Dragon','Derro Savant','Devourer','Dread Wraith',
    'Dracolich','Dragon Turtle','Dragonborn Gladiator','Dragonspawn Abomination',
    'Dream Eater',
    // E
    'Earthrage Battlebriar','Efreet Flamestrider','Elder Basilisk',
    'Elder Green Dragon','Ettin Marauder',
    // F
    'Fey Panther','Fire Beetle','Flame Serpent','Flesh-Crazed Berserker',
    'Foulspawn Berserker','Foulspawn Mangler','Foulspawn Seer','Frost Titan',
    // G
    'Gargoyle Stalker','Gelatinous Sphere','Ghoul King','Ghost Panther',
    'Ghoul Hungerer','Gibbering Abomination','Girallon','Githyanki Warrior',
    'Githzerai Cenobite','Gladiator Champion','Gnoll Huntmaster',
    'Goblin Skullcleaver','Grave Titan','Greenspawn Razorfiend',
    // H
    'Harrow Hound','Hellwasp','Homunculus','Hook Horror Ravager','Horde Ghoul',
    'Horned Devil','Human Duelist','Human Rabble','Hunter Drake',
    // I
    'Ice Troll','Inferno Spider','Iron Lich',
    // J
    'Jackalwere',
    // K
    'Kraken Priest','Kruthik Adult','Kruthik Hive Lord',
    // L
    'Lava Drake','Legion Devil','Leviathan','Living Thundercloud',
    // M
    'Mad Wraith','Magmin','Marilith','Meenlock','Mercurial Ooze','Merrow',
    'Mimic','Mind Flayer Infiltrator','Moilian Heart','Moon Wraith','Mud Lasher',
    // N
    'Necrotic Ooze','Nightwalker','Norker Warrior',
    // O
    'Ogre Pulverizer','Oni Mage','Ooze Master','Orc Storm Shaman',
    // P
    'Phantom Brigade','Phoenix','Plague Demon','Plaguechanged Ghoul',
    'Portal Drake','Primordial Hydra','Psionic Vampire',
    // Q
    'Quickling Runner',
    // R
    'Rage Drake Ravager','Razorclaw Stalker','Redspawn Firebelcher','Remorhaz',
    'Revenant Warrior','Runecrag Giant',
    // S
    'Salamander Firetail','Sand Kraken','Satyr Piper','Scion of Flame','Sea Hag',
    'Shadowhunter','Shadowborn Stalker','Sharn','Skull Lord',
    'Slaughterstone Eviscerator','Sphinx','Spirit Devourer','Storm Archon',
    'Stormclaw Scorpion',
    // T
    'Tomb Mote','Tortured Soul','Treacherous Succubus','Tusked Drake',
    // U
    'Umber Hulk Tunneler','Unseelie Knight',
    // V
    'Vampire Noble','Vampire Spawn Stalker','Venom Eye Basilisk','Void Harbinger',
    // W
    'War Troll','Warforged Titan','Water Mephit','Werewolf Alpha','White Maw',
    'Winterclaw Owlbear','Wood Woad','Wyvern',
    // X
    'Xivort Sneak',
    // Y
    'Young Bronze Dragon','Young Gold Dragon','Young Silver Dragon',
    'Yuan-ti Nightmare Speaker',
    // Z
    'Zehir Cultist','Zombie Behemoth','Zombie Plaguebearer',
  ];

  function makeId() { return 'cr_' + Math.random().toString(36).slice(2, 10); }

  function defaultCreature() {
    return {
      id: makeId(),
      name: '', size: 'medium', type: '', cr: '',
      ac: 10, hp: 10, speed: 6,
      saves: { STR:0, DEX:0, CON:0, INT:0, WIS:0, CHA:0 },
      resistances: '', immunities: '', vulnerabilities: '', condImmunities: '',
      senses: '', languages: '', notes: '',
    };
  }

  function loadDB() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { creatures: [] };
      const obj = JSON.parse(raw);
      if (!obj || !Array.isArray(obj.creatures)) return { creatures: [] };
      // Patch any missing fields against the default
      obj.creatures = obj.creatures.map(c => Object.assign(defaultCreature(), c));
      return obj;
    } catch (e) { return { creatures: [] }; }
  }
  function saveDB() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(db)); } catch (e) {}
  }

  let db = loadDB();
  let editingId = null;       // id of creature currently being edited, or null for new
  let searchTerm = '';

  // ── DOM refs ─────────────────────────────────────────────────
  const btn       = document.getElementById('bestiary-btn');
  const overlay   = document.getElementById('bestiary-overlay');
  const closeBtn  = document.getElementById('bestiary-close');
  const searchIn  = document.getElementById('bestiary-search');
  const newBtn    = document.getElementById('bestiary-new-btn');
  const listEl    = document.getElementById('bestiary-list');
  const editorEl  = document.getElementById('bestiary-editor');
  const editorModeEl = document.getElementById('be-editor-mode');
  const cancelBtn = document.getElementById('be-cancel-btn');
  const saveBtn   = document.getElementById('be-save-btn');
  const deleteBtn = document.getElementById('be-delete-btn');
  const banner    = document.getElementById('bestiary-place-banner');
  const bannerTxt = document.getElementById('bestiary-place-banner-text');
  const bannerCancel = document.getElementById('bestiary-place-cancel');

  // ── Open / close ─────────────────────────────────────────────
  function openOverlay() {
    renderList();
    overlay.classList.add('open');
  }
  function closeOverlay() {
    overlay.classList.remove('open');
    hideEditor();
  }
  // Expose for the unified TOKEN button on the toolbar.
  window.__bestiaryOpen  = openOverlay;
  window.__bestiaryClose = closeOverlay;
  if (btn) btn.addEventListener('click', openOverlay);
  closeBtn.addEventListener('click', closeOverlay);
  overlay.addEventListener('click', e => { if (e.target === overlay) closeOverlay(); });

  // ── Search ───────────────────────────────────────────────────
  searchIn.addEventListener('input', () => {
    searchTerm = searchIn.value.trim().toLowerCase();
    renderList();
  });

  // ── List rendering ───────────────────────────────────────────
  function matches(c) {
    if (!searchTerm) return true;
    const hay = [c.name, c.type, c.cr, c.size].join(' ').toLowerCase();
    return hay.includes(searchTerm);
  }
  function renderList() {
    listEl.innerHTML = '';
    // Always-on "My Character" card at the top — lets the player drop their
    // own active character on the map as a token (drag or click Place Me).
    // We render it whenever there's any sheet at all; if the name is blank
    // we still show the card with a CTA to open the sheet panel and set up.
    const sheet = window.arcaneSheet && window.arcaneSheet();
    if (sheet) {
      listEl.appendChild(buildMyCharacterCard(sheet));
    } else {
      // No sheet IIFE loaded — fall back to a static prompt
      const hint = document.createElement('div');
      hint.className = 'be-empty';
      hint.innerHTML = '🎭 Open the character sheet (top-left) and add a character to enable "Place Me".';
      listEl.appendChild(hint);
    }
    const visible = db.creatures.filter(matches)
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    if (visible.length === 0 && !sheet) {
      const empty = document.createElement('div');
      empty.className = 'be-empty';
      empty.textContent = db.creatures.length === 0
        ? 'No creatures yet — click "＋ New Creature" to add one.'
        : 'No matches.';
      listEl.appendChild(empty);
      return;
    }
    visible.forEach(c => listEl.appendChild(buildCard(c)));
  }

  // Build a creature-like object from the player's active character sheet
  // so it can flow through the existing token-placement pipeline.
  function creatureFromSheet(sheet) {
    return {
      name:  sheet.name || 'Adventurer',
      size:  'medium',
      type:  (sheet.cls || 'player character').toLowerCase(),
      cr:    'Lv' + (sheet.level || 1),
      ac:    (sheet.defenses && sheet.defenses.AC) || 10,
      hp:    sheet.maxhp || sheet.hp || 0,
      speed: 6,
      saves: {},
      color: '#7C6FF7',           // purple — distinguishes PCs from monster tokens
      vision: sheet.vision || 'normal',  // controls fog reveal around the token
      ownerSheetId: sheet.id,     // links the token back to its character sheet
    };
  }

  function buildMyCharacterCard(sheet) {
    const card = document.createElement('div');
    card.className = 'be-card my-character';
    card.draggable = true;
    card.addEventListener('dragstart', e => {
      e.dataTransfer.setData('text/x-arcane-mycharacter', sheet.id);
      e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.setData('text/plain', sheet.name || 'My Character');
      card.classList.add('be-dragging');
    });
    card.addEventListener('dragend', () => card.classList.remove('be-dragging'));

    const main = document.createElement('div');
    main.className = 'be-card-main';

    const name = document.createElement('div');
    name.className = 'be-card-name';
    name.innerHTML = '🎭 ' + escapeHTML(sheet.name || 'Adventurer');

    const sub = document.createElement('div');
    sub.className = 'be-card-sub';
    const detail = (sheet.cls ? sheet.cls + ' · ' : '') + 'Lv' + (sheet.level || 1);
    sub.innerHTML =
      `<span>${escapeHTML(detail)}</span>` +
      `<span class="be-badge">AC ${(sheet.defenses && sheet.defenses.AC) || 10}</span>` +
      `<span class="be-badge">HP ${sheet.maxhp || sheet.hp || 0}</span>`;
    main.appendChild(name);
    main.appendChild(sub);

    const actions = document.createElement('div');
    actions.className = 'be-card-actions';

    const placeBtn = document.createElement('button');
    placeBtn.className = 'be-place';
    placeBtn.textContent = '📍 Place Me';
    placeBtn.addEventListener('click', () => startPlacing(creatureFromSheet(sheet)));

    actions.appendChild(placeBtn);
    card.appendChild(main);
    card.appendChild(actions);
    return card;
  }
  function buildCard(c) {
    const card = document.createElement('div');
    card.className = 'be-card';
    card.draggable = true;
    card.addEventListener('dragstart', e => {
      e.dataTransfer.setData('text/x-arcane-creature', c.id);
      e.dataTransfer.effectAllowed = 'copy';
      // Some browsers also need a plain-text payload
      e.dataTransfer.setData('text/plain', c.name || 'Creature');
      card.classList.add('be-dragging');
    });
    card.addEventListener('dragend', () => card.classList.remove('be-dragging'));
    const main = document.createElement('div');
    main.className = 'be-card-main';
    const name = document.createElement('div');
    name.className = 'be-card-name';
    name.textContent = c.name || 'Unnamed';
    const sub = document.createElement('div');
    sub.className = 'be-card-sub';
    const parts = [];
    if (c.size || c.type) parts.push(`${cap(c.size)} ${c.type || ''}`.trim());
    if (c.cr) parts.push(`CR ${c.cr}`);
    sub.innerHTML =
      `<span>${escapeHTML(parts.join(' · '))}</span>` +
      `<span class="be-badge">AC ${c.ac}</span>` +
      `<span class="be-badge">HP ${c.hp}</span>` +
      `<span class="be-badge">Spd ${c.speed}</span>`;
    main.appendChild(name); main.appendChild(sub);

    const actions = document.createElement('div');
    actions.className = 'be-card-actions';

    const placeBtn = document.createElement('button');
    placeBtn.className = 'be-place';
    placeBtn.textContent = '📍 Place';
    placeBtn.addEventListener('click', () => startPlacing(c));

    const editBtn = document.createElement('button');
    editBtn.textContent = '✎ Edit';
    editBtn.addEventListener('click', () => showEditor(c));

    actions.appendChild(placeBtn);
    actions.appendChild(editBtn);

    card.appendChild(main);
    card.appendChild(actions);
    return card;
  }
  function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }
  function escapeHTML(s) {
    return String(s ?? '').replace(/[&<>"']/g, ch =>
      ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  }

  // ── Editor ────────────────────────────────────────────────────
  function showEditor(c) {
    editingId = c ? c.id : null;
    editorEl.style.display = 'block';
    editorModeEl.textContent = c ? `Edit: ${c.name || 'Unnamed'}` : 'New Creature';
    deleteBtn.style.display = c ? '' : 'none';
    const src = c || defaultCreature();
    document.getElementById('be-name').value      = src.name;
    document.getElementById('be-size').value      = src.size;
    document.getElementById('be-type').value      = src.type;
    document.getElementById('be-cr').value        = src.cr;
    document.getElementById('be-ac').value        = src.ac;
    document.getElementById('be-hp').value        = src.hp;
    document.getElementById('be-speed').value     = src.speed;
    ['STR','DEX','CON','INT','WIS','CHA'].forEach(a => {
      document.getElementById('be-save-' + a).value = (src.saves || {})[a] || 0;
    });
    document.getElementById('be-resist').value      = src.resistances;
    document.getElementById('be-immune').value      = src.immunities;
    document.getElementById('be-vuln').value        = src.vulnerabilities;
    document.getElementById('be-cond-immune').value = src.condImmunities;
    document.getElementById('be-senses').value      = src.senses;
    document.getElementById('be-languages').value   = src.languages;
    document.getElementById('be-notes').value       = src.notes;
    editorEl.scrollIntoView({ behavior:'smooth', block:'start' });
  }
  function hideEditor() {
    editorEl.style.display = 'none';
    editingId = null;
  }
  function readEditor() {
    const c = editingId
      ? db.creatures.find(x => x.id === editingId) || defaultCreature()
      : defaultCreature();
    c.name           = document.getElementById('be-name').value.trim();
    c.size           = document.getElementById('be-size').value;
    c.type           = document.getElementById('be-type').value.trim();
    c.cr             = document.getElementById('be-cr').value.trim();
    c.ac             = parseInt(document.getElementById('be-ac').value)    || 0;
    c.hp             = parseInt(document.getElementById('be-hp').value)    || 0;
    c.speed          = parseInt(document.getElementById('be-speed').value) || 0;
    c.saves = {};
    ['STR','DEX','CON','INT','WIS','CHA'].forEach(a => {
      c.saves[a] = parseInt(document.getElementById('be-save-' + a).value) || 0;
    });
    c.resistances     = document.getElementById('be-resist').value.trim();
    c.immunities      = document.getElementById('be-immune').value.trim();
    c.vulnerabilities = document.getElementById('be-vuln').value.trim();
    c.condImmunities  = document.getElementById('be-cond-immune').value.trim();
    c.senses          = document.getElementById('be-senses').value.trim();
    c.languages       = document.getElementById('be-languages').value.trim();
    c.notes           = document.getElementById('be-notes').value.trim();
    return c;
  }

  newBtn.addEventListener('click', () => showEditor(null));
  cancelBtn.addEventListener('click', hideEditor);

  // Load the preset name roster (skips duplicates by case-insensitive name).
  const presetsBtn = document.getElementById('bestiary-presets-btn');
  if (presetsBtn) {
    presetsBtn.addEventListener('click', () => {
      const existingLC = new Set(db.creatures.map(c => (c.name || '').toLowerCase()));
      let added = 0;
      MONSTER_PRESETS.forEach(name => {
        if (existingLC.has(name.toLowerCase())) return;
        const c = defaultCreature();
        c.name = name;
        db.creatures.push(c);
        added++;
      });
      if (added === 0) {
        alert('All preset names are already in your bestiary.');
        return;
      }
      saveDB();
      renderList();
      alert(`Added ${added} preset name${added === 1 ? '' : 's'} to your bestiary. ` +
            `Open each one and fill in the AC / HP / Saves / etc. from your own source.`);
    });
  }

  saveBtn.addEventListener('click', () => {
    const c = readEditor();
    if (!c.name) { alert('Please enter a name.'); return; }
    if (editingId) {
      const idx = db.creatures.findIndex(x => x.id === editingId);
      if (idx >= 0) db.creatures[idx] = c; else db.creatures.push(c);
    } else {
      db.creatures.push(c);
    }
    saveDB();
    hideEditor();
    renderList();
  });

  deleteBtn.addEventListener('click', () => {
    if (!editingId) return;
    const c = db.creatures.find(x => x.id === editingId);
    if (!c) return;
    if (!confirm(`Delete "${c.name || 'Unnamed'}"? This cannot be undone.`)) return;
    db.creatures = db.creatures.filter(x => x.id !== editingId);
    saveDB();
    hideEditor();
    renderList();
  });

  // ── Placement mode (hook into the canvas pointer) ────────────
  window.__bestiaryPending = null;  // visible to pointerDown hook below
  function startPlacing(c) {
    window.__bestiaryPending = c;
    bannerTxt.textContent = `📍 Click the grid to place "${c.name}" — Esc or click Cancel to abort`;
    banner.style.display = 'flex';
    closeOverlay();
  }
  function cancelPlacing() {
    window.__bestiaryPending = null;
    banner.style.display = 'none';
  }
  bannerCancel.addEventListener('click', cancelPlacing);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && window.__bestiaryPending) cancelPlacing();
  });

  // The actual placement happens in pointerDown (we install a tiny hook below).
  // Provide a helper the hook can call.
  window.__bestiaryPlaceAt = function (r, c) {
    const cr = window.__bestiaryPending;
    if (!cr) return false;
    if (typeof window.__pushTokenForBestiary !== 'function') return false;
    window.__pushTokenForBestiary(cr, r, c);
    cancelPlacing();
    return true;
  };

  // ── HTML5 drag & drop onto the battle grid ──────────────────
  const gridCanvas = document.getElementById('grid');
  if (gridCanvas) {
    gridCanvas.addEventListener('dragover', e => {
      // Must preventDefault for 'drop' to fire; signal a copy cursor
      if (e.dataTransfer && e.dataTransfer.types &&
          ([...e.dataTransfer.types].includes('text/x-arcane-creature') ||
           [...e.dataTransfer.types].includes('text/x-arcane-mycharacter'))) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        gridCanvas.classList.add('be-drop-hover');
      }
    });
    gridCanvas.addEventListener('dragleave', () => {
      gridCanvas.classList.remove('be-drop-hover');
    });
    gridCanvas.addEventListener('drop', e => {
      const creatureId = e.dataTransfer.getData('text/x-arcane-creature');
      const sheetId    = e.dataTransfer.getData('text/x-arcane-mycharacter');
      if (!creatureId && !sheetId) return;
      e.preventDefault();
      gridCanvas.classList.remove('be-drop-hover');

      // Resolve the creature object — either a saved bestiary entry, or
      // a synthesised one from the player's active character sheet.
      let cr = null;
      if (creatureId) {
        cr = db.creatures.find(x => x.id === creatureId);
      } else if (sheetId) {
        const sheets = (window.arcaneSheets && window.arcaneSheets()) || [];
        const sh = sheets.find(s => s.id === sheetId);
        if (sh) cr = creatureFromSheet(sh);
      }
      if (!cr) return;

      // Convert client coords → canvas coords → grid cell
      const rect = gridCanvas.getBoundingClientRect();
      const sx = gridCanvas.width  / rect.width;
      const sy = gridCanvas.height / rect.height;
      const px = (e.clientX - rect.left) * sx;
      const py = (e.clientY - rect.top)  * sy;
      if (typeof cellFromXY !== 'function' ||
          typeof window.__pushTokenForBestiary !== 'function') return;
      const cell = cellFromXY(px, py);
      window.__pushTokenForBestiary(cr, cell.r, cell.c);
      // Cancel any pending click-placement so things don't stack on next click
      cancelPlacing();
    });
  }
})();

// ═══════════════════════════════════════════════════════════════════
// 🪞 GRID SYNC — DM broadcasts the projected grid state to all players
// ═══════════════════════════════════════════════════════════════════
(function () {
  const DEBOUNCE_MS = 350;   // throttle DM pushes

  function captureGridState() {
    // Mirror just the projection-relevant state. Personal UI state (which
    // buttons are toggled, presets, scenes) is NOT included.
    return {
      v: 1,
      rows, cols,
      grid: JSON.parse(JSON.stringify(grid)),
      tokens: tokens.map(t => ({ ...t })),
      walls: walls.map(w => ({ ...w })),
      labels: labels.map(l => ({ ...l })),
      lights: lights.map(l => ({ ...l })),
      covers: { ...covers },
      traps: JSON.parse(JSON.stringify(traps || {})),
      fogEnabled,
      fogVis:    { ...fogVis },
      fogTarget: { ...fogTarget },
      projBounds: projBounds ? { ...projBounds } : null,
      initiative: (initiative || []).map(e => ({ ...e })),
      initCurrent, roundNum,
      bgImageDataUrl: window._bgImageDataUrl || null,
    };
  }

  function applyGridState(s) {
    if (!s || typeof s !== 'object') return;
    // Log to console so we can diagnose blank-page reports
    try { console.log('[arcane] applying grid_state', {
      rows: s.rows, cols: s.cols,
      hasBg: !!s.bgImageDataUrl,
      bgSize: s.bgImageDataUrl ? s.bgImageDataUrl.length : 0,
      tokenCount: (s.tokens || []).length,
      gridCells: Object.keys(s.grid || {}).length,
    }); } catch(e) {}

    // Dimensions first — affects canvas sizing.
    // Guard against bad inputs that could collapse the canvas to 0×0.
    if (typeof s.rows === 'number' && s.rows >= 1) rows = s.rows;
    if (typeof s.cols === 'number' && s.cols >= 1) cols = s.cols;
    const colSlider = document.getElementById('col-slider');
    const rowSlider = document.getElementById('row-slider');
    if (colSlider) { colSlider.value = cols; document.getElementById('col-val').textContent = cols; }
    if (rowSlider) { rowSlider.value = rows; document.getElementById('row-val').textContent = rows; }

    // Grid / tokens / walls / labels / covers / traps
    grid    = s.grid    || {};
    tokens  = (s.tokens || []).map(t => ({
      ...t,
      conditions: [...(t.conditions || [])],
      deathSaves: { ...(t.deathSaves || { successes:0, failures:0 }) },
    }));
    walls   = (s.walls  || []).map(w => ({ ...w }));
    labels  = (s.labels || []).map(l => ({ ...l }));
    lights  = (s.lights || []).map(l => ({ ...l }));
    covers  = { ...(s.covers || {}) };
    traps   = JSON.parse(JSON.stringify(s.traps || {}));

    // Fog
    fogEnabled = !!s.fogEnabled;
    for (const k of Object.keys(fogVis))    delete fogVis[k];
    for (const k of Object.keys(fogTarget)) delete fogTarget[k];
    Object.assign(fogVis,    s.fogVis    || {});
    Object.assign(fogTarget, s.fogTarget || {});
    const fb = document.getElementById('fog-btn');
    if (fb) {
      fb.classList.toggle('active', fogEnabled);
      document.getElementById('fog-panel').style.display = fogEnabled ? 'flex' : 'none';
    }

    // Projection bounds
    projBounds = s.projBounds ? { ...s.projBounds } : null;

    // Initiative
    initiative  = (s.initiative || []).map(e => ({ ...e }));
    initCurrent = typeof s.initCurrent === 'number' ? s.initCurrent : -1;
    roundNum    = s.roundNum || 1;
    if (typeof renderInitiative === 'function') renderInitiative();

    // Background map image (data URL)
    if (s.bgImageDataUrl && s.bgImageDataUrl !== window._bgImageDataUrl) {
      window._bgImageDataUrl = s.bgImageDataUrl;
      const img = new Image();
      img.onload = () => { bgImage = img; };
      img.src = s.bgImageDataUrl;
    } else if (!s.bgImageDataUrl && window._bgImageDataUrl) {
      bgImage = null; window._bgImageDataUrl = null;
    }

    // Re-render — wrap in try/catch so a single bad field can't blank the page.
    try {
      if (typeof resize === 'function') resize();
      else if (typeof rebuildCells === 'function') rebuildCells();
    } catch (renderErr) {
      try { console.warn('[arcane] re-render after grid_state failed:', renderErr); } catch(e){}
    }
    // Tell the sync layer that our local state already matches `s`, so we
    // don't immediately push it back to the server in an echo loop.
    try {
      const snap = captureGridState();
      if (typeof window.__mpNoteSynced === 'function') window.__mpNoteSynced(snap);
    } catch (e) {}
  }

  // Expose so MP IIFE can call into us
  window.__applyMpGridState = applyGridState;

  // ── DM-side debounced push ─────────────────────────────────────
  let pending = false;
  let pendingTimer = null;
  let lastSnapshotJson = '';
  let inflight = false;

  async function flushSync() {
    if (typeof window.__mpApi !== 'function')     return;
    if (typeof window.__mpRoom !== 'function')    return;
    const room = window.__mpRoom();
    const myId = window.__mpMyId && window.__mpMyId();
    if (!room || !myId)                            return;
    if (inflight) { pending = true; return; }

    inflight = true;
    pending = false;
    try {
      const snap     = captureGridState();
      const snapJson = JSON.stringify(snap);
      // Skip if nothing changed since the last successful push
      if (snapJson === lastSnapshotJson) {
        inflight = false;
        return;
      }
      // Everyone in the room pushes. The server merges:
      //   • DM pushes replace the full state.
      //   • Non-DM pushes only update the `tokens` field —
      //     preserving the DM's effects / walls / fog / etc.
      await window.__mpApi('/api/grid_state', { room, player_id: myId, state: snap });
      lastSnapshotJson = snapJson;
    } catch (e) {
      // Silent — next mutation will retry
    } finally {
      inflight = false;
      if (pending) scheduleSync();
    }
  }

  function scheduleSync() {
    pending = true;
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      flushSync();
    }, DEBOUNCE_MS);
  }

  // Public entry point: anything that mutates the grid calls this.
  window.__mpScheduleSync = scheduleSync;

  // Also push periodically as a safety net (catches any mutations that
  // forgot to call __mpScheduleSync — e.g., direct token edits via the
  // modal). Runs for everyone in a room, not just the DM.
  setInterval(() => {
    if (window.__mpRoom && window.__mpRoom()) scheduleSync();
  }, 2000);

  // Public so applyGridState can mark a received state as already-synced
  // (prevents the player echoing the DM's state right back at the server).
  window.__mpNoteSynced = function (state) {
    try { lastSnapshotJson = JSON.stringify(state); } catch (e) {}
  };
})();

// ═══════════════════════════════════════════════════════════════════
// 🎁 DM "Send Item" modal + player "Item Received" toast
// ═══════════════════════════════════════════════════════════════════
(function () {
  // ── DM-side modal ─────────────────────────────────────────────
  const btn       = document.getElementById('mp-dm-give-item-btn');
  const overlay   = document.getElementById('give-item-overlay');
  const closeBtn  = document.getElementById('gi-close');
  const sendBtn   = document.getElementById('gi-send-btn');
  const targetSel = document.getElementById('gi-target');
  const nameIn    = document.getElementById('gi-name');
  const qtyIn     = document.getElementById('gi-qty');
  const wtIn      = document.getElementById('gi-weight');
  const notesIn   = document.getElementById('gi-notes');

  function refreshTargets() {
    if (!targetSel) return;
    const prev = targetSel.value;
    targetSel.innerHTML = '';
    const optAll = document.createElement('option');
    optAll.value = 'all'; optAll.textContent = '👥 Whole Party';
    targetSel.appendChild(optAll);
    if (window.mpPlayers) {
      const { dmId, myId, players } = window.mpPlayers();
      Object.entries(players).forEach(([id, name]) => {
        if (id === myId) return;
        const o = document.createElement('option');
        o.value = id; o.textContent = '🧙 ' + name;
        targetSel.appendChild(o);
      });
    }
    if (prev && [...targetSel.options].some(o => o.value === prev)) {
      targetSel.value = prev;
    }
  }

  function openModal() {
    if (!window.mpInRoom || !window.mpInRoom()) {
      alert('Open or join a multiplayer room first.');
      return;
    }
    refreshTargets();
    nameIn.value = '';
    qtyIn.value  = '1';
    wtIn.value   = '0';
    notesIn.value = '';
    overlay.classList.add('open');
    setTimeout(() => nameIn.focus(), 50);
  }
  function closeModal() { overlay.classList.remove('open'); }

  if (btn) btn.addEventListener('click', openModal);
  if (closeBtn) closeBtn.addEventListener('click', closeModal);
  if (overlay) overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });
  if (targetSel) {
    targetSel.addEventListener('mousedown', refreshTargets);
    targetSel.addEventListener('focus',     refreshTargets);
  }
  if (window.mpOnPlayersChanged) window.mpOnPlayersChanged(refreshTargets);

  function doSend() {
    if (!window.mpSend || !window.mpInRoom || !window.mpInRoom()) return;
    const name = (nameIn.value || '').trim();
    if (!name) { nameIn.focus(); return; }
    const qty  = Math.max(1, parseInt(qtyIn.value) || 1);
    const wt   = Math.max(0, parseFloat(wtIn.value) || 0);
    const notes = (notesIn.value || '').trim();
    const target = targetSel.value || 'all';
    const payload = '__GIVEITEM__:' + JSON.stringify({
      name, qty, weight: wt, notes,
    });
    window.mpSend(payload, target);

    // DM feedback: jump to the relevant tab so they see the card go out
    if (target !== 'all' && window.mpSwitchTab) window.mpSwitchTab(target);
    else if (window.mpSwitchTab) window.mpSwitchTab('all');

    closeModal();
  }
  if (sendBtn) sendBtn.addEventListener('click', doSend);
  [nameIn, qtyIn, wtIn].forEach(el => {
    if (el) el.addEventListener('keydown', e => { if (e.key === 'Enter') doSend(); });
  });

  // ── Player-side toast ────────────────────────────────────────
  const toast     = document.getElementById('item-received-toast');
  const toastTitle  = document.getElementById('item-received-title');
  const toastDetail = document.getElementById('item-received-detail');
  const toastDismiss = document.getElementById('item-received-dismiss');
  let _toastTimer = null;

  window.arcaneShowItemToast = function (item, fromName, sheetName) {
    if (!toast) return;
    const qty = Number(item.qty) || 1;
    const wt  = Number(item.weight) || 0;
    toastTitle.textContent = `Received ${qty}× ${item.name}`;
    const sub = [];
    if (fromName)   sub.push(`from ${fromName}`);
    if (sheetName)  sub.push(`→ ${sheetName}'s inventory`);
    if (wt > 0)     sub.push(`${(wt * qty).toFixed(1)} lb`);
    toastDetail.textContent = sub.join(' · ');
    toast.style.display = 'flex';
    if (_toastTimer) clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => { toast.style.display = 'none'; }, 6000);
  };
  if (toastDismiss) toastDismiss.addEventListener('click', () => {
    toast.style.display = 'none';
    if (_toastTimer) clearTimeout(_toastTimer);
  });
})();

// ═══════════════════════════════════════════════════════════════════
// 🔥 PICK UP TORCH — player stands on a light tile, clicks to take it.
// The light leaves the map, joins their inventory equipped, and extends
// their effective vision (max of their natural vision and the torch).
// ═══════════════════════════════════════════════════════════════════
(function () {
  const btn = document.getElementById('pickup-light-btn');
  if (!btn) return;

  // Per-frame check (cheap — just iterating lights × tokens once)
  function detectPickup() {
    if (typeof window.arcaneSheet !== 'function') return null;
    const sheet = window.arcaneSheet();
    if (!sheet || !sheet.id) return null;
    // Any token owned by this player's active character?
    const myTokens = tokens.filter(t => t.ownerSheetId === sheet.id);
    if (myTokens.length === 0) return null;
    // Light on the same cell as any of those tokens?
    for (const tok of myTokens) {
      const lit = lights.find(l => l.r === tok.r && l.c === tok.c);
      if (lit) return { sheet, token: tok, light: lit };
    }
    return null;
  }

  // Refresh the floating button visibility periodically
  setInterval(() => {
    const pick = detectPickup();
    if (pick) {
      btn.textContent = `🔥 Pick Up ${pick.light.name || 'Light'}`;
      btn.dataset.lightId = pick.light.id;
      btn.style.display = 'block';
    } else {
      btn.style.display = 'none';
      btn.dataset.lightId = '';
    }
  }, 400);

  btn.addEventListener('click', () => {
    const pick = detectPickup();
    if (!pick) return;
    const { sheet, token, light } = pick;

    pushUndo();

    // 1) Add the light to the active sheet's inventory, equipped
    if (!Array.isArray(sheet.inventory)) sheet.inventory = [];
    sheet.inventory.push({
      id:          'it_' + Math.random().toString(36).slice(2, 9),
      name:        light.name || 'Torch',
      qty:         1,
      weight:      1,
      equipped:    true,
      lightRadius: light.radius || 5,
      notes:       'Picked up — illuminates ' + (light.radius || 5) + ' sq when equipped',
    });
    if (typeof window.__arcaneSaveSheets === 'function') window.__arcaneSaveSheets();

    // 2) Reflect on the token so other clients see the enhanced vision
    token.equippedLight = {
      radius: light.radius || 5,
      name:   light.name   || 'Torch',
    };

    // 3) Remove the light source from the map
    lights = lights.filter(l => l.id !== light.id);

    // 4) Refresh sheet panel if it's currently showing this character
    if (typeof window.arcaneOpenSheetTo === 'function' &&
        sheet && sheet.id) {
      // No-op if nothing's open — but if it IS, refresh inventory
      try { window.arcaneRefreshInventory && window.arcaneRefreshInventory(); } catch (e) {}
    }

    // 5) Sync to all clients
    if (window.__mpScheduleSync) window.__mpScheduleSync();

    // Brief confirmation animation
    btn.textContent = '✓ Picked up!';
    setTimeout(() => { btn.style.display = 'none'; }, 600);
  });
})();
