// static/js/house-builder.module.js
import * as THREE from "three";

/* =========================
   Room color utilities
   ========================= */
const basePalette = [
  "#38bdf8", "#f97316", "#6d28d9", "#f9a8d4", "#22c55e", "#a3e635",
  "#f59e0b", "#0ea5e9", "#ef4444", "#8b5cf6", "#14b8a6", "#facc15",
  "#84cc16", "#eab308", "#06b6d4", "#d946ef", "#fb7185", "#93c5fd"
];
const seededRooms = {
  living:"#38bdf8", bedroom:"#6d28d9", kitchen:"#0ea5e9",
  bathroom:"#f97316", corridor:"#a3e635"
};
function makeRoomColorGetter(seedMap) {
  const map = { ...seededRooms, ...(seedMap || {}) };
  let idx = 0;
  return room => {
    if (!room) return null;
    if (map[room]) return map[room];
    const col = basePalette[idx++ % basePalette.length];
    map[room] = col;
    return col;
  };
}

// --- uniform colors for all doors/windows ---
const DOOR_COLOR   = 0x8b5e3c;
const WINDOW_COLOR = 0x22c55e;

/* =========================
   Small helpers
   ========================= */
const EPS = 1e-6;
const overlapLen = (a1, a2, b1, b2) => Math.max(0, Math.min(a2,b2) - Math.max(a1,b1));

function addBox(parent, sx, sy, sz, cx, cy, cz, mat) {
  const geo = new THREE.BoxGeometry(Math.max(.02, sx), Math.max(.02, sy), Math.max(.02, sz));
  const m = new THREE.Mesh(geo, mat);
  m.position.set(cx, cy, cz);
  parent.add(m);
  return m;
}

function cutBarsAlongAxis(a0, a1, openingsAB) {
  const bars = [];
  let cursor = a0;
  openingsAB.sort((A,B) => A.a - B.a);
  for (const o of openingsAB) {
    const a = Math.max(a0, o.a), b = Math.min(a1, o.b);
    if (b > a + EPS) {
      if (a > cursor + EPS) bars.push({ a: cursor, b: a });
      cursor = b;
    }
  }
  if (cursor < a1 - EPS) bars.push({ a: cursor, b: a1 });
  return bars;
}

/* =========================
   Merge co-linear walls
   ========================= */
function mergeColinearWalls(walls, {
  posTol = 0.10,
  gapTol = 0.35,
  thicknessBlend = (a,b) => Math.max(a,b)
} = {}) {
  const horiz = walls.filter(w => w.orient === 'h').slice();
  const vert  = walls.filter(w => w.orient === 'v').slice();

  function merge1D(items, axisMin, axisMax, fixedKey, toWall) {
    items.sort((a,b) => a[fixedKey] - b[fixedKey]);
    const groups = [];
    for (const it of items) {
      let g = groups[groups.length - 1];
      if (!g || Math.abs(g.fixed - it[fixedKey]) > posTol) {
        g = { fixed: it[fixedKey], arr: [] };
        groups.push(g);
      }
      g.arr.push(it);
    }
    const merged = [];
    for (const g of groups) {
      g.arr.sort((a,b) => a[axisMin] - b[axisMin]);
      let cur = { ...g.arr[0] };
      for (let i = 1; i < g.arr.length; i++) {
        const nx = g.arr[i];
        const gap = nx[axisMin] - cur[axisMax];
        const overlap = overlapLen(cur[axisMin], cur[axisMax], nx[axisMin], nx[axisMax]);
        if (gap <= gapTol || overlap > 0) {
          cur[axisMax] = Math.max(cur[axisMax], nx[axisMax]);
          cur.th = thicknessBlend(cur.th, nx.th);
          cur.len = Math.max(cur.len, nx.len);
          cur.room = cur.room || nx.room;
        } else {
          merged.push(toWall(cur));
          cur = { ...nx };
        }
      }
      merged.push(toWall(cur));
    }
    return merged;
  }

  const mergedH = merge1D(
    horiz.map(w => ({...w, x1:w.x1, x2:w.x2, fixed:w.cz})),
    "x1","x2","fixed",
    cur => ({
      orient: 'h',
      th: cur.th,
      len: cur.x2 - cur.x1,
      x1: cur.x1, x2: cur.x2,
      z1: cur.fixed, z2: cur.fixed,
      cx: (cur.x1 + cur.x2)/2,
      cz: cur.fixed,
      room: cur.room
    })
  );

  const mergedV = merge1D(
    vert.map(w => ({...w, z1:w.z1, z2:w.z2, fixed:w.cx})),
    "z1","z2","fixed",
    cur => ({
      orient: 'v',
      th: cur.th,
      len: cur.z2 - cur.z1,
      x1: cur.fixed, x2: cur.fixed,
      z1: cur.z1, z2: cur.z2,
      cx: cur.fixed,
      cz: (cur.z1 + cur.z2)/2,
      room: cur.room
    })
  );

  return [...mergedH, ...mergedV];
}

/* =========================
   Footprint / perimeter helpers
   ========================= */
function computeFootprintBBox(walls, fallbackRect){
  if (!walls || !walls.length) return { ...fallbackRect };
  let minX = +Infinity, maxX = -Infinity, minZ = +Infinity, maxZ = -Infinity;
  for (const w of walls) {
    const xlo = Math.min(w.x1, w.x2), xhi = Math.max(w.x1, w.x2);
    const zlo = Math.min(w.z1, w.z2), zhi = Math.max(w.z1, w.z2);
    if (xlo < minX) minX = xlo;
    if (xhi > maxX) maxX = xhi;
    if (zlo < minZ) minZ = zlo;
    if (zhi > maxZ) maxZ = zhi;
  }
  return { minX, maxX, minZ, maxZ };
}
function expandRect(rect, pad){
  return {
    minX: rect.minX - pad,
    maxX: rect.maxX + pad,
    minZ: rect.minZ - pad,
    maxZ: rect.maxZ + pad
  };
}
function clampRectToFloor(rect, floorRect){
  return {
    minX: Math.max(floorRect.minX, rect.minX),
    maxX: Math.min(floorRect.maxX, rect.maxX),
    minZ: Math.max(floorRect.minZ, rect.minZ),
    maxZ: Math.min(floorRect.maxZ, rect.maxZ),
  };
}
function rectWidth(r){ return r.maxX - r.minX; }
function rectDepth(r){ return r.maxZ - r.minZ; }
function rectCenter(r){ return { x:(r.minX+r.maxX)/2, z:(r.minZ+r.maxZ)/2 }; }
function makeCenteredRect(w, d){
  const hw = w * 0.5, hd = d * 0.5;
  return { minX:-hw, maxX: hw, minZ:-hd, maxZ: hd };
}
// Recenter a shared rect for this floor, clamped to the floor’s max size
function perimRectForFloor(sharedRect, floorRect){
  const w = Math.min(rectWidth(sharedRect), rectWidth(floorRect));
  const d = Math.min(rectDepth(sharedRect), rectDepth(floorRect));
  return makeCenteredRect(w, d);
}
function addPerimeterRectWalls(group, colliders, {
  rect, wallH, yOffset, thickness = 0.18, mat, outset = 0.0
}) {
  const w = Math.max(0.01, rect.maxX - rect.minX);
  const d = Math.max(0.01, rect.maxZ - rect.minZ);

  const southZ = rect.minZ - outset + thickness / 2;
  const northZ = rect.maxZ + outset - thickness / 2;
  const westX  = rect.minX - outset + thickness / 2;
  const eastX  = rect.maxX + outset - thickness / 2;

  const south = addBox(group, w, wallH, thickness,
    (rect.minX + rect.maxX)/2, yOffset + wallH/2, southZ, mat);
  south.userData.kind='wall'; colliders.push(south);

  const north = addBox(group, w, wallH, thickness,
    (rect.minX + rect.maxX)/2, yOffset + wallH/2, northZ, mat);
  north.userData.kind='wall'; colliders.push(north);

  const west = addBox(group, thickness, wallH, d,
    westX, yOffset + wallH/2, (rect.minZ + rect.maxZ)/2, mat);
  west.userData.kind='wall'; colliders.push(west);

  const east = addBox(group, thickness, wallH, d,
    eastX, yOffset + wallH/2, (rect.minZ + rect.maxZ)/2, mat);
  east.userData.kind='wall'; colliders.push(east);
}

/* =========================
   XY transform helpers (to sync to base footprint)
   ========================= */
function transformXZ(x, z, srcRect, dstRect, {uniform=true}={}){
  const sc = rectCenter(srcRect), dc = rectCenter(dstRect);
  const sx = rectWidth(dstRect) / Math.max(1e-6, rectWidth(srcRect));
  const sz = rectDepth(dstRect) / Math.max(1e-6, rectDepth(srcRect));
  const s  = uniform ? Math.min(sx, sz) : null;
  const nx = dc.x + (x - sc.x) * (uniform ? s : sx);
  const nz = dc.z + (z - sc.z) * (uniform ? s : sz);
  return { x:nx, z:nz };
}
function transformPrimitiveXZ(o, srcRect, dstRect, opt){
  const a = transformXZ(o.x1, o.z1, srcRect, dstRect, opt);
  const b = transformXZ(o.x2, o.z2, srcRect, dstRect, opt);
  const c = transformXZ(o.cx, o.cz, srcRect, dstRect, opt);
  return {
    ...o,
    x1:Math.min(a.x,b.x), x2:Math.max(a.x,b.x),
    z1:Math.min(a.z,b.z), z2:Math.max(a.z,b.z),
    cx:c.x, cz:c.z,
    sx:Math.abs(b.x-a.x), sz:Math.abs(b.z-a.z)
  };
}

/* =========================
   Attach utils
   ========================= */
function openingTouchesWall(wall, open) {
  const nearTol = Math.max(0.18, wall.th * 1.1);
  if (wall.orient === 'h') {
    const near = Math.abs(open.cz - wall.cz) <= nearTol;
    const ol   = overlapLen(wall.x1, wall.x2, open.x1, open.x2);
    return near && ol >= 0.005;
  } else {
    const near = Math.abs(open.cx - wall.cx) <= nearTol;
    const ol   = overlapLen(wall.z1, wall.z2, open.z1, open.z2);
    return near && ol >= 0.005;
  }
}

// Clamp opening to a wall run, with padding and nibs
function clampOpeningToWallPadded(wall, a, b, {
  pad = 0.18,
  margin = 0.003,
  edgeNib = 0.05
} = {}) {
  let aa = Math.min(a, b) - pad;
  let bb = Math.max(a, b) + pad;
  const lo = (wall.orient === 'h') ? wall.x1 + Math.max(margin, edgeNib)
                                   : wall.z1 + Math.max(margin, edgeNib);
  const hi = (wall.orient === 'h') ? wall.x2 - Math.max(margin, edgeNib)
                                   : wall.z2 - Math.max(margin, edgeNib);
  aa = Math.max(lo, aa);
  bb = Math.min(hi, bb);
  if (bb < aa + EPS) return null;
  return { a: aa, b: bb };
}

function snapAndMergeOpenings(opensAB, wallMin, wallMax, {
  barSnapTol = 0.22,
  snapEndTol = 0.30,
  minOpenLen = 0.50
} = {}) {
  if (!opensAB.length) return opensAB;

  for (const o of opensAB) {
    o.a = Math.max(wallMin, Math.min(o.a, o.b));
    o.b = Math.min(wallMax, Math.max(o.a, o.b));
  }
  opensAB.sort((A,B) => A.a - B.a);

  const first = opensAB[0];
  if (first.a - wallMin <= snapEndTol) first.a = wallMin;
  const last = opensAB[opensAB.length - 1];
  if (wallMax - last.b <= snapEndTol) last.b = wallMax;

  const merged = [];
  let cur = { ...opensAB[0] };
  for (let i = 1; i < opensAB.length; i++) {
    const next = opensAB[i];
    const gap = next.a - cur.b;
    if (gap <= barSnapTol) {
      cur.b = Math.max(cur.b, next.b);
      cur.o = cur.o || next.o;
    } else {
      merged.push(cur);
      cur = { ...next };
    }
  }
  merged.push(cur);

  for (const o of merged) {
    if ((o.b - o.a) < minOpenLen) {
      const need = (minOpenLen - (o.b - o.a)) / 2;
      o.a = Math.max(wallMin, o.a - need);
      o.b = Math.min(wallMax, o.b + need);
    }
  }
  return merged;
}

/* =========================
   Legacy perimeter (not used when syncing)
   ========================= */
function addPerimeterWalls(group, colliders, { floorW, floorD, wallH, ox, oz, yOffset, thickness = 0.18, mat }) {
  const zS = oz + thickness / 2;
  const south = addBox(group, floorW, wallH, thickness, ox + floorW / 2, yOffset + wallH / 2, zS, mat); colliders.push(south);
  const zN = oz + floorD - thickness / 2;
  const north = addBox(group, floorW, wallH, thickness, ox + floorW / 2, yOffset + wallH / 2, zN, mat); colliders.push(north);
  const xW = ox + thickness / 2;
  const west = addBox(group, thickness, wallH, floorD, xW, yOffset + wallH / 2, oz + floorD / 2, mat); colliders.push(west);
  const xE = ox + floorW - thickness / 2;
  const east = addBox(group, thickness, wallH, floorD, xE, yOffset + wallH / 2, oz + floorD / 2, mat); colliders.push(east);
}

/* =========================
   Kind normalization
   ========================= */
function normalizeKind(raw) {
  if (raw == null) return null;
  if (typeof raw === "object") {
    const v = raw.name ?? raw.label ?? raw.type ?? null;
    if (v != null) return String(v).toLowerCase().trim();
  }
  return String(raw).toLowerCase().trim();
}
function pickKind({ i, p, clsArray }) {
  const raw =
    p?.kind ?? p?.type ?? p?.cls ?? p?.class ??
    (clsArray && clsArray[i] && (clsArray[i].name ?? clsArray[i].type ?? clsArray[i].label)) ?? null;
  const k = normalizeKind(raw);
  if (!k) return "wall";
  if (k.startsWith("wal")) return "wall";
  if (k.startsWith("win")) return "window";
  if (k.startsWith("doo")) return "door";
  if (k === "walls") return "wall";
  if (k === "windows") return "window";
  if (k === "doors") return "door";
  if (k === "1" || k === "0" || k === "wallid") return "wall";
  if (k === "2") return "window";
  if (k === "3") return "door";
  return k;
}

/* =========================
   Scoring: best wall for an opening
   ========================= */
function scoreOpeningForWall(w, o) {
  const axisOverlap = (w.orient === 'h')
    ? overlapLen(w.x1, w.x2, o.x1, o.x2)
    : overlapLen(w.z1, w.z2, o.z1, o.z2);
  if (axisOverlap <= 0) return Infinity;

  const perp = (w.orient === 'h') ? Math.abs(o.cz - w.cz) : Math.abs(o.cx - w.cx);

  const longSide  = Math.max(Math.abs(o.x2 - o.x1), Math.abs(o.z2 - o.z1));
  const shortSide = Math.min(Math.abs(o.x2 - o.x1), Math.abs(o.z2 - o.z1));
  const thickFit  = Math.abs(shortSide - w.th);

  const lengthPenalty = Math.max(0, (longSide - axisOverlap));
  return 3.0 * perp + 4.0 * thickFit + 1.5 * lengthPenalty - 1.0 * axisOverlap;
}

/* =======================================================================
   buildGroupFromFloors  (main export)
   ======================================================================= */
export default function buildGroupFromFloors(floors, opts = {}) {
  const {
    unitPerPx = 0.01,
    floorHeight = 3.0,
    slab = 0.30,
    sill = 1.0,
    windowHeight = 1.2,
    useRoomColors = true,
    roomColorSeedMap = undefined,

    // perimeter controls
    perimeterMode = "footprint",   // "footprint" | "image" | "off"
    perimeterThickness = 0.18,
    perimeterMargin = 0.00,        // no padding outside objects
    perimeterOutset = 0.0,         // keep 0 as requested
    addPerimeterIfSparse = true,   // legacy
    perimeterCoverage = 0.30,      // legacy

    // openings shaping
    openPad = 0.22,
    minOpenLen = 0.50,
    doorSnapFactor = 0.7,
    barSnapTol = 0.22,
    snapEndTol = 0.30,

    // NEW: sync all floors to ground floor footprint
    syncPerimeterAcrossFloors = true,
    baseFloorIndex = 0,
    uniformScaleContents = true,

    // keep explicit to avoid runtime ReferenceErrors
    windowExtra = 0.0,

    debug = false,
  } = opts;

  const group = new THREE.Group();
  const colliders = [];
  const floorMeshes = [];
  const getRoomColor = makeRoomColorGetter(roomColorSeedMap);
  let totalHeight = 0;
  const debugInfo = { floors: [] };

  // ---------- PRE-PASS: compute BASE (ground) footprint rectangle (centered, no padding) ----------
  let baseRectCentered = null;
  if (syncPerimeterAcrossFloors && floors.length) {
    const base = floors[Math.max(0, Math.min(baseFloorIndex, floors.length-1))];
    if (base) {
      const U = unitPerPx;
      const W = base.Width ?? 1000;
      const H = base.Height ?? 1000;
      const floorW = W * U, floorD = H * U;
      const ox = -floorW/2, oz = -floorD/2;

      // collect base-floor raw walls
      const pts = base.points || [];
      const cls = base.classes || [];
      const rawWallsBase = [];
      for (let i=0;i<pts.length;i++){
        const p = pts[i];
        const name = normalizeKind(p?.kind ?? p?.type ?? p?.cls ?? p?.class ??
                                   (cls && cls[i] && (cls[i].name ?? cls[i].type ?? cls[i].label)) ?? "wall");
        if (!name || !name.startsWith("wal")) continue;

        const x1 = (p.x1 * U), y1 = (p.y1 * U), x2 = (p.x2 * U), y2 = (p.y2 * U);
        const sx = (x2 - x1),  sz = (y2 - y1);
        const orient = (Math.abs(sx) >= Math.abs(sz)) ? 'h' : 'v';
        const th = Math.min(Math.abs(sx), Math.abs(sz));
        const cx = ox + (x1 + x2)/2, cz = oz + (y1 + y2)/2;

        rawWallsBase.push({
          orient,
          th: Math.max(.08, th),
          len: Math.max(Math.abs(sx), Math.abs(sz)),
          x1: ox + Math.min(x1, x2), x2: ox + Math.max(x1, x2),
          z1: oz + Math.min(y1, y2), z2: oz + Math.max(y1, y2),
          cx, cz, room: p.room
        });
      }

      const wallsMerged = mergeColinearWalls(rawWallsBase);
      const floorRect   = { minX: ox, maxX: ox + floorW, minZ: oz, maxZ: oz + floorD };
      const rawRect     = computeFootprintBBox(wallsMerged, floorRect);
      const clamped     = clampRectToFloor(rawRect, floorRect);
      baseRectCentered  = makeCenteredRect(rectWidth(clamped), rectDepth(clamped));
    }
  }

  // ---------- MAIN LOOP ----------
  for (let idx = 0; idx < floors.length; idx++) {
    const data = floors[idx]; if (!data) continue;

    const wallH = floorHeight, doorH = 2.1;
    const winH  = Math.max(0.40, windowHeight);
    const U     = unitPerPx;

    const W = data.Width ?? 1000;
    const H = data.Height ?? 1000;
    const floorW = W * U, floorD = H * U;

    const yOffset = idx * (floorHeight + slab);
    const ox = -floorW/2, oz = -floorD/2;

    // materials
    const baseWallMat   = new THREE.MeshStandardMaterial({ color: 0x334155 });
    const doorMat       = new THREE.MeshStandardMaterial({ color: DOOR_COLOR, metalness: 0.1, roughness: 0.8 });
    const windowBandMat = new THREE.MeshStandardMaterial({
      color: WINDOW_COLOR, transparent: true, opacity: 0.48, depthWrite: false, side: THREE.DoubleSide
    });

    // classify points -> raw walls, doors, windows (world coords centered at image)
    const pts = data.points || [];
    const cls = data.classes || [];
    let rawWalls = [], doors = [], wins = [];

    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const kind = pickKind({ i, p, clsArray: cls });
      const room = p.room;
      const x1 = (p.x1 * U), y1 = (p.y1 * U), x2 = (p.x2 * U), y2 = (p.y2 * U);
      const sx = (x2 - x1),  sz = (y2 - y1);
      const cx = ox + (x1 + x2)/2, cz = oz + (y1 + y2)/2;

      if (kind === "wall") {
        const orient = (Math.abs(sx) >= Math.abs(sz)) ? 'h' : 'v';
        const th = Math.min(Math.abs(sx), Math.abs(sz));
        rawWalls.push({
          orient,
          th: Math.max(.08, th),
          len: Math.max(Math.abs(sx), Math.abs(sz)),
          x1: ox + Math.min(x1, x2), x2: ox + Math.max(x1, x2),
          z1: oz + Math.min(y1, y2), z2: oz + Math.max(y1, y2),
          cx, cz, room
        });
      } else if (kind === "door") {
        doors.push({
          type:'door',
          x1: ox + Math.min(x1,x2), x2: ox + Math.max(x1,x2),
          z1: oz + Math.min(y1,y2), z2: oz + Math.max(y1,y2),
          cx, cz, sx: Math.abs(sx), sz: Math.abs(sz), room
        });
      } else if (kind === "window") {
        wins.push({
          type:'window',
          x1: ox + Math.min(x1,x2), x2: ox + Math.max(x1,x2),
          z1: oz + Math.min(y1,y2), z2: oz + Math.max(y1,y2),
          cx, cz, sx: Math.abs(sx), sz: Math.abs(sz), room
        });
      }
    }

    const imageRect = { minX: ox, maxX: ox + floorW, minZ: oz, maxZ: oz + floorD };

    // ----- Compute this floor's tight perimeter (no padding), then sync to base -----
    let perimRect;
    if (syncPerimeterAcrossFloors && baseRectCentered) {
      // Tight footprint from THIS floor's objects (no padding & clamped)
      const rawRectThis = computeFootprintBBox(rawWalls, imageRect);
      const clampedThis = clampRectToFloor(rawRectThis, imageRect);
      // Transform ALL content to base footprint (uniform, centered)
      for (let i=0;i<rawWalls.length;i++) rawWalls[i] = transformPrimitiveXZ(rawWalls[i], clampedThis, baseRectCentered, {uniform: uniformScaleContents});
      for (let i=0;i<doors.length;i++)    doors[i]    = transformPrimitiveXZ(doors[i],    clampedThis, baseRectCentered, {uniform: uniformScaleContents});
      for (let i=0;i<wins.length;i++)     wins[i]     = transformPrimitiveXZ(wins[i],     clampedThis, baseRectCentered, {uniform: uniformScaleContents});
      // Use the base rect for floor/slab/perimeter
      perimRect = { ...baseRectCentered };
    } else if (perimeterMode === "off") {
      perimRect = imageRect;
    } else if (perimeterMode === "image") {
      perimRect = makeCenteredRect(rectWidth(imageRect), rectDepth(imageRect));
    } else { // "footprint" tight & centered on this floor only
      const rawRect = computeFootprintBBox(rawWalls, imageRect);
      const clamped = clampRectToFloor(expandRect(rawRect, Math.max(0, perimeterMargin)), imageRect);
      perimRect = makeCenteredRect(rectWidth(clamped), rectDepth(clamped));
    }

    // Merge walls (after potential transform)
    const walls = mergeColinearWalls(rawWalls);
    if (debug) {
      console.log(`[builder] floor ${idx}: walls=${rawWalls.length} -> merged=${walls.length}, doors=${doors.length}, windows=${wins.length}`);
    }

    // average door width (meters)
    let avgDoorM = null;
    if (typeof data.averageDoor === "number" && !Number.isNaN(data.averageDoor)) {
      avgDoorM = Math.max(0.6, Math.min(1.2, data.averageDoor * U));
    }

    // ---------- Build FLOOR & SLAB from shared perimeter ----------
    const prW  = Math.max(0.01, perimRect.maxX - perimRect.minX);
    const prD  = Math.max(0.01, perimRect.maxZ - perimRect.minZ);
    const prC  = rectCenter(perimRect);

    const floorMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(prW, prD),
      new THREE.MeshStandardMaterial({ color: 0xf1f5f9, roughness: 1 })
    );
    floorMesh.rotation.x = -Math.PI/2;
    floorMesh.position.set(prC.x, yOffset, prC.z);
    floorMesh.receiveShadow = true;
    group.add(floorMesh);
    floorMeshes.push(floorMesh);

    if (slab > 0.01) {
      const slabMesh = new THREE.Mesh(
        new THREE.BoxGeometry(prW, slab, prD),
        new THREE.MeshStandardMaterial({ color: 0xe2e8f0, roughness: 1 })
      );
      slabMesh.position.set(prC.x, yOffset - slab/2, prC.z);
      group.add(slabMesh);
    }

    // ---------- Attach openings to best wall ----------
    const allOpenings = [...doors, ...wins];
    const wallOpenings = new Map(walls.map(w => [w, []]));
    const attached = new WeakSet();

    for (const o of allOpenings) {
      let best = null, bestScore = Infinity;
      for (const w of walls) {
        if (!openingTouchesWall(w, o)) continue;
        const s = scoreOpeningForWall(w, o);
        if (s < bestScore) { bestScore = s; best = w; }
      }
      if (best) {
        wallOpenings.get(best).push(o);
        attached.add(o);
      }
    }

    // placeholders for anything that didn’t attach (debug visibility)
    const unattached = allOpenings.filter(o => !attached.has(o));
    if (unattached.length && debug) {
      console.warn(`[builder] floor ${idx}: unattached openings =`, unattached.length);
    }
    if (unattached.length) {
      for (const o of unattached) {
        const lx = Math.abs(o.x2 - o.x1), lz = Math.abs(o.z2 - o.z1);
        if (o.type === 'window') {
          const bh = Math.max(0.4, windowHeight);
          const y = yOffset + sill + bh/2;
          const horiz = lx >= lz;
          if (horiz) addBox(group, Math.max(0.3, lx), bh, 0.04, o.cx, y, o.cz, windowBandMat).userData.kind = 'window';
          else       addBox(group, 0.04, bh, Math.max(0.3, lz), o.cx, y, o.cz, windowBandMat).userData.kind = 'window';
        } else {
          const dh = 2.1;
          if (lx >= lz) addBox(group, Math.max(0.6, lx), dh, 0.08, o.cx, yOffset + dh/2, o.cz, doorMat).userData.kind = 'door';
          else          addBox(group, 0.08, dh, Math.max(0.6, lz), o.cx, yOffset + dh/2, o.cz, doorMat).userData.kind = 'door';
        }
      }
    }

    // ---------- Build walls + attached openings ----------
    let outWalls=0,outDoors=0,outWins=0;

    for (const wseg of walls) {
      let wallMat = baseWallMat;
      if (useRoomColors && wseg.room) {
        const c = getRoomColor(wseg.room);
        if (c) wallMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(c) });
      }

      const openings = wallOpenings.get(wseg) || [];
      const wallMin = (wseg.orient === 'h') ? wseg.x1 : wseg.z1;
      const wallMax = (wseg.orient === 'h') ? wseg.x2 : wseg.z2;

      let opensAB = openings.map(o => {
        const aRaw = (wseg.orient === 'h') ? o.x1 : o.z1;
        const bRaw = (wseg.orient === 'h') ? o.x2 : o.z2;
        const padded = clampOpeningToWallPadded(wseg, aRaw, bRaw, {
          pad: Math.min(Math.max(openPad, wseg.th * 1.2), 0.25),
          margin: 0.003,
          edgeNib: 0.05
        });
        if (!padded) return null;

        if (o.type === 'door' && typeof avgDoorM === "number") {
          const need = doorSnapFactor * avgDoorM;
          const len  = Math.max(0, padded.b - padded.a);
          if (len < need) {
            const grow = (need - len) / 2;
            padded.a = Math.max(wallMin, padded.a - grow);
            padded.b = Math.min(wallMax, padded.b + grow);
          }
        }
        if ((padded.b - padded.a) < minOpenLen) {
          const extra = (minOpenLen - (padded.b - padded.a)) / 2;
          padded.a = Math.max(wallMin, padded.a - extra);
          padded.b = Math.min(wallMax, padded.b + extra);
        }
        return { a: padded.a, b: padded.b, o };
      }).filter(Boolean);

      opensAB = snapAndMergeOpenings(opensAB, wallMin, wallMax, { barSnapTol, snapEndTol, minOpenLen });

      // solid wall bars
      const bars = cutBarsAlongAxis(wallMin, wallMax, opensAB.map(x => ({ a: x.a, b: x.b })));
      for (const bar of bars) {
        if (bar.b <= bar.a + EPS) continue;
        const segLen = (bar.b - bar.a);
        if (wseg.orient === 'h') {
          const cx = (bar.a + bar.b)/2, cz = wseg.cz;
          const m = addBox(group, segLen, wallH, wseg.th, cx, yOffset + wallH/2, cz, wallMat);
          m.userData.kind='wall'; colliders.push(m); outWalls++;
        } else {
          const cz = (bar.a + bar.b)/2, cx = wseg.cx;
          const m = addBox(group, wseg.th, wallH, segLen, cx, yOffset + wallH/2, cz, wallMat);
          m.userData.kind='wall'; colliders.push(m); outWalls++;
        }
      }

      // doors & windows
      for (const pair of opensAB) {
        const o = pair.o;
        const A = pair.a, B = pair.b;
        const openLen = Math.max(0, B - A);
        if (openLen < minOpenLen) continue;

        if (o.type === 'door') {
          const lintelH = Math.max(0, wallH - doorH);

          if (lintelH > 0.02) {
            if (wseg.orient === 'h') {
              const cxL = (A+B)/2, czL = wseg.cz;
              const m = addBox(group, openLen, lintelH, wseg.th, cxL, yOffset + doorH + lintelH/2, czL, baseWallMat);
              m.userData.kind='wall'; colliders.push(m); outWalls++;
            } else {
              const cxL = wseg.cx, czL = (A+B)/2;
              const m = addBox(group, wseg.th, lintelH, openLen, cxL, yOffset + doorH + lintelH/2, czL, baseWallMat);
              m.userData.kind='wall'; colliders.push(m); outWalls++;
            }
          }

          const wallCenter = (wallMin + wallMax) / 2;
          const hingeAtA = Math.abs(A - wallCenter) <= Math.abs(B - wallCenter);
          const DOOR_OPEN = Math.PI / 10;

          if (wseg.orient === 'h') {
            const hingeX = hingeAtA ? A : B;
            const sign   = hingeAtA ? +1 : -1;
            const pivot = new THREE.Object3D();
            pivot.position.set(hingeX, yOffset, wseg.cz);
            group.add(pivot);

            const leafLen = openLen;
            const leafT   = Math.max(0.03, Math.min(wseg.th * 0.6, 0.10));
            const localCx = hingeAtA ? (openLen/2) : -(openLen/2);
            const leaf = addBox(pivot, leafLen, doorH, leafT, localCx, doorH/2, 0, doorMat);
            leaf.userData.kind='door'; outDoors++;
            pivot.rotation.y = sign * DOOR_OPEN;

          } else {
            const hingeZ = hingeAtA ? A : B;
            const sign   = hingeAtA ? -1 : +1;
            const pivot = new THREE.Object3D();
            pivot.position.set(wseg.cx, yOffset, hingeZ);
            group.add(pivot);

            const leafLen = openLen;
            const leafT   = Math.max(0.03, Math.min(wseg.th * 0.6, 0.10));
            const localCz = hingeAtA ? (openLen/2) : -(openLen/2);
            const leaf = addBox(pivot, leafT, doorH, leafLen, 0, doorH/2, localCz, doorMat);
            leaf.userData.kind='door'; outDoors++;
            pivot.rotation.y = sign * DOOR_OPEN;
          }
          continue;
        }

        if (o.type === 'window') {
          const minNib    = 0.05;
          const baseBand  = Math.max(0.40, windowHeight);
          let targetBand  = baseBand + Math.max(0, windowExtra);
          targetBand = Math.min(targetBand, wallH - 2 * minNib);

          const delta     = targetBand - baseBand;
          let bottomH     = Math.max(minNib, sill - delta * 0.5);
          let topH        = Math.max(minNib, wallH - (bottomH + targetBand));

          let overflow = bottomH + targetBand + topH - wallH;
          if (overflow > 0) {
            const shaveBottom = Math.min(overflow * 0.5, Math.max(0, bottomH - minNib));
            bottomH -= shaveBottom; overflow -= shaveBottom;
            const shaveTop = Math.min(overflow, Math.max(0, topH - minNib));
            topH -= shaveTop; overflow -= shaveTop;
            if (overflow > 0) targetBand = Math.max(0.10, targetBand - overflow);
          }

          const bandH  = targetBand;
          const bandT  = Math.max(0.02, Math.min(wseg.th * 0.6, 0.09));
          const cyBand = yOffset + bottomH + bandH / 2;

          if (wseg.orient === 'h') {
            const cx = (A+B)/2, cz = wseg.cz;
            if (bottomH > EPS) {
              const m = addBox(group, (B - A), bottomH, wseg.th,
                               cx, yOffset + bottomH/2, cz, baseWallMat);
              m.userData.kind='wall'; colliders.push(m);
            }
            if (topH > EPS) {
              const m = addBox(group, (B - A), topH, wseg.th,
                               cx, yOffset + bottomH + bandH + topH/2, cz, baseWallMat);
              m.userData.kind='wall'; colliders.push(m);
            }
            const band = addBox(group, (B - A), bandH, bandT,
                                cx, cyBand, cz, windowBandMat);
            band.userData.kind='window';
            band.renderOrder = 950; band.material.depthWrite = false;

          } else {
            const cx = wseg.cx, cz = (A+B)/2;
            if (bottomH > EPS) {
              const m = addBox(group, wseg.th, bottomH, (B - A),
                               cx, yOffset + bottomH/2, cz, baseWallMat);
              m.userData.kind='wall'; colliders.push(m);
            }
            if (topH > EPS) {
              const m = addBox(group, wseg.th, topH, (B - A),
                               cx, yOffset + bottomH + bandH + topH/2, cz, baseWallMat);
              m.userData.kind='wall'; colliders.push(m);
            }
            const band = addBox(group, bandT, bandH, (B - A),
                                cx, cyBand, cz, windowBandMat);
            band.userData.kind='window';
            band.renderOrder = 950; band.material.depthWrite = false;
          }
          continue;
        }
      }
    }

    // ---------- Perimeter walls (after openings; 0 outset; not merged with windows) ----------
    if (perimeterMode !== "off") {
      const perimeterMat = new THREE.MeshStandardMaterial({ color: 0x334155 });
      addPerimeterRectWalls(group, colliders, {
        rect: perimRect,
        wallH: floorHeight,
        yOffset,
        thickness: perimeterThickness,
        mat: perimeterMat,
        outset: perimeterOutset // stays 0
      });
    }

    // Legacy sparse perimeter (disabled when syncing)
    if (!syncPerimeterAcrossFloors) {
      const perimeter = 2 * (floorW + floorD);
      const mergedLenSum = walls.reduce((s,w) => s + w.len, 0);
      if (addPerimeterIfSparse && mergedLenSum < perimeterCoverage * perimeter && perimeterMode === "off") {
        addPerimeterWalls(group, colliders, {
          floorW, floorD, wallH, ox, oz, yOffset,
          thickness: perimeterThickness, mat: baseWallMat
        });
      }
    }

    totalHeight = Math.max(totalHeight, yOffset + wallH);

    // debug counts vs input
    const inWalls = cls.filter(c => (c?.name||"").toLowerCase().includes('wall')).length;
    const inDoors = cls.filter(c => (c?.name||"").toLowerCase().includes('door')).length;
    const inWins  = cls.filter(c => (c?.name||"").toLowerCase().includes('window')).length;

    debugInfo.floors.push({ idx, inWalls, inDoors, inWins, outWalls, outDoors, outWins });
  }

  const bbox = new THREE.Box3().setFromObject(group);
  return { group, colliders, floorMeshes, bbox, totalHeight, debugInfo };
}
