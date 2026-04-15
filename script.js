// ── Constants ─────────────────────────────────────────────────────────────────
const W = 900, H = 480;
const KNOT_COUNT = 18;   // physics nodes per band
const DAMPING = 0.76;
const GRAVITY = 0.28;
const ITERS = 14;   // constraint solver iterations

const RED = '#ff2040';
const BLUE = '#2080ff';
const RED_GLOW = 'rgba(255,32,64,0.75)';
const BLUE_GLOW = 'rgba(32,128,255,0.75)';

// Fingertip landmark indices (MediaPipe)
const TIPS = [4, 8, 12, 16, 20];

// Hand skeleton connections
const CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17]
];

// Per-finger band: [red-side colour, blue-side colour]
const FINGER_PALETTE = [
  ['#ff2040', '#40a0ff'],  // thumb
  ['#ff6020', '#20d0ff'],  // index
  ['#ff20b0', '#20e8ff'],  // middle
  ['#e040ff', '#4060ff'],  // ring
  ['#ff2040', '#2080ff'],  // pinky
];

// ── DOM ───────────────────────────────────────────────────────────────────────
const video = document.getElementById('webcam');
const canvas = document.getElementById('overlay');
const ctx = canvas.getContext('2d');
const statusEl = document.getElementById('status');
canvas.width = W; canvas.height = H;

// ── ElasticBand ───────────────────────────────────────────────────────────────
class ElasticBand {
  constructor(fingerIdx) {
    this.fi = fingerIdx;
    this.nodes = Array.from({ length: KNOT_COUNT }, () => ({ x: 0, y: 0, px: 0, py: 0 }));
    this.ready = false;
    this.active = false;
  }

  _init(x1, y1, x2, y2) {
    for (let i = 0; i < KNOT_COUNT; i++) {
      const t = i / (KNOT_COUNT - 1);
      this.nodes[i].x = this.nodes[i].px = x1 + (x2 - x1) * t;
      this.nodes[i].y = this.nodes[i].py = y1 + (y2 - y1) * t;
    }
    this.ready = true;
  }

  update(x1, y1, x2, y2) {
    if (!this.ready) this._init(x1, y1, x2, y2);

    const segLen = Math.hypot(x2 - x1, y2 - y1) / (KNOT_COUNT - 1);

    // Pin endpoints to fingertips
    const n0 = this.nodes[0];
    const nN = this.nodes[KNOT_COUNT - 1];
    n0.x = n0.px = x1; n0.y = n0.py = y1;
    nN.x = nN.px = x2; nN.y = nN.py = y2;

    // Verlet integrate interior nodes
    for (let i = 1; i < KNOT_COUNT - 1; i++) {
      const n = this.nodes[i];
      const vx = (n.x - n.px) * DAMPING;
      const vy = (n.y - n.py) * DAMPING;
      n.px = n.x; n.py = n.y;
      n.x += vx;
      n.y += vy + GRAVITY;
    }

    // Constraint relaxation (keep segment lengths)
    for (let it = 0; it < ITERS; it++) {
      for (let i = 0; i < KNOT_COUNT - 1; i++) {
        const a = this.nodes[i];
        const b = this.nodes[i + 1];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.hypot(dx, dy) || 0.001;
        const half = (d - segLen) / d * 0.5;
        const cx = dx * half, cy = dy * half;
        if (i > 0) { a.x += cx; a.y += cy; }
        if (i < KNOT_COUNT - 2) { b.x -= cx; b.y -= cy; }
      }
      // Re-pin endpoints every iteration
      this.nodes[0].x = x1; this.nodes[0].y = y1;
      this.nodes[KNOT_COUNT - 1].x = x2; this.nodes[KNOT_COUNT - 1].y = y2;
    }
    this.active = true;
  }

  // Smooth quadratic-curve path
  _path(ctx) {
    const ns = this.nodes;
    ctx.beginPath();
    ctx.moveTo(ns[0].x, ns[0].y);
    for (let i = 1; i < ns.length - 1; i++) {
      const mx = (ns[i].x + ns[i + 1].x) * 0.5;
      const my = (ns[i].y + ns[i + 1].y) * 0.5;
      ctx.quadraticCurveTo(ns[i].x, ns[i].y, mx, my);
    }
    ctx.lineTo(ns[ns.length - 1].x, ns[ns.length - 1].y);
  }

  draw(ctx) {
    if (!this.active) return;
    const [c1, c2] = FINGER_PALETTE[this.fi];
    const ns = this.nodes;

    // Gradient from red-side tip to blue-side tip
    const grad = ctx.createLinearGradient(ns[0].x, ns[0].y, ns[KNOT_COUNT - 1].x, ns[KNOT_COUNT - 1].y);
    grad.addColorStop(0, c1);
    grad.addColorStop(0.48, '#ffffff');
    grad.addColorStop(1, c2);

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Layer 1 – wide outer glow
    ctx.globalAlpha = 0.45;
    ctx.lineWidth = 12;
    ctx.shadowBlur = 40;
    ctx.shadowColor = c1;
    ctx.strokeStyle = grad;
    this._path(ctx); ctx.stroke();

    // Layer 2 – mid band
    ctx.globalAlpha = 0.80;
    ctx.lineWidth = 5;
    ctx.shadowBlur = 14;
    ctx.shadowColor = '#ffffff66';
    ctx.strokeStyle = grad;
    this._path(ctx); ctx.stroke();

    // Layer 3 – bright core
    ctx.globalAlpha = 1.0;
    ctx.lineWidth = 1.8;
    ctx.shadowBlur = 3;
    ctx.strokeStyle = '#ffffffcc';
    this._path(ctx); ctx.stroke();

    ctx.restore();
  }
}

// One band per finger pair
const bands = TIPS.map((_, i) => new ElasticBand(i));

// ── Hand state ────────────────────────────────────────────────────────────────
let handMap = {}; // { 'Right': landmarks[], 'Left': landmarks[] }

// Convert normalised landmark → canvas coords (mirror x)
function lm2c(lm) { return { x: (1 - lm.x) * W, y: lm.y * H }; }

function onResults(results) {
  handMap = {};
  if (!results.multiHandLandmarks) return;
  results.multiHandLandmarks.forEach((lms, i) => {
    const label = results.multiHandedness[i]?.label ?? (i === 0 ? 'Right' : 'Left');
    handMap[label] = lms;
  });
}

// ── Draw a hand skeleton ──────────────────────────────────────────────────────
function drawHand(lms, color, glow) {
  const pts = lms.map(lm2c);

  // Skeleton lines
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.shadowBlur = 14;
  ctx.shadowColor = glow;
  ctx.globalAlpha = 0.90;
  CONNECTIONS.forEach(([a, b]) => {
    ctx.beginPath();
    ctx.moveTo(pts[a].x, pts[a].y);
    ctx.lineTo(pts[b].x, pts[b].y);
    ctx.stroke();
  });
  ctx.restore();

  // Knuckles (small dots)
  ctx.save();
  ctx.fillStyle = color;
  ctx.shadowBlur = 8;
  ctx.shadowColor = glow;
  pts.forEach((p, i) => {
    if (TIPS.includes(i)) return;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.restore();

  // Fingertips – glowing orbs
  TIPS.forEach(ti => {
    const p = pts[ti];
    // Halo
    ctx.save();
    ctx.beginPath();
    ctx.arc(p.x, p.y, 20, 0, Math.PI * 2);
    ctx.fillStyle = glow.replace('0.75', '0.12');
    ctx.fill();
    // Main orb
    ctx.beginPath();
    ctx.arc(p.x, p.y, 9, 0, Math.PI * 2);
    ctx.shadowBlur = 24;
    ctx.shadowColor = glow;
    ctx.fillStyle = color;
    ctx.fill();
    // White core
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.shadowBlur = 6;
    ctx.fill();
    ctx.restore();
  });
}

// ── Canvas hint text ──────────────────────────────────────────────────────────
function drawHint(text) {
  ctx.save();
  ctx.font = 'bold 15px Segoe UI, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.fillText(text, W / 2, H - 18);
  ctx.restore();
}

// ── Main render loop ──────────────────────────────────────────────────────────
function loop() {
  ctx.clearRect(0, 0, W, H);

  // Subtle vignette
  const vg = ctx.createRadialGradient(W / 2, H / 2, H * 0.22, W / 2, H / 2, H * 0.80);
  vg.addColorStop(0, 'transparent');
  vg.addColorStop(1, 'rgba(2,2,9,0.52)');
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, W, H);

  const rh = handMap['Right'];  // red hand
  const lh = handMap['Left'];   // blue hand
  const twoHands = rh && lh;

  // Draw elastic bands (behind hands)
  if (twoHands) {
    TIPS.forEach((ti, bi) => {
      const rp = lm2c(rh[ti]);
      const lp = lm2c(lh[ti]);
      bands[bi].update(rp.x, rp.y, lp.x, lp.y);
      bands[bi].draw(ctx);
    });
  } else {
    // Deactivate bands so they re-init fresh next time both hands appear
    bands.forEach(b => { b.active = false; b.ready = false; });
  }

  // Draw hands on top
  if (rh) drawHand(rh, RED, RED_GLOW);
  if (lh) drawHand(lh, BLUE, BLUE_GLOW);

  // On-screen guidance
  if (!rh && !lh) drawHint('🖐  Show both hands to stretch the bands!');
  else if (!twoHands) drawHint('🖐  Show your other hand too!');

  requestAnimationFrame(loop);
}

// ── Camera + MediaPipe init ───────────────────────────────────────────────────
(async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: W, height: H, facingMode: 'user' },
      audio: false
    });
    video.srcObject = stream;
    await video.play();
    statusEl.textContent = '✅ Camera ready — loading hand detector…';
  } catch (e) {
    statusEl.textContent = '❌ Camera denied — please allow webcam and refresh.';
    console.error(e);
    return;
  }

  const mpHands = new Hands({
    locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${f}`
  });
  mpHands.setOptions({
    maxNumHands: 2,
    modelComplexity: 1,
    minDetectionConfidence: 0.72,
    minTrackingConfidence: 0.60
  });
  mpHands.onResults(onResults);

  const cam = new Camera(video, {
    onFrame: async () => { await mpHands.send({ image: video }); },
    width: W,
    height: H
  });
  cam.start();

  statusEl.textContent = '🖐  Show both hands — elastic bands stretch between each fingertip!';
  loop();
})();
