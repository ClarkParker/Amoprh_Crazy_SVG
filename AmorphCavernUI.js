// Amorph Cavern — single-file SVG game UI for the Amorph_FX proof of concept.
// WINDOW SIZE: 1000x600
//
// Everything you see is inline SVG: an animated feTurbulence nebula + film grain,
// a "gooey" feDisplacementMap creature that morphs as it moves, neon feGaussianBlur
// glow on cavern walls carved live from the incoming audio, a parallax starfield,
// beat-driven particles/rings, and an all-SVG HUD.
//
// Data flow (see AmorphCavernDSP.cmajor):
//   audio  -> levelOut/bassOut/midOut/trebleOut events -> shape the world
//   game   -> "Danger" param (param2) -> the DSP bends the audio so you HEAR it
//
// Single file, no imports, light DOM, full cleanup. (dev-kit rules.)

const NS = "http://www.w3.org/2000/svg";
const VBW = 1000, VBH = 600;
const CREATURE_X = 262;          // fixed screen-x of the creature (viewBox units)
const BASE_R = 23;               // creature base radius
const SLICE = 40;                // world spacing between cavern samples
const SAFE = 130;                // clearance (px) considered "fully safe"

const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp = (a, b, t) => a + (b - a) * t;
const hsl = (h, s, l, a = 1) => `hsla(${h.toFixed(0)},${s.toFixed(0)}%,${l.toFixed(0)}%,${a})`;
const mk = (name, attrs) => { const e = document.createElementNS(NS, name); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };

// Catmull-Rom -> cubic bezier segments (no leading "M"), through ordered points.
function cubicSegs(pts) {
  let d = "";
  const n = pts.length;
  for (let i = 0; i < n - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    const c1x = p1.x + (p2.x - p0.x) / 6, c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6, c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
  }
  return d;
}

// Closed Catmull-Rom for the morphing creature blob.
function smoothClosed(pts) {
  const n = pts.length;
  let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
    const c1x = p1.x + (p2.x - p0.x) / 6, c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6, c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
  }
  return d + " Z";
}

class AmorphCavernUI extends HTMLElement {
  constructor(pc) {
    super();
    this.pc = pc;
    this.audio = { level: 0, bass: 0, mid: 0, treble: 0 };  // smoothed bands from DSP
    this._endpointListeners = [];
    this._raf = null;
    this._onPointer = null;
    this._onDown = null;
    this._onKey = null;
    this._lastT = 0;
    this._lastDangerSend = 0;
    this._frame = 0;
  }

  // ---------------------------------------------------------------- lifecycle
  connectedCallback() {
    this.innerHTML = this.getHTML();
    this._cacheRefs();
    this._buildPools();
    this._resetGame(true);
    this._wireBridge();
    this._wireInput();
    this._wireControls();
    const loop = t => { this._tick(t); this._raf = requestAnimationFrame(loop); };
    this._raf = requestAnimationFrame(loop);
  }

  disconnectedCallback() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._endpointListeners.forEach(([id, fn]) => this.pc.removeEndpointListener?.(id, fn));
    if (this._onPointer) this.removeEventListener("pointermove", this._onPointer);
    if (this._onDown) this.removeEventListener("pointerdown", this._onDown);
    if (this._onKey) window.removeEventListener("keydown", this._onKey);
  }

  // ------------------------------------------------------------------ bridge
  _wireBridge() {
    const bind = (id, key) => {
      const fn = v => { this.audio[key] = clamp(+v || 0, 0, 1); };
      this.pc.addEndpointListener?.(id, fn);
      this._endpointListeners.push([id, fn]);
    };
    bind("levelOut", "level");
    bind("bassOut", "bass");
    bind("midOut", "mid");
    bind("trebleOut", "treble");
    // tell the DSP how the game feels (drives the audio bend)
    this._send = (v) => this.pc.sendEventOrValue?.("param2", clamp(v, 0, 1));
  }

  // ----------------------------------------------------- SVG tuning controls
  _wireControls() {
    this._sent = [];
    this._cur = { param1: 1.0, param3: 0.6, param4: 0 };
    this._panelOpen = false;
    const send = (id, v) => { this._sent.push({ id, v }); if (this._sent.length > 32) this._sent.shift(); this.pc.sendEventOrValue?.(id, v); };
    const isEcho = (id, v) => this._sent.some(p => p.id === id && Math.abs(p.v - v) < 1e-4);

    this.querySelector("#tuneBtn").addEventListener("pointerdown", e => {
      e.stopPropagation();
      this._panelOpen = !this._panelOpen;
      this.panel.classList.toggle("open", this._panelOpen);
    });

    const X0 = 108, L = 120;                 // slider track in viewBox units
    const toVal = (e, min, max) => {
      const m = this.svg.getScreenCTM(); const pt = this.svg.createSVGPoint();
      pt.x = e.clientX; pt.y = e.clientY;
      const loc = pt.matrixTransform(m.inverse());
      return min + clamp((loc.x - X0) / L, 0, 1) * (max - min);
    };
    const slider = (id, min, max, fill, handle, track, valEl, fmt) => {
      const setValue = (v, notify) => {
        v = clamp(v, min, max); const n = (v - min) / (max - min);
        fill.setAttribute("width", (n * L).toFixed(1));
        handle.setAttribute("cx", (X0 + n * L).toFixed(1));
        valEl.textContent = fmt(v);
        this._cur[id] = v;
        if (notify) send(id, v);
      };
      const begin = el => el.addEventListener("pointerdown", e => {
        e.stopPropagation(); this._uiBusy = true; el.setPointerCapture?.(e.pointerId);
        setValue(toVal(e, min, max), true);
        const mv = e2 => setValue(toVal(e2, min, max), true);
        const up = e2 => { this._uiBusy = false; el.releasePointerCapture?.(e2.pointerId); el.removeEventListener("pointermove", mv); el.removeEventListener("pointerup", up); el.removeEventListener("pointercancel", up); };
        el.addEventListener("pointermove", mv); el.addEventListener("pointerup", up); el.addEventListener("pointercancel", up);
      });
      begin(handle); begin(track);
      this.pc.addParameterListener?.(id, v => { if (!isEcho(id, v)) setValue(v, false); });
      this.pc.requestParameterValue?.(id);
      setValue(this._cur[id], false);
    };
    slider("param1", 0, 3, this.querySelector("#sensFill"), this.querySelector("#sensHandle"), this.querySelector("#sensTrk"), this.querySelector("#sensVal"), v => v.toFixed(1) + "x");
    slider("param3", 0, 1, this.querySelector("#fxFill"), this.querySelector("#fxHandle"), this.querySelector("#fxTrk"), this.querySelector("#fxVal"), v => Math.round(v * 100) + "%");

    // Bypass toggle (param4) — shown as the on/off state of the sound-bend
    const bg = this.querySelector("#bypassBg"), knob = this.querySelector("#bypassKnob"), bval = this.querySelector("#bypassVal");
    const setBypass = (v, notify) => {
      const off = v >= 0.5;
      bg.setAttribute("fill", off ? "#15263f" : "#0e7a5f");
      knob.setAttribute("cx", off ? 94 : 122);
      bval.textContent = off ? "OFF" : "ON";
      this._cur.param4 = off ? 1 : 0;
      if (notify) send("param4", off ? 1 : 0);
    };
    this.querySelector("#bypassToggle").addEventListener("pointerdown", e => {
      e.stopPropagation(); this._uiBusy = true;
      setBypass(this._cur.param4 >= 0.5 ? 0 : 1, true);
      requestAnimationFrame(() => { this._uiBusy = false; });
    });
    this.pc.addParameterListener?.("param4", v => { if (!isEcho("param4", v)) setBypass(v, false); });
    this.pc.requestParameterValue?.("param4");
    setBypass(0, false);
  }

  // ------------------------------------------------------------------- input
  _wireInput() {
    this._onPointer = e => {
      if (this._uiBusy || e.target.closest?.("#panel,#tuneBtn")) return;
      const m = this.svg.getScreenCTM();
      if (!m) return;
      const pt = this.svg.createSVGPoint();
      pt.x = e.clientX; pt.y = e.clientY;
      const loc = pt.matrixTransform(m.inverse());
      this.targetY = clamp(loc.y, 36, VBH - 36);
      this._pointerActive = true;
    };
    this._onDown = e => { if (e.target.closest?.("#panel,#tuneBtn")) return; this._activate(); };
    this._onKey = e => {
      if (e.code === "Space") { e.preventDefault(); this._activate(); }
      else if (e.code === "ArrowUp" || e.code === "KeyW") { this.targetY = clamp((this.targetY ?? VBH / 2) - 46, 36, VBH - 36); this._pointerActive = true; }
      else if (e.code === "ArrowDown" || e.code === "KeyS") { this.targetY = clamp((this.targetY ?? VBH / 2) + 46, 36, VBH - 36); this._pointerActive = true; }
    };
    this.addEventListener("pointermove", this._onPointer);
    this.addEventListener("pointerdown", this._onDown);
    window.addEventListener("keydown", this._onKey);
  }

  _activate() {
    if (this.state === "play") return;
    this._resetGame(false);
    this.state = "play";
    this._setOverlay(false);
  }

  // ------------------------------------------------------------- game state
  _resetGame(initial) {
    this.state = "idle";
    this.worldX = 0;
    this.speed = 150;
    this.score = 0;
    this.danger = 0;
    this.shake = 0;
    this.creature = { x: CREATURE_X, y: VBH / 2, vy: 0, r: BASE_R };
    this.targetY = this.targetY ?? VBH / 2;
    this.slices = [];
    this._genX = -SLICE * 3;
    this._noisePhase = Math.random() * 1000;
    this._cy = VBH / 2;
    while (this._genX < VBW + SLICE * 3) this._spawnSlice();
    if (initial) {
      this.best = +(localStorage.getItem("amorphCavernBest") || 0);
      this._setOverlay(true, "AMORPH CAVERN",
        "move to fly · feed the cavern with sound · click / space to dive");
    }
  }

  // Procedural cavern: smooth noise centre, gap squeezed by bass, treble spikes.
  _spawnSlice() {
    const p = this._noisePhase + this._genX * 0.0042;
    const wander = Math.sin(p) * 120 + Math.sin(p * 2.3 + 1.7) * 54 + Math.sin(p * 4.7 + 0.5) * 22;
    this._cy = lerp(this._cy, VBH / 2 + wander, 0.5);
    const diff = clamp(this.score / 2600, 0, 1);                 // 0..1 over time
    let gap = 250 - this.audio.bass * 96 - diff * 70;
    gap = clamp(gap, 116, 300);
    const spikeT = this.audio.treble * Math.random() * 30;
    const spikeB = this.audio.treble * Math.random() * 30;
    this.slices.push({ wx: this._genX, cy: this._cy, gap, spikeT, spikeB });
    this._genX += SLICE;
  }

  // ----------------------------------------------------------------- update
  _tick(t) {
    const dt = this._lastT ? clamp((t - this._lastT) / 1000, 0, 0.05) : 0.016;
    this._lastT = t;
    this._frame++;

    // decay audio so bars fall when the host stops sending events
    const dk = Math.pow(0.0008, dt);
    this.audio.level *= dk; this.audio.bass *= dk; this.audio.mid *= dk; this.audio.treble *= dk;

    this._update(dt, t);
    this._render(t);
  }

  _update(dt, t) {
    // speed ramps while playing
    if (this.state === "play") this.speed = Math.min(330, this.speed + dt * 7);
    const sc = (this.state === "idle") ? this.speed * 0.45 : this.speed;
    this.worldX += sc * dt;

    // recycle / generate cavern slices
    while (this.slices.length && this.slices[0].wx - this.worldX < -SLICE * 2) this.slices.shift();
    while (this._genX - this.worldX < VBW + SLICE * 3) this._spawnSlice();

    // creature motion
    const cr = this.creature;
    if (this.state === "idle" || (!this._pointerActive && this.state !== "play")) {
      this.targetY = VBH / 2 + Math.sin(t * 0.0016) * 120;
    }
    const prevY = cr.y;
    cr.y = lerp(cr.y, this.targetY, clamp(dt * 8, 0, 1));
    cr.vy = (cr.y - prevY) / Math.max(dt, 1e-3);
    cr.r = lerp(cr.r, BASE_R + this.audio.level * 10, 0.2);

    // sample cavern at the creature
    const b = this._boundaryAt(CREATURE_X);
    const clearance = Math.min(cr.y - b.top, b.bot - cr.y) - cr.r;
    let danger = clamp(1 - clearance / SAFE, 0, 1);

    if (this.state === "play") {
      this.score += sc * dt * 0.1;
      if (clearance <= 0) this._die();
    } else {
      danger *= 0.25;
    }
    this.danger = lerp(this.danger, danger, 0.25);
    this.shake = lerp(this.shake, this.danger * this.danger * 10, 0.3);

    // feed the DSP (throttled ~30 Hz) so the sound bends with the danger
    if (t - this._lastDangerSend > 33) { this._send?.(this.state === "play" ? this.danger : 0); this._lastDangerSend = t; }

    // beat detection -> particle bursts
    const lvl = this.audio.level;
    if (lvl > 0.32 && lvl - (this._lastLvl || 0) > 0.08) this._beat(lvl);
    this._lastLvl = lvl;

    this._updateParticles(dt);
    this._updateStars(dt);
  }

  _boundaryAt(screenX) {
    const wx = screenX + this.worldX;
    const s = this.slices;
    // find bracketing slices
    let i = 1;
    while (i < s.length && s[i].wx < wx) i++;
    const a = s[Math.max(0, i - 1)], c = s[Math.min(s.length - 1, i)];
    const span = (c.wx - a.wx) || 1;
    const f = clamp((wx - a.wx) / span, 0, 1);
    const cy = lerp(a.cy, c.cy, f);
    const gap = lerp(a.gap, c.gap, f);
    const st = lerp(a.spikeT, c.spikeT, f);
    const sb = lerp(a.spikeB, c.spikeB, f);
    return { top: cy - gap / 2 + st, bot: cy + gap / 2 - sb };
  }

  _die() {
    this.state = "dead";
    this.best = Math.max(this.best, Math.floor(this.score));
    localStorage.setItem("amorphCavernBest", String(this.best));
    this._burst(this.creature.x, this.creature.y, 28, 1);
    this._setOverlay(true, "LOST IN THE DARK",
      `depth ${Math.floor(this.score)} m   ·   best ${this.best} m   ·   click to dive again`);
  }

  // --------------------------------------------------------------- particles
  _buildPools() {
    this.spores = [];
    for (let i = 0; i < 70; i++) {
      const el = mk("circle", { r: 0, fill: "#fff", opacity: 0 });
      this.fxLayer.appendChild(el);
      this.spores.push({ el, life: 0, max: 1, x: 0, y: 0, vx: 0, vy: 0, r: 0, hue: 180, kind: 0 });
    }
    this.rings = [];
    for (let i = 0; i < 6; i++) {
      const el = mk("circle", { r: 0, fill: "none", "stroke-width": 2, opacity: 0 });
      this.fxLayer.appendChild(el);
      this.rings.push({ el, life: 0, max: 1, x: 0, y: 0, r0: 0 });
    }
    this.stars = [];
    for (let i = 0; i < 46; i++) {
      const x = Math.random() * VBW, y = Math.random() * VBH;
      const r = 0.6 + Math.random() * 1.8;
      const el = mk("circle", { cx: x, cy: y, r, fill: "#bcd8ff", opacity: 0.2 + Math.random() * 0.4 });
      this.starLayer.appendChild(el);
      this.stars.push({ el, x, y, r, sp: 6 + Math.random() * 26, tw: Math.random() * 6.28 });
    }
  }

  _beat(lvl) {
    const cr = this.creature;
    this._burst(cr.x + 6, cr.y, Math.round(4 + lvl * 8), lvl);
    const ring = this.rings.find(r => r.life <= 0);
    if (ring) { ring.life = ring.max = 0.7; ring.x = cr.x; ring.y = cr.y; ring.r0 = cr.r; }
  }

  _burst(x, y, n, energy) {
    let made = 0;
    for (const s of this.spores) {
      if (s.life > 0) continue;
      const ang = Math.random() * 6.283, sp = 40 + Math.random() * 200 * energy;
      s.x = x; s.y = y; s.vx = Math.cos(ang) * sp; s.vy = Math.sin(ang) * sp;
      s.r = 1.4 + Math.random() * 3.4; s.max = s.life = 0.5 + Math.random() * 0.9;
      s.hue = 170 + Math.random() * 140; s.kind = 1;
      if (++made >= n) break;
    }
  }

  _updateParticles(dt) {
    // ambient drifting spores
    if (this._frame % 4 === 0) {
      const s = this.spores.find(p => p.life <= 0);
      if (s) {
        s.x = VBW + 10; s.y = Math.random() * VBH;
        s.vx = -(20 + Math.random() * 40); s.vy = (Math.random() - 0.5) * 20;
        s.r = 0.8 + Math.random() * 2.2; s.max = s.life = 2 + Math.random() * 2.5;
        s.hue = 190 + Math.random() * 60; s.kind = 0;
      }
    }
    const dShift = this.danger * 0.8;        // shift toward red/orange when in danger
    for (const s of this.spores) {
      if (s.life <= 0) { if (+s.el.getAttribute("opacity")) s.el.setAttribute("opacity", 0); continue; }
      s.life -= dt;
      s.x += s.vx * dt; s.y += s.vy * dt; s.vy += (s.kind ? 20 : 0) * dt;
      const f = clamp(s.life / s.max, 0, 1);
      s.el.setAttribute("cx", s.x.toFixed(1));
      s.el.setAttribute("cy", s.y.toFixed(1));
      s.el.setAttribute("r", (s.r * (s.kind ? f : 1)).toFixed(2));
      s.el.setAttribute("fill", hsl(lerp(s.hue, 8, dShift), 90, 65));
      s.el.setAttribute("opacity", (f * (s.kind ? 0.9 : 0.5)).toFixed(2));
    }
    for (const r of this.rings) {
      if (r.life <= 0) { if (+r.el.getAttribute("opacity")) r.el.setAttribute("opacity", 0); continue; }
      r.life -= dt;
      const f = clamp(r.life / r.max, 0, 1);
      r.el.setAttribute("cx", r.x.toFixed(1));
      r.el.setAttribute("cy", r.y.toFixed(1));
      r.el.setAttribute("r", (r.r0 + (1 - f) * 90).toFixed(1));
      r.el.setAttribute("stroke", hsl(lerp(190, 8, this.danger), 95, 65));
      r.el.setAttribute("opacity", (f * 0.6).toFixed(2));
    }
  }

  _updateStars(dt) {
    const tw = this._frame * 0.05;
    for (const st of this.stars) {
      st.x -= (st.sp + this.audio.bass * 30) * dt * 0.4;
      if (st.x < -4) { st.x = VBW + 4; st.y = Math.random() * VBH; }
      st.el.setAttribute("cx", st.x.toFixed(1));
      const o = 0.25 + 0.25 * Math.sin(tw + st.tw) + this.audio.treble * 0.4;
      st.el.setAttribute("opacity", clamp(o, 0.05, 0.95).toFixed(2));
    }
  }

  // ------------------------------------------------------------------ render
  _render(t) {
    const A = this.audio;

    // world shake when close to the walls
    const sx = (Math.random() - 0.5) * this.shake, sy = (Math.random() - 0.5) * this.shake;
    this.world.setAttribute("transform", `translate(${sx.toFixed(1)} ${sy.toFixed(1)})`);

    // ---- cavern walls (live from audio) ----
    const top = [], bot = [];
    for (const s of this.slices) {
      const x = s.wx - this.worldX;
      top.push({ x, y: s.cy - s.gap / 2 + s.spikeT });
      bot.push({ x, y: s.cy + s.gap / 2 - s.spikeB });
    }
    if (top.length > 1) {
      const x0 = top[0].x, xl = top[top.length - 1].x;
      const topD = `M ${x0.toFixed(1)} -80 L ${x0.toFixed(1)} ${top[0].y.toFixed(1)}` + cubicSegs(top) + ` L ${xl.toFixed(1)} -80 Z`;
      const botD = `M ${x0.toFixed(1)} ${VBH + 80} L ${x0.toFixed(1)} ${bot[0].y.toFixed(1)}` + cubicSegs(bot) + ` L ${xl.toFixed(1)} ${VBH + 80} Z`;
      this.topRock.setAttribute("d", topD);
      this.botRock.setAttribute("d", botD);
      this.topEdge.setAttribute("d", `M ${x0.toFixed(1)} ${top[0].y.toFixed(1)}` + cubicSegs(top));
      this.botEdge.setAttribute("d", `M ${x0.toFixed(1)} ${bot[0].y.toFixed(1)}` + cubicSegs(bot));
    }
    const edgeHue = lerp(lerp(186, 300, A.bass), 8, this.danger);   // cyan->magenta, ->red in danger
    const edgeCol = hsl(((edgeHue % 360) + 360) % 360, 95, 60 + A.bass * 12);
    this.topEdge.setAttribute("stroke", edgeCol);
    this.botEdge.setAttribute("stroke", edgeCol);
    this.neonBlur.setAttribute("stdDeviation", (2.5 + A.level * 6 + this.danger * 3).toFixed(2));

    // ---- creature morph ----
    const cr = this.creature;
    const N = 16, pts = [];
    const tt = t * 0.001;
    const stretch = clamp(cr.vy / 900, -0.5, 0.5);
    for (let i = 0; i < N; i++) {
      const a = (i / N) * 6.2832;
      let rad = cr.r * (1
        + 0.16 * Math.sin(a * 3 + tt * 2.2)
        + 0.10 * Math.sin(a * 5 - tt * 1.6)
        + A.mid * 0.5 * Math.sin(a * 2 + tt * 5)
        + A.treble * 0.35 * Math.sin(a * 7 - tt * 7));
      const ry = rad * (1 + stretch * Math.cos(a));       // squash/stretch with vertical speed
      pts.push({ x: cr.x + Math.cos(a) * rad, y: cr.y + Math.sin(a) * ry });
    }
    this.blob.setAttribute("d", smoothClosed(pts));
    this.blob.setAttribute("fill", hsl(lerp(188, 6, this.danger), 90, 60));
    this.creatureGlow.setAttribute("stdDeviation", (4 + A.level * 8 + this.danger * 6).toFixed(2));
    this.core.setAttribute("cx", cr.x); this.core.setAttribute("cy", cr.y);
    this.core.setAttribute("r", (cr.r * (0.5 + A.level * 0.4)).toFixed(1));
    this.gradC1.setAttribute("stop-color", hsl(lerp(180, 32, this.danger), 100, 96));
    this.gradC2.setAttribute("stop-color", hsl(lerp(300, 8, this.danger), 95, 60));

    // ---- nebula + grain (animated filters) ----
    const bf = (0.009 + A.treble * 0.02 + 0.003 * (0.5 + 0.5 * Math.sin(t * 0.00012)));
    this.nebTurb.setAttribute("baseFrequency", `${bf.toFixed(4)} ${(bf * 1.5).toFixed(4)}`);
    this.nebLayer.setAttribute("opacity", (0.32 + A.level * 0.4).toFixed(2));
    if (this._frame % 2 === 0) this.grainTurb.setAttribute("seed", (this._frame % 90).toString());

    // ---- gooey displacement on the creature ----
    this.gooDisp.setAttribute("scale", (6 + A.mid * 22 + this.danger * 14).toFixed(1));

    // ---- danger vignette ----
    this.danger > 0.02
      ? this.dangerVig.setAttribute("opacity", (this.danger * 0.6).toFixed(2))
      : this.dangerVig.setAttribute("opacity", 0);

    // ---- HUD ----
    this._renderHUD();
  }

  _renderHUD() {
    this.scoreText.textContent = `DEPTH ${Math.floor(this.score)} m`;
    this.bestText.textContent = `BEST ${this.best || 0} m`;
    const bars = [["bass", this.audio.bass], ["mid", this.audio.mid], ["treble", this.audio.treble], ["level", this.audio.level]];
    bars.forEach(([k, v], i) => {
      const h = clamp(v, 0, 1) * 54;
      const r = this._bars[i];
      r.setAttribute("y", (60 - h).toFixed(1));
      r.setAttribute("height", h.toFixed(1));
    });
  }

  _setOverlay(show, title, sub) {
    this.overlay.classList.toggle("show", show);
    if (title != null) this.ovTitle.textContent = title;
    if (sub != null) this.ovSub.textContent = sub;
  }

  // -------------------------------------------------------------- ref cache
  _cacheRefs() {
    const q = s => this.querySelector(s);
    this.svg = q("svg");
    this.world = q("#world");
    this.topRock = q("#topRock"); this.botRock = q("#botRock");
    this.topEdge = q("#topEdge"); this.botEdge = q("#botEdge");
    this.neonBlur = q("#neonBlur");
    this.blob = q("#blob"); this.core = q("#core");
    this.creatureGlow = q("#creatureGlow");
    this.gradC1 = q("#gradC1"); this.gradC2 = q("#gradC2");
    this.nebTurb = q("#nebTurb"); this.nebLayer = q("#nebLayer");
    this.grainTurb = q("#grainTurb");
    this.gooDisp = q("#gooDisp");
    this.dangerVig = q("#dangerVig");
    this.fxLayer = q("#fx"); this.starLayer = q("#stars");
    this.scoreText = q("#scoreText"); this.bestText = q("#bestText");
    this.overlay = q("#overlay"); this.ovTitle = q("#ovTitle"); this.ovSub = q("#ovSub");
    this.panel = q("#panel");
    this._bars = [q("#bar0"), q("#bar1"), q("#bar2"), q("#bar3")];
  }

  // -------------------------------------------------------------- markup
  getHTML() {
    return `
<style>
  *, *::before, *::after { box-sizing: border-box; outline: none; -webkit-tap-highlight-color: transparent; }
  html, body { margin: 0; padding: 0; overflow: hidden; }
  amorph-cavern-ui { display: block; width: 100%; height: 100%; overflow: hidden;
    background: #04060d; user-select: none; -webkit-user-select: none; cursor: crosshair; }
  amorph-cavern-ui svg { display: block; width: 100%; height: 100%; }
  amorph-cavern-ui .hud { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-weight: 700;
    letter-spacing: 2px; fill: #9fd8ff; }
  amorph-cavern-ui #overlay { opacity: 0; transition: opacity .5s ease; pointer-events: none; }
  amorph-cavern-ui #overlay.show { opacity: 1; }
  amorph-cavern-ui #ovTitle { font-family: ui-monospace, Menlo, monospace; font-weight: 800;
    letter-spacing: 10px; fill: #eaf6ff; }
  amorph-cavern-ui #ovSub { font-family: ui-monospace, Menlo, monospace; letter-spacing: 3px; fill: #7fb8e8; }
  @keyframes amorphPulse { 0%,100% { opacity: .85 } 50% { opacity: .35 } }
  amorph-cavern-ui #ovSub { animation: amorphPulse 2.4s ease-in-out infinite; }
  amorph-cavern-ui #tuneBtn { cursor: pointer; }
  amorph-cavern-ui #panel { opacity: 0; pointer-events: none; transition: opacity .25s ease; }
  amorph-cavern-ui #panel.open { opacity: 1; pointer-events: auto; }
  amorph-cavern-ui .ctl-label { fill: #9fd8ff; font: 600 11px ui-monospace, Menlo, monospace; letter-spacing: 1px; }
  amorph-cavern-ui .ctl-val { fill: #eaf6ff; font: 600 11px ui-monospace, Menlo, monospace; }
</style>
<svg viewBox="0 0 ${VBW} ${VBH}" preserveAspectRatio="xMidYMid slice">
  <defs>
    <radialGradient id="bgGrad" cx="50%" cy="42%" r="75%">
      <stop offset="0%" stop-color="#13284a"/>
      <stop offset="45%" stop-color="#0a1230"/>
      <stop offset="100%" stop-color="#03040c"/>
    </radialGradient>
    <linearGradient id="rockGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#0c1d35"/>
      <stop offset="60%" stop-color="#0a1124"/>
      <stop offset="100%" stop-color="#05070f"/>
    </linearGradient>
    <linearGradient id="rockGrad2" x1="0" y1="1" x2="0" y2="0">
      <stop offset="0%" stop-color="#0c1d35"/>
      <stop offset="60%" stop-color="#0a1124"/>
      <stop offset="100%" stop-color="#05070f"/>
    </linearGradient>
    <radialGradient id="creatureGrad" cx="50%" cy="50%" r="50%">
      <stop id="gradC1" offset="0%" stop-color="#ccffff"/>
      <stop id="gradC2" offset="55%" stop-color="#1fc8ff"/>
      <stop offset="100%" stop-color="#0a1840" stop-opacity="0.15"/>
    </radialGradient>
    <radialGradient id="vigGrad" cx="50%" cy="50%" r="70%">
      <stop offset="55%" stop-color="#000" stop-opacity="0"/>
      <stop offset="100%" stop-color="#000" stop-opacity="0.85"/>
    </radialGradient>
    <radialGradient id="dangerGrad" cx="50%" cy="50%" r="72%">
      <stop offset="40%" stop-color="#ff2a00" stop-opacity="0"/>
      <stop offset="100%" stop-color="#ff1500" stop-opacity="0.7"/>
    </radialGradient>

    <!-- animated nebula: fractal turbulence, tinted + blurred -->
    <filter id="nebula" x="-20%" y="-20%" width="140%" height="140%">
      <feTurbulence id="nebTurb" type="fractalNoise" baseFrequency="0.01 0.015" numOctaves="4" seed="7" result="n"/>
      <feColorMatrix in="n" type="matrix" result="t"
        values="0 0 0 0.55 0
                0 0 0 0.10 0
                0 0 0 0.85 0
                0 0 0 0.9 0"/>
      <feGaussianBlur in="t" stdDeviation="7"/>
    </filter>

    <!-- film grain -->
    <filter id="grain">
      <feTurbulence id="grainTurb" type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="3" result="g"/>
      <feColorMatrix in="g" type="matrix"
        values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.05 0"/>
    </filter>

    <!-- neon glow for cavern edges -->
    <filter id="neon" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur id="neonBlur" stdDeviation="4" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>

    <!-- gooey, amorphous creature: blur->alpha contrast + turbulent displacement -->
    <filter id="goo" x="-80%" y="-80%" width="260%" height="260%">
      <feGaussianBlur in="SourceGraphic" stdDeviation="3" result="bl"/>
      <feColorMatrix in="bl" type="matrix"
        values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 20 -8" result="goo"/>
      <feTurbulence type="fractalNoise" baseFrequency="0.018 0.03" numOctaves="2" seed="11" result="warp"/>
      <feDisplacementMap id="gooDisp" in="goo" in2="warp" scale="10" xChannelSelector="R" yChannelSelector="G" result="d"/>
      <feGaussianBlur id="creatureGlow" in="d" stdDeviation="5" result="cg"/>
      <feMerge><feMergeNode in="cg"/><feMergeNode in="d"/></feMerge>
    </filter>
  </defs>

  <!-- backdrop -->
  <rect width="${VBW}" height="${VBH}" fill="url(#bgGrad)"/>
  <rect id="nebLayer" width="${VBW}" height="${VBH}" filter="url(#nebula)" opacity="0.35"/>
  <g id="stars"></g>

  <g id="world">
    <!-- cavern rock -->
    <path id="topRock" fill="url(#rockGrad)"/>
    <path id="botRock" fill="url(#rockGrad2)"/>
    <!-- neon edges -->
    <path id="topEdge" fill="none" stroke="#1fc8ff" stroke-width="3" stroke-linecap="round" filter="url(#neon)"/>
    <path id="botEdge" fill="none" stroke="#1fc8ff" stroke-width="3" stroke-linecap="round" filter="url(#neon)"/>

    <!-- particles -->
    <g id="fx"></g>

    <!-- creature -->
    <g filter="url(#goo)">
      <path id="blob" fill="#1fc8ff"/>
      <circle id="core" cx="${CREATURE_X}" cy="${VBH / 2}" r="14" fill="url(#creatureGrad)"/>
    </g>
  </g>

  <!-- grain + vignette overlays -->
  <rect width="${VBW}" height="${VBH}" filter="url(#grain)" opacity="0.5" pointer-events="none"/>
  <rect width="${VBW}" height="${VBH}" fill="url(#vigGrad)" pointer-events="none"/>
  <rect id="dangerVig" width="${VBW}" height="${VBH}" fill="url(#dangerGrad)" opacity="0" pointer-events="none"/>

  <!-- HUD (all SVG) -->
  <text id="scoreText" class="hud" x="24" y="40" font-size="20">DEPTH 0 m</text>
  <text id="bestText" class="hud" x="24" y="62" font-size="11" opacity="0.6">BEST 0 m</text>
  <g transform="translate(${VBW - 92}, 24)">
    <rect x="-12" y="-8" width="92" height="78" rx="8" fill="#060a16" opacity="0.55"/>
    <rect id="bar0" x="0"  y="60" width="12" height="0" rx="2" fill="#ff5ba6"/>
    <rect id="bar1" x="20" y="60" width="12" height="0" rx="2" fill="#7c6bff"/>
    <rect id="bar2" x="40" y="60" width="12" height="0" rx="2" fill="#27e0ff"/>
    <rect id="bar3" x="60" y="60" width="12" height="0" rx="2" fill="#5cff9b"/>
    <text class="hud" x="0" y="70" font-size="7" opacity="0.6">B</text>
    <text class="hud" x="20" y="70" font-size="7" opacity="0.6">M</text>
    <text class="hud" x="40" y="70" font-size="7" opacity="0.6">T</text>
    <text class="hud" x="60" y="70" font-size="7" opacity="0.6">L</text>
  </g>

  <!-- tuning (all-SVG controls) -->
  <g id="tuneBtn" transform="translate(24,74)">
    <rect x="0" y="0" width="78" height="22" rx="11" fill="#0a1322" stroke="#1b3a5a"/>
    <text x="39" y="15" text-anchor="middle" class="ctl-label">TUNE</text>
  </g>
  <g id="panel" transform="translate(24,104)">
    <rect x="0" y="0" width="234" height="126" rx="12" fill="#060c18" opacity="0.94" stroke="#13294a"/>
    <text x="16" y="26" class="ctl-label" opacity="0.6">SOUND ENGINE</text>

    <text x="16" y="52" class="ctl-label">SENS</text>
    <rect id="sensTrk" x="84" y="46" width="120" height="4" rx="2" fill="#15263f"/>
    <rect id="sensFill" x="84" y="46" width="40" height="4" rx="2" fill="#27e0ff"/>
    <circle id="sensHandle" data-endpoint-id="param1" cx="124" cy="48" r="7" fill="#eaf6ff" stroke="#27e0ff" stroke-width="2" cursor="ew-resize"/>
    <text id="sensVal" x="210" y="52" class="ctl-val">1.0x</text>

    <text x="16" y="82" class="ctl-label">BEND</text>
    <rect id="fxTrk" x="84" y="76" width="120" height="4" rx="2" fill="#15263f"/>
    <rect id="fxFill" x="84" y="76" width="72" height="4" rx="2" fill="#27e0ff"/>
    <circle id="fxHandle" data-endpoint-id="param3" cx="156" cy="78" r="7" fill="#eaf6ff" stroke="#27e0ff" stroke-width="2" cursor="ew-resize"/>
    <text id="fxVal" x="210" y="82" class="ctl-val">60%</text>

    <text x="16" y="112" class="ctl-label">BEND FX</text>
    <g id="bypassToggle" data-endpoint-id="param4" cursor="pointer">
      <rect id="bypassBg" x="84" y="100" width="48" height="20" rx="10" fill="#15263f"/>
      <circle id="bypassKnob" cx="94" cy="110" r="7" fill="#eaf6ff"/>
      <text id="bypassVal" x="146" y="114" class="ctl-val">ON</text>
    </g>
  </g>

  <!-- overlay -->
  <g id="overlay">
    <rect width="${VBW}" height="${VBH}" fill="#03040c" opacity="0.55"/>
    <text id="ovTitle" x="${VBW / 2}" y="${VBH / 2 - 6}" text-anchor="middle" font-size="46" filter="url(#neon)">AMORPH CAVERN</text>
    <text id="ovSub" x="${VBW / 2}" y="${VBH / 2 + 40}" text-anchor="middle" font-size="14">move to fly · click to dive</text>
  </g>
</svg>`;
  }
}

const TAG = "amorph-cavern-ui";
if (!customElements.get(TAG)) customElements.define(TAG, AmorphCavernUI);

export default function createPatchView(patchConnection) {
  return new AmorphCavernUI(patchConnection);
}
