/* ------------------------------------------------------------------------
   IMRNNs - script.js
   Canvas-based embedding modulation visualisation + tabs + scroll reveal
   ------------------------------------------------------------------------ */

/* ── Tab system ── */
const tabs   = Array.from(document.querySelectorAll('.tab'));
const panels = Array.from(document.querySelectorAll('.tab-panel'));

function activateTab(nextTab) {
  tabs.forEach(tab => {
    const isActive = tab === nextTab;
    tab.classList.toggle('active', isActive);
    tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
    tab.tabIndex = isActive ? 0 : -1;
  });

  panels.forEach(panel => {
    const isActive = panel.id === nextTab.dataset.tab;
    panel.classList.toggle('active', isActive);
    panel.hidden = !isActive;
  });
}

tabs.forEach((tab, index) => {
  tab.addEventListener('click', () => activateTab(tab));
  tab.addEventListener('keydown', event => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft' && event.key !== 'Home' && event.key !== 'End') {
      return;
    }

    event.preventDefault();

    let nextIndex = index;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
    if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = tabs.length - 1;

    tabs[nextIndex].focus();
    activateTab(tabs[nextIndex]);
  });
});

Array.from(document.querySelectorAll('[data-copy-target]')).forEach(button => {
  button.addEventListener('click', async () => {
    const target = document.getElementById(button.dataset.copyTarget);
    if (!target) return;

    const text = target.textContent || '';
    const original = button.textContent;

    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const temp = document.createElement('textarea');
        temp.value = text;
        document.body.appendChild(temp);
        temp.select();
        document.execCommand('copy');
        temp.remove();
      }
      button.textContent = 'Copied';
    } catch (error) {
      button.textContent = 'Copy failed';
    }

    window.setTimeout(() => {
      button.textContent = original;
    }, 1400);
  });
});

/* ── IntersectionObserver reveal ── */
const observer = new IntersectionObserver(
  entries => entries.forEach(e => { if (e.isIntersecting) e.target.classList.add('visible'); }),
  { threshold: 0.12 }
);
document.querySelectorAll('.reveal').forEach(n => observer.observe(n));

/* ------------------------------------------------------------------------
   EmbeddingViz - Canvas animation based on IMRNNs Figure 1
   
   Four stages, matching the paper's Figure 1:
     0 - Static space (frozen retriever output, neutral colours)
     1 - Query -> Doc modulation (relevant docs pulled closer, irrelevant pushed)
     2 - Doc -> Query refinement (query shifts toward relevant cluster)
     3 - Final modulated space (settled, token labels appear: Peso/Mexico/Raining/Sky)
   ------------------------------------------------------------------------ */
class EmbeddingViz {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx    = canvas.getContext('2d');
    this.dpr    = Math.min(window.devicePixelRatio || 1, 2);
    this.isPlaying = false;
    this.uiIdx = 0;

    // ── Colour palette ──
    this.C = {
      amber:  '#f0b42a',
      teal:   '#1dd3c0',
      blue:   '#60a4f0',
      rose:   '#e05060',
      text:   'rgba(200,220,255,0.85)',
      muted:  'rgba(130,155,185,0.65)',
      grid:   'rgba(255,255,255,0.025)',
      bg0:    '#060d18',
      bg1:    '#0a1628',
    };

    // ── Stage data (normalised coords 0–1, origin top-left) ──
    this.stages = [
      { // 0: Static - raw retriever embeddings
        q:  { x: 0.23, y: 0.50 },
        d1: { x: 0.64, y: 0.21 },   // relevant
        d2: { x: 0.70, y: 0.53 },   // support
        d3: { x: 0.72, y: 0.83 },   // irrelevant
        lineStyle: 'neutral',
        vectorAlpha: 0,
        tokensAlpha: 0,
        label: 'Static Embedding Space',
        pill:  'Step 1 / 4',
        title: 'Projection into the working space',
        desc:  'IMRNNs starts from the retriever\'s static embedding space and projects query and document embeddings into a compact working space.',
      },
      { // 1: Query → Doc
        q:  { x: 0.23, y: 0.50 },
        d1: { x: 0.52, y: 0.27 },
        d2: { x: 0.58, y: 0.50 },
        d3: { x: 0.82, y: 0.86 },
        lineStyle: 'active',
        vectorAlpha: 0,
        tokensAlpha: 0,
        label: 'Query → Document Modulation',
        pill:  'Step 2 / 4',
        title: 'The query adapter modulates documents',
        desc:  'The query adapter predicts a query-conditioned transform that pulls relevant documents closer and begins pushing irrelevant ones away.',
      },
      { // 2: Doc → Query
        q:  { x: 0.38, y: 0.42 },
        d1: { x: 0.52, y: 0.27 },
        d2: { x: 0.58, y: 0.50 },
        d3: { x: 0.82, y: 0.86 },
        lineStyle: 'active',
        vectorAlpha: 1,
        tokensAlpha: 0,
        label: 'Document → Query Refinement',
        pill:  'Step 3 / 4',
        title: 'The document adapter refines the query',
        desc:  'Candidate documents produce document-side transforms whose aggregate shifts the query toward the relevant semantic neighbourhood.',
      },
      { // 3: Final modulated space
        q:  { x: 0.44, y: 0.40 },
        d1: { x: 0.55, y: 0.25 },
        d2: { x: 0.61, y: 0.48 },
        d3: { x: 0.87, y: 0.89 },
        lineStyle: 'final',
        vectorAlpha: 1,
        tokensAlpha: 1,
        label: 'Modulated Embedding Space',
        pill:  'Step 4 / 4',
        title: 'Final ranking and token attribution',
        desc:  'Relevant concepts dominate around the query while irrelevant concepts recede. Modulation vectors back-project to interpretable keywords: Peso, Mexico vs Raining, Sky.',
      },
    ];

    this.W = 0;
    this.H = 0;

    this.fromIdx    = 0;
    this.toIdx      = 0;
    this.t          = 1;           // transition progress 0→1
    this.holdTimer  = 0;
    this.HOLD_MS    = 3000;        // ms to hold each stage
    this.TRANS_MS   = 750;         // ms for smooth transition
    this.lastTS     = 0;
    this.raf        = null;

    this.stagePill  = document.getElementById('stage-pill');
    this.stageTitle = document.getElementById('stage-title');
    this.stageDesc  = document.getElementById('stage-description');

    this._updateUI(0);
    this.resize();
    this.draw();
  }

  resize() {
    const w = this.canvas.parentElement.clientWidth || 460;
    const h = Math.max(290, Math.min(380, Math.round(w * 0.46)));
    this.W  = w;
    this.H  = h;
    this.canvas.width  = w * this.dpr;
    this.canvas.height = h * this.dpr;
    this.canvas.style.width  = w + 'px';
    this.canvas.style.height = h + 'px';
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.scale(this.dpr, this.dpr);
    this.draw();
  }

  // Normalised → screen pixels (with padding)
  px(nx) { return 52 + nx * (this.W - 104); }
  py(ny) { return 40 + ny * (this.H - 80);  }

  // Ease in-out cubic
  ease(t) { return t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3) / 2; }

  lerp(a, b, t) { return a + (b - a) * this.ease(Math.min(1, Math.max(0, t))); }

  lerpPt(p, q, t) { return { x: this.lerp(p.x, q.x, t), y: this.lerp(p.y, q.y, t) }; }

  _hexToRgb(hex) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return [r, g, b];
  }

  _updateUI(idx) {
    const s = this.stages[idx];
    this.uiIdx = idx;
    if (this.stagePill)  this.stagePill.textContent  = s.pill;
    if (this.stageTitle) this.stageTitle.textContent  = s.title;
    if (this.stageDesc)  this.stageDesc.textContent   = s.desc;
  }

  updateUiForFrame() {
    const frameIdx = this.t < 0.58 ? this.fromIdx : this.toIdx;
    if (frameIdx !== this.uiIdx) this._updateUI(frameIdx);
  }

  /* ─── Drawing primitives ─── */

  drawBg() {
    const ctx = this.ctx;
    const g = ctx.createRadialGradient(this.W * 0.5, this.H * 0.45, 0, this.W * 0.5, this.H * 0.5, this.W * 0.72);
    g.addColorStop(0,   this.C.bg1);
    g.addColorStop(1,   this.C.bg0);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.W, this.H);
  }

  drawGrid() {
    const ctx = this.ctx;
    ctx.strokeStyle = this.C.grid;
    ctx.lineWidth   = 1;
    for (let xi = 0; xi <= this.W; xi += 44) {
      ctx.beginPath(); ctx.moveTo(xi, 0); ctx.lineTo(xi, this.H); ctx.stroke();
    }
    for (let yi = 0; yi <= this.H; yi += 44) {
      ctx.beginPath(); ctx.moveTo(0, yi); ctx.lineTo(this.W, yi); ctx.stroke();
    }
  }

  drawGlow(x, y, r, hex, strength = 0.22) {
    const [ri, gi, bi] = this._hexToRgb(hex);
    const g = this.ctx.createRadialGradient(x, y, 0, x, y, r * 4.5);
    g.addColorStop(0,   `rgba(${ri},${gi},${bi},${strength})`);
    g.addColorStop(0.4, `rgba(${ri},${gi},${bi},${strength * 0.5})`);
    g.addColorStop(1,   `rgba(${ri},${gi},${bi},0)`);
    this.ctx.fillStyle = g;
    this.ctx.beginPath();
    this.ctx.arc(x, y, r * 4.5, 0, Math.PI * 2);
    this.ctx.fill();
  }

  drawDot(x, y, r, hex, label, alpha) {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = alpha;

    this.drawGlow(x, y, r, hex, 0.2);

    // Main fill
    ctx.fillStyle = hex;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();

    // Specular
    ctx.fillStyle = 'rgba(255,255,255,0.28)';
    ctx.beginPath();
    ctx.arc(x - r * 0.22, y - r * 0.3, r * 0.38, 0, Math.PI * 2);
    ctx.fill();

    // Label above
    if (label) {
      ctx.fillStyle = this.C.text;
      ctx.font      = `600 10.5px "DM Sans", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(label, x, y - r - 5);
    }

    ctx.restore();
  }

  drawLine(x1, y1, x2, y2, hex, alpha, width = 1.4) {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha  = alpha;
    ctx.strokeStyle  = hex;
    ctx.lineWidth    = width;
    ctx.lineCap      = 'round';
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.restore();
  }

  drawArrow(x1, y1, x2, y2, hex, alpha) {
    if (alpha < 0.01) return;
    const ctx   = this.ctx;
    const angle = Math.atan2(y2 - y1, x2 - x1);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = hex;
    ctx.fillStyle   = hex;
    ctx.lineWidth   = 2.2;
    ctx.lineCap     = 'round';
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    // Arrowhead
    ctx.translate(x2, y2);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(-8, -3.5);
    ctx.lineTo(-8,  3.5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  drawToken(text, x, y, positive, alpha) {
    if (alpha < 0.02) return;
    const ctx    = this.ctx;
    const color  = positive ? this.C.teal  : this.C.rose;
    const bgRGB  = positive ? '29,211,192' : '224,80,96';
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = `600 9.5px "DM Sans", sans-serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    const tw = ctx.measureText(text).width + 14;
    const th = 17;
    const rx = x - tw / 2, ry = y - th / 2;
    // Pill bg
    ctx.fillStyle   = `rgba(${bgRGB},0.14)`;
    ctx.strokeStyle = `rgba(${bgRGB},0.35)`;
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.roundRect(rx, ry, tw, th, 4);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  drawStageLabel(label, alpha) {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha  = alpha;
    ctx.fillStyle    = this.C.muted;
    ctx.font         = `500 10px "DM Sans", sans-serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(label, this.W / 2, this.H - 10);
    ctx.restore();
  }

  draw() {
    this.updateUiForFrame();

    const T    = this.t;
    const from = this.stages[this.fromIdx];
    const to   = this.stages[this.toIdx];

    // Interpolate positions
    const qp  = this.lerpPt(from.q,  to.q,  T);
    const d1p = this.lerpPt(from.d1, to.d1, T);
    const d2p = this.lerpPt(from.d2, to.d2, T);
    const d3p = this.lerpPt(from.d3, to.d3, T);

    const q  = { x: this.px(qp.x),  y: this.py(qp.y)  };
    const d1 = { x: this.px(d1p.x), y: this.py(d1p.y) };
    const d2 = { x: this.px(d2p.x), y: this.py(d2p.y) };
    const d3 = { x: this.px(d3p.x), y: this.py(d3p.y) };

    const vecAlpha  = this.lerp(from.vectorAlpha,  to.vectorAlpha, T);
    const tokAlpha  = this.lerp(from.tokensAlpha,  to.tokensAlpha, T);
    const stg       = this.uiIdx;

    // Line colours by stage
    const neutral   = 'rgba(160,190,220,0.28)';
    const lClrRel   = stg >= 1 ? this.C.teal  : neutral;
    const lClrSup   = stg >= 1 ? this.C.blue  : neutral;
    const lClrIrr   = stg >= 1 ? this.C.rose  : neutral;
    const lAlpha    = 0.55;
    const lAlphaIrr = stg >= 3 ? 0.22 : lAlpha;

    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.W, this.H);

    this.drawBg();
    this.drawGrid();

    // Connection lines
    this.drawLine(q.x, q.y, d1.x, d1.y, lClrRel, lAlpha);
    this.drawLine(q.x, q.y, d2.x, d2.y, lClrSup, lAlpha * 0.8);
    this.drawLine(q.x, q.y, d3.x, d3.y, lClrIrr, lAlphaIrr);

    // Modulation vector arrow (query shift direction, visible from stage 2)
    if (vecAlpha > 0.01) {
      const ax1 = q.x - 34, ay1 = q.y + 24;
      const ax2 = q.x - 18, ay2 = q.y + 10;
      this.drawArrow(ax1, ay1, ax2, ay2, this.C.teal, vecAlpha * 0.75);
    }

    const showDocLabels = tokAlpha < 0.15;
    this.drawDot(d3.x, d3.y, 7,   this.C.rose,  showDocLabels ? 'D-' : '', stg >= 3 ? 0.42 : 0.82);
    this.drawDot(d2.x, d2.y, 7,   this.C.blue,  showDocLabels ? 'D' : '', 0.82);
    this.drawDot(d1.x, d1.y, 8.5, this.C.teal,  showDocLabels ? 'D+' : '', 0.92);
    this.drawDot(q.x,  q.y,  11,  this.C.amber, 'Q',  1.0);

    if (tokAlpha > 0.01) {
      this.drawToken('Peso',    d1.x - 16, d1.y - 32, true,  tokAlpha);
      this.drawToken('Mexico',  d1.x + 42, d1.y - 8,  true,  tokAlpha);
      this.drawToken('Raining', d3.x - 34, d3.y - 34, false, tokAlpha * 0.55);
      this.drawToken('Sky',     d3.x + 18, d3.y - 52, false, tokAlpha * 0.55);
    }

    this.drawStageLabel(this.stages[this.uiIdx].label, 0.8);
  }

  /* ─── Main render loop ─── */
  render(ts) {
    const dt = Math.min(ts - this.lastTS, 100);
    this.lastTS = ts;

    // Advance hold timer once transition done
    if (this.t >= 1) {
      this.holdTimer += dt;
      if (this.holdTimer >= this.HOLD_MS) {
        this.holdTimer = 0;
        this.fromIdx   = this.toIdx;
        this.toIdx     = (this.toIdx + 1) % this.stages.length;
        this.t         = 0;
      }
    } else {
      this.t = Math.min(1, this.t + dt / this.TRANS_MS);
    }

    this.draw();
    this.raf = requestAnimationFrame(this.render.bind(this));
  }

  start() {
    if (this.isPlaying) return;
    this.isPlaying = true;
    this.lastTS = performance.now();
    this.raf    = requestAnimationFrame(this.render.bind(this));
  }

  stop() {
    this.isPlaying = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = null;
    this.draw();
  }
}

/* ── Boot ── */
const canvas = document.getElementById('embedding-canvas');
if (canvas) {
  const viz = new EmbeddingViz(canvas);
  const toggle = document.getElementById('viz-toggle');
  const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

  const syncToggle = () => {
    if (!toggle) return;
    toggle.textContent = viz.isPlaying ? 'Pause Motion' : 'Play Motion';
    toggle.setAttribute('aria-pressed', viz.isPlaying ? 'true' : 'false');
  };

  if (!motionQuery.matches) viz.start();
  syncToggle();

  if (toggle) {
    toggle.addEventListener('click', () => {
      if (viz.isPlaying) viz.stop();
      else viz.start();
      syncToggle();
    });
  }

  const handleMotionPreference = event => {
    if (event.matches) viz.stop();
    else if (!viz.isPlaying) viz.start();
    syncToggle();
  };

  if (typeof motionQuery.addEventListener === 'function') {
    motionQuery.addEventListener('change', handleMotionPreference);
  } else if (typeof motionQuery.addListener === 'function') {
    motionQuery.addListener(handleMotionPreference);
  }

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => viz.resize(), 200);
  });
}
