// Immersive mode — VIBE MOCKUP, pass 2. Overhead 5-mile view of the city at
// night: water + shaded building extrusions under a neon grid, volumetric
// pulsing clouds with kind-icon indicators, an alerts rail on the left and a
// mock Sia voice panel on the right (canned lines; speaks via the browser's
// built-in speech synth — no AI wired in). All data on this page is fake and
// hand-placed; live wiring waits until the direction is locked.

const canvas = document.getElementById("scene");
const ctx = canvas.getContext("2d");
const clockEl = document.getElementById("clock");

const REDUCED_MOTION = matchMedia("(prefers-reduced-motion: reduce)").matches;

// World units are miles. +x east, +z north, y up. Radius of awareness: 5.
const RADIUS = 5;

const TINTS = {
  commotion: "#ff2f6d",
  crowding: "#ff9e3d",
  gathering: "#8b5cff",
};

const KIND_LABEL = {
  commotion: "commotion",
  crowding: "crowd pressure",
  gathering: "gathering",
};

// Kind glyphs — inline SVG, filled with the indicator's tint.
const ICONS = {
  commotion:
    '<svg viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><path d="M7.2 0 2.2 7h2.9L4.6 12l5.2-7.6H6.6L7.2 0z"/></svg>',
  crowding:
    '<svg viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><circle cx="3.1" cy="4.3" r="1.8"/><circle cx="8.9" cy="4.3" r="1.8"/><circle cx="6" cy="8.7" r="1.8"/></svg>',
  gathering:
    '<svg viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><path d="M6 0l1.5 4.5L12 6 7.5 7.5 6 12 4.5 7.5 0 6l4.5-1.5L6 0z"/></svg>',
};

// Hand-placed mock clouds: Seattle-ish districts around a downtown origin.
const CLOUDS = [
  {
    id: "cap-hill",
    name: "Capitol Hill",
    kind: "commotion",
    x: 1.1, z: 0.6,
    intensity: 0.85,
    line: "Three dispatches in four blocks — the hill is loud tonight.",
  },
  {
    id: "sodo",
    name: "SoDo",
    kind: "crowding",
    x: 0.2, z: -1.8,
    intensity: 0.7,
    line: "Stadium letting out; foot traffic flooding toward the stations.",
  },
  {
    id: "ballard",
    name: "Ballard",
    kind: "gathering",
    x: -2.6, z: 3.1,
    intensity: 0.5,
    line: "Late market by the locks — busy but friendly.",
  },
  {
    id: "u-district",
    name: "U District",
    kind: "commotion",
    x: 1.7, z: 3.4,
    intensity: 0.45,
    line: "Scattered calls near the Ave. Minor, worth a glance.",
  },
  {
    id: "belltown",
    name: "Belltown",
    kind: "crowding",
    x: -0.5, z: 0.9,
    intensity: 0.6,
    line: "Bar corridor at peak churn.",
  },
  {
    id: "alki",
    name: "Alki",
    kind: "gathering",
    x: -3.4, z: -1.2,
    intensity: 0.35,
    line: "Beach crowd lingering past sunset.",
  },
];

// ——— camera ———————————————————————————————————————————————————————————

const THETA = 0.92; // ~53° above the plane — tilted enough to feel 3D
const SIN_T = Math.sin(THETA);
const COS_T = Math.cos(THETA);
const DIST = 15;

const camera = { yaw: 0, fov: 900 };

let W = 0, H = 0, CY = 0, DPR = 1;

function resize() {
  DPR = Math.min(devicePixelRatio || 1, 2);
  W = innerWidth;
  H = innerHeight;
  CY = H * 0.46;
  canvas.width = W * DPR;
  canvas.height = H * DPR;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  // The rails eat ~250px a side; fit the disc to the stage between them.
  camera.fov = Math.max(420, Math.min((W - 520) * 1.12, H * 1.45));
}
addEventListener("resize", resize);
resize();

// World → screen. Returns null when behind the camera.
function project(x, y, z) {
  const cosY = Math.cos(camera.yaw), sinY = Math.sin(camera.yaw);
  const rx = x * cosY - z * sinY;
  const rz = x * sinY + z * cosY;

  const vy = y - DIST * SIN_T;
  const vz = rz + DIST * COS_T;
  const yc = vy * COS_T + vz * SIN_T;
  const zc = -vy * SIN_T + vz * COS_T;

  if (zc < 1) return null;
  const s = camera.fov / zc;
  return { x: W / 2 + rx * s, y: CY - yc * s, s, depth: zc };
}

// Depth fog: far things sink into the void.
function fog(depth) {
  return Math.max(0, Math.min(1, 2.2 - depth / 12));
}

// ——— static geometry ———————————————————————————————————————————————————

function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Rough Seattle water: the Sound west, Lake Washington east, Lake Union
// center-north, the ship canal stitching them. Gestures, not GIS.
const WATER = [
  // Puget Sound / Elliott Bay
  [[-6, -6], [-2.6, -5.2], [-1.7, -3.4], [-1.15, -2.2], [-1.3, -1.1], [-2.1, -0.1],
   [-2.9, 0.9], [-3.3, 2.2], [-3.15, 3.4], [-3.5, 4.6], [-3.8, 6], [-6, 6]],
  // Lake Washington
  [[3.4, -6], [3.9, -3.6], [3.6, -1.4], [4.1, 0.8], [3.8, 2.6], [4.2, 4.4], [4, 6], [6, 6], [6, -6]],
  // Lake Union
  [[-0.25, 1.15], [0.35, 1.3], [0.55, 2.1], [0.3, 2.85], [-0.3, 2.7], [-0.55, 1.9]],
];

// Ship canal: drawn as a fat water-colored stroke, not a polygon.
const CANAL = [[-3.2, 2.9], [-1.6, 3.05], [-0.4, 2.55], [0.1, 2.4], [0.5, 2.3], [1.6, 2.75], [2.6, 2.6], [3.7, 2.2]];

function inWater(x, z) {
  return WATER.some((poly) => {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
      const [xi, zi] = poly[i], [xj, zj] = poly[j];
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    }
    return inside;
  });
}

// Street grid clipped to the awareness circle. Majors every 1 mi, minors 0.25.
const GRID_LINES = [];
for (let m = -RADIUS; m <= RADIUS + 1e-9; m += 0.25) {
  const major = Math.abs(m - Math.round(m)) < 1e-9;
  const half = Math.sqrt(Math.max(0, RADIUS * RADIUS - m * m));
  if (half < 0.05) continue;
  GRID_LINES.push({ a: [m, -half], b: [m, half], major });
  GRID_LINES.push({ a: [-half, m], b: [half, m], major });
}

// Two arterials — brighter diagonals so the grid reads as a real city.
const ARTERIALS = [
  [[-0.4, -4.8], [-0.2, -1.5], [0.3, 1.0], [0.1, 4.9]],
  [[-4.9, -0.6], [-1.5, -0.4], [1.8, -0.9], [4.9, -0.7]],
];

// Solid building extrusions: a dense downtown core, low sprawl elsewhere,
// nothing in the water. Sun is fixed to the city (SW light), so per-face
// brightness is precomputed and rotates with the world.
const LIGHT = [-0.45, -0.89]; // normalized, pointing from the light
const FACE_NORMALS = [[0, -1], [1, 0], [0, 1], [-1, 0]];
const FACE_LIT = FACE_NORMALS.map(([nx, nz]) => 0.35 + 0.65 * Math.max(0, nx * LIGHT[0] + nz * LIGHT[1]));

const BLOCKS = (() => {
  const rand = mulberry32(20260714);
  const blocks = [];
  while (blocks.length < 170) {
    const angle = rand() * Math.PI * 2;
    const r = Math.pow(rand(), 1.6) * 3.6;
    const x = Math.cos(angle) * r;
    const z = Math.sin(angle) * r;
    if (inWater(x, z)) continue;
    const core = r < 1.1;
    const h = core ? 0.09 + Math.pow(rand(), 1.8) * 0.5 : 0.03 + Math.pow(rand(), 2.6) * 0.14;
    const w = (core ? 0.07 : 0.06) + rand() * 0.08;
    blocks.push({ x, z, w, h });
  }
  return blocks;
})();

// Pre-rendered soft blob sprite per tint (radial gradient, drawn additively).
const SPRITES = Object.fromEntries(
  Object.entries(TINTS).map(([kind, tint]) => {
    const size = 256;
    const sprite = document.createElement("canvas");
    sprite.width = sprite.height = size;
    const sctx = sprite.getContext("2d");
    const gradient = sctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, `${tint}cc`);
    gradient.addColorStop(0.35, `${tint}55`);
    gradient.addColorStop(1, `${tint}00`);
    sctx.fillStyle = gradient;
    sctx.fillRect(0, 0, size, size);
    return [kind, sprite];
  }),
);

// A white-hot core sprite shared by every cloud — the energy at the middle.
const CORE_SPRITE = (() => {
  const size = 128;
  const sprite = document.createElement("canvas");
  sprite.width = sprite.height = size;
  const sctx = sprite.getContext("2d");
  const gradient = sctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, "rgba(255, 250, 255, 0.9)");
  gradient.addColorStop(0.4, "rgba(255, 250, 255, 0.25)");
  gradient.addColorStop(1, "rgba(255, 250, 255, 0)");
  sctx.fillStyle = gradient;
  sctx.fillRect(0, 0, size, size);
  return sprite;
})();

// Per-cloud blob field, seeded per cloud so every load breathes the same city.
for (const cloud of CLOUDS) {
  const rand = mulberry32(cloud.id.length * 7919 + Math.round(cloud.x * 100));
  const count = 5 + Math.round(cloud.intensity * 4);
  cloud.blobs = Array.from({ length: count }, () => ({
    dx: (rand() - 0.5) * 1.1 * (0.6 + cloud.intensity),
    dz: (rand() - 0.5) * 1.1 * (0.6 + cloud.intensity),
    y: 0.06 + rand() * 0.34,
    r: 0.45 + rand() * 0.65 * (0.5 + cloud.intensity),
    phase: rand() * Math.PI * 2,
    drift: 0.4 + rand() * 0.8,
  }));
  cloud.phase = rand() * Math.PI * 2;
}

// ——— draw passes ————————————————————————————————————————————————————————

function discPath() {
  const path = new Path2D();
  for (let a = 0; a <= 128; a += 1) {
    const t = (a / 128) * Math.PI * 2;
    const p = project(Math.cos(t) * RADIUS, 0, Math.sin(t) * RADIUS);
    if (!p) continue;
    if (a === 0) path.moveTo(p.x, p.y);
    else path.lineTo(p.x, p.y);
  }
  path.closePath();
  return path;
}

function polyPath(points) {
  const path = new Path2D();
  let started = false;
  for (const [x, z] of points) {
    const p = project(x, 0, z);
    if (!p) { started = false; continue; }
    if (!started) { path.moveTo(p.x, p.y); started = true; }
    else path.lineTo(p.x, p.y);
  }
  path.closePath();
  return path;
}

function drawGround(disc) {
  // Land inside the iris, water carved on top, all clipped to the disc.
  ctx.save();
  ctx.clip(disc);

  ctx.fillStyle = "#0a1122";
  ctx.fill(disc);

  const p0 = project(0, 0, 0);
  if (p0) {
    const rx = 5.6 * p0.s;
    const glow = ctx.createRadialGradient(p0.x, p0.y, 0, p0.x, p0.y, rx);
    glow.addColorStop(0, "rgba(38, 90, 150, 0.3)");
    glow.addColorStop(0.45, "rgba(24, 55, 110, 0.14)");
    glow.addColorStop(1, "rgba(10, 18, 46, 0)");
    ctx.fillStyle = glow;
    ctx.fill(disc);
  }

  // Night water is a void: darker than land, lit only at the shoreline.
  for (const poly of WATER) {
    const path = polyPath(poly);
    ctx.fillStyle = "rgba(3, 7, 16, 0.96)";
    ctx.fill(path);
    ctx.strokeStyle = "rgba(45, 226, 255, 0.28)";
    ctx.lineWidth = 1.2;
    ctx.stroke(path);
  }

  // Ship canal
  strokePath(CANAL, "rgba(3, 7, 16, 0.96)", 5);
  strokePath(CANAL, "rgba(45, 226, 255, 0.14)", 6.5);

  ctx.restore();
}

function strokePath(points, style, width) {
  let started = false;
  ctx.beginPath();
  for (const [x, z] of points) {
    const p = project(x, 0, z);
    if (!p) { started = false; continue; }
    if (!started) { ctx.moveTo(p.x, p.y); started = true; }
    else ctx.lineTo(p.x, p.y);
  }
  ctx.strokeStyle = style;
  ctx.lineWidth = width;
  ctx.stroke();
}

function drawGrid() {
  ctx.lineCap = "round";
  for (const line of GRID_LINES) {
    const mid = project((line.a[0] + line.b[0]) / 2, 0, (line.a[1] + line.b[1]) / 2);
    if (!mid) continue;
    const alpha = fog(mid.depth) * (line.major ? 0.3 : 0.09);
    if (alpha < 0.015) continue;
    strokePath([line.a, line.b], `rgba(43, 92, 158, ${alpha})`, line.major ? 1.1 : 0.6);
  }
  for (const arterial of ARTERIALS) {
    strokePath(arterial, "rgba(45, 226, 255, 0.26)", 1.6);
    strokePath(arterial, "rgba(45, 226, 255, 0.07)", 5);
  }
}

function drawRings() {
  for (const r of [1, 2.5, 5]) {
    const points = [];
    for (let a = 0; a <= 128; a += 1) {
      const t = (a / 128) * Math.PI * 2;
      points.push([Math.cos(t) * r, Math.sin(t) * r]);
    }
    strokePath(points, `rgba(45, 226, 255, ${r === RADIUS ? 0.34 : 0.1})`, r === RADIUS ? 1.4 : 0.8);
  }
  for (let deg = 0; deg < 360; deg += 10) {
    const t = (deg / 180) * Math.PI;
    const inner = deg % 30 === 0 ? RADIUS - 0.22 : RADIUS - 0.1;
    strokePath(
      [[Math.cos(t) * inner, Math.sin(t) * inner], [Math.cos(t) * RADIUS, Math.sin(t) * RADIUS]],
      "rgba(45, 226, 255, 0.3)",
      1,
    );
  }
}

function drawBlocks() {
  // Painter's algorithm: project once, sort far → near, draw solid faces.
  const cosY = Math.cos(camera.yaw), sinY = Math.sin(camera.yaw);
  const camX = 0, camY = DIST * SIN_T, camZ = -DIST * COS_T;

  const drawable = [];
  for (const block of BLOCKS) {
    const half = block.w / 2;
    const corners = [
      [block.x - half, block.z - half],
      [block.x + half, block.z - half],
      [block.x + half, block.z + half],
      [block.x - half, block.z + half],
    ];
    const base = corners.map(([x, z]) => project(x, 0, z));
    const top = corners.map(([x, z]) => project(x, block.h, z));
    if (base.some((p) => !p) || top.some((p) => !p)) continue;
    const depth = (base[0].depth + base[2].depth) / 2;
    drawable.push({ block, corners, base, top, depth });
  }
  drawable.sort((a, b) => b.depth - a.depth);

  for (const { block, corners, base, top, depth } of drawable) {
    const dim = fog(depth);
    if (dim < 0.03) continue;

    for (let i = 0; i < 4; i += 1) {
      const j = (i + 1) % 4;
      const [nx, nz] = FACE_NORMALS[i];
      // Rotate the face normal with the world, then test it against the view
      // ray to the face — only camera-facing walls get drawn.
      const rnx = nx * cosY - nz * sinY;
      const rnz = nx * sinY + nz * cosY;
      const fcx = ((corners[i][0] + corners[j][0]) / 2) * cosY - ((corners[i][1] + corners[j][1]) / 2) * sinY;
      const fcz = ((corners[i][0] + corners[j][0]) / 2) * sinY + ((corners[i][1] + corners[j][1]) / 2) * cosY;
      const facing = rnx * (fcx - camX) + rnz * (fcz - camZ);
      if (facing >= 0) continue;

      const lit = FACE_LIT[i];
      ctx.fillStyle = `rgba(${Math.round(20 * lit + 8)}, ${Math.round(30 * lit + 10)}, ${Math.round(56 * lit + 16)}, ${(0.92 * dim).toFixed(3)})`;
      ctx.beginPath();
      ctx.moveTo(base[i].x, base[i].y);
      ctx.lineTo(base[j].x, base[j].y);
      ctx.lineTo(top[j].x, top[j].y);
      ctx.lineTo(top[i].x, top[i].y);
      ctx.closePath();
      ctx.fill();
    }

    ctx.fillStyle = `rgba(34, 50, 86, ${(0.95 * dim).toFixed(3)})`;
    ctx.beginPath();
    ctx.moveTo(top[0].x, top[0].y);
    for (let i = 1; i < 4; i += 1) ctx.lineTo(top[i].x, top[i].y);
    ctx.closePath();
    ctx.fill();

    if (block.h > 0.12) {
      ctx.strokeStyle = `rgba(45, 226, 255, ${(0.2 * dim).toFixed(3)})`;
      ctx.lineWidth = 0.7;
      ctx.stroke();
    }
  }
}

function drawClouds(t) {
  ctx.globalCompositeOperation = "lighter";
  for (const cloud of CLOUDS) {
    const sprite = SPRITES[cloud.kind];
    const breath = REDUCED_MOTION
      ? 0.8
      : 0.78 + 0.22 * Math.sin(t * (0.5 + cloud.intensity * 0.7) + cloud.phase);

    // Ground stain: the cloud's light bleeding onto the streets below it.
    const ground = project(cloud.x, 0, cloud.z);
    if (ground) {
      const stain = (0.9 + cloud.intensity * 1.4) * ground.s * breath;
      ctx.globalAlpha = fog(ground.depth) * 0.12 * breath;
      ctx.drawImage(sprite, ground.x - stain, ground.y - stain * COS_T, stain * 2, stain * COS_T * 2);
    }

    for (const blob of cloud.blobs) {
      const sway = REDUCED_MOTION ? 0 : Math.sin(t * 0.22 * blob.drift + blob.phase) * 0.09;
      const p = project(cloud.x + blob.dx + sway, blob.y, cloud.z + blob.dz - sway * 0.6);
      if (!p) continue;
      const radius = blob.r * p.s * breath;
      ctx.globalAlpha = fog(p.depth) * (0.2 + cloud.intensity * 0.38) * breath;
      ctx.drawImage(sprite, p.x - radius, p.y - radius * 0.72, radius * 2, radius * 1.44);
    }

    const core = project(cloud.x, 0.16, cloud.z);
    if (core) {
      const radius = (0.2 + cloud.intensity * 0.3) * core.s * breath;
      ctx.globalAlpha = fog(core.depth) * (0.18 + cloud.intensity * 0.3) * breath;
      ctx.drawImage(CORE_SPRITE, core.x - radius, core.y - radius, radius * 2, radius * 2);
    }
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
}

function beaconHeight(cloud) {
  return 0.85 + cloud.intensity * 0.5;
}

function drawBeacons(t) {
  for (const cloud of CLOUDS) {
    const base = project(cloud.x, 0.32, cloud.z);
    const tip = project(cloud.x, beaconHeight(cloud), cloud.z);
    if (!base || !tip) continue;
    const tint = TINTS[cloud.kind];
    const flicker = REDUCED_MOTION ? 0.6 : 0.45 + 0.25 * Math.sin(t * 1.7 + cloud.phase * 3);
    const gradient = ctx.createLinearGradient(base.x, base.y, tip.x, tip.y);
    gradient.addColorStop(0, `${tint}00`);
    gradient.addColorStop(1, tint);
    ctx.strokeStyle = gradient;
    ctx.globalAlpha = fog(base.depth) * flicker;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(base.x, base.y);
    ctx.lineTo(tip.x, tip.y);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}

// ——— indicators + alerts rail (one selection model for both) ————————————

const alertsList = document.getElementById("alerts");
document.getElementById("alert-count").textContent = String(CLOUDS.length);

const BY_INTENSITY = [...CLOUDS].sort((a, b) => b.intensity - a.intensity);

const alertRows = new Map(); // cloud.id → <button>
for (const cloud of BY_INTENSITY) {
  const item = document.createElement("li");
  const row = document.createElement("button");
  row.className = "alert";
  row.style.setProperty("--tint", TINTS[cloud.kind]);
  row.setAttribute("aria-expanded", "false");
  row.innerHTML =
    `<span class="alert-row">
      <span class="glyph">${ICONS[cloud.kind]}</span>
      <span class="who">
        <span class="name">${cloud.name}</span>
        <span class="kind">${KIND_LABEL[cloud.kind]}</span>
      </span>
      <span class="meter"><i style="width:${Math.round(cloud.intensity * 100)}%"></i></span>
    </span>
    <span class="line">${cloud.line}</span>`;
  row.addEventListener("click", () => {
    const expanded = row.getAttribute("aria-expanded") === "true";
    if (expanded) collapseAll();
    else select(cloud);
  });
  item.appendChild(row);
  alertsList.appendChild(item);
  alertRows.set(cloud.id, row);
}

const indicators = CLOUDS.map((cloud) => {
  const button = document.createElement("button");
  button.className = "indicator";
  button.style.setProperty("--tint", TINTS[cloud.kind]);
  button.style.setProperty("--phase", `${(cloud.phase % 2).toFixed(2)}s`);
  button.setAttribute("aria-label", `${cloud.name} — ${KIND_LABEL[cloud.kind]}`);
  button.setAttribute("aria-expanded", "false");
  button.innerHTML =
    '<span class="ring" aria-hidden="true"></span>' +
    `<span class="badge" aria-hidden="true">${ICONS[cloud.kind]}</span>` +
    `<span class="tag" aria-hidden="true">${cloud.name}</span>`;
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    select(cloud);
  });
  document.body.appendChild(button);
  return { cloud, button };
});

function select(cloud) {
  for (const { cloud: other, button } of indicators) {
    button.setAttribute("aria-expanded", String(other.id === cloud.id));
  }
  for (const [id, row] of alertRows) {
    row.setAttribute("aria-expanded", String(id === cloud.id));
  }
  alertRows.get(cloud.id).scrollIntoView({ block: "nearest", behavior: REDUCED_MOTION ? "auto" : "smooth" });
}

function collapseAll() {
  for (const { button } of indicators) button.setAttribute("aria-expanded", "false");
  for (const row of alertRows.values()) row.setAttribute("aria-expanded", "false");
}

canvas.addEventListener("click", collapseAll);
addEventListener("keydown", (event) => {
  if (event.key === "Escape") collapseAll();
});

function placeIndicators() {
  for (const { cloud, button } of indicators) {
    const p = project(cloud.x, beaconHeight(cloud), cloud.z);
    if (!p) {
      button.style.visibility = "hidden";
      continue;
    }
    button.style.visibility = "visible";
    button.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)`;
    button.style.opacity = fog(p.depth).toFixed(2);
  }
}

// ——— voice panel (mock conversation, real speech synth) —————————————————

const voice = document.querySelector(".voice");
const voiceState = document.getElementById("voice-state");
const transcript = document.getElementById("transcript");
const mic = document.getElementById("mic");

const EXCHANGES = [
  ["what about the bridges?", "I-90 is clean. 520 carries stadium spillover for another hour."],
  ["where's it calm?", "West of the canal. Ballard is a market crowd, nothing sharp."],
  ["should i avoid downtown?", "Belltown is churning but moving. Take Second, skip First."],
  ["anything new?", "Nothing since the hill. I'll speak up if that changes."],
];
let exchangeIndex = 0;

function addLine(who, text) {
  const line = document.createElement("li");
  line.className = who;
  line.textContent = text;
  transcript.appendChild(line);
  while (transcript.children.length > 8) transcript.firstChild.remove();
  transcript.scrollTop = transcript.scrollHeight;
}

// Seed the panel mid-conversation so the room feels lived-in.
addLine("you", "how's capitol hill?");
addLine("sia", "Loud. Three dispatches in four blocks — I'd come down Aurora instead.");

function setVoice(state, label) {
  voice.dataset.state = state;
  voiceState.textContent = label;
}

function speak(text, onDone) {
  if (!("speechSynthesis" in window)) {
    setTimeout(onDone, 1800);
    return;
  }
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1.02;
  utterance.pitch = 0.85;
  utterance.onend = onDone;
  utterance.onerror = onDone;
  speechSynthesis.speak(utterance);
}

let listening = false;
function micDown(event) {
  event.preventDefault();
  if (listening || voice.dataset.state === "speaking") return;
  listening = true;
  mic.classList.add("hot");
  setVoice("listening", "listening…");
}
function micUp() {
  if (!listening) return;
  listening = false;
  mic.classList.remove("hot");
  const [question, answer] = EXCHANGES[exchangeIndex % EXCHANGES.length];
  exchangeIndex += 1;
  addLine("you", question);
  setVoice("speaking", "sia");
  setTimeout(() => {
    addLine("sia", answer);
    speak(answer, () => setVoice("idle", "idle"));
  }, 350);
}
mic.addEventListener("pointerdown", micDown);
mic.addEventListener("pointerup", micUp);
mic.addEventListener("pointercancel", micUp);
mic.addEventListener("keydown", (event) => {
  if (event.key === " " || event.key === "Enter") micDown(event);
});
mic.addEventListener("keyup", (event) => {
  if (event.key === " " || event.key === "Enter") micUp();
});

// ——— clock + loop ———————————————————————————————————————————————————————

function tickClock() {
  clockEl.textContent = new Date().toTimeString().slice(0, 5);
}
tickClock();
setInterval(tickClock, 30_000);

const ORBIT_SPEED = (Math.PI * 2) / 240; // full orbit in four minutes

let last = performance.now();
function frame(nowMs) {
  const t = nowMs / 1000;
  if (!REDUCED_MOTION) {
    camera.yaw += ORBIT_SPEED * ((nowMs - last) / 1000);
  }
  last = nowMs;

  ctx.clearRect(0, 0, W, H);
  const disc = discPath();
  drawGround(disc);
  drawGrid();
  drawRings();
  drawBlocks();
  drawClouds(t);
  drawBeacons(t);
  placeIndicators();

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
