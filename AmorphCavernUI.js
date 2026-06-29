// Amorph Cavern — single-file SVG game UI for the Amorph_FX proof of concept.
// WINDOW SIZE: 1000x600
//
// Everything is inline SVG: a procedural feTurbulence rock texture + a parallax
// far-wall layer for depth, volumetric god-rays in the tunnel void, an animated
// nebula + fine film grain, neon feGaussianBlur glow on cavern walls carved live
// from the incoming audio, a bioluminescent creature (rim-lit body, looking eye,
// six flowing tentacles, a wake trail) that morphs as it flies, beat particles,
// foreground bokeh, and an all-SVG HUD.
//
// Data flow (see AmorphCavernDSP.cmajor):
//   audio  -> levelOut/bassOut/midOut/trebleOut events -> shape the world
//   game   -> "Danger" param (param2) -> the DSP bends the audio so you HEAR it
//
// Single file, no imports, light DOM, full cleanup. (dev-kit rules.)

const NS = "http://www.w3.org/2000/svg";
const VBW = 1000, VBH = 600;
const CREATURE_X = 255;          // fixed screen-x of the creature (viewBox units)
const BASE_R = 30;               // creature base radius
const SLICE = 30;                // world spacing between cavern samples
const SAFE = 135;                // clearance (px) considered "fully safe"

const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp = (a, b, t) => a + (b - a) * t;
// interpolate hue along the SHORT arc (so cyan->red goes via magenta, never green)
const hueLerp = (a, b, t) => a + (((b - a + 540) % 360) - 180) * t;
const hsl = (h, s, l, a = 1) => `hsla(${h.toFixed(0)},${s.toFixed(0)}%,${l.toFixed(0)}%,${a})`;
const mk = (name, attrs) => { const e = document.createElementNS(NS, name); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };

// craggy high-frequency detail added to the smooth cavern boundary (deterministic).
const crag = (wx, o) => 7 * Math.sin(wx * 0.06 + o) + 3.5 * Math.sin(wx * 0.16 + o * 1.7);

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

// Closed Catmull-Rom for the morphing creature body.
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
    this.audio = { level: 0, bass: 0, mid: 0, treble: 0 };
    this._endpointListeners = [];
    this._raf = null;
    this._onPointer = null; this._onDown = null; this._onKey = null;
    this._lastT = 0; this._lastDangerSend = 0; this._frame = 0;
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
    bind("levelOut", "level"); bind("bassOut", "bass"); bind("midOut", "mid"); bind("trebleOut", "treble");
    this._send = v => this.pc.sendEventOrValue?.("param2", clamp(v, 0, 1));
  }

  // ----------------------------------------------------- SVG tuning controls
  _wireControls() {
    this._sent = [];
    this._cur = { param1: 1.0, param3: 0.6, param4: 0 };
    this._panelOpen = false;
    const send = (id, v) => { this._sent.push({ id, v }); if (this._sent.length > 32) this._sent.shift(); this.pc.sendEventOrValue?.(id, v); };
    const isEcho = (id, v) => this._sent.some(p => p.id === id && Math.abs(p.v - v) < 1e-4);

    this.querySelector("#tuneBtn").addEventListener("pointerdown", e => {
      e.stopPropagation(); this._panelOpen = !this._panelOpen; this.panel.classList.toggle("open", this._panelOpen);
    });

    const X0 = 108, L = 120;
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
        valEl.textContent = fmt(v); this._cur[id] = v;
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
      const m = this.svg.getScreenCTM(); if (!m) return;
      const pt = this.svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
      const loc = pt.matrixTransform(m.inverse());
      this.targetY = clamp(loc.y, 36, VBH - 36); this._pointerActive = true;
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
    this._resetGame(false); this.state = "play"; this._setOverlay(false);
  }

  // ------------------------------------------------------------- game state
  _resetGame(initial) {
    this.state = "idle";
    this.worldX = 0; this.speed = 150; this.score = 0; this.danger = 0; this.shake = 0;
    this.creature = { x: CREATURE_X, y: VBH / 2, vy: 0, r: BASE_R };
    this.targetY = this.targetY ?? VBH / 2;
    this.slices = []; this._genX = -SLICE * 3; this._noisePhase = Math.random() * 1000; this._cy = VBH / 2;
    while (this._genX < VBW + SLICE * 3) this._spawnSlice();
    if (initial) {
      this.best = +(localStorage.getItem("amorphCavernBest") || 0);
      this._setOverlay(true, "AMORPH CAVERN", "move to fly · feed the cavern with sound · click / space to dive");
    }
  }

  _spawnSlice() {
    const p = this._noisePhase + this._genX * 0.0042;
    const wander = Math.sin(p) * 120 + Math.sin(p * 2.3 + 1.7) * 54 + Math.sin(p * 4.7 + 0.5) * 22;
    this._cy = lerp(this._cy, VBH / 2 + wander, 0.5);
    const diff = clamp(this.score / 2600, 0, 1);
    let gap = 252 - this.audio.bass * 96 - diff * 66;
    gap = clamp(gap, 124, 300);
    const spikeT = this.audio.treble * Math.random() * 26;
    const spikeB = this.audio.treble * Math.random() * 26;
    this.slices.push({ wx: this._genX, cy: this._cy, gap, spikeT, spikeB });
    this._genX += SLICE;
  }

  // ----------------------------------------------------------------- update
  _tick(t) {
    const dt = this._lastT ? clamp((t - this._lastT) / 1000, 0, 0.05) : 0.016;
    this._lastT = t; this._frame++;
    const dk = Math.pow(0.0008, dt);
    this.audio.level *= dk; this.audio.bass *= dk; this.audio.mid *= dk; this.audio.treble *= dk;
    this._update(dt, t); this._render(t);
  }

  _update(dt, t) {
    if (this.state === "play") this.speed = Math.min(330, this.speed + dt * 7);
    const sc = (this.state === "idle") ? this.speed * 0.45 : this.speed;
    this.worldX += sc * dt;

    while (this.slices.length && this.slices[0].wx - this.worldX < -SLICE * 2) this.slices.shift();
    while (this._genX - this.worldX < VBW + SLICE * 3) this._spawnSlice();

    const cr = this.creature;
    if (this.state === "idle" || (!this._pointerActive && this.state !== "play")) {
      this.targetY = VBH / 2 + Math.sin(t * 0.0016) * 120;
    }
    const prevY = cr.y;
    cr.y = lerp(cr.y, this.targetY, clamp(dt * 8, 0, 1));
    cr.vy = (cr.y - prevY) / Math.max(dt, 1e-3);
    cr.r = lerp(cr.r, BASE_R + this.audio.level * 10, 0.2);

    const b = this._boundaryAt(CREATURE_X);
    const clearance = Math.min(cr.y - b.top, b.bot - cr.y) - cr.r;
    let danger = clamp(1 - clearance / SAFE, 0, 1);
    if (this.state === "play") { this.score += sc * dt * 0.1; if (clearance <= 0) this._die(); }
    else danger *= 0.25;
    this.danger = lerp(this.danger, danger, 0.25);
    this.shake = lerp(this.shake, this.danger * this.danger * 9, 0.3);

    if (t - this._lastDangerSend > 33) { this._send?.(this.state === "play" ? this.danger : 0); this._lastDangerSend = t; }

    const lvl = this.audio.level;
    if (lvl > 0.32 && lvl - (this._lastLvl || 0) > 0.08) this._beat(lvl);
    this._lastLvl = lvl;

    this._updateParticles(dt);
    this._updateStars(dt);
    this._updateBokeh(dt);
  }

  _boundaryAt(screenX) {
    const wx = screenX + this.worldX;
    const s = this.slices;
    let i = 1; while (i < s.length && s[i].wx < wx) i++;
    const a = s[Math.max(0, i - 1)], c = s[Math.min(s.length - 1, i)];
    const span = (c.wx - a.wx) || 1; const f = clamp((wx - a.wx) / span, 0, 1);
    const cy = lerp(a.cy, c.cy, f), gap = lerp(a.gap, c.gap, f);
    const st = lerp(a.spikeT, c.spikeT, f), sb = lerp(a.spikeB, c.spikeB, f);
    return { top: cy - gap / 2 + st + crag(wx, 0.3), bot: cy + gap / 2 - sb + crag(wx, 2.1) };
  }

  _die() {
    this.state = "dead";
    this.best = Math.max(this.best, Math.floor(this.score));
    localStorage.setItem("amorphCavernBest", String(this.best));
    this._burst(this.creature.x, this.creature.y, 34, 1.2);
    this._setOverlay(true, "LOST IN THE DARK", `depth ${Math.floor(this.score)} m   ·   best ${this.best} m   ·   click to dive again`);
  }

  // --------------------------------------------------------------- particles
  _buildPools() {
    this.spores = [];
    for (let i = 0; i < 140; i++) {
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
    for (let i = 0; i < 54; i++) {
      const x = Math.random() * VBW, y = Math.random() * VBH, r = 0.6 + Math.random() * 1.8;
      const el = mk("circle", { cx: x, cy: y, r, fill: "#bcd8ff", opacity: 0.2 + Math.random() * 0.4 });
      this.starLayer.appendChild(el);
      this.stars.push({ el, x, y, r, sp: 6 + Math.random() * 26, tw: Math.random() * 6.28 });
    }
    // foreground bokeh — big soft out-of-focus motes for depth
    this.bokeh = [];
    const bg = this.querySelector("#bokeh");
    for (let i = 0; i < 7; i++) {
      const x = Math.random() * VBW, y = Math.random() * VBH, r = 26 + Math.random() * 48;
      const el = mk("circle", { cx: x, cy: y, r, fill: "#39d6ff", opacity: 0.05 });
      bg.appendChild(el);
      this.bokeh.push({ el, x, y, r, sp: 10 + Math.random() * 22, ph: Math.random() * 6.28 });
    }
    // tentacles
    this._tentSegs = 5; this._tentacles = [];
    const tg = this.querySelector("#tentacles");
    for (let k = 0; k < 6; k++) {
      const el = mk("path", { fill: "none", "stroke-width": (3.4 - k * 0.15).toFixed(2), "stroke-linecap": "round", opacity: 0.8 });
      tg.appendChild(el); this._tentacles.push(el);
    }
  }

  _beat(lvl) {
    const cr = this.creature;
    this._burst(cr.x + 6, cr.y, Math.round(5 + lvl * 9), lvl);
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
    if (this._frame % 3 === 0) {
      const s = this.spores.find(p => p.life <= 0);
      if (s) {
        s.x = VBW + 10; s.y = Math.random() * VBH;
        s.vx = -(20 + Math.random() * 40); s.vy = (Math.random() - 0.5) * 20;
        s.r = 0.8 + Math.random() * 2.2; s.max = s.life = 2 + Math.random() * 2.5;
        s.hue = 190 + Math.random() * 60; s.kind = 0;
      }
    }
    // continuous wake trail behind the creature
    const cr = this.creature;
    const w = this.spores.find(p => p.life <= 0);
    if (w) {
      w.x = cr.x - cr.r * 0.5; w.y = cr.y + (Math.random() - 0.5) * cr.r * 0.9;
      w.vx = -(Math.max(this.speed, 120) * 0.85); w.vy = (Math.random() - 0.5) * 14;
      w.r = 1.6 + Math.random() * 2.6; w.max = w.life = 0.55 + Math.random() * 0.45;
      w.hue = lerp(190, 6, this.danger); w.kind = 2;
    }

    const dShift = this.danger * 0.8;
    for (const s of this.spores) {
      if (s.life <= 0) { if (+s.el.getAttribute("opacity")) s.el.setAttribute("opacity", 0); continue; }
      s.life -= dt;
      s.x += s.vx * dt; s.y += s.vy * dt; s.vy += (s.kind === 1 ? 20 : 0) * dt;
      const f = clamp(s.life / s.max, 0, 1);
      s.el.setAttribute("cx", s.x.toFixed(1));
      s.el.setAttribute("cy", s.y.toFixed(1));
      s.el.setAttribute("r", (s.r * (s.kind ? f : 1)).toFixed(2));
      s.el.setAttribute("fill", hsl(hueLerp(s.hue, 8, dShift), 90, 66));
      s.el.setAttribute("opacity", (f * (s.kind ? 0.9 : 0.5)).toFixed(2));
    }
    for (const r of this.rings) {
      if (r.life <= 0) { if (+r.el.getAttribute("opacity")) r.el.setAttribute("opacity", 0); continue; }
      r.life -= dt;
      const f = clamp(r.life / r.max, 0, 1);
      r.el.setAttribute("cx", r.x.toFixed(1)); r.el.setAttribute("cy", r.y.toFixed(1));
      r.el.setAttribute("r", (r.r0 + (1 - f) * 95).toFixed(1));
      r.el.setAttribute("stroke", hsl(hueLerp(190, 8, this.danger), 95, 66));
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

  _updateBokeh(dt) {
    for (const b of this.bokeh) {
      b.x -= (b.sp + this.audio.bass * 24) * dt;
      if (b.x < -b.r) { b.x = VBW + b.r; b.y = Math.random() * VBH; }
      b.el.setAttribute("cx", b.x.toFixed(1));
      b.el.setAttribute("cy", (b.y + Math.sin(this._frame * 0.01 + b.ph) * 12).toFixed(1));
      b.el.setAttribute("fill", hsl(hueLerp(190, 8, this.danger * 0.7), 85, 62));
      b.el.setAttribute("opacity", (0.04 + this.audio.level * 0.06).toFixed(3));
    }
  }

  // ------------------------------------------------------------------ render
  _render(t) {
    const A = this.audio;
    const sx = (Math.random() - 0.5) * this.shake, sy = (Math.random() - 0.5) * this.shake;
    this.world.setAttribute("transform", `translate(${sx.toFixed(1)} ${sy.toFixed(1)})`);

    this._renderFar(t, A);
    this._renderWalls(t, A);
    this._renderCreature(t, A);

    // nebula + grain
    const bf = (0.009 + A.treble * 0.018 + 0.003 * (0.5 + 0.5 * Math.sin(t * 0.00012)));
    this.nebTurb.setAttribute("baseFrequency", `${bf.toFixed(4)} ${(bf * 1.5).toFixed(4)}`);
    this.nebLayer.setAttribute("opacity", (0.3 + A.level * 0.35).toFixed(2));
    if (this._frame % 2 === 0) this.grainTurb.setAttribute("seed", (this._frame % 90).toString());

    // god-rays sway + intensity
    this.rays.setAttribute("transform", `rotate(${(Math.sin(t * 0.0002) * 4).toFixed(2)} 520 -40)`);
    this.rays.setAttribute("opacity", (0.05 + A.level * 0.13 + A.treble * 0.05).toFixed(3));

    // scrolling rock texture
    this.rockTex.setAttribute("patternTransform", `translate(${((-this.worldX * 0.6) % 600).toFixed(1)} 0)`);

    this.danger > 0.02 ? this.dangerVig.setAttribute("opacity", (this.danger * 0.6).toFixed(2)) : this.dangerVig.setAttribute("opacity", 0);
    this._renderHUD();
  }

  _renderFar(t, A) {
    const off = this.worldX * 0.5, pts = 24, top = [], bot = [];
    for (let i = 0; i <= pts; i++) {
      const x = i / pts * VBW, wx = x + off, p = this._noisePhase * 0.7 + wx * 0.003;
      const cy = VBH / 2 + Math.sin(p) * 150 + Math.sin(p * 2.1 + 1) * 60;
      const gap = 330 + Math.sin(p * 1.3) * 40;
      top.push({ x, y: cy - gap / 2 }); bot.push({ x, y: cy + gap / 2 });
    }
    this.farTop.setAttribute("d", `M 0 -60 L 0 ${top[0].y.toFixed(1)}` + cubicSegs(top) + ` L ${VBW} -60 Z`);
    this.farBot.setAttribute("d", `M 0 ${VBH + 60} L 0 ${bot[0].y.toFixed(1)}` + cubicSegs(bot) + ` L ${VBW} ${VBH + 60} Z`);
  }

  _renderWalls(t, A) {
    const top = [], bot = [];
    for (const s of this.slices) {
      const x = s.wx - this.worldX, wx = s.wx;
      top.push({ x, y: s.cy - s.gap / 2 + s.spikeT + crag(wx, 0.3) });
      bot.push({ x, y: s.cy + s.gap / 2 - s.spikeB + crag(wx, 2.1) });
    }
    if (top.length > 1) {
      const x0 = top[0].x, xl = top[top.length - 1].x;
      this.topRock.setAttribute("d", `M ${x0.toFixed(1)} -80 L ${x0.toFixed(1)} ${top[0].y.toFixed(1)}` + cubicSegs(top) + ` L ${xl.toFixed(1)} -80 Z`);
      this.botRock.setAttribute("d", `M ${x0.toFixed(1)} ${VBH + 80} L ${x0.toFixed(1)} ${bot[0].y.toFixed(1)}` + cubicSegs(bot) + ` L ${xl.toFixed(1)} ${VBH + 80} Z`);
      const topEdgeD = `M ${x0.toFixed(1)} ${top[0].y.toFixed(1)}` + cubicSegs(top);
      const botEdgeD = `M ${x0.toFixed(1)} ${bot[0].y.toFixed(1)}` + cubicSegs(bot);
      this.topEdge.setAttribute("d", topEdgeD); this.botEdge.setAttribute("d", botEdgeD);
    }
    const edgeHue = hueLerp(lerp(186, 300, A.bass), 8, this.danger);
    const edgeCol = hsl(((edgeHue % 360) + 360) % 360, 95, 60 + A.bass * 12);
    this.topEdge.setAttribute("stroke", edgeCol); this.botEdge.setAttribute("stroke", edgeCol);
    this.neonBlur.setAttribute("stdDeviation", (2.5 + A.level * 6 + this.danger * 3).toFixed(2));
  }

  _renderCreature(t, A) {
    const cr = this.creature, tt = t * 0.001, dHue = this.danger;
    const bodyHue = hueLerp(190, 6, dHue), bodyCol = hsl(bodyHue, 90, 64);

    // body morph
    const N = 18, pts = [];
    const stretch = clamp(cr.vy / 800, -0.45, 0.45);
    for (let i = 0; i < N; i++) {
      const a = (i / N) * 6.2832;
      const rad = cr.r * (1 + 0.12 * Math.sin(a * 3 + tt * 2) + 0.08 * Math.sin(a * 5 - tt * 1.7)
        + A.mid * 0.32 * Math.sin(a * 2 + tt * 4) + A.treble * 0.2 * Math.sin(a * 7 - tt * 6));
      const ry = rad * (1 + stretch * Math.cos(a));
      pts.push({ x: cr.x + Math.cos(a) * rad, y: cr.y + Math.sin(a) * ry });
    }
    this.blob.setAttribute("d", smoothClosed(pts));
    this.blob.setAttribute("stroke", hsl(bodyHue, 100, 82));
    this.bodyG1.setAttribute("stop-color", hsl(hueLerp(184, 34, dHue), 100, 97));
    this.bodyG2.setAttribute("stop-color", hsl(bodyHue, 95, 56));

    // core
    this.core.setAttribute("cx", cr.x); this.core.setAttribute("cy", cr.y);
    this.core.setAttribute("r", (cr.r * (0.55 + A.level * 0.35)).toFixed(1));

    // tentacles trailing rear (-x), swaying
    const amp = 5 + A.mid * 16 + A.level * 8, M = this._tentacles.length;
    this._tentacles.forEach((el, k) => {
      const S = this._tentSegs;
      const rootY = cr.y + ((k / (M - 1)) - 0.5) * cr.r * 1.2;
      const rootX = cr.x - cr.r * 0.5;
      const pp = [];
      for (let s = 0; s <= S; s++) {
        const fx = s / S;
        const x = rootX - fx * cr.r * 2.7;
        const y = rootY + Math.sin(tt * 5 + k * 0.8 + s * 0.7) * amp * fx - cr.vy * 0.012 * cr.r * fx;
        pp.push({ x, y });
      }
      el.setAttribute("d", `M ${pp[0].x.toFixed(1)} ${pp[0].y.toFixed(1)}` + cubicSegs(pp));
      el.setAttribute("stroke", bodyCol);
    });

    // eye toward travel
    const ex = cr.x + cr.r * 0.4, ey = cr.y - cr.r * 0.05, er = cr.r * 0.34;
    const look = clamp(cr.vy * 0.01, -1, 1);
    this.eyeWhite.setAttribute("cx", ex); this.eyeWhite.setAttribute("cy", ey); this.eyeWhite.setAttribute("r", er.toFixed(1));
    this.eyeIris.setAttribute("cx", (ex + er * 0.25).toFixed(1)); this.eyeIris.setAttribute("cy", (ey + er * 0.4 * look).toFixed(1)); this.eyeIris.setAttribute("r", (er * 0.55).toFixed(1));
    this.eyeIris.setAttribute("fill", hsl(bodyHue, 95, 52));
    this.eyePupil.setAttribute("cx", (ex + er * 0.3).toFixed(1)); this.eyePupil.setAttribute("cy", (ey + er * 0.4 * look).toFixed(1)); this.eyePupil.setAttribute("r", (er * 0.27).toFixed(1));
    this.eyeShine.setAttribute("cx", (ex + er * 0.02).toFixed(1)); this.eyeShine.setAttribute("cy", (ey - er * 0.32).toFixed(1)); this.eyeShine.setAttribute("r", (er * 0.15).toFixed(1));

    this.creatureGlow.setAttribute("stdDeviation", (5 + A.level * 7 + this.danger * 5).toFixed(2));
  }

  _renderHUD() {
    this.scoreText.textContent = `DEPTH ${Math.floor(this.score)} m`;
    this.bestText.textContent = `BEST ${this.best || 0} m`;
    const bars = [this.audio.bass, this.audio.mid, this.audio.treble, this.audio.level];
    bars.forEach((v, i) => { const h = clamp(v, 0, 1) * 54; const r = this._bars[i]; r.setAttribute("y", (60 - h).toFixed(1)); r.setAttribute("height", h.toFixed(1)); });
  }

  _setOverlay(show, title, sub) {
    this.overlay.classList.toggle("show", show);
    if (title != null) this.ovTitle.textContent = title;
    if (sub != null) this.ovSub.textContent = sub;
  }

  // -------------------------------------------------------------- ref cache
  _cacheRefs() {
    const q = s => this.querySelector(s);
    this.svg = q("svg"); this.world = q("#world");
    this.farTop = q("#farTop"); this.farBot = q("#farBot");
    this.topRock = q("#topRock"); this.botRock = q("#botRock");
    this.topEdge = q("#topEdge"); this.botEdge = q("#botEdge");
    this.neonBlur = q("#neonBlur");
    this.blob = q("#blob"); this.core = q("#core");
    this.bodyG1 = q("#bodyG1"); this.bodyG2 = q("#bodyG2");
    this.eyeWhite = q("#eyeWhite"); this.eyeIris = q("#eyeIris"); this.eyePupil = q("#eyePupil"); this.eyeShine = q("#eyeShine");
    this.creatureGlow = q("#creatureGlow");
    this.nebTurb = q("#nebTurb"); this.nebLayer = q("#nebLayer"); this.grainTurb = q("#grainTurb");
    this.rays = q("#rays"); this.rockTex = q("#rockTex");
    this.dangerVig = q("#dangerVig");
    this.fxLayer = q("#fx"); this.starLayer = q("#stars");
    this.scoreText = q("#scoreText"); this.bestText = q("#bestText");
    this.overlay = q("#overlay"); this.ovTitle = q("#ovTitle"); this.ovSub = q("#ovSub");
    this.panel = q("#panel");
    this._bars = [q("#bar0"), q("#bar1"), q("#bar2"), q("#bar3")];
  }

  // -------------------------------------------------------------- markup
  getHTML() {
    const ray = (x, w, rot) => `<rect x="${x}" y="-60" width="${w}" height="760" fill="url(#rayGrad)" transform="rotate(${rot} ${x + w / 2} -60)"/>`;
    return `
<style>
  *, *::before, *::after { box-sizing: border-box; outline: none; -webkit-tap-highlight-color: transparent; }
  html, body { margin: 0; padding: 0; overflow: hidden; }
  amorph-cavern-ui { display: block; width: 100%; height: 100%; overflow: hidden;
    background: #04060d; user-select: none; -webkit-user-select: none; cursor: crosshair; }
  amorph-cavern-ui svg { display: block; width: 100%; height: 100%; }
  amorph-cavern-ui .hud { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-weight: 700; letter-spacing: 2px; fill: #9fd8ff; }
  amorph-cavern-ui #overlay { opacity: 0; transition: opacity .5s ease; pointer-events: none; }
  amorph-cavern-ui #overlay.show { opacity: 1; }
  amorph-cavern-ui #ovTitle { font-family: ui-monospace, Menlo, monospace; font-weight: 800; letter-spacing: 10px; fill: #eaf6ff; }
  amorph-cavern-ui #ovSub { font-family: ui-monospace, Menlo, monospace; letter-spacing: 3px; fill: #7fb8e8; animation: amorphPulse 2.4s ease-in-out infinite; }
  @keyframes amorphPulse { 0%,100% { opacity: .85 } 50% { opacity: .35 } }
  amorph-cavern-ui #tuneBtn { cursor: pointer; }
  amorph-cavern-ui #panel { opacity: 0; pointer-events: none; transition: opacity .25s ease; }
  amorph-cavern-ui #panel.open { opacity: 1; pointer-events: auto; }
  amorph-cavern-ui .ctl-label { fill: #9fd8ff; font: 600 11px ui-monospace, Menlo, monospace; letter-spacing: 1px; }
  amorph-cavern-ui .ctl-val { fill: #eaf6ff; font: 600 11px ui-monospace, Menlo, monospace; }
</style>
<svg viewBox="0 0 ${VBW} ${VBH}" preserveAspectRatio="xMidYMid slice">
  <defs>
    <radialGradient id="bgGrad" cx="50%" cy="40%" r="80%">
      <stop offset="0%" stop-color="#152a52"/>
      <stop offset="45%" stop-color="#0a1430"/>
      <stop offset="100%" stop-color="#03040c"/>
    </radialGradient>
    <radialGradient id="bodyGrad" cx="42%" cy="36%" r="68%">
      <stop id="bodyG1" offset="0%" stop-color="#ccffff"/>
      <stop id="bodyG2" offset="58%" stop-color="#17b6ff"/>
      <stop offset="100%" stop-color="#0a2052" stop-opacity="0.9"/>
    </radialGradient>
    <radialGradient id="coreGrad" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="40%" stop-color="#bff2ff" stop-opacity="0.8"/>
      <stop offset="100%" stop-color="#bff2ff" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="rayGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#9fe8ff" stop-opacity="0.6"/>
      <stop offset="100%" stop-color="#9fe8ff" stop-opacity="0"/>
    </linearGradient>
    <radialGradient id="vigGrad" cx="50%" cy="50%" r="72%">
      <stop offset="52%" stop-color="#000" stop-opacity="0"/>
      <stop offset="100%" stop-color="#000" stop-opacity="0.88"/>
    </radialGradient>
    <radialGradient id="dangerGrad" cx="50%" cy="50%" r="72%">
      <stop offset="38%" stop-color="#ff2a00" stop-opacity="0"/>
      <stop offset="100%" stop-color="#ff1500" stop-opacity="0.72"/>
    </radialGradient>

    <!-- procedural rock texture (rasterised once, scrolled via patternTransform) -->
    <filter id="rockNoise">
      <feTurbulence type="fractalNoise" baseFrequency="0.021 0.027" numOctaves="5" seed="9" result="t"/>
      <feColorMatrix in="t" type="matrix"
        values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0.9 0.9 0.9 0 -0.42" result="a"/>
      <feFlood flood-color="#22386180" result="c"/>
      <feComposite in="c" in2="a" operator="in"/>
    </filter>
    <pattern id="rockTex" width="600" height="600" patternUnits="userSpaceOnUse">
      <rect width="600" height="600" fill="#0a1426"/>
      <rect width="600" height="600" filter="url(#rockNoise)"/>
    </pattern>

    <!-- animated nebula -->
    <filter id="nebula" x="-20%" y="-20%" width="140%" height="140%">
      <feTurbulence id="nebTurb" type="fractalNoise" baseFrequency="0.01 0.015" numOctaves="4" seed="7" result="n"/>
      <feColorMatrix in="n" type="matrix" result="tt"
        values="0 0 0 0.5 0  0 0 0 0.18 0  0 0 0 0.9 0  0 0 0 0.9 0"/>
      <feGaussianBlur in="tt" stdDeviation="8"/>
    </filter>

    <!-- fine film grain -->
    <filter id="grain">
      <feTurbulence id="grainTurb" type="fractalNoise" baseFrequency="1.3" numOctaves="2" seed="3" result="g"/>
      <feColorMatrix in="g" type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.035 0"/>
    </filter>

    <!-- neon glow for cavern edges -->
    <filter id="neon" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur id="neonBlur" stdDeviation="4" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>

    <!-- bioluminescent glow that keeps the creature's shape crisp -->
    <filter id="bioGlow" x="-120%" y="-120%" width="340%" height="340%">
      <feGaussianBlur id="creatureGlow" in="SourceGraphic" stdDeviation="6" result="g"/>
      <feMerge><feMergeNode in="g"/><feMergeNode in="g"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>

    <filter id="soft" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="9"/></filter>
  </defs>

  <!-- backdrop -->
  <rect width="${VBW}" height="${VBH}" fill="url(#bgGrad)"/>
  <rect id="nebLayer" width="${VBW}" height="${VBH}" filter="url(#nebula)" opacity="0.32"/>
  <g id="stars"></g>

  <!-- parallax far walls (depth) -->
  <g filter="url(#soft)" opacity="0.55">
    <path id="farTop" fill="#070f20"/>
    <path id="farBot" fill="#070f20"/>
  </g>

  <!-- volumetric god-rays (show in the tunnel void, behind the rock) -->
  <g id="rays" opacity="0.08" filter="url(#soft)">
    ${ray(180, 38, -14)}${ray(360, 30, -6)}${ray(520, 46, 4)}${ray(700, 30, 12)}${ray(860, 40, 18)}
  </g>

  <g id="world">
    <path id="topRock" fill="url(#rockTex)"/>
    <path id="botRock" fill="url(#rockTex)"/>
    <path id="topEdge" fill="none" stroke="#1fc8ff" stroke-width="3" stroke-linecap="round" filter="url(#neon)"/>
    <path id="botEdge" fill="none" stroke="#1fc8ff" stroke-width="3" stroke-linecap="round" filter="url(#neon)"/>

    <g id="fx"></g>

    <g id="creature" filter="url(#bioGlow)">
      <g id="tentacles"></g>
      <path id="blob" fill="url(#bodyGrad)" stroke="#bff2ff" stroke-width="2"/>
      <circle id="core" cx="${CREATURE_X}" cy="${VBH / 2}" r="16" fill="url(#coreGrad)"/>
      <g id="eye">
        <circle id="eyeWhite" cx="${CREATURE_X + 12}" cy="${VBH / 2}" r="10" fill="#f2fbff"/>
        <circle id="eyeIris" cx="${CREATURE_X + 14}" cy="${VBH / 2}" r="5.5" fill="#17b6ff"/>
        <circle id="eyePupil" cx="${CREATURE_X + 15}" cy="${VBH / 2}" r="2.7" fill="#05101f"/>
        <circle id="eyeShine" cx="${CREATURE_X + 12}" cy="${VBH / 2 - 3}" r="1.6" fill="#ffffff"/>
      </g>
    </g>
  </g>

  <!-- foreground depth + overlays -->
  <g id="bokeh"></g>
  <rect width="${VBW}" height="${VBH}" filter="url(#grain)" opacity="0.6" pointer-events="none"/>
  <rect width="${VBW}" height="${VBH}" fill="url(#vigGrad)" pointer-events="none"/>
  <rect id="dangerVig" width="${VBW}" height="${VBH}" fill="url(#dangerGrad)" opacity="0" pointer-events="none"/>

  <!-- HUD -->
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
