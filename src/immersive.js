// Immersive mode — VIBE MOCKUP. Overhead 5-mile view of the city at night:
// perspective street grid, range rings, wireframe blocks for depth, and
// volumetric pulsing clouds with clickable beacon indicators. All data on
// this page is fake and hand-placed; live wiring waits until the direction
// is locked. Nothing here touches the signal store or domain.js.

const canvas = document.getElementById("scene");
const ctx = canvas.getContext("2d");
const chip = document.getElementById("chip");
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

// Orbit camera looking at the origin from elevation THETA, distance DIST.
// Chosen so the whole 5-mile disc sits in a landscape frame with the far
// rim near the top — overhead, but with enough tilt to feel dimensional.
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
  CY = H * 0.44;
  canvas.width = W * DPR;
  canvas.height = H * DPR;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  camera.fov = Math.min(W * 0.9, H * 1.55);
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
  return {
    x: W / 2 + rx * s,
    y: CY - yc * s,
    s,
    depth: zc,
  };
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

// Street grid clipped to the awareness circle. Majors every 1 mi, minors 0.25.
const GRID_LINES = [];
for (let m = -RADIUS; m <= RADIUS + 1e-9; m += 0.25) {
  const major = Math.abs(m - Math.round(m)) < 1e-9;
  const half = Math.sqrt(Math.max(0, RADIUS * RADIUS - m * m));
  if (half < 0.05) continue;
  GRID_LINES.push({ a: [m, -half], b: [m, half], major, vertical: true });
  GRID_LINES.push({ a: [-half, m], b: [half, m], major, vertical: false });
}

// Two arterials — brighter diagonals so the grid reads as a real city, not
// graph paper. Rough gestures at Aurora (N-S drift) and the I-90 cut.
const ARTERIALS = [
  [[-0.4, -4.8], [-0.2, -1.5], [0.3, 1.0], [0.1, 4.9]],
  [[-4.9, -0.6], [-1.5, -0.4], [1.8, -0.9], [4.9, -0.7]],
];

// Wireframe blocks: abstract massing for parallax, denser near the core.
const BLOCKS = (() => {
  const rand = mulberry32(20260714);
  const blocks = [];
  for (let i = 0; i < 70; i += 1) {
    const angle = rand() * Math.PI * 2;
    const r = Math.pow(rand(), 1.7) * 3.4; // bias toward the center
    const x = Math.cos(angle) * r;
    const z = Math.sin(angle) * r;
    const height = 0.06 + Math.pow(rand(), 2.4) * (r < 1.2 ? 0.55 : 0.18);
    const w = 0.05 + rand() * 0.09;
    blocks.push({ x, z, w, h: height });
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

// Per-cloud blob field: a low stack of drifting puffs, seeded per cloud so
// every load breathes the same city.
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

function drawAmbient() {
  // The city's own light pollution: a squashed radial glow under the disc.
  const p0 = project(0, 0, 0);
  if (!p0) return;
  const rx = 5.6 * p0.s;
  const ry = rx * COS_T * 1.15;
  ctx.save();
  ctx.translate(p0.x, p0.y);
  ctx.scale(1, ry / rx);
  const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
  gradient.addColorStop(0, "rgba(38, 90, 150, 0.34)");
  gradient.addColorStop(0.45, "rgba(24, 55, 110, 0.16)");
  gradient.addColorStop(1, "rgba(10, 18, 46, 0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(-rx, -rx, rx * 2, rx * 2);
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
    const alpha = fog(mid.depth) * (line.major ? 0.34 : 0.1);
    if (alpha < 0.015) continue;
    strokePath([line.a, line.b], `rgba(43, 92, 158, ${alpha})`, line.major ? 1.1 : 0.6);
  }
  for (const arterial of ARTERIALS) {
    strokePath(arterial, "rgba(45, 226, 255, 0.28)", 1.6);
    strokePath(arterial, "rgba(45, 226, 255, 0.07)", 5);
  }
}

function drawRings() {
  // The iris: range rings at 1 / 2.5 / 5 mi with degree ticks on the rim.
  for (const r of [1, 2.5, 5]) {
    const points = [];
    for (let a = 0; a <= 128; a += 1) {
      const t = (a / 128) * Math.PI * 2;
      points.push([Math.cos(t) * r, Math.sin(t) * r]);
    }
    strokePath(points, `rgba(45, 226, 255, ${r === RADIUS ? 0.34 : 0.12})`, r === RADIUS ? 1.4 : 0.8);
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
  ctx.lineWidth = 0.7;
  for (const block of BLOCKS) {
    const base = project(block.x, 0, block.z);
    const top = project(block.x, block.h, block.z);
    if (!base || !top) continue;
    const alpha = fog(base.depth) * 0.2;
    if (alpha < 0.02) continue;
    const half = block.w * base.s * 0.5;
    ctx.strokeStyle = `rgba(76, 108, 178, ${alpha})`;
    ctx.strokeRect(top.x - half, top.y, half * 2, base.y - top.y);
    ctx.strokeStyle = `rgba(120, 170, 255, ${alpha * 0.9})`;
    ctx.strokeRect(top.x - half, top.y - half * 0.5, half * 2, half * 0.5);
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

function beaconHeight(cloud) {
  return 0.85 + cloud.intensity * 0.5;
}

// ——— DOM indicators (the crisp, clickable HUD layer) ————————————————————

const indicators = CLOUDS.map((cloud) => {
  const button = document.createElement("button");
  button.className = "indicator";
  button.style.setProperty("--tint", TINTS[cloud.kind]);
  button.style.setProperty("--phase", `${(cloud.phase % 2).toFixed(2)}s`);
  button.setAttribute("aria-label", `${cloud.name} — ${KIND_LABEL[cloud.kind]}`);
  button.setAttribute("aria-expanded", "false");
  button.innerHTML =
    '<span class="ring" aria-hidden="true"></span>' +
    '<span class="diamond" aria-hidden="true"></span>' +
    `<span class="tag" aria-hidden="true">${cloud.name}</span>`;
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    openChip(cloud, button);
  });
  document.body.appendChild(button);
  return { cloud, button };
});

let openCloud = null;

function openChip(cloud, button) {
  openCloud = cloud;
  const tint = TINTS[cloud.kind];
  chip.style.setProperty("--tint", tint);
  chip.querySelector(".kind").textContent = KIND_LABEL[cloud.kind];
  chip.querySelector("h2").textContent = cloud.name;
  chip.querySelector("p").textContent = cloud.line;
  chip.classList.add("open");
  requestAnimationFrame(() => {
    chip.querySelector(".meter i").style.width = `${Math.round(cloud.intensity * 100)}%`;
  });
  for (const { button: other } of indicators) {
    other.setAttribute("aria-expanded", String(other === button));
  }
}

function closeChip() {
  openCloud = null;
  chip.classList.remove("open");
  chip.querySelector(".meter i").style.width = "0";
  for (const { button } of indicators) button.setAttribute("aria-expanded", "false");
}

canvas.addEventListener("click", closeChip);
addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeChip();
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

// ——— clock + loop ———————————————————————————————————————————————————————

function tickClock() {
  const now = new Date();
  clockEl.textContent = now.toTimeString().slice(0, 5);
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
  drawAmbient();
  drawGrid();
  drawRings();
  drawBlocks();
  drawClouds(t);
  drawBeacons(t);
  placeIndicators();

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
