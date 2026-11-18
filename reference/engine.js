// ===================== DrumEngine v0.1 =====================
// Physical drum model: modal membranes + coupled air cavity/port + nonlinear mallet
// contact + snare wires (unilateral contact) + shell (Donnell cylinder) + hoop (ring) modes.
// Written to be ported 1:1 to C++ (JUCE processBlock -> Voice.process).
var DrumEngine = (function () {
  'use strict';
  var RHO = 1.2, C = 343, TAU = 2 * Math.PI, NU = 0.35;
  var QB = 0, CHICK = 25, TAUMET = 0.2, MMAX = 10, NMAX = 7, NPROXY = 36, RESK = 400, RINGK = 2500;

  // ---------- Bessel functions (trapezoid on periodic integral: exponentially accurate) ----------
  function besselJ(m, x) {
    var N = 112, s = 0;
    for (var k = 0; k < N; k++) { var t = TAU * k / N; s += Math.cos(m * t - x * Math.sin(t)); }
    return s / N;
  }
  var ZEROS = [], JNEXT = [], RAD = [], RT = 256;
  (function init() {
    for (var m = 0; m <= MMAX; m++) {
      var zs = [], x = m === 0 ? 0.5 : m + 0.5, step = 0.1, prev = besselJ(m, x);
      while (zs.length < NMAX) {
        var x2 = x + step, cur = besselJ(m, x2);
        if (prev * cur < 0) {
          var lo = x, hi = x2, flo = prev;
          for (var it = 0; it < 48; it++) {
            var mid = 0.5 * (lo + hi), fm = besselJ(m, mid);
            if (flo * fm <= 0) hi = mid; else { lo = mid; flo = fm; }
          }
          zs.push(0.5 * (lo + hi));
        }
        x = x2; prev = cur;
      }
      ZEROS.push(zs);
      JNEXT.push(zs.map(function (j) { return besselJ(m + 1, j); }));
      RAD.push(zs.map(function (j) {
        var t = new Float32Array(RT + 2);
        for (var i = 0; i <= RT + 1; i++) t[i] = besselJ(m, j * Math.min(1, i / RT));
        return t;
      }));
    }
  })();
  function radial(m, n, r) {
    if (r <= 0) return RAD[m][n][0];
    var t = Math.min(1, r) * RT, i = t | 0, f = t - i, tab = RAD[m][n];
    return tab[i] + (tab[i + 1] - tab[i]) * f;
  }
  function hash(m, n) { var s = Math.sin(m * 12.9898 + n * 78.233) * 43758.5453; return s - Math.floor(s); }

  // ---------- Material tables ----------
  // rho kg/m^3, E Pa, eta = internal loss factor, hf = extra high-frequency loss, coat = added kg/m^2
  var HEAD_MATS = {
    mylar_clear:  { name: 'Mylar (clear)',            rho: 1390, E: 4.5e9, eta: 0.006, hf: 0.3, coat: 0,     thick: 0.254, color: '#dfe9ee', alpha: 0.55 , ys: 1.2e+08 },
    mylar_coated: { name: 'Mylar (coated)',           rho: 1390, E: 4.5e9, eta: 0.016, hf: 1.2, coat: 0.025, thick: 0.254, color: '#f3f1ea', alpha: 1 , ys: 1.2e+08 },
    mylar_2ply:   { name: 'Mylar 2-ply (oil/film)',   rho: 1390, E: 4.5e9, eta: 0.04,  hf: 1.6, coat: 0.01,  thick: 0.356, color: '#c9d8de', alpha: 0.75 , ys: 1.2e+08 },
    synth_skin:   { name: 'Synthetic skin (fiber)',   rho: 1300, E: 3.5e9, eta: 0.022,  hf: 1.2, coat: 0.06,  thick: 0.254, color: '#e9d9b8', alpha: 1 , ys: 1e+08 },
    kevlar:       { name: 'Aramid / Kevlar weave',    rho: 1440, E: 2.0e10,eta: 0.012, hf: 0.6, coat: 0.02,  thick: 0.40,  color: '#d8c56a', alpha: 1 , ys: 4e+08 },
    calfskin:     { name: 'Calfskin',                 rho: 1100, E: 0.9e9, eta: 0.015, hf: 1.3, coat: 0,     thick: 0.30,  color: '#e6cf9e', alpha: 1 , ys: 6e+07 },
    goatskin:     { name: 'Goatskin',                 rho: 1080, E: 1.2e9, eta: 0.012, hf: 1.1, coat: 0,     thick: 0.35,  color: '#dcc08a', alpha: 1 , ys: 6e+07 },
    cowhide:      { name: 'Cowhide (thick rawhide)',  rho: 1150, E: 0.9e9, eta: 0.008, hf: 1.0, coat: 0,     thick: 1.5,   color: '#c9a46a', alpha: 1 , ys: 6e+07 },
    deerskin:     { name: 'Deerskin / elk',           rho: 1000, E: 0.5e9, eta: 0.025, hf: 1.7, coat: 0,     thick: 0.6,   color: '#cfa978', alpha: 1 , ys: 5e+07 },
    steel_sheet:  { name: 'Steel sheet (pan / keg)',  rho: 7850, E: 200e9, eta: 0.0006,hf: 0.05,coat: 0,     thick: 0.9,   color: '#b8bec6', alpha: 1, metal: true },
    brass_sheet:  { name: 'Brass sheet',              rho: 8500, E: 100e9, eta: 0.0009,hf: 0.06,coat: 0,     thick: 0.8,   color: '#d6b45a', alpha: 1, metal: true },
    alu_sheet:    { name: 'Aluminum sheet',           rho: 2700, E: 69e9,  eta: 0.0012,hf: 0.08,coat: 0,     thick: 1.0,   color: '#cfd4d9', alpha: 1, metal: true },
    fishskin:     { name: 'Fish skin',                rho: 1050, E: 0.6e9, eta: 0.015,  hf: 1.2, coat: 0,     thick: 0.15,  color: '#d9d2b4', alpha: 0.9, ys: 5e+07 }
  };
  // Shell: E, rho, Q (structural), absorb (cavity wall absorption 0..1)
  var SHELL_MATS = {
    maple:     { name: 'Maple',              rho: 705,  E: 12.6e9, Q: 40,  absorb: 0.35, color: '#d9a96a' },
    birch:     { name: 'Birch',              rho: 670,  E: 13.9e9, Q: 45,  absorb: 0.30, color: '#e3c08a' },
    mahogany:  { name: 'Mahogany',           rho: 590,  E: 10.1e9, Q: 32,  absorb: 0.45, color: '#8a4a2b' },
    oak:       { name: 'Oak',                rho: 760,  E: 12.5e9, Q: 38,  absorb: 0.35, color: '#b98d55' },
    walnut:    { name: 'Walnut',             rho: 640,  E: 11.6e9, Q: 36,  absorb: 0.40, color: '#5e3d26' },
    bubinga:   { name: 'Bubinga',            rho: 890,  E: 18e9,   Q: 48,  absorb: 0.28, color: '#9c4a33' },
    keyaki:    { name: 'Keyaki (zelkova)',   rho: 690,  E: 11e9,   Q: 40,  absorb: 0.35, color: '#b07a45' },
    log:       { name: 'Carved hardwood log',rho: 800,  E: 12e9,   Q: 35,  absorb: 0.40, color: '#7a4b2a' },
    mango:     { name: 'Mango / sheesham',   rho: 650,  E: 10e9,   Q: 32,  absorb: 0.42, color: '#a87444' },
    glass:     { name: 'Glass',              rho: 2500, E: 70e9,   Q: 900, absorb: 0.04, color: '#bfe3e0' },
    slate:     { name: 'Slate / stone',      rho: 2750, E: 45e9,   Q: 220, absorb: 0.08, color: '#6f7780' },
    rosewood:  { name: 'Honduras rosewood',  rho: 1030, E: 21e9,   Q: 170, absorb: 0.20, color: '#7b3a22' },
    padauk:    { name: 'Padauk',             rho: 760,  E: 13e9,   Q: 85,  absorb: 0.28, color: '#a8452c' },
    bamboo:    { name: 'Bamboo',             rho: 700,  E: 17e9,   Q: 50,  absorb: 0.25, color: '#cbbf72' },
    gourd:     { name: 'Gourd / calabash',   rho: 450,  E: 4e9,    Q: 18,  absorb: 0.50, color: '#c9933f' },
    clay:      { name: 'Clay (terracotta)',  rho: 1900, E: 18e9,   Q: 70,  absorb: 0.15, color: '#b5613b' },
    acrylic:   { name: 'Acrylic',            rho: 1190, E: 3.2e9,  Q: 22,  absorb: 0.10, color: '#9fd3e6' },
    fiberglass:{ name: 'Fiberglass',         rho: 1850, E: 20e9,   Q: 60,  absorb: 0.12, color: '#dcdccb' },
    aluminum:  { name: 'Aluminum',           rho: 2700, E: 69e9,   Q: 450, absorb: 0.05, color: '#c4c9cf' },
    steel:     { name: 'Steel',              rho: 7850, E: 200e9,  Q: 600, absorb: 0.05, color: '#a9afb6' },
    brass:     { name: 'Brass',              rho: 8500, E: 100e9,  Q: 500, absorb: 0.05, color: '#d4b04c' },
    bronze:    { name: 'Bronze',             rho: 8800, E: 110e9,  Q: 700, absorb: 0.05, color: '#b8863b' },
    copper:    { name: 'Copper',             rho: 8960, E: 117e9,  Q: 400, absorb: 0.05, color: '#c27a4a' }
  };
  var HOOPS = {
    triple:  { name: 'Steel triple-flange', E: 200e9, rho: 7850, heff: 0.006, area: 6e-5,   Q: 250, color: '#b9bec4' },
    diecast: { name: 'Die-cast zinc',       E: 96e9,  rho: 6600, heff: 0.010, area: 1.6e-4, Q: 90,  color: '#8e9399' },
    wood:    { name: 'Wood hoop',           E: 12e9,  rho: 700,  heff: 0.015, area: 4.5e-4, Q: 25,  color: '#9b6a3c' },
    none:    { name: 'None (rope / tacked)', E: 0 }
  };
  // mass kg (effective), tau = contact time (s) at 3 m/s on rigid surface, alpha = Hertz exponent,
  // rc = contact radius (m), lam = Hunt-Crossley loss (s/m), vmax = full-velocity speed (m/s)
  var MALLETS = {
    stick:     { name: 'Stick (wood tip)',      mass: 0.030, tau: 0.00030, alpha: 1.5, rc: 0.004, lam: 0.2, vmax: 7, ring: [[1250, 9, 1], [3300, 10, 0.5], [6400, 12, 0.25]], click: 0.17 },
    stick_nyl: { name: 'Stick (nylon tip)',     mass: 0.030, tau: 0.00024, alpha: 1.5, rc: 0.003, lam: 0.15,vmax: 7, ring: [[1300, 9, 0.8], [3500, 10, 0.6], [7200, 12, 0.35]], click: 0.18 },
    rods:      { name: 'Rods (dowel bundle)',   mass: 0.020, tau: 0.00060, alpha: 1.7, rc: 0.009, lam: 0.25, vmax: 6, ring: [[900, 5, 0.6], [2400, 6, 0.4], [5200, 7, 0.3]], click: 0.14 },
    felt_beat: { name: 'Kick beater (felt)',    mass: 0.080, tau: 0.0020,  alpha: 2.5, rc: 0.025, lam: 0.4, vmax: 5, ring: [[1700, 2.2, 1.6], [3400, 2.5, 0.7]], click: 0.45 },
    plas_beat: { name: 'Kick beater (plastic)', mass: 0.080, tau: 0.0007,  alpha: 1.8, rc: 0.022, lam: 0.25,vmax: 5, ring: [[2700, 3, 0.55], [4600, 3.5, 0.35]], click: 0.22 },
    soft_mal:  { name: 'Soft felt mallet',      mass: 0.040, tau: 0.0030,  alpha: 2.6, rc: 0.016, lam: 0.3, vmax: 4, ring: [], click: 0.05 },
    hard_mal:  { name: 'Hard felt mallet',      mass: 0.040, tau: 0.0011,  alpha: 2.2, rc: 0.012, lam: 0.25,vmax: 4.5, ring: [[1800, 3, 0.2]], click: 0.06 },
    bachi:     { name: 'Bachi (heavy wood)',    mass: 0.150, tau: 0.0008,  alpha: 1.5, rc: 0.012, lam: 0.3, vmax: 9, ring: [[650, 8, 1], [1800, 9, 0.5], [3500, 10, 0.25]], click: 0.1 },
    tipper:    { name: 'Tipper / beater stick', mass: 0.020, tau: 0.0005,  alpha: 1.6, rc: 0.006, lam: 0.25,vmax: 6, ring: [[1500, 8, 0.7], [4100, 9, 0.4]], click: 0.2 },
    pan_stick: { name: 'Pan stick (rubber tip)',mass: 0.035, tau: 0.0010,  alpha: 2.0, rc: 0.008, lam: 0.15,vmax: 5, ring: [[2600, 3, 0.15]], click: 0.009 },
    yarn:      { name: 'Yarn mallet (marimba)', mass: 0.035, tau: 0.0018, alpha: 1.4, rc: 0.013, lam: 0.25, vmax: 4.5, ring: [], click: 0.01 },
    xylo:      { name: 'Hard mallet (xylophone)', mass: 0.028, tau: 0.0008, alpha: 1.8, rc: 0.006, lam: 0.15, vmax: 5, ring: [[3200, 4, 0.08]], click: 0.03 },
    palm:      { name: 'Hand — palm (bass)',    mass: 0.400, tau: 0.0040,  alpha: 2.0, rc: 0.045, lam: 0.4, vmax: 5, ring: [], click: 0.03 },
    fingers:   { name: 'Hand — fingers (tone)', mass: 0.080, tau: 0.0015,  alpha: 2.0, rc: 0.015, lam: 0.3, vmax: 5, ring: [[2200, 1.2, 0.3]], click: 0.024 },
    slap:      { name: 'Hand — slap',           mass: 0.050, tau: 0.0006,  alpha: 1.8, rc: 0.010, lam: 0.2, vmax: 6, ring: [[2600, 1.2, 0.5], [5200, 1.5, 0.3]], click: 0.02 }
  };

  // ---------- Head modal analysis ----------
  function headModes(head, a, full, pillow, sign) {
    var hm = head.mat || HEAD_MATS[head.material] || HEAD_MATS.mylar_clear;
    var h = Math.max(0.03, head.thickness) * 1e-3;
    var sigma = hm.rho * h + hm.coat;
    var D = hm.E * h * h * h / (12 * (1 - NU * NU));
    var T = Math.max(20, head.tension);
    if (hm.ys) { var Tcap = hm.ys * h; T = Tcap * Math.tanh(T / Tcap); }   // a film or skin can't be cranked past its strength: tension saturates instead of shrieking
    var even = head.evenness == null ? 0.9 : head.evenness;
    var muff = head.muffle || 0;
    var AIRK = [2.0, 1.6, 1.3, 1.15, 1.05, 1, 1, 1, 1, 1, 1];
    var OUTK = [1, 0.92, 0.84, 0.76, 0.7, 0.65, 0.6, 0.6, 0.6, 0.6, 0.6];
    var modes = [];
    var lite = !!head.lite, mTop = full ? (lite ? 5 : MMAX) : 0, nTop = lite ? 5 : NMAX, NPX = lite ? 18 : NPROXY;   // lite: kit CPU saver
    for (var m = 0; m <= mTop; m++) for (var n = 0; n < nTop; n++) {
      var j = ZEROS[m][n], k = j / a;
      var sigE = sigma + AIRK[m] * RHO * a / j;          // air mass loading (both sides)
      var kb = (j + 0.78) / a;                            // clamped-plate eigenvalue ~ j + 0.78
      var memb = T * k * k, bend = D * kb * kb * kb * kb;  // membrane + bending stiffness
      var w = Math.sqrt((memb + bend) / sigE), f = w / TAU;
      if (f > 12000) continue;
      var Jn = JNEXT[m][n];
      var Nn = (m === 0 ? 1 : 0.5) * Math.PI * a * a * Jn * Jn;  // ∫ψ² dA
      var M = sigE * Nn;
      var ka = w / C * a, x2 = Math.pow(ka, 2 * (m + 1));
      var g = Math.pow(0.45, m) * x2 / (1 + x2);
      var alpha = 0.6
        + 0.4 * hm.eta * w * (1 + 0.6 * hm.hf * f / 2000)  // internal loss
        + 0.025 * RHO * C / sigE * g                        // radiation
        + muff * (14 + 9 * m + 0.0015 * w)                 // muffling
        + (m === 0 ? pillow * 35 : pillow * 8);            // internal pillow
      var S = m === 0 ? TAU * a * a * Jn / j : 0;           // volume displacement per unit q
      var rimF = m === 0 ? sign * T * TAU * j * Jn : 0;     // net axial force on rim per unit q
      var base = { m: m, n: n + 1, j: j, k: k, w: w, f: f, M: M, alpha: alpha, S: S, rimF: rimF,
        outW: Math.sqrt(Nn) / a * OUTK[m], tmw: k * k * Nn / (Math.PI * a * a), frac: memb / (memb + bend), orient: 0 };
      if (m === 0) modes.push(base);
      else for (var o = 0; o < 2; o++) {
        var det = 1 + (o ? 1 : -1) * (1 - even) * 0.015 * (0.3 + 0.7 * hash(m, n));
        var md = Object.assign({}, base); md.w = w * det; md.f = f * det; md.orient = o;
        modes.push(md);
      }
    }
    harmonize(modes, head.harmonic || 0);
    // Dense high-frequency bed: above the highest simulated mode a real head has thousands of modes.
    // Each proxy stands in for a group of them (amplitude ~ sqrt(group size)); they take part in the
    // mallet contact like any other mode, so the stick "feels" them and they ring with material damping.
    if (full && !head.noProxy) {
      var fTop = 0; modes.forEach(function (md) { if (md.f > fTop) fTop = md.f; });
      var fHi = 11500, cw = Math.sqrt(T / sigma);
      if (fTop < fHi * 0.9) {
        var Nf = function (f) { return Math.PI * a * a * Math.PI * f * f / (cw * cw); };   // membrane mode count below f
        var lo = fTop * 1.04, r = Math.pow(fHi / lo, 1 / NPX), prevN = Nf(lo);
        var sigA = sigma + RHO * a / 30;
        for (var pi = 0; pi < NPX; pi++) {
          var fc = lo * Math.pow(r, pi + 0.5 + 0.35 * (hash(pi, 7) - 0.5));
          var fEdge = lo * Math.pow(r, pi + 1), Nnow = Nf(fEdge), grp = Math.max(1, Nnow - prevN); prevN = Nnow;
          var wp = TAU * fc, kp = wp / cw, Np = 0.25 * Math.PI * a * a / Math.max(4, kp * a) * 2;
          var alp = 0.6 + 0.4 * hm.eta * wp * (1 + 0.6 * hm.hf * fc / 2000) + muff * (40 + 0.0015 * wp);
          modes.push({ m: 99, n: pi, j: kp * a, k: kp, w: wp, f: fc, M: sigA * Np, alpha: alp, S: 0, rimF: 0,
            outW: 0.55 * Math.sqrt(Np) / a, tmw: 0, frac: 0, orient: 0, proxy: true, a0: a,
            amp: Math.sqrt(grp) * 0.5 * (hash(pi, 11) < 0.5 ? -1 : 1), ph: hash(pi, 13) * TAU });
        }
      }
    }
    return { modes: modes, sigma: sigma, T: T, tmCoef: hm.E * h / (2 * (1 - NU) * T), a: a, metal: !!hm.metal };
  }
  // Pull the lowest distinct modes toward a harmonic series (1:2:3:4:5:6) the way a pan tuner
  // hammers note areas, or a tabla's loaded centre patch does. amount 0..1.
  function harmonize(modes, amt) {
    if (!(amt > 0)) return;
    var base = modes.filter(function (md) { return md.orient === 0; }).sort(function (x, y) { return x.f - y.f; }).slice(0, 6);
    if (!base.length) return;
    var f0 = base[0].f;
    base.forEach(function (b, k) {
      var r = Math.pow((k + 1) * f0 / b.f, amt);
      modes.forEach(function (md) { if (md.m === b.m && md.n === b.n) { md.w *= r; md.f *= r; } });
    });
    modes.sort(function (x, y) { return (x.m === 0 ? 0 : 1) - (y.m === 0 ? 0 : 1) || x.f - y.f; });
  }

  // Donnell thin-cylinder modes (axial half-wave), n = circumferential order
  function shellModes(SM, R, L, h, Ms) {
    var out = [], lam = Math.PI * R / L, l2 = lam * lam, cp = Math.sqrt(SM.E / (SM.rho * (1 - NU * NU)));
    for (var n = 2; n <= 14; n++) {
      var s = n * n + l2;
      var Om2 = l2 * l2 * (1 - NU * NU) / (s * s) + h * h / (12 * R * R) * s * s;
      var w = Math.sqrt(Om2) * cp / R;
      if (w / TAU < 11000) out.push({ w: w, M: Ms / 2, alpha: w / (2 * SM.Q) + 6, rad: Math.min(1, Math.pow(w / (TAU * 1500), 2)) });
    }
    out.sort(function (x, y) { return x.w - y.w; });
    return out.slice(0, 8);
  }
  function ringModes(HP, R) {
    var out = []; if (!HP || !HP.E) return out;
    var cst = Math.sqrt(HP.E / HP.rho) * HP.heff / Math.sqrt(12) / (R * R);
    var M = HP.rho * TAU * R * HP.area;
    for (var n = 2; n <= 11; n++) {
      var w = cst * n * (n * n - 1) / Math.sqrt(n * n + 1);
      if (w / TAU < 11000) out.push({ w: w, M: M / 2, alpha: w / (2 * HP.Q) + 4 + 600 / (1 + w / (TAU * 150)), rad: Math.min(1, Math.pow(w / (TAU * 1500), 2)) });
    }
    return out;
  }

  // ---------- Special build: tuned tongue drum ----------
  var SCALES = {
    major: { name: 'Major', iv: [0, 2, 4, 5, 7, 9, 11] },
    minor: { name: 'Natural minor', iv: [0, 2, 3, 5, 7, 8, 10] },
    pent_major: { name: 'Pentatonic major', iv: [0, 2, 4, 7, 9] },
    pent_minor: { name: 'Pentatonic minor', iv: [0, 3, 5, 7, 10] },
    akebono: { name: 'Akebono', iv: [0, 2, 3, 7, 8] },
    hijaz: { name: 'Hijaz', iv: [0, 1, 4, 5, 7, 8, 10] },
    dorian: { name: 'Dorian', iv: [0, 2, 3, 5, 7, 9, 10] },
    celtic: { name: 'Celtic minor', iv: [0, 2, 3, 5, 7, 10] },
    blues: { name: 'Blues', iv: [0, 3, 5, 6, 7, 10] },
    whole: { name: 'Whole tone', iv: [0, 2, 4, 6, 8, 10] },
    chromatic: { name: 'Chromatic', iv: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] }
  };
  function scaleNotes(root, scale, count) {
    var iv = (SCALES[scale] || SCALES.major).iv, out = [];
    for (var i = 0; out.length < count; i++) out.push(root + 12 * Math.floor(i / iv.length) + iv[i % iv.length]);
    return out;
  }
  function midiHz(n) { return 440 * Math.pow(2, (n - 69) / 12); }
  // Tuned bars (marimba / xylophone / vibes): free-free beams over tube resonators. Raw partials 1 : 2.76 : 5.40 : 8.93;
  // undercutting the bar's arch tunes them to 1 : 4 : 10 (marimba) or 1 : 3 : 6 (xylophone).
  var BAR_BETA = [4.730, 7.853, 10.996, 14.137], BAR_SIG = [0.9825, 1.0008, 0.99997, 1];
  // how a material behaves as a bar. gE: shear / Young's modulus (wood is very anisotropic, so its twisting modes sit low);
  // hx: how much faster the highs die than a constant-Q material (porous clay +, metals and glass -);
  // grain: how far a cut-and-fired / grown material strays from clean tuning; clk: how hard and clacky the surface is.
  function barProps(M) {
    var n = M.name || '', metal = M.E > 50e9 && M.rho > 4000;
    if (/Glass/.test(n)) return { gE: 0.40, hx: -0.35, grain: 0.05, clk: 0.035 };
    if (/Slate|stone/.test(n)) return { gE: 0.40, hx: 0.05, grain: 0.35, clk: 0.035 };
    if (/Clay|terracotta/i.test(n)) return { gE: 0.40, hx: 0.25, grain: 0.7, clk: 0.035, qK: 1.7 };   // fired clay rings like a flower pot, but its highs fade fast
    if (/Acrylic/.test(n)) return { gE: 0.36, hx: 0.25, grain: 0.05, clk: 0.06 };
    if (/Fiberglass/.test(n)) return { gE: 0.15, hx: 0.0, grain: 0.05, clk: 0.05 };
    if (metal || /Aluminum/.test(n)) return { gE: 0.38, hx: -0.6, grain: 0.0, clk: 0.06 };
    if (/Bamboo/.test(n)) return { gE: 0.05, hx: -0.2, grain: 0.25, clk: 0.03 };
    if (/Gourd/.test(n)) return { gE: 0.08, hx: 0.3, grain: 0.4, clk: 0.03 };
    return { gE: 0.07, hx: -0.3, grain: 0.15, clk: 0.02, sus: 0.55 };   // woods (tone-wood bars: the fundamental rings well past the knock)
  }
  function barModel(cfg, SM, a) {
    var sp = cfg.special, TM = sp.material === '__shell' || !SHELL_MATS[sp.material] ? SM : SHELL_MATS[sp.material];
    var h = Math.max(1, sp.thickness || 20) * 1e-3, notes = scaleNotes(sp.root == null ? 45 : sp.root, sp.scale || 'chromatic', Math.max(1, Math.min(64, sp.count | 0 || 52)));
    var N = notes.length, amt = sp.overtone == null ? 0.9 : sp.overtone, xylo = sp.tuning === 'xylo', res = sp.resonators == null ? 0.8 : sp.resonators;
    var even = sp.evenness == null ? 0.98 : sp.evenness, muff = sp.muffle || 0, cE = Math.sqrt(TM.E / TM.rho);
    var raw = [1, 2.756, 5.404, 8.933], tgt = xylo ? [1, 3, 6, 10] : [1, 4, 9.8, 16], oK = xylo ? [1, 0.42, 0.2, 0.1] : [1, 0.3, 0.14, 0.07];   // overtones well under the fundamental, like a real bar over its resonator (no honk)
    var tongues = [], modes = [], metal = TM.E > 50e9, BP = barProps(TM), G = TM.E * BP.gE;
    for (var p = 0; p < N; p++) {
      var note = notes[p], f1 = midiHz(note) * (1 + (1 - even) * 0.03 * (hash(p, 5) - 0.5));
      var under = 1 - 0.55 * amt;                                   // the arch lowers the fundamental a lot
      var L = Math.sqrt(1.028 * h * cE * under / f1);                // free-free rectangular bar length
      var w = Math.max(0.025, Math.min(0.075, (sp.width || 5.5) * 0.01 * (1.15 - 0.3 * p / Math.max(1, N - 1))));
      var th = -Math.PI / 2 + TAU * p / N, hw = 0.4 * TAU / N;
      var t = { idx: p, note: note, f: f1, L: L, w: w, th: th, hw: hw, rb: 0.94, ln: 0.8, bar: true, tooLong: L > 1.3 };
      tongues.push(t);
      var mass = TM.rho * w * h * L * (0.7 + 0.3 * (1 - amt));
      var loss = function (f) { return Math.pow(Math.max(1, f / 500), BP.hx); };
      for (var k = 0; k < 4; k++) {
        var f = f1 * Math.pow(raw[k], 1 - amt) * Math.pow(tgt[k], amt) * (k ? 1 + BP.grain * 0.06 * (hash(p, 60 + k) - 0.5) : 1); if (f > 11000) continue;
        var wv = TAU * f, x = wv / C * Math.sqrt(w * L), eff = x * x / (1 + x * x);
        var tube = k === 0 ? res : (xylo && k === 1 ? 0.6 * res : 0);   // a closed tube reinforces f and 3f
        var alpha = Math.min(wv / (2 * TM.Q * (BP.qK || 1)) * loss(f) * (k === 0 ? BP.sus || 1 : 1), k === 0 ? (BP.sus ? 12 : 22) : 1e9) + 0.35 + tube * 0.7 + muff * (10 + 0.002 * wv);   // even the tiniest top bar rings ~0.3 s
        modes.push({ m: p, n: k + 1, bar: t, tg: t, j: 0, k: BAR_BETA[k] / L, w: wv, f: f, M: mass / 4, S: 0, rimF: 0, alpha: alpha,
          outW: Math.sqrt(eff + 0.03) * oK[k] * (1 + 1.8 * tube) * (metal ? 0.8 : 1) * Math.pow(Math.max(1, f1 / 440), 0.3), tmw: 0, frac: 0, orient: 0, partial: k });
      }
      // twisting (torsional) modes: excited by strokes off the bar's centre line; low in wood, high in isotropic materials
      var hb = h * (1 - 0.45 * amt), J = w * hb * hb * hb * (1 / 3 - 0.21 * Math.min(1, hb / w)), Ip = w * hb * (w * w + hb * hb) / 12, cT = Math.sqrt(G * J / (TM.rho * Ip));
      for (var nt = 1; nt <= 2; nt++) {
        var ft = nt * cT / (2 * L) * (1 + BP.grain * 0.05 * (hash(p, 70 + nt) - 0.5)); if (ft > 11000 || ft < f1 * 1.2) continue;
        var wt = TAU * ft, xt = wt / C * Math.sqrt(w * L), et = xt * xt / (1 + xt * xt);
        modes.push({ m: p, n: 10 + nt, bar: t, tg: t, j: 0, k: nt * Math.PI / L, w: wt, f: ft, M: mass / 4, S: 0, rimF: 0,
          alpha: Math.min(wt / (2 * TM.Q * (BP.qK || 1)) * loss(ft), 1e9) * 1.3 + 0.5 + muff * (10 + 0.002 * wt), outW: Math.sqrt(et + 0.03) * (BP.gE < 0.2 ? 0.15 : 0.3) * Math.pow(Math.max(1, f1 / 440), 0.3), tmw: 0, frac: 0, orient: 0, partial: 10 + nt });
      }
      t.clk = BP.clk;
    }
    return { modes: modes, tongues: tongues, sigma: TM.rho * h, T: 0, tmCoef: 0, a: a, TM: TM };
  }
  function barShape(md, r, th) {
    var t = md.tg, d = th - t.th; d = Math.atan2(Math.sin(d), Math.cos(d));
    if (d > t.hw || d < -t.hw) return 0;
    var x = (t.rb - r) / t.ln; if (x < 0 || x > 1) return 0;
    if (md.partial >= 10) return (d / t.hw) * Math.cos((md.partial - 10) * Math.PI * x);   // twisting: opposite sides move in opposite directions
    var k = md.partial, b = BAR_BETA[k] * x, sg = BAR_SIG[k];
    return 0.5 * (Math.cosh(b) + Math.cos(b) - sg * (Math.sinh(b) + Math.sin(b)));
  }
  // Cantilever tongue (clamped at the plate, free at the tip). Bending partials (beta*L)^2 = 3.516, 22.03, 61.70
  // -> ratios 1 : 6.27 : 17.55; torsion ~ 0.96 L/w. "Overtone tuning" pulls them to 1 : 2 (torsion) : 3 : 6.
  function tongueModel(cfg, SM, a) {
    var sp = cfg.special, TM = sp.material === '__shell' || !SHELL_MATS[sp.material] ? SM : SHELL_MATS[sp.material];
    var h = Math.max(0.3, sp.thickness || 2) * 1e-3, notes = scaleNotes(sp.root == null ? 50 : sp.root, sp.scale || 'minor', Math.max(1, Math.min(36, sp.count | 0 || 9)));
    var N = notes.length, cbar = Math.sqrt(TM.E * h * h / (12 * TM.rho)), amt = sp.overtone == null ? 0.7 : sp.overtone;
    var even = sp.evenness == null ? 0.97 : sp.evenness, muff = sp.muffle || 0, rb = 0.94;
    var order = []; for (var i = 0; i < N; i += 2) order.push(i); for (var j = (N - 1) - ((N - 1) % 2 === 0 ? 1 : 0); j > 0; j -= 2) order.push(j);
    var tongues = [], modes = [];
    for (var p = 0; p < N; p++) {
      var ni = order[p], note = notes[ni];
      var f1 = midiHz(note) * (1 + (1 - even) * 0.03 * (hash(ni, 5) - 0.5));
      var L = Math.sqrt(3.516 * cbar / (TAU * f1));
      var th = -Math.PI / 2 + TAU * p / N;
      var hw = Math.min(0.40 * TAU / N, ((sp.width || 3.5) * 0.01 / 2) / (rb * a));
      var w = 2 * hw * rb * a, ln = Math.min(L / a, 0.9);
      var t = { idx: ni, note: note, f: f1, L: L, w: w, th: th, hw: hw, rb: rb, ln: ln, tooLong: L / a > 0.9 };
      tongues.push(t);
      var rawT = Math.max(1.3, 0.96 * L / w);
      var raw = [1, rawT, 6.267, 17.55], tgt = [1, 2, 3, 6], psiK = [1, 0.5, -0.6, 0.45], sK = [0.39, 0, 0.11, 0.06], oK = [1, 0.55, 0.9, 0.8];
      var mass = TM.rho * w * h * L;
      for (var k = 0; k < 4; k++) {
        var r = Math.pow(raw[k], 1 - amt) * Math.pow(tgt[k], amt), f = f1 * r;
        if (f > 11000) continue;
        var wv = TAU * f, x = wv / C * Math.sqrt(w * L), eff = x * x / (1 + x * x);
        modes.push({ m: ni, n: k + 1, tg: t, j: 0, k: 1.875 * (k + 1) / L, w: wv, f: f, M: mass / 4, S: sK[k] * w * L, rimF: 0,
          alpha: Math.min(wv / (2 * TM.Q) + 0.3 * f / 1000, k === 0 ? 16 : k === 1 ? 30 : 1e9) + 0.5 + muff * (12 + 0.002 * wv),   // tiny high tongues still ring (>~0.4 s)
          outW: Math.sqrt(eff + 0.02) * oK[k], tmw: 0, frac: 0, orient: 0, partial: k });
      }
    }
    return { modes: modes, tongues: tongues, sigma: TM.rho * h, T: 0, tmCoef: 0, a: a, TM: TM };
  }
  function tongueShape(md, r, th) {
    var t = md.tg, d = th - t.th; d = Math.atan2(Math.sin(d), Math.cos(d));
    if (d > t.hw || d < -t.hw) return 0;
    var x = (t.rb - r) / t.ln; if (x < 0 || x > 1) return 0;
    var lat = d / t.hw;
    switch (md.partial) {
      case 0: return Math.pow(x, 1.9);
      case 1: return x * lat;
      case 2: return x * x * (1 - 1.75 * x) * 1.3;
      default: return x * x * (1 - 3.2 * x + 2.5 * x * x) * 2;
    }
  }

  // A head cut from the shell material: plate stiffness/damping come from the shell's E, rho, Q.
  function shellHeadMat(SM) {
    var metal = SM.E > 50e9, wood = SM.rho < 1000 && SM.E < 20e9;
    return { name: SM.name + ' plate', rho: SM.rho, E: SM.E, eta: 1 / SM.Q, hf: metal ? 0.05 : wood ? 0.6 : 0.35, coat: 0,
      thick: metal ? 1.0 : wood ? 4 : SM.rho > 1500 ? 6 : 3, color: SM.color, alpha: 1, metal: metal };
  }
  // ---------- Headless bodies: the shell itself is the vibrating object ----------
  // Inextensional ring/bowl bending modes (n = circumferential order). r (0..1) = strike height, bottom -> rim.
  function bodyAmp(md, u) {
    var b = md.body;
    if (b === 'bowl') return Math.pow(Math.max(0, u), 0.8 * md.m);
    if (b === 'gbowl') { var v = (u - 0.3) / 0.7; return v <= 0 ? 0 : Math.pow(v, 0.8 * md.m); }
    if (b === 'stem') return u < 0.4 ? 1 - u / 0.4 : 0;
    return md.n === 1 ? 0.65 + 0.35 * u : (2 * u - 1);   // tube / ring families
  }
  function bodyModes(cfg, SM) {
    var sh = cfg.shell, a = sh.diameter * 0.0127, H = Math.max(0.005, sh.depth * 0.0254);
    var h = Math.max(0.4, sh.thickness || 3) * 1e-3, even = sh.evenness == null ? 0.9 : sh.evenness, muff = sh.muffle || 0;
    var cbar = Math.sqrt(SM.E / SM.rho), out = [];
    function ring(R, factor, mass, kind, fam, nmax) {
      for (var n = 2; n <= (nmax || 12); n++) {
        var w = factor * cbar * h / Math.sqrt(12) / (R * R) * n * (n * n - 1) / Math.sqrt(n * n + 1);
        if (w / TAU > 11000) break;
        var x = w / C * R, eff = x * x / (1 + x * x);
        var alpha = w / (2 * SM.Q) + 1.2 + 0.01 * RHO * C / (SM.rho * h) * eff + muff * (25 + 0.004 * w);
        for (var o = 0; o < 2; o++) {
          var det = 1 + (o ? 1 : -1) * (1 - even) * 0.02 * (0.3 + 0.7 * hash(n, fam + 3));
          out.push({ m: n, n: fam, j: n, k: n / R, w: w * det, f: w * det / TAU, M: mass / 2, alpha: alpha, S: 0, rimF: 0,
            outW: Math.sqrt(eff) * (kind === 'stem' ? 0.7 : 1), tmw: 0, frac: 0, orient: o, body: kind });
        }
      }
    }
    var shape = sh.shape;
    if (shape === 'kettle') {
      var D = Math.max(0.02, (sh.bowlDepth || sh.depth) * 0.0254);
      ring(a, 1.3 * Math.sqrt(1 + 0.5 * a / D), SM.rho * h * (Math.PI * a * a + TAU * a * D) * 0.5, 'bowl', 1);
    } else if (shape === 'goblet') {
      var D2 = Math.max(0.02, (sh.bowlDepth || 6) * 0.0254), rs = Math.max(0.005, (sh.portDiam || 2) * 0.0127), Ls = Math.max(0.01, (sh.portLen || 6) * 0.0254);
      ring(a, 1.3 * Math.sqrt(1 + 0.5 * a / D2), SM.rho * h * (Math.PI * a * a + TAU * a * D2) * 0.5, 'gbowl', 1);
      ring(rs, 1, SM.rho * h * TAU * rs * Ls, 'stem', 2, 8);
    } else { // open tube, ring/frame (free ends): Rayleigh inextensional modes, plus the axial-twist family
      var Ms = SM.rho * h * TAU * a * H;
      ring(a, 1, Ms, 'tube', 1);
      if (H > 0.3 * a) ring(a, Math.sqrt(1 + 24 * (1 - NU) * Math.pow(a / H, 2) / 9), Ms, 'tube', 2, 8);
    }
    out.sort(function (x, y) { return x.f - y.f; });
    return out;
  }
  function modeShape(md, r, th) {
    if (md.ms) return metalShape(md, r, th);
    if (md.bar) return barShape(md, r, th);
    if (md.tg) return tongueShape(md, r, th);
    if (md.proxy) { var rr = Math.min(1, r); return md.amp * Math.sin(md.k * md.a0 * rr * 0.9 + md.ph + 3 * th) * Math.sqrt(Math.max(0, 1 - rr * rr * rr * rr)) ; }
    var ang = md.m === 0 ? 1 : (md.orient ? Math.sin(md.m * th) : Math.cos(md.m * th));
    return (md.body ? bodyAmp(md, r) : radial(md.m, md.n - 1, r)) * ang;
  }

  // ---------- Build the full model from a config ----------
  function buildModel(cfg, sr) {
    if (cfg.special && cfg.special.type === 'metal') return buildMetalModel(cfg, sr || 48000);
    var sh = cfg.shell, SM = SHELL_MATS[sh.material] || SHELL_MATS.maple;
    var two = cfg.kind === 'double';
    var a = sh.diameter * 0.0127, L = Math.max(0.005, sh.depth * 0.0254);
    if (cfg.kind === 'none') {
      var bm = bodyModes(cfg, SM);
      return { cfg: cfg, two: false, none: true, a: a, aR: a, V: 1, Kc: 0, port: null,
        B: { modes: bm, sigma: SM.rho * Math.max(0.4, sh.thickness || 3) * 1e-3, T: 0, tmCoef: 0, a: a }, R: null,
        airModes: [], shell: [], hoop: [], SM: SM, snare: { on: false, tension: 0.5, level: 0 },
        mallet: MALLETS[cfg.mallet] || MALLETS.stick, mix: cfg.mix || { batter: 1, reso: 0.6, shell: 0.5 }, gain: 1 };
    }
    var pillow = two ? (cfg.pillow || 0) : 0;
    var barsB = !!(cfg.special && cfg.special.type === 'bars'), tongueDrum = !!(cfg.special && (cfg.special.type === 'tongue' || barsB));
    if (tongueDrum) { cfg = Object.assign({}, cfg, { kind: 'single' }); two = false; }
    var bat = cfg.kind === 'shellhead' ? Object.assign({}, cfg.batter, { mat: shellHeadMat(SM) }) : cfg.batter;
    if (cfg.lite) bat = Object.assign({}, bat, { lite: true });
    var B = barsB ? barModel(cfg, SM, a) : tongueDrum ? tongueModel(cfg, SM, a) : headModes(bat, a, true, pillow, -1);
    var R = null, aR = a;
    // shell-dependent losses: cavity wall absorption + bearing-edge/rim compliance (low-Q shells soak up highs)
    var edgeLoss = function (hd) { hd.modes.forEach(function (md) { md.alpha += (md.m === 0 ? 4 : 1.5) * SM.absorb + (md.f / 1000) * 6 / Math.sqrt(SM.Q); }); };
    if (!tongueDrum) edgeLoss(B);
    if (two) { aR = (cfg.reso.diameter || sh.diameter) * 0.0127; R = headModes(cfg.reso, aR, false, pillow, 1); edgeLoss(R); }

    var V, port = null, air = [], rav = a, Lsh = L;
    if (two) {
      var bul = sh.shape === 'barrel' ? (sh.bulge || 0) : 0;
      rav = 0.5 * (a + aR) * (1 + 0.6 * bul);
      V = Math.PI * rav * rav * L;
      if (cfg.reso.hole > 0) { var rp = cfg.reso.hole * 0.0127; port = { A: Math.PI * rp * rp, L: 1.7 * rp + 0.002, Q: 6 }; }
      for (var n = 1; n <= 3; n++) air.push(n * C / (2 * L));
      air.push(1.841 * C / (TAU * rav));
    } else if (sh.shape === 'goblet' || sh.shape === 'kettle') {
      var bd = Math.max(0.03, (sh.bowlDepth || sh.depth) * 0.0254);
      V = Math.PI * a * a * bd * 0.62;
      var rp2 = Math.max(0.2, sh.portDiam || 4) * 0.0127;
      var pl = sh.shape === 'goblet' ? (sh.portLen || 8) * 0.0254 : Math.max(0.002, (sh.thickness || 2) * 1e-3);
      port = { A: Math.PI * rp2 * rp2, L: pl + 1.7 * rp2, Q: 8 };
      Lsh = bd + (sh.shape === 'goblet' ? pl : 0);
      if (sh.shape === 'goblet') { air.push(C / (2 * (pl + 1.2 * rp2))); air.push(C / (pl + 1.2 * rp2)); }
      air.push(1.841 * C / (TAU * a)); air.push(3.054 * C / (TAU * a));
    } else if (sh.shape === 'barrel') {   // one head on a bulging barrel: open at the bottom (conga, ashiko) or, as a shell drum, a closed keg with a vent
      var bulS = sh.bulge || 0, rB0 = (sh.bottomDia || (cfg.kind === 'single' ? (sh.portDiam || sh.diameter * 0.75) : sh.diameter)) * 0.0127;
      rav = 0.5 * (a + rB0) * (1 + 0.6 * bulS);
      if (cfg.kind === 'shellhead') {
        V = Math.PI * rav * rav * L * 0.95;
        var rv = Math.max(0.005, (sh.portDiam || 3) * 0.0127);
        port = { A: Math.PI * rv * rv, L: Math.max(0.002, (sh.thickness || 6) * 1e-3) + 1.7 * rv, Q: 6 };
        for (var n3 = 1; n3 <= 3; n3++) air.push(n3 * C / (2 * L));
        air.push(1.841 * C / (TAU * rav));
      } else {
        var rbot = Math.max(0.01, Math.min(rav * 1.2, rB0)), ellB = L + 0.6 * rbot;
        V = 0.81 * Math.PI * rav * rav * ellB;
        port = { A: Math.PI * rbot * rbot, L: ellB / 2, Q: 3 };
        if (L > 0.08) for (var n4 = 1; n4 <= 3; n4++) air.push((2 * n4 - 1) * C / (4 * ellB) * (1 - 0.12 * bulS));   // the belly lowers the pipe a little
      }
    } else { // open tube or frame
      var ell = L + 0.6 * a;
      V = 0.81 * Math.PI * a * a * ell;
      port = { A: Math.PI * a * a, L: ell / 2, Q: 3 };
      if (L > 0.08) for (var n2 = 1; n2 <= 3; n2++) air.push((2 * n2 - 1) * C / (4 * ell));
    }
    if (port) {
      port.mp = RHO * port.A * port.L;
      port.wH = Math.sqrt(RHO * C * C * port.A / (V * port.L));
      port.alpha = port.wH / (2 * port.Q) + 10 * SM.absorb + pillow * 120;
    }
    var airQ = 4 + 26 * (1 - SM.absorb) * (1 - 0.8 * pillow);
    var airModes = air.filter(function (f) { return f < 9000; }).map(function (f) { return { w: f * TAU, alpha: f * TAU / (2 * airQ) }; });

    var hs = Math.max(0.4, sh.thickness || 6) * 1e-3;
    var Ms = SM.rho * TAU * rav * hs * Math.max(0.02, Lsh);
    var shell = shellModes(SM, rav, Math.max(0.02, Lsh), hs, Ms);
    var hoop = tongueDrum ? [] : (two || sh.shape === 'cylinder' || sh.shape === 'open' || sh.shape === 'kettle' || sh.shape === 'barrel') ? ringModes(HOOPS[sh.hoop], a + 0.006) : [];
    if (!two && !tongueDrum && sh.hoop && sh.hoop !== 'none') hoop = ringModes(HOOPS[sh.hoop], a + 0.006);

    var sn = cfg.snare || { on: false };
    return {
      cfg: cfg, two: two, a: a, aR: aR, V: V, Kc: RHO * C * C / V, port: port, tongue: tongueDrum, bars: barsB, tongues: tongueDrum ? B.tongues : null,
      B: B, R: R, airModes: airModes, shell: shell, hoop: hoop, SM: SM,
      snare: { on: !!sn.on && !tongueDrum, tension: sn.tension == null ? 0.5 : sn.tension, level: sn.level == null ? 0.7 : sn.level },
      mallet: MALLETS[cfg.mallet] || MALLETS.stick, mics: cfg.mics,
      mix: cfg.mix || { batter: 1, reso: 0.6, shell: 0.5 },
      gain: 1
    };
  }

  // ---------- Real-time voice (one physical drum; new hits act on the vibrating state) ----------
  function Voice(sr) {
    this.sr = sr; this.model = null; this.mallets = []; this.pulses = [];
    this.noise = 22222; this.svf1 = 0; this.svf2 = 0; this.env = 0; this.dc1 = 0; this.dc2 = 0;
    this.gain = 1;
  }
  Voice.prototype.setModel = function (model) {
    var old = this; var prevQ = this.q, prevV = this.v, prevN = this.nModes;
    this.model = model; this.gain = model.gain || 1;
    var Bm = model.B.modes, Rm = model.R ? model.R.modes : [];
    var list = [];
    Bm.forEach(function (md) { list.push({ md: md, head: 0 }); });
    Rm.forEach(function (md) { list.push({ md: md, head: 1 }); });
    var N = list.length; this.nModes = N; this.nB = Bm.length;
    // substeps
    var Ycav = 0;
    list.forEach(function (it) { if (it.md.S) Ycav += it.md.S * it.md.S / it.md.M; });
    if (model.port) Ycav += model.port.A * model.port.A / model.port.mp;
    this.Ycav = Ycav;
    var wmax = 2 * Math.PI * 1500;
    var os = Math.min(6, Math.max(1, Math.ceil(wmax / this.sr / 0.45)));
    if (model.snare && model.snare.on && !model.tongue) {   // snare wires on a very light / small head need finer time steps to stay stable
      var snH = model.two ? 1 : 0, Yest = 0;
      list.forEach(function (it) { if (it.head === snH && it.md.m === 0) Yest += 1 / it.md.M; });
      var dt1 = 1 / this.sr, X1 = 0.004 * Math.pow(TAU * 2600, 2) * dt1 * dt1 * (Yest * 3 * Math.max(0.05, model.snare.level) + 1 / 0.0032);
      os = Math.min(6, Math.max(os, Math.ceil(Math.sqrt(X1 / 14))));
    }
    this.os = os; var dt = 1 / (this.sr * os); this.dt = dt;
    var A = function () { return new Float64Array(N); };
    this.w2 = A(); this.a2 = A(); this.invM = A(); this.S = A(); this.rimF = A(); this.tmw = A(); this.frac = A();
    this.oB = A(); this.oR = A(); this.cSn = A();
    var snHead = model.two ? 1 : 0;
    for (var i = 0; i < N; i++) {
      var md = list[i].md, hd = list[i].head;
      var wd = md.w * dt < 1.9 ? 2 / dt * Math.sin(md.w * dt / 2) : 0;  // prewarp for symplectic Euler
      this.w2[i] = wd * wd; this.a2[i] = wd ? 2 * md.alpha : 0;
      this.invM[i] = wd ? 1 / md.M : 0; this.S[i] = md.S; this.rimF[i] = md.rimF;
      this.tmw[i] = (hd === 0 && md.f < 2500) ? md.tmw : 0; this.frac[i] = md.w * dt < 1.4 ? md.frac : 0;
      this.oB[i] = hd === 0 ? md.outW : 0; this.oR[i] = hd === 1 ? md.outW : 0;
      this.cSn[i] = (model.snare.on && hd === snHead && md.m === 0) ? 1 : 0;
    }
    this.chW = A(); for (var ci = 0; ci < N; ci++) this.chW[ci] = 60 + 0.004 * list[ci].md.w;
    // sparse index lists: only (0,n)-type modes move air / the rim / the snare wires; only some modes feel tension modulation
    var zl = [], tl = []; for (var zi = 0; zi < N; zi++) { if (this.S[zi] || this.rimF[zi] || this.cSn[zi]) zl.push(zi); if (this.tmw[zi]) tl.push(zi); }
    this.zIdx = Int32Array.from(zl); this.tIdx = Int32Array.from(tl);
    this.chk = this.chk || 0; this.chkT = this.chkT || 0;
    var mw = micWeights(list.map(function (it) { return it.md; }), function (md, r, th) { return modeShape(md, r, th); }, model.mics, list.map(function (it) { return it.head === 0 ? it.md.outW : it.md.outW * 0.6; }));
    this.oHL = mw.L; this.oHR = mw.R; this.mics = mw.g;
    this.tmCoef = model.B.tmCoef * 0.08 * (model.cfg.bend == null ? 1 : model.cfg.bend);
    this.sgnSn = model.two ? -1 : 1;
    if (prevQ && prevN === N) { this.q = prevQ; this.v = prevV; } else { this.q = A(); this.v = A(); this.mallets = []; }
    // resonator banks: [w2, a2, invM]
    function bank(arr, d) {
      var n = arr.length, o = { n: n, rad: new Float64Array(n), w2: new Float64Array(n), a2: new Float64Array(n), invM: new Float64Array(n), y: new Float64Array(n), v: new Float64Array(n) };
      arr.forEach(function (r, i) { var wd = r.w * d < 1.9 ? 2 / d * Math.sin(r.w * d / 2) : 0; o.w2[i] = wd * wd; o.a2[i] = 2 * r.alpha; o.rad[i] = r.rad == null ? 1 : r.rad; o.invM[i] = r.M ? 1 / r.M : 1; });
      return o;
    }
    this.shellB = bank(model.shell, dt); this.hoopB = bank(model.hoop, dt); this.airB = bank(model.airModes, dt);
    if (!(prevQ && prevN === N)) { this.px = 0; this.pv = 0; this.pPrev = 0; this.wires = null; }
    this.px = this.px || 0; this.pv = this.pv || 0; this.pPrev = this.pPrev || 0;
    // snare wires
    var t = model.snare.tension, fw = 35 + 140 * t, mw = 0.004;
    var snT = model.cfg.kind === 'shellhead' ? 3000 : (model.two ? model.R.T : model.B.T) || 3000; this.envK = 0.02 * Math.min(6, Math.max(1, 3000 / snT));   // slack heads (frame drums) still drive an audible buzz
    this.wire = { m: mw, k: mw * Math.pow(TAU * fw, 2), gap: (0.04 + 0.22 * t) * 1e-3, kc: mw * Math.pow(TAU * 2600, 2), alpha: 25 + 20 * t };
    if (!this.wires) { this.wires = [{ y: 0, v: 0, Fp: 0, mf: 1 }, { y: 0, v: 0, Fp: 0, mf: 0.8 }, { y: 0, v: 0, Fp: 0, mf: 1.25 }]; this.needSettle = !!model.snare.on; }
    this.vol = 0; this.volv = 0; this.tm = 0; this.rim = 0; this.qc = 0; this.qcv = 0;
    var Ysn = 0; for (var yi = 0; yi < N; yi++) Ysn += this.cSn[yi] * this.invM[yi]; this.Ysn = Ysn;
    // wires against a very light head: keep the contact well inside the integrator's stable range
    var yW = Ysn * 3 * Math.max(0.05, model.snare.level) + 1 / (this.wire.m * 0.8);
    this.wire.kcE = Math.min(this.wire.kc, 14 / (dt * dt * yW));
    var mix = model.mix;
    this.mixB = mix.batter; this.mixR = mix.reso; this.mixS = mix.shell;
    var tone = mix.tone == null ? 0.35 : mix.tone;        // -1..+1  ->  -9..+9 dB shelf above ~1.2 kHz
    this.shelfG = Math.pow(10, tone * 9 / 20) - 1; this.lowG = Math.pow(10, Math.max(0, tone) * 2 / 20) - 1;
    this.yPrev = this.yPrev || 0; this.lpT = this.lpT || 0; this.lpL = this.lpL || 0;
    this.gT = 1 - Math.exp(-TAU * 1200 / this.sr); this.gClk = 1 - Math.exp(-TAU * 5500 / this.sr); this.gL = 1 - Math.exp(-TAU * 90 / this.sr);
  };
  // strike: r 0..1 (fraction of radius), theta rad, vel 0..1, mode 'head'|'rimshot'|'rimclick'
  Voice.prototype.strike = function (r, theta, vel, mode) {
    this.sinceHit = 0;
    var md = this.model; if (!md) return;
    var ml = md.mallet, v0 = ml.vmax * Math.pow(Math.max(0.01, Math.min(1, vel)), 1.3) * (this.vk || 1);
    mode = mode || 'head';
    var mk = this.makePsi(Math.min(0.98, r), theta, ml.rc);
    if (mode === 'rim') {   // stick on the hoop only: a bright wooden/metal tick, with a little of it leaking into the head through the bearing edge
      var pr = this.makePsi(0.97, theta, 0.01), dR = Math.max(0.0002, ml.tau * 0.5);
      this.pulses.push({ t: 0, dur: dR, amp: 0.52 * Math.min(ml.mass, 0.06) * v0 * 1.6 * Math.PI / (2 * dR), hoop: 1, psi: null, head: 0 });
      this.pulses.push({ t: 0, dur: 0.0006, amp: 0.3 * Math.min(ml.mass, 0.06) * v0 * 1.6 * Math.PI / (2 * 0.0006), hoop: 0, psi: pr, head: 0.006 });
      return;
    }
    if (mode === 'rimclick') {
      var ps = this.makePsi(0.9, theta, 0.01);
      this.pulses.push({ t: 0, dur: 0.00025, amp: 0.4 * Math.min(ml.mass, 0.06) * v0 * 1.6 * Math.PI / (2 * 0.00025), hoop: 1, psi: null, head: 0 });
      this.pulses.push({ t: 0, dur: 0.0008, amp: 0.4 * Math.min(ml.mass, 0.06) * v0 * 1.6 * Math.PI / (2 * 0.0008), hoop: 0, psi: ps, head: 0.012 });
      return;
    }
    var klin = ml.mass * Math.pow(Math.PI / ml.tau, 2), d0 = 3 * ml.tau / Math.PI;
    var kc = klin * Math.pow(d0, 1 - ml.alpha);
    var h = 0, hv = 0; for (var i = 0; i < this.nB; i++) { h += mk[i] * this.q[i]; hv += mk[i] * this.v[i]; }
    if (this.mallets.length > 1) this.mallets.shift();
    var Y = 0; for (var yi = 0; yi < this.nB; yi++) Y += mk[yi] * mk[yi] * this.invM[yi];
    this.ringSet(ml);
    this.mallets.push({ Y: Y, psi: mk, y: h, v: v0, v0: v0, m: ml.mass, kc: kc, al: ml.alpha, loss: Math.min(0.85, 2 * ml.lam), h: h, hv: hv, F: 0, life: 0 });
    if (mode === 'rimshot') {
      var dur = Math.max(0.00015, ml.tau * 0.5);
      this.pulses.push({ t: 0, dur: dur, amp: 0.6 * Math.min(ml.mass, 0.06) * v0 * 1.6 * Math.PI / (2 * dur), hoop: 1, psi: null, head: 0 });
    }
  };
  Voice.prototype.ringSet = function (ml) {
    var rg = ml.ring || [], n = rg.length, sr = this.sr;
    if (!this.rb || this.rbFor !== ml) {
      this.rbFor = ml; this.rb = { n: n, c1: [], c2: [], g: [], y1: new Float64Array(n), y2: new Float64Array(n) };
      for (var i = 0; i < n; i++) {
        var w = TAU * rg[i][0] / sr, rr = Math.exp(-w / (2 * rg[i][1]));
        this.rb.c1.push(2 * rr * Math.cos(w)); this.rb.c2.push(-rr * rr); this.rb.g.push(rg[i][2] * (1 - rr));
      }
    }
    this.resK = (ml.click == null ? 0.2 : ml.click) / (ml.mass * 2e4) * (this.model && this.model.bars ? (this.model.tongues[0] && this.model.tongues[0].clk || 0.08) : 1);   // residual (local dent) + striker ring level; a thick bar barely dents
  };
  Voice.prototype.strikeTongue = function (i, vel) {
    var t = this.model && this.model.tongues && this.model.tongues.filter(function (x) { return x.idx === i; })[0]; if (!t) return;
    if (t.bar) this.strike(t.rb - 0.33 * t.ln, t.th + 0.22 * t.hw, vel, 'head');   // just off the bar's centre: full fundamental, a touch of the second partial
    else this.strike(t.rb - 0.82 * t.ln, t.th + 0.15 * t.hw, vel, 'head');
  };
  Voice.prototype.settle = function () {   // a freshly built snare: let wires + head find their resting preload silently (no 'tick' on load)
    var n = Math.round(0.25 * this.sr), buf = new Float32Array(256), bR = new Float32Array(256), c0 = this.chk, ct = this.chkT;
    this.chk = this.chkT = 1;
    for (var o = 0; o < n; o += 256) this.process(buf, 256, null, null, bR);
    this.chk = c0; this.chkT = ct; this.env = 0; this.bzA = this.bzB = 0; this.clp = 0; this.Fprev = 0;
    for (var i = 0; i < this.nModes; i++) this.v[i] = 0;
  };
  Voice.prototype.setChoke = function (x) { this.chkT = Math.max(0, Math.min(1, x)); };
  Voice.prototype.addPulse = function (r, th, amp, dur, delay) {
    if (!this.model) return; var ps = this.makePsi(Math.min(0.98, r), th, 0.006);
    this.pulses.push({ t: -(delay || 0), dur: dur, amp: amp, hoop: 0, psi: ps, head: 1 });
  };
  Voice.prototype.makePsi = function (r, theta, rc) {
    var Bm = this.model.B.modes, a = this.model.a, out = new Float64Array(this.nModes);
    for (var i = 0; i < Bm.length; i++) {
      var md = Bm[i];
      out[i] = modeShape(md, r, theta) * Math.exp(-Math.pow(md.k * rc, 2) / 8);
    }
    return out;
  };
  Voice.prototype.reset = function () { this.bzA = this.bzB = 0; this.env = 0;
    if (!this.q) return; this.q.fill(0); this.v.fill(0); this.mallets = []; this.pulses = [];
    [this.shellB, this.hoopB, this.airB].forEach(function (b) { b.y.fill(0); b.v.fill(0); });
    this.px = this.pv = this.pPrev = 0; this.env = 0; this.chk = 0; this.chkT = 0; this.svf1 = this.svf2 = 0; this.yPrev = 0; this.lpT = 0; this.lpL = 0; this.Fprev = 0; this.clp = 0; if (this.rb) { this.rb.y1.fill(0); this.rb.y2.fill(0); }
    this.wires.forEach(function (w) { w.y = 0; w.v = 0; w.Fp = 0; });
  };
  // Render n samples into out (Float32Array). snap: optional {every, arr: [], max} to record batter q.
  Voice.prototype.process = function (out, n, snap, comps, outRt) {
    var extP = this.extP || 0, zIdx = this.zIdx, tIdx = this.tIdx, nBm = this.nB;
    // only ringing in sympathy (not struck for a while): just the air-coupled (0,n) modes need computing
    this.sinceHit = (this.sinceHit || 0) + n;
    var sympOnly = this.kitMode && this.sinceHit > 1.5 * this.sr && !this.mallets.length && !this.pulses.length;
    if (sympOnly && !this.wasSymp) { var inZ = new Uint8Array(this.nModes); for (var zr = 0; zr < zIdx.length; zr++) inZ[zIdx[zr]] = 1; for (var zq = 0; zq < this.nModes; zq++) if (!inZ[zq]) { this.q[zq] = 0; this.v[zq] = 0; } }   // the rest has long decayed
    this.wasSymp = sympOnly;
    var sIdx = sympOnly ? zIdx : null, NN = sympOnly ? zIdx.length : this.nModes;   // extP: sound pressure from the other drums in a kit (sympathetic resonance)
    var md = this.model; if (!md) { for (var z = 0; z < n; z++) { out[z] = 0; if (outRt) outRt[z] = 0; } return; }
    var oHL = this.oHL, oHR = this.oHR, chW = this.chW;
    var N = this.nModes, q = this.q, v = this.v, w2 = this.w2, a2 = this.a2, invM = this.invM, S = this.S,
      rimF = this.rimF, tmw = this.tmw, frac = this.frac, oB = this.oB, oR = this.oR, cSn = this.cSn;
    var dt = this.dt, os = this.os, Kc = md.Kc, port = md.port;
    var shellB = this.shellB, hoopB = this.hoopB, airB = this.airB;
    var W = this.wire, wires = this.wires, snOn = md.snare.on, snLvl = md.snare.level, sgn = this.sgnSn;
    var mal = this.mallets, pulses = this.pulses, tmCoef = this.tmCoef;
    var cS = 1, cH = 0.08;
    // SVF coefficients for buzz noise (bandpass ~4.2 kHz)
    var fsv = 2 * Math.sin(Math.PI * Math.min(0.24, 4200 / this.sr)), qsv = 1.1;
    for (var s = 0; s < n; s++) {
      var outB = 0, outR = 0, outS = 0, outH = 0, outP = 0, outA = 0, buzz = 0, Fsum = 0;
      for (var sub = 0; sub < os; sub++) {
        // --- pulses (rim) ---
        var Fhoop = 0, npl = 0, plF = this.plF || (this.plF = []), plP = this.plP || (this.plP = []);
        for (var pi = pulses.length - 1; pi >= 0; pi--) {
          var P = pulses[pi]; P.t += dt;
          if (P.t < 0) continue;
          if (P.t >= P.dur) { pulses.splice(pi, 1); continue; }
          var fp = P.amp * Math.sin(Math.PI * P.t / P.dur);
          Fhoop += fp * P.hoop; if (P.psi) { plF[npl] = fp * P.head; plP[npl] = P.psi; npl++; }
        }
        var chk = this.chk = this.chk + (this.chkT - this.chk) * 0.002;
        // --- cavity pressure ---
        var volP = this.vol + this.volv * dt - (port ? port.A * (this.px + this.pv * dt) : 0);
        var p = Kc * volP / (1 + Kc * dt * dt * this.Ycav);   // implicit cavity spring (rank-one)
        // --- snare wires ---
        var Fsn = 0;
        if (snOn) {
          var u = sgn * (this.qc + this.qcv * dt), Ysn = this.Ysn * 3 * snLvl;
          for (var wi = 0; wi < 3; wi++) {
            var Wr = wires[wi], dl = u - (Wr.y + Wr.v * dt), Fc = 0;
            if (dl > 0) { Fc = W.kcE * dl / (1 + W.kcE * dt * dt * (Ysn + 1 / (W.m * Wr.mf))); }
            var acc = (Fc - W.k * Wr.mf * (Wr.y + W.gap)) / (W.m * Wr.mf) - W.alpha * Wr.v;
            Wr.v += acc * dt; Wr.y += Wr.v * dt;
            var dF = Fc - Wr.Fp; Wr.Fp = Fc;
            this.env += (dF < 0 ? -dF : dF) * this.envK;
            Fsn += Fc;
          }
          Fsn = -sgn * Fsn * snLvl;
        }
        // --- tension modulation ---
        var modr = tmCoef * this.tm, mod = modr > 0 ? 0.6 * Math.tanh(modr / 0.6) : 0;
        // --- membrane modes: pass 1 (all forces except mallet contact) ---
        var nm = mal.length;
        var m0 = nm > 0 ? mal[0] : null, m1 = nm > 1 ? mal[1] : null;
        var ps0 = m0 ? m0.psi : null, ps1 = m1 ? m1.psi : null;
        var h0 = 0, h1 = 0;
        for (var ii = 0; ii < NN; ii++) {
          var i = sIdx ? sIdx[ii] : ii;
          var f = -(p + extP) * S[i] + Fsn * cSn[i];
          for (var pk = 0; pk < npl; pk++) f += plF[pk] * plP[pk][i];
          var qi = q[i];
          var ac = f * invM[i] - w2[i] * (1 + mod * frac[i]) * qi - (a2[i] + chk * chW[i]) * v[i];
          var vi = v[i] + ac * dt; qi += vi * dt; v[i] = vi; q[i] = qi;
          if (ps0) h0 += ps0[i] * qi;
          if (ps1) h1 += ps1[i] * qi;
        }
        // --- mallet contact: exact implicit solve against predicted head position ---
        var F0 = 0, F1 = 0;
        for (var k = 0; k < nm; k++) {
          var M_ = mal[k], hp = k === 0 ? h0 : h1, F = 0;
          var del = M_.gone ? -1 : (M_.y + M_.v * dt) - hp;
          if (del > 0) {
            var ks = M_.kc * Math.pow(del, M_.al - 1);
            F = ks * del / (1 + ks * dt * dt * (M_.Y + 1 / M_.m));
            // contact loss as unloading hysteresis, keyed to the (smooth) mallet velocity
            if (M_.v < 0) { var uu = Math.min(1, -M_.v / (0.2 * M_.v0)); F *= 1 - M_.loss * uu * uu * (3 - 2 * uu); }
          }
          if (F > 0) M_.hit = true; else if (M_.hit && M_.v <= 0) M_.gone = true; // player retracts after release
          M_.F = F; M_.v -= F / M_.m * dt; M_.y += M_.v * dt; M_.life += dt;
          if (k === 0) F0 = F * dt; else F1 = F * dt;
        }
        // --- pass 2: apply contact impulses, accumulate observables ---
        var vol = 0, volv = 0, tm = 0, rim = 0, qc = 0, qcv = 0, ob = 0, orr = 0, hv0 = 0, hv1 = 0, ohl = 0, ohr = 0;
        for (var jj2 = 0; jj2 < NN; jj2++) {
          var i2 = sIdx ? sIdx[jj2] : jj2, vi2 = v[i2], qi2 = q[i2];
          if (F0 || F1) {
            var dv = (F0 * (ps0 ? ps0[i2] : 0) + F1 * (ps1 ? ps1[i2] : 0)) * invM[i2];
            vi2 += dv; qi2 += dv * dt; v[i2] = vi2; q[i2] = qi2;
          }
          if (i2 < nBm) ob += oB[i2] * vi2; else orr += oR[i2] * vi2; ohl += oHL[i2] * vi2; ohr += oHR[i2] * vi2;
          if (ps0) hv0 += ps0[i2] * vi2;
          if (ps1) hv1 += ps1[i2] * vi2;
        }
        for (var zz = 0; zz < zIdx.length; zz++) { var iz = zIdx[zz], qz = q[iz], vz = v[iz]; vol += S[iz] * qz; volv += S[iz] * vz; rim += rimF[iz] * qz; qc += cSn[iz] * qz; qcv += cSn[iz] * vz; }
        for (var tt = 0; tt < tIdx.length; tt++) { var it2 = tIdx[tt], qt = q[it2]; tm += tmw[it2] * qt * qt; }
        if (m0) m0.hv = hv0;
        if (m1) m1.hv = hv1;
        Fsum = (F0 + F1) / dt;
        this.vol = vol; this.volv = volv; this.tm = tm; this.rim = rim; this.qc = qc; this.qcv = qcv;
        // retire finished mallets
        for (var k3 = mal.length - 1; k3 >= 0; k3--) { var Mr = mal[k3]; if (Mr.gone || Mr.life > 0.05) mal.splice(k3, 1); }
        // --- port air ---
        if (port) { this.pv += (p * port.A / port.mp - 2 * port.alpha * this.pv) * dt; this.px += this.pv * dt; }
        // --- air cavity modes (driven by dp/dt) ---
        var dp = (p - this.pPrev) / dt; this.pPrev = p;
        var oa = 0;
        for (var ai = 0; ai < airB.n; ai++) {
          var av = airB.v[ai] + (dp * 1e-4 - airB.w2[ai] * airB.y[ai] - airB.a2[ai] * airB.v[ai]) * dt;
          airB.v[ai] = av; airB.y[ai] += av * dt; oa += av;
        }
        // --- shell & hoop ---
        var os_ = 0, oh = 0;
        for (var si = 0; si < shellB.n; si++) {
          var sv = shellB.v[si] + ((rim * cS + Fhoop * 0.3) * shellB.invM[si] - shellB.w2[si] * shellB.y[si] - shellB.a2[si] * shellB.v[si]) * dt;
          shellB.v[si] = sv; shellB.y[si] += sv * dt; os_ += sv * shellB.rad[si];
        }
        for (var hi = 0; hi < hoopB.n; hi++) {
          var hv2 = hoopB.v[hi] + ((rim * cH + Fhoop) * hoopB.invM[hi] - hoopB.w2[hi] * hoopB.y[hi] - hoopB.a2[hi] * hoopB.v[hi]) * dt;
          hoopB.v[hi] = hv2; hoopB.y[hi] += hv2 * dt; oh += hv2 * hoopB.rad[hi];
        }
        if (sub === os - 1) { outB = ob; outR = orr; this.ohl = ohl; this.ohr = ohr; outS = os_; outH = oh; outP = port ? this.pv * port.A / (Math.PI * md.a * md.a) : 0; outA = oa; }
      }
      // --- contact click: residual local response (dF/dt) + the striker's own ringing ---
      var dF = Fsum - (this.Fprev || 0); this.Fprev = Fsum;
      var click = dF * (this.resK || 0) * RESK;
      var clickRaw = click;
      var rb = this.rb;
      if (rb && (dF !== 0 || rb.on)) { rb.on = false; for (var ri = 0; ri < rb.n; ri++) {
        var yr = rb.c1[ri] * rb.y1[ri] + rb.c2[ri] * rb.y2[ri] + rb.g[ri] * dF; rb.y2[ri] = rb.y1[ri]; rb.y1[ri] = yr; click += yr * (this.resK || 0) * RINGK;
        if (yr > 1e-9 || yr < -1e-9) rb.on = true;
      } }
      this.clp = (this.clp || 0) + this.gClk * (click - (this.clp || 0)); click = this.clp;
      // --- snare buzz noise ---
      if (snOn) {
        this.noise ^= this.noise << 13; this.noise ^= this.noise >> 17; this.noise ^= this.noise << 5;
        var wn = (this.noise | 0) / 2147483648;
        var lp = this.svf2 + fsv * this.svf1, hp = wn - lp - qsv * this.svf1, bp = fsv * hp + this.svf1;
        this.svf1 = bp; this.svf2 = lp;
        this.env *= 0.995; if (this.env > 50) this.env = 50;   // ~4 ms per wire impact: the strands' clicks blur into a wash instead of a rattle
        // wire rattle: broad 2.5-7 kHz band, rolled off above ~8 kHz like real snare wires (no fizzy top);
        // gentle contact (soft notes, sympathetic buzz) only makes a dull 'shh' - the bright sizzle needs real impacts
        var eD = this.env / (this.env + 0.008), cB = 0.2 + 0.45 * eD;
        var bz = bp + 0.15 * hp; this.bzA = (this.bzA || 0) + cB * (bz - (this.bzA || 0)); this.bzB = (this.bzB || 0) + cB * (this.bzA - (this.bzB || 0));
        buzz = 2.9 * this.env * this.bzB * snLvl;
      }
      var micB = outB + 0.12 * outS + 0.25 * outH + 0.5 * buzz + 0.1 * outA + click;
      var micR = outR + 0.6 * outP + buzz + 0.25 * outS + 0.3 * outA + 0.3 * click;
      var y0 = this.mixB * micB + this.mixR * micR + this.mixS * (outS * 0.5 + outH * 0.6);
      // overheads: per-mode stereo weights + centred body/buzz/click
      var ext = 0.35 * this.mixS * (outS * 0.5 + outH * 0.6) + 0.5 * buzz + 0.4 * click + 0.3 * outP + 0.1 * outA;
      var mc = this.mics;
      var yl = mc.cL * y0 + mc.oh * (this.ohl + ext), yr = mc.cR * y0 + mc.oh * (this.ohr + ext);
      if (yl !== yl || yr !== yr || yl > 1e6 || yl < -1e6) { this.reset(); yl = yr = 0; }
      out[s] = yl; if (outRt) outRt[s] = yr;
      if (comps) { comps.B[s] = outB; comps.R[s] = outR; comps.S[s] = outS; comps.H[s] = outH; comps.P[s] = outP; comps.A[s] = outA; comps.Z[s] = buzz; }
      if ((s & 255) === 255 && mal.length === 0 && pulses.length === 0) {
        var qm = 0; for (var zz = 0; zz < N; zz++) { var av2 = v[zz] < 0 ? -v[zz] : v[zz]; if (av2 > qm) qm = av2; }
        if (qm < 1e-14) { this.reset(); }
      }
      if (snap && s % snap.every === 0 && snap.arr.length < snap.max) {
        var fr = new Float32Array(this.nB); for (var b = 0; b < this.nB; b++) fr[b] = q[b]; snap.arr.push(fr);
      }
    }
  };

  // ===================== STEREO MICS =====================
  // Close mic = existing mono mix. Overhead pair hovers above the piece; near-field means each mic
  // hears the part of the vibration pattern under it, so high-order modes de-correlate L/R.
  function micWeights(modes, shapeFn, mics, outWs) {
    var mc = mics || {}, n = modes.length, L = new Float64Array(n), R = new Float64Array(n);
    var width = mc.width == null ? 0.7 : mc.width, height = mc.height == null ? 0.8 : mc.height, pan = mc.pan || 0;
    var nf = Math.min(0.95, width / (1 + 0.8 * height * height));  // nearer & wider -> more L/R difference
    var thL = 2.25 + pan * 0.9, thR = 0.55 + pan * 0.9, rm = 0.65;
    for (var i = 0; i < n; i++) {
      var md = modes[i], w = outWs ? outWs[i] : md.outW;
      var sl = shapeFn(md, rm, thL), sr = shapeFn(md, rm, thR);
      var ohW = w / (1 + 0.6 * height);
      var common = (1 - nf) * (md.m <= 1 || md.m === 99 ? 1 : 0.45);
      L[i] = ohW * (common + nf * 1.5 * sl);
      R[i] = ohW * (common + nf * 1.5 * sr);
    }
    var a = (pan + 1) * Math.PI / 4, close = mc.close == null ? 1 : mc.close, oh = mc.oh == null ? 0.7 : mc.oh;
    return { L: L, R: R, g: { cL: close * Math.cos(a) * Math.SQRT2 * 0.5, cR: close * Math.sin(a) * Math.SQRT2 * 0.5, oh: oh * 0.8 } };
  }

  // ===================== METAL: cymbals, hi-hats, gongs, bells =====================
  var ALLOYS = {
    b20:      { name: 'B20 bronze (cast)',   rho: 8600, E: 110e9, eta: 0.00022, color: '#c99a45' },
    b12:      { name: 'B12 bronze',          rho: 8650, E: 112e9, eta: 0.00026, color: '#cfa04d' },
    b8:       { name: 'B8 bronze (sheet)',   rho: 8700, E: 115e9, eta: 0.0003, color: '#d8aa55' },
    bellmetal:{ name: 'Bell metal (B22)',    rho: 8600, E: 105e9, eta: 0.00012, color: '#b98a3d' },
    brass:    { name: 'Brass',               rho: 8450, E: 100e9, eta: 0.00045, color: '#ddb84f' },
    nickel:   { name: 'Nickel silver',       rho: 8700, E: 125e9, eta: 0.00035, color: '#cbc8ba' },
    steel:    { name: 'Stainless steel',     rho: 7900, E: 195e9, eta: 0.00025, color: '#b8bec5' },
    aluminum: { name: 'Aluminum',            rho: 2700, E: 69e9,  eta: 0.0004, color: '#cfd4d9' },
    titanium: { name: 'Titanium',            rho: 4500, E: 110e9, eta: 0.0002, color: '#a3a9b2' },
    copper:   { name: 'Copper',              rho: 8960, E: 117e9, eta: 0.0006, color: '#c27a4a' }
  };
  var PIECES = {
    ride: 'Ride', crash: 'Crash', splash: 'Splash', china: 'China', trash: 'Trash / hole crash',
    hihat: 'Hi-hat (pair)', stack: 'Stack (two pressed)', tamtam: 'Tam-tam', opera: 'Opera gong (pitch glide)',
    nipple: 'Nipple / boss gong', bell: 'Bell', cowbell: 'Cowbell'
  };

  function plateSet(c, piece, quality, sp, which, budget, sr) {
    var A = ALLOYS[c.alloy] || ALLOYS.b20;
    var a = Math.max(0.03, (c.diameter || 16) * 0.0127), h = Math.max(0.2, c.thickness || 1) * 1e-3;
    var taper = c.taper || 0, heff = h * (1 - 0.3 * taper);
    var cbar = Math.sqrt(A.E / A.rho), even = c.evenness == null ? 0.92 : c.evenness;
    var hammer = c.hammer || 0, lathe = c.lathe == null ? 0.5 : c.lathe, holes = c.holes || 0, flange = c.flange || 0;
    var maxN = Math.round((quality === 'light' ? 95 : 170) * budget), nProxy = Math.round((quality === 'light' ? 66 : 130) * budget * (piece === 'hihat' || piece === 'stack' ? 0.45 : 1));   // hats render their bed as noise: fewer proxies are enough
    var fmax = Math.min(15500, 0.3 * (sr || 44100));
    var modes = [], isBellPiece = piece === 'bell' || piece === 'cowbell';
    var massPlate = A.rho * Math.PI * a * a * heff * (1 - 0.02 * holes);
    var gong = piece === 'tamtam' || piece === 'opera' || piece === 'nipple';
    var rim = gong ? (sp.rim == null ? 0.6 : sp.rim) : 0;
    var rb = isBellPiece ? 0 : Math.min(0.6, Math.max(0, (c.bellDia || 0) / Math.max(1, c.diameter || 16)));
    var D = A.E * heff * heff * heff / (12 * (1 - NU * NU));
    if (!isBellPiece) {
      var base = Math.sqrt(D / (A.rho * heff)) / (a * a);
      var dome = Math.max(0.3, c.dome == null ? 20 : c.dome) * 1e-3, Rc = a * a / (2 * dome);
      var irr = 0.06 * (1 - even) + hammer * 0.05 + flange * 0.12 + holes * 0.012;
      var cand = [];
      for (var m = 0; m <= 120; m++) {
        var any = false;
        for (var n = 0; n <= 60; n++) {
          if (m < 2 && n === 0) continue;
          var lam = 1.15 * m + Math.PI * n - (m === 0 ? 0.1 : 0.2);
          var wp = base * lam * lam, wc = cbar / Rc / ((1 + m * m) * (1 + n));
          var w = Math.sqrt(wp * wp + wc * wc);
          if (rim) w *= 1 + rim * 0.6 / (1 + 0.15 * m) * (n === 0 ? 1 : 0.4);
          w *= 1 + irr * (hash(m, n + 17) - 0.5) * 2;
          if (w / TAU > fmax) break;
          any = true; cand.push({ m: m, n: n, w: w, lam: lam });
        }
        if (!any && m > 3) break;
      }
      cand.sort(function (x, y) { return x.w - y.w; });
      var thinK = 1;
      if (quality === 'light' && ['crash', 'ride', 'splash', 'china', 'trash'].indexOf(piece) >= 0) {
        // light cymbals: cover the same range as full quality, but keep only every few modes above ~900 Hz
        // (each kept mode speaks for the ones skipped), so the bed starts where it does in full mode
        var full = cand.slice(0, Math.round(170 * budget)), low = full.filter(function (c0) { return c0.w < TAU * 900; }), hi = full.filter(function (c0) { return c0.w >= TAU * 900; });
        var room = Math.max(8, maxN - low.length), keep = Math.min(1, room / Math.max(1, hi.length)), acc = 0, hiK = [];
        hi.forEach(function (c0) { acc += keep; if (acc >= 1) { acc -= 1; hiK.push(c0); } });
        hiK.forEach(function (c0) { c0.thin = 1 / keep; }); low.forEach(function (c0) { c0.lowK = 1.5; });   // (light) keep the body as present as in full quality
        cand = low.concat(hiK);
      } else cand = cand.slice(0, maxN);
      cand.forEach(function (cd) {
        var f = cd.w / TAU, k = cd.lam / a;
        var hfLoss = (1 + 0.5 * hammer + 0.6 * flange + 0.1 * holes) * (1 - 0.35 * lathe) * (gong ? 0.45 : 1) * (piece === 'hihat' ? 1 + f / 14000 : 1);
        // cymbals: the shimmer (2-8 kHz) outlasts the low modes, whose energy drains upward into it;
        // that keeps the tail a wash instead of a chord of obvious low partials
        var cym = !gong && piece !== 'hihat' && piece !== 'stack', hfK = cym ? cymHF(f, piece) : 1;
        var drain = cym ? 1.8 * (piece === 'ride' ? 0.3 : piece === 'splash' ? 1.8 : 0.25) * Math.exp(-f / 900) + (piece === 'splash' ? 1.2 : 0) : 0;
        // the stand: the cymbal sits on felt and a sleeve at its centre, which soaks up the big, slow low-mode flexing
        // (without it a thin cymbal flaps like a loose sheet and its low partials ring on as metallic tones)
        if (cym) drain += (piece === 'ride' ? 1.5 : 9) * Math.exp(-f / 300);
        var alpha = (gong ? (piece === 'opera' ? 0.5 : 0.03) : 0.12) + (piece === 'hihat' ? RTn('hhA0', 1) + RTn('hhA1', 8) * Math.exp(-f / 1500) : 0) + 0.5 * A.eta * cd.w * hfLoss * hfK + drain + 0.002 * f / 1000 * RHO * C / (A.rho * heff)
          + (cd.m <= 2 && !gong ? 0.5 : 0) + flange * (cd.m < 6 ? 3 : 0.6) + holes * 0.25 + (gong ? 0 : 0.08 + 0.4 * Math.pow(14 / Math.max(6, c.diameter || 16), 2));
        var pairs = cd.m > 0 && cd.m <= 6 ? 2 : 1;
        for (var o = 0; o < pairs; o++) {
          var det = pairs === 2 ? 1 + (o ? 1 : -1) * (0.002 + (1 - even) * 0.012) * (0.3 + 0.7 * hash(cd.m, cd.n + 3)) : 1;
          var phi = pairs === 2 ? (o ? Math.PI / (2 * cd.m) : 0) : hash(cd.m + 7, cd.n) * TAU;
          modes.push({ m: cd.m, n: cd.n, w: cd.w * det, f: f * det, M: massPlate / 4, alpha: alpha, k: k, phi: phi, ms: 'plate', rb: rb, which: which,
            orient: o, taper: taper, outW: cd.thin ? Math.sqrt(cd.thin) : cd.lowK || 1, spread: cd.thin ? 0.01 * cd.thin : 0, S: 0, rimF: 0, tmw: 0, frac: 1, lam: cd.lam });
        }
      });
      // cymbal cup (bell) or the tuned boss of a nipple gong
      var bellH = (c.bellHeight == null ? 15 : c.bellHeight) * 1e-3;
      if (rb > 0.02 && bellH > 0.002) {
        var Rb = rb * a, hb = heff * 1.4, mb = A.rho * hb * TAU * Rb * bellH * 0.8;
        // the cup sings longest on a ride; on thin crashes / splashes / chinas it is a short 'tink', not a drone
        var cupK = piece === 'ride' ? 1 : piece === 'splash' ? 7 : piece === 'crash' ? 2.5 : piece === 'china' || piece === 'trash' ? 3.5 : 1;
        // a cymbal's bell is part of the same bronze, sitting on the felt: it never rings on alone as a pure tone for 20 s
        // (that was the 'cheap' ping under the wash). ride bell: about 4 s to die away; crash/china/splash bells: ~2.5 s or less
        var cupMin = piece === 'ride' ? 6.91 / 4 : ['crash', 'china', 'trash', 'splash'].indexOf(piece) >= 0 ? 6.91 / 2.5 : 0;
        var bossTuned = piece === 'nipple', f0b = bossTuned ? midiHz(sp.bossNote == null ? 45 : sp.bossNote) : 0;
        var ratios = [1, 2.0, 2.76, 3.9, 5.1, 6.4, 7.8, 9.3, 11];
        for (var fam = 0; fam < (bossTuned ? 1 : 2); fam++) for (var bn = 2; bn <= 10; bn++) {
          var wb = bossTuned ? TAU * f0b * ratios[bn - 2] : 1.3 * Math.sqrt(1 + 0.5 * Rb / bellH) * cbar * hb / Math.sqrt(12) / (Rb * Rb) * bn * (bn * bn - 1) / Math.sqrt(bn * bn + 1) * (fam ? 1.6 + 0.08 * bn : 1);
          if (wb / TAU > fmax) break;
          for (var ob = 0; ob < 2; ob++) modes.push({ m: bn, n: fam, w: wb * (1 + (ob ? 1 : -1) * 0.0015), f: wb / TAU, M: mb / 2, alpha: Math.max((0.12 + 0.35 * A.eta * wb * (bossTuned ? 0.5 : 1)) * cupK, cupMin), k: bn / Rb, phi: ob ? Math.PI / (2 * bn) : 0, ms: 'bell', rb: rb,
            which: which, orient: ob, outW: bossTuned ? (bn === 2 ? 2.6 : bn === 3 ? 1.6 : 1.1) : fam ? 0.9 : 1.3, S: 0, rimF: 0, tmw: 0, frac: 1, cup: true, boss: bossTuned && bn <= 3 });
        }
      }
    } else {
      // free-hanging bell or cowbell: partial series (minor-third church bell / irregular cowbell)
      var Kb = piece === 'bell' ? 0.47 : 0.43, f1 = Kb * h / (a * a) * cbar;
      var R = piece === 'bell' ? [0.5, 1, 1.19, 1.5, 2, 2.51, 2.66, 3.01, 4.0, 5.1, 6.2] : [1, 1.48, 1.86, 2.53, 3.04, 3.8, 4.6, 5.7];
      var Mb = A.rho * h * TAU * a * a * 1.2;
      R.forEach(function (r, i) {
        var w = TAU * f1 * r * (1 + (1 - even) * 0.03 * (hash(i, 9) - 0.5) + hammer * 0.02 * (hash(i, 4) - 0.5)); if (w / TAU > fmax) return;
        var mm = 2 + Math.floor(i / 2);
        var alpha = (piece === 'bell' ? 0.06 : 0.25) + 0.5 * A.eta * w * (piece === 'cowbell' ? 4 : 1) * (1 + hammer) + (piece === 'cowbell' ? 9 : 0);
        for (var o = 0; o < 2; o++) modes.push({ m: mm, n: i, w: w * (1 + (o ? 1 : -1) * 0.0015 * (1 + 3 * (1 - even))), f: w / TAU, M: Mb / 4, alpha: alpha, k: mm / a,
          phi: o ? Math.PI / (2 * mm) : 0, ms: 'bowl', which: which, orient: o, outW: 1, S: 0, rimF: 0, tmw: 0, frac: 1 });
      });
    }
    // light quality: a dense bed of grouped proxy modes above the explicit ones keeps the wash
    if (!isBellPiece) {
      var fTop = 0; modes.forEach(function (md) { if (md.ms === 'plate' && md.f > fTop) fTop = md.f; });   // plate modes only (the cup has its own)
      if (piece === 'hihat' || piece === 'stack') fTop = Math.max(fTop, 4200);   // hats: the dense bed is the sizzle above the body
      if (fTop < fmax * 0.85) {
        var NP = nProxy, lo = fTop * 1.03, r2 = Math.pow(fmax / lo, 1 / NP);
        var dens = (Math.PI * a * a) / (4 * Math.PI) * Math.sqrt(A.rho * heff / D);   // plate modes per rad/s
        for (var pi = 0; pi < NP; pi++) {
          var cymR = !gong && piece !== 'hihat' && piece !== 'stack', fc = lo * Math.pow(r2, pi + 0.5 + (cymR ? 0.9 : 0.3) * (hash(pi, 21) - 0.5)), grp = Math.max(1, dens * TAU * fc * (r2 - 1));   // cymbals: irregular spacing (an even comb of lines flutters at its spacing rate: the wire buzz)
          var wv = TAU * fc;
          var cymP = !gong && piece !== 'hihat' && piece !== 'stack', hfK2 = cymP ? cymHF(fc, piece) : 1, splX = piece === 'splash' ? 2.2 : 0;
          modes.push({ m: 50, n: pi, w: wv, f: fc, M: massPlate / 4, alpha: 0.2 + 0.5 * A.eta * wv * hfK2 * (1 + 0.5 * hammer + 0.6 * flange + 0.1 * holes) * (1 - 0.35 * lathe) * (piece === 'hihat' ? 1 + fc / 14000 : 1) + flange * 0.6 + holes * 0.25 + (gong ? 0 : 0.15) + splX,
            k: Math.sqrt(wv / Math.sqrt(D / (A.rho * heff))), phi: hash(pi, 23) * TAU, ms: 'proxy', spread: r2 - 1, amp: Math.sqrt(grp) * 1.4 * (cymP && fc > 7000 ? Math.pow(7000 / fc, 1.5) : 1) * (cymP ? 0.3 + 1.4 * hash(pi, 27) * hash(pi, 28) + 0.5 * hash(pi, 29) : 1),   // (and uneven strengths, like real partials) rb: rb, which: which, orient: 0,
            outW: 1, S: 0, rimF: 0, tmw: 0, frac: 0, proxy: true });
        }
      }
    }
    var cymO = !gong && piece !== 'hihat' && piece !== 'stack' && !isBellPiece;
    modes.forEach(function (md) {
      if (cymO && md.ms === 'plate') md.outW *= md.f / (md.f + 120);   // low bending modes radiate a little less from a thin plate (but overhead mics are close: they still carry body)
      var x = md.w / C * a * 0.7, mm = md.boss ? 0 : md.ms === 'proxy' ? 3 : Math.min(md.m, cymO && md.ms === 'plate' ? 1 : 3), p = Math.pow(x, 2 * (mm + 1));
      md.outW *= Math.sqrt(p / (1 + p));
    });
    return { modes: modes, a: a, mass: massPlate, A: A, heff: heff, cbar: cbar, rb: rb, D: D };
  }
  // relative material loss for cymbal modes: flatter above 2 kHz (shimmer sustains), rising again in the top octave (no fizz)
  function cymHF(f, piece) {
    var e = piece === 'splash' ? 0.45 : piece === 'ride' ? RTn('hfE', 0.2) : 0.1, k = piece === 'ride' ? RTn('hfK', 1) : 1;   // splashes stay a quick, less airy flash. rides and crashes (from recordings): the low hum outlasts the shimmer
    return k * (f <= 2000 ? 1 : f <= 8000 ? Math.pow(2000 / f, e) : Math.pow(0.25, e) * Math.pow(f / 8000, 1.8));
  }
  function metalShape(md, r, th) {
    var ang = Math.cos(md.m * th + md.phi);
    if (md.ms === 'plate') {
      // Bessel-like radial shape: evanescent inside the turning point (x < m), oscillatory ~ x^-1/2 beyond it
      var x = md.lam * Math.max(0, r), m = md.m, R;
      if (x < m) R = Math.pow(x / m, 0.6 * m) * Math.cos(-Math.PI / 4);
      else R = Math.cos(x - m * Math.PI / 2 - Math.PI / 4 - (m ? Math.sqrt(x * x - m * m) - x + m * Math.acos(Math.min(1, m / x)) : 0)) * Math.sqrt((m + 1.5) / (x + 1.5));
      if (md.rb > 0 && r < md.rb) R *= 0.25 + 0.75 * r / md.rb;
      if (md.taper) R *= 1 + 0.5 * md.taper * r * r;
      return R * ang;
    }
    if (md.ms === 'bell') { var u = r / Math.max(0.01, md.rb); return u > 1.25 ? 0.003 * ang : u > 1 ? (0.55 + 0.45 * Math.sin(Math.PI * 0.9)) * (1 - (u - 1) / 0.25) * ang : (0.55 + 0.45 * Math.sin(Math.PI * u * 0.9)) * ang; }
    if (md.ms === 'bowl') return Math.pow(Math.max(0, r), 0.7 * md.m) * ang;
    if (md.ms === 'proxy') { var cupK = md.rb > 0.02 && r < md.rb * 1.1 ? Math.pow(r / (md.rb * 1.1), 3) * 0.3 : 1; return md.amp * Math.max(0, r) * cupK * Math.sin(md.k * r * 0.12 + md.phi + 3 * th); }
    return 0;
  }

  // tonal balance of a cymbal's sound (dB by frequency), taken from recordings: a ride's 'hollow' wash is a strong low
  // hum (150-500 Hz) and a bright shimmer around 4-6 kHz with the 1-2 kHz region scooped out; crashes share the scoop
  var CYM_EQ = {
    ride: [[120, -18], [250, -13], [400, -9], [700, -5], [1200, -2], [2000, 0], [3500, 3], [6000, 6], [10000, 4]],   // (tuned by ear with the user: a ping-led ride, mids up, lows well back)
    crash: [[120, -20], [250, -18], [400, -14], [700, -9], [1200, -8], [2000, -5], [3500, 0], [7000, 2], [12000, 1]],   // (a crash's energy is nearly all above 600 Hz)
    china: [[120, -18], [250, -15], [400, -11], [700, -6], [1200, -4], [2000, -3], [3500, 0], [7000, 1], [12000, 0]],
    hihat: [[250, -2], [500, 5], [700, 3], [1000, -5], [1300, -8], [1800, -5], [2500, -4], [4000, -2], [8000, 2], [12000, 4]]   // (from an open-hat recording: a hollow dip near 1 kHz, a bright, airy top)
  };
  var RTUNE = {}; function RTn(k, d) { return RTUNE[k] != null ? RTUNE[k] : d; }
  function cymEq(f, piece) {
    var T = piece === 'hihat' && RTUNE.hhEq ? RTUNE.hhEq : piece === 'ride' && RTUNE.eq ? RTUNE.eq : CYM_EQ[piece === 'hihat' ? 'hihat' : piece === 'ride' ? 'ride' : piece === 'china' || piece === 'trash' ? 'china' : 'crash'];
    if (f <= T[0][0]) return Math.pow(10, T[0][1] / 20);
    for (var i = 1; i < T.length; i++) if (f <= T[i][0]) { var u = Math.log(f / T[i - 1][0]) / Math.log(T[i][0] / T[i - 1][0]); return Math.pow(10, (T[i - 1][1] + u * (T[i][1] - T[i - 1][1])) / 20); }
    return Math.pow(10, T[T.length - 1][1] / 20);
  }
  function buildMetalModel(cfg, sr) {
    var sp = cfg.special, piece = sp.piece || 'crash', q = cfg.lite ? 'light' : sp.quality || 'full', kb = cfg.lite ? (sp.piece === 'hihat' || sp.piece === 'stack' ? 0.55 : 0.7) : 1;   // kit CPU saver: lighter still
    var pair = piece === 'hihat' || piece === 'stack';
    if (pair) {   // two plates resting on each other only make sense (and only stay stable) as cymbal-weight plates: top <= 3 mm, bottom <= 2 mm
      var cap = function (pl, mx) { return pl && pl.thickness > mx ? Object.assign({}, pl, { thickness: mx }) : pl; };
      sp = Object.assign({}, sp, { top: cap(sp.top, 3), bottom: cap(sp.bottom, 2) });
    }
    var T = plateSet(sp.top || {}, piece, q, sp, 0, (pair ? 0.65 : 1) * kb, sr);
    var modes = T.modes.slice(), Bp = null;
    if (pair) { Bp = plateSet(sp.bottom || sp.top || {}, piece, q, sp, 1, 0.55 * kb, sr); modes = modes.concat(Bp.modes); }
    var g = T.A.E / (12 * T.A.rho * (1 - NU * NU));
    // clamp / felts / tape: extra damping on every mode -> a shorter, controllable release (stronger on the highs)
    var cl = Math.max(0, Math.min(1, sp.clamp || 0));
    if (cl > 0) modes.forEach(function (md) { md.alpha += cl * cl * 16 * (0.45 + 0.55 * Math.min(2.2, md.f / 2000)) + cl * 0.8; });
    return {
      metal: true, cfg: cfg, piece: piece, pair: pair, dark: (piece === 'crash' || piece === 'splash') ? Math.max(0, 0.7 - ((sp.top || {}).lathe == null ? 0.5 : sp.top.lathe)) * RTn('dkK', 0.6) : 0,   /* raw / unlathed crashes read darker */ a: T.a, top: T, bot: Bp, modes: modes, nTop: T.modes.length,
      B: { modes: T.modes, sigma: T.A.rho * T.heff, a: T.a, tmCoef: 0 }, R: null, SM: { name: T.A.name, Q: Math.round(1 / T.A.eta) },
      gamma: g, bloom: sp.bloom == null ? 1 : sp.bloom, glide: piece === 'opera' ? (sp.glide == null ? 0.6 : sp.glide) : 0,
      rivets: (sp.top && sp.top.rivets) || 0, chain: !!(sp.top && sp.top.chain),
      hh: { clutch: sp.clutch == null ? 0.6 : sp.clutch, tilt: sp.tilt == null ? 0.3 : sp.tilt, gap: sp.gap == null ? 8 : sp.gap,
        open: sp.pedal == null ? 0.15 : sp.pedal, press: sp.press == null ? 0.5 : sp.press },
      mallet: MALLETS[cfg.mallet] || MALLETS.stick, mix: cfg.mix || {}, mics: cfg.mics, gain: 1, airModes: [], shell: [], hoop: []
    };
  }

  // ---------- Metal core ----------
  function MetalCore(sr) { this.sr = sr; this.model = null; this.mallets = []; this.pulses = []; this.noise = 777; }
  MetalCore.prototype.setModel = function (model) {
    var same = this.model && this.N === model.modes.length;
    this.model = model;
    var modes = model.modes, N = modes.length, dt = 1 / this.sr; this.N = N; this.nB = model.nTop; this.dt = dt;
    var A = function () { return new Float64Array(N); };
    this.w2 = A(); this.a2 = A(); this.invM = A(); this.chW = A(); this.ck = A(); this.sk = A(); this.qs = A(); this.oC = A(); this.mmx = A(); this.hhW = A();
    var g = model.gamma, bl = model.bloom, w0 = Infinity, k0 = 1;
    modes.forEach(function (md) { if (md.ms === 'plate' && md.w < w0) { w0 = md.w; k0 = md.k; } });
    var glideC = model.glide * 3 * g * k0 * k0 / (w0 * w0);
    var nPlate = 0;
    for (var i = 0; i < N; i++) {
      var md = modes[i], ok = md.w * dt < 1.9, wd = ok ? 2 / dt * Math.sin(md.w * dt / 2) : 0;
      this.w2[i] = wd * wd; this.a2[i] = ok ? 2 * md.alpha : 0; this.invM[i] = ok ? 1 / md.M : 0;
      this.chW[i] = 30 + 0.003 * md.w; this.hhW[i] = 115 + 420 * Math.exp(-md.f / 900) + 260 * Math.pow(md.f / 9000, 3);   // clamped cymbals choke the very top too
      this.oC[i] = md.outW; this.mmx[i] = ok ? Math.max(0, 3.3 / (this.w2[i] * dt * dt) - 1) : 0;
      var plate = md.ms === 'plate' && ok;
      if (plate) nPlate++;
      this.sk[i] = plate ? 0.25 * md.k * md.k : 0;
      this.ck[i] = (plate && md.w * dt < 1.2) ? (bl * g * md.k * md.k / (md.w * md.w) + glideC) : 0;
      this.qs[i] = plate ? (hash(i, 31) < 0.5 ? -1 : 1) * md.k : 0;
    }
    this.qScale = 1;
    // spectral diffusion: in a real cymbal the dense, nonlinearly coupled modes never hold a clean pitch; each
    // partial wanders a little (more when hit harder), which turns a "chord" of metal tones into a shimmering wash
    var pcJ = model.piece, cymJ = ['crash', 'ride', 'splash', 'china', 'trash', 'hihat', 'stack'].indexOf(pcJ) >= 0;
    this.jit = A(); this.jS = A(); this.jD = A(); this.jC = [A(), A(), A(), A()]; this.jL = [0, 0, 0, 0]; this.jOn = cymJ;
    if (cymJ) for (var ij = 0; ij < N; ij++) {
      var mj = modes[ij]; if (!(mj.ms === 'plate' || mj.ms === 'proxy' || (mj.cup && pcJ !== 'ride')) || !this.w2[ij]) continue;
      var fj = mj.f, dj = fj < 120 ? 0 : 0.0045 * Math.min(1.6, Math.sqrt(fj / 3000)) + 0.008 * Math.exp(-fj / 1000) * (pcJ === 'ride' ? 0.6 : pcJ === 'china' || pcJ === 'trash' || pcJ === 'splash' ? 1.4 : 1);
      if (mj.spread) dj = Math.max(dj, (mj.ms === "proxy" ? 0.6 : 0.35) * mj.spread);   // a proxy stands for a band of modes: let it wander across that band
      this.jD[ij] = 2 * dj * (pcJ === "hihat" || pcJ === "stack" || !cymJ ? 1 : 0.35);   // w2 scales with frequency squared
      var nn = 0; for (var kj = 0; kj < 4; kj++) { var c = hash(ij, 40 + kj) * 2 - 1; this.jC[kj][ij] = c; nn += c * c; }
      nn = 1 / Math.sqrt(nn + 1e-9); for (var kj2 = 0; kj2 < 4; kj2++) this.jC[kj2][ij] *= nn;
    }
    this.jG = [3, 5.5, 8, 12].map(function (fc) { return 1 - Math.exp(-TAU * fc * 32 * dt); });
    this.jSeed = 777; this.jAmp = 0;
    var kRef = 0; for (var i5 = 0; i5 < N; i5++) kRef = Math.max(kRef, Math.abs(this.qs[i5]));
    this.qB = QB * bl * g / Math.sqrt(Math.max(1, nPlate)) / Math.max(1, kRef) * (model.piece === 'tamtam' ? 1.6 : model.piece === 'china' ? 1.4 : 1);
    var mw = micWeights(modes, metalShape, model.mics, null);
    this.oHL = mw.L; this.oHR = mw.R; this.mics = mw.g;
    // dense high-mode bed: keep its physics (energy, damping, cascade, choke) but render it as shaped noise,
    // so it never sounds like a set of discrete whistling tones
    // real cymbals: above a few hundred Hz the partials are so dense, and so strongly coupled, that what you hear is a
    // wash, not tones. So the discrete plate partials are rendered partly as band noise too: mostly tone at the bottom
    // (the low hum), mostly wash from ~1 kHz up. (bells, cups, gongs keep their partials: those really are tonal)
    var pcW = model.piece, washy = ['crash', 'ride', 'splash', 'china', 'trash', 'hihat', 'stack'].indexOf(pcW) >= 0;
    var f50 = pcW === 'ride' ? RTn('f50', 600) : pcW === 'china' || pcW === 'trash' ? 450 : pcW === 'splash' ? 550 : pcW === 'hihat' ? RTn('hhF50', 250) : pcW === 'stack' ? 450 : 600;   // below this a partial stays mostly a clear tone; above it, mostly wash
    this.wTone = new Float64Array(N);
    var pidx = []; for (var ip = 0; ip < N; ip++) {
      var mp = modes[ip]; if (!this.w2[ip]) continue;
      if (mp.ms === 'proxy') pidx.push(ip);
      else if (washy && mp.ms === 'plate' && mp.f > 100) { pidx.push(ip); this.wTone[ip] = 1 / (1 + Math.pow(mp.f / f50, 2)); }
    }
    pidx.sort(function (x, y) { return modes[x].f - modes[y].f; });
    // half-octave bands, so each band's noise sits where its partials are
    var bandOf = {}, bKeys = []; pidx.forEach(function (ip) { var bk = Math.floor(2 * Math.log2(modes[ip].f / 200)); if (!bandOf[bk]) { bandOf[bk] = []; bKeys.push(bk); } bandOf[bk].push(ip); });
    bKeys.sort(function (x, y) { return x - y; });
    var NG = bKeys.length, groups = [];
    for (var gI = 0; gI < NG; gI++) {
      var ids = bandOf[bKeys[gI]]; if (!ids.length) continue;
      var flo = modes[ids[0]].f, fhi = modes[ids[ids.length - 1]].f, fc0 = Math.sqrt(flo * fhi), bw = washy && pcW !== 'hihat' && pcW !== 'stack' ? Math.max(fc0 * 0.12, 0.5 * (fhi - flo)) : Math.max(fc0 * 0.25, fhi - flo);   // cymbals: a narrower band hugging its partials, so the wash shimmers with the metal instead of hissing beside it
      var w0 = TAU * Math.min(0.45 * this.sr, fc0) / this.sr, Q = Math.max(0.6, fc0 / bw), al = Math.sin(w0) / (2 * Q);
      var b0 = al / (1 + al), a1 = -2 * Math.cos(w0) / (1 + al), a2 = (1 - al) / (1 + al);
      // measure the filter's noise gain once, so the envelope maps to rms directly
      var z1 = 0, z2 = 0, acc = 0, seed = 99;
      for (var t = 0; t < 4096; t++) { seed = (seed * 1664525 + 1013904223) >>> 0; var xn = seed / 2147483648 - 1, y = b0 * xn + z1; z1 = -a1 * y + z2; z2 = -b0 * xn - a2 * y; if (t > 512) acc += y * y; }
      var norm = 1 / Math.sqrt(acc / 3583 + 1e-12);
      var grp = { ids: Int32Array.from(ids), b0: b0, a1: a1, a2: a2, norm: norm, zC: [0, 0], zL: [0, 0], zR: [0, 0], eC: 0, eL: 0, eR: 0, tC: 0, tL: 0, tR: 0, osc: null };
      if (washy) {
        // a real cymbal's wash is not noise: it is thousands of steady, irregularly spaced partials (a recorded ride shows
        // ~30 sharp spectral lines per kHz). Noise fluctuates fast and reads as hiss / rice / cicadas; a cloud of steady
        // sine partials (random frequencies across this band, ~a dozen per kHz) shimmers and beats slowly like the metal.
        var bk = bKeys[gI], eLo = 200 * Math.pow(2, bk / 2), eHi = Math.min(0.45 * this.sr, 200 * Math.pow(2, (bk + 1) / 2));
        var lightQ = model.cfg.special.quality === 'light' || model.cfg.lite, dens = lightQ ? 8 : 20, Kmx = lightQ ? 14 : 40;
        var K = Math.max(lightQ ? 4 : 7, Math.min(Kmx, Math.round(dens * (eHi - eLo) / 1000)));   // (low bands are narrow in Hz but still need several lines, or a few pure tones stand out)
        var tpl = model.top || {}, cSeed = Math.round(((tpl.a || 0) * 997 + (tpl.heff || 0) * 7.3e4 + modes.length * 13) % 9973);   // every cymbal gets its own set of wash pitches
        if (eHi > eLo * 1.05) {
          var oc = new Float64Array(K), os = new Float64Array(K), ox = new Float64Array(K), oy = new Float64Array(K), wA = new Float64Array(K), wB = new Float64Array(K), sA = 0, sB = 0;
          for (var ko = 0; ko < K; ko++) {
            var fo = eLo + (eHi - eLo) * (ko + 0.15 + 0.7 * hash(bk * 131 + ko + cSeed, 91)) / K, wo = TAU * fo / this.sr, ph = TAU * hash(bk * 131 + ko, 92);
            oc[ko] = Math.cos(wo); os[ko] = Math.sin(wo); ox[ko] = Math.cos(ph); oy[ko] = Math.sin(ph);
            wA[ko] = 0.3 + 0.7 * hash(bk * 131 + ko, 93); wB[ko] = 0.3 + 0.7 * hash(bk * 131 + ko, 94); sA += wA[ko] * wA[ko]; sB += wB[ko] * wB[ko];
          }
          var nA = Math.sqrt(2 / sA), nB = Math.sqrt(2 / sB); for (var ko2 = 0; ko2 < K; ko2++) { wA[ko2] *= nA; wB[ko2] *= nB; }
          var nSh = pcW === 'ride' ? RTn('nSh', 0.5) : pcW === 'china' || pcW === 'trash' ? 0.5 : pcW === 'hihat' ? RTn('hhN', 0.85) : pcW === 'stack' ? 0.5 : 0.45;   // recordings: a crash's lines stand ~16 dB over the floor between them, a ride's ~22 dB
          grp.osc = { K: K, c: oc, s: os, x: ox, y: oy, wA: wA, wB: wB, kc: Math.sqrt(1 - nSh), kn: Math.sqrt(nSh) };
        }
      }
      groups.push(grp);
      for (var k2 = 0; k2 < ids.length; k2++) { var ii = ids[k2]; this.pW = this.pW || {}; }
    }
    this.pGroups = groups; this.pOC = new Float64Array(N); this.pOL = new Float64Array(N); this.pOR = new Float64Array(N);
    var pc = model.piece, tone = pc === 'hihat' || pc === 'stack' ? 0.08 : pc === 'china' || pc === 'trash' ? 0.3 : pc === 'ride' ? RTn('tone', 0.55) : pc === 'crash' || pc === 'splash' ? 0.45 : ['tamtam', 'opera', 'nipple'].indexOf(pc) >= 0 ? 0.85 : 0.8;   // the partials now drift, so they can carry more of the wash without whistling
    if (model.cfg.special.quality === 'light' && pc !== 'hihat' && pc !== 'stack') tone *= 0.8;   // light: fewer, wider proxies -> lean a little more on the noise rendering
    // a proxy is ONE line standing in for a whole band of real partials. Where proxies sit far apart (a thick ride's top
    // octave: one every ~200 Hz) a few strong proxy tones beat against each other at 150-400 Hz: that periodic flutter
    // was the 'wire / cicada' buzz. Sparse proxies therefore go almost entirely into the wash; dense ones may stay tonal.
    var pxGap = {}, pxl = []; for (var ipx = 0; ipx < N; ipx++) if (modes[ipx].ms === 'proxy' && this.w2[ipx]) pxl.push(ipx);
    pxl.sort(function (x, y) { return modes[x].f - modes[y].f; });
    for (var jp = 0; jp < pxl.length; jp++) { var gl = jp > 0 ? modes[pxl[jp]].f - modes[pxl[jp - 1]].f : 1e9, gr2 = jp + 1 < pxl.length ? modes[pxl[jp + 1]].f - modes[pxl[jp]].f : 1e9; pxGap[pxl[jp]] = Math.min(gl, gr2) < 1e8 ? Math.min(gl, gr2) : 0; }
    var kt = Math.sqrt(tone), kn = Math.sqrt(1 - tone);   // energy split: ringing partials vs shaped noise
    this.oD = new Float64Array(N); this.dingE = 0; this.dingK = Math.exp(-1 / ((model.piece === 'ride' ? RTn('dingT', 0.1) : 0.035) * this.sr));
    for (var gq = 0; gq < groups.length; gq++) for (var k3 = 0; k3 < groups[gq].ids.length; k3++) { var i8 = groups[gq].ids[k3]; if (modes[i8].ms !== 'proxy') { kt = Math.sqrt(this.wTone[i8]); kn = Math.sqrt(1 - this.wTone[i8]); } else { var tP = washy && pcW !== 'hihat' && pcW !== 'stack' ? tone * 0.0 : tone; /* a proxy stands for a whole band of partials: as one sine it is far too strong and beats against its neighbours (the wire/cicada flutter); cymbals render it as wash */ kt = Math.sqrt(tP); kn = Math.sqrt(1 - tP); } var cymT = washy && pcW !== 'hihat' && pcW !== 'stack', fq = modes[i8].f, hsT = cymT && fq > 2500 ? Math.pow(fq / 2500, pcW === 'ride' ? -0.7 : -RTn('cHs', 0.35) - (model.dark || 0)) : 1, nsT = cymT && fq > 1000 ? Math.pow(fq / 1000, pcW === 'ride' ? -RTn('nsE', 0.3) : -RTn('cNs', 0.4) - (model.dark || 0)) : 1;
      var eqW = cymT || (pcW === 'hihat' && RTn('hhEqOn', 1)) ? cymEq(fq, pcW) : 1; hsT *= eqW;
      var full = this.oC[i8] * hsT; kn *= hsT * nsT; kt *= hsT;   // (the wash sits lower than the ringing: dark, smooth, not a hiss on top)
      if (cymT && modes[i8].ms !== 'proxy') this.oD[i8] = this.oC[i8] * hsT * (1 - Math.sqrt(this.wTone[i8]));
      else if (cymT && pcW === 'ride' && RTn('dingP', 2.6)) this.oD[i8] = 0;   // the 'ding': these partials ring out as tone for a moment after the stick lands
         // (cymbal wash: ease the top so it shimmers rather than hisses)
      this.pOC[i8] = this.oC[i8] * kn; this.pOL[i8] = this.oHL[i8] * kn; this.pOR[i8] = this.oHR[i8] * kn; this.oC[i8] *= kt; this.oHL[i8] *= kt; this.oHR[i8] *= kt; }
    if (pcW === 'ride' && RTn('washG', 0.6) !== 1) { var wg = RTn('washG', 0.6), wgF = RTn('washHiF', 0); for (var iw = 0; iw < N; iw++) { if (modes[iw].f < wgF) continue; this.pOC[iw] *= wg; this.pOL[iw] *= wg; this.pOR[iw] *= wg; } }
    // the bell (cup) of a crash/ride: a stick on the bell should ping a few dB over a bow stroke, not drown the kit
    if (washy && pcW !== 'hihat' && pcW !== 'stack') for (var ic2 = 0; ic2 < N; ic2++) if (modes[ic2].cup) { var cuK = pcW === 'ride' ? RTn('cuK', 0.55) : 0.2; this.oC[ic2] *= cuK; this.oHL[ic2] *= cuK; this.oHR[ic2] *= cuK; }
    if (washy && pcW !== 'hihat' && pcW !== 'stack') for (var iq = 0; iq < N; iq++) { var mq = modes[iq]; if (mq.ms === 'plate' && mq.f <= 100 && this.w2[iq]) { var eqq = cymEq(mq.f, pcW); this.oC[iq] *= eqq; this.oHL[iq] *= eqq; this.oHR[iq] *= eqq; } }
    this.nseed = 4242; this.gHP = 1 - Math.exp(-TAU * 1600 / this.sr); this.gLP = 1 - Math.exp(-TAU * 6000 / this.sr); this.gSzH = 1 - Math.exp(-TAU * RTn('hhSzH', 4000) / this.sr); this.gSzL = 1 - Math.exp(-TAU * Math.min(0.45 * this.sr, RTn('hhSzL', 14000)) / this.sr);
    // energy cascade bands (wave-turbulence "bloom"): plate modes grouped into log-frequency bands
    var fmin = Infinity, fmx = 0; for (var i6 = 0; i6 < N; i6++) if (modes[i6].ms === 'plate' && this.w2[i6]) { fmin = Math.min(fmin, modes[i6].f); fmx = Math.max(fmx, modes[i6].f); }
    var NBD = 10, bands = []; for (var bb = 0; bb < NBD; bb++) bands.push([]);
    for (var i7 = 0; i7 < N; i7++) {
      var mm = modes[i7]; if (!((mm.ms === 'plate' || mm.ms === 'proxy') && this.w2[i7])) continue;
      var bi = Math.floor(NBD * Math.log(mm.f / fmin) / Math.log(fmx / fmin * 1.0001)); bands[Math.max(0, Math.min(NBD - 1, bi))].push(i7);
    }
    this.bands = bands.filter(function (b) { return b.length; }).map(function (b) { return Int32Array.from(b); });
    this.mcap = model.pair ? 1e9 : ['tamtam', 'opera', 'nipple'].indexOf(model.piece) >= 0 ? 0.5 : 0.04;   /* (a stack's pressed plates sit pre-bent: capping their stiffening shifts that rest shape and sets them buzzing) */   // gongs keep their big pitch bends (that IS their sound); cymbals: at most ~2%
    this.cascK = 3000 * model.bloom * (model.piece === 'tamtam' ? 0.3 : model.piece === 'china' ? 1.6 : model.piece === 'ride' ? 0.5 : 1);
    this.h2inv = 1 / (model.top.heff * model.top.heff); this.cascN = 0;
    if (!same) { this.q = A(); this.v = A(); this.mallets = []; this.pulses = []; }
    this.bloomA = model.pair ? 0.03 : 0.0012;
    this.washRel = model.piece === 'hihat' ? RTn('hhRel', 0.0015) : 0.03;   /* an open hat's sizzle hangs on while the plates keep brushing each other: its wash lets go slowly */   // hats/stacks: their sound IS the clash wash, and a closed hat is over in tens of ms: no bloom delay
    this.q0 = null; this.narrow = model.piece === 'hihat' || model.piece === 'stack' ? 0.5 : 0;
    this.needSettle = !same && model.pair;
    this.S = this.S || 0; this.P = this.P || 0; this.ru = this.ru || 0; this.ruv = this.ruv || 0; this.chk = this.chk || 0; this.chkT = this.chkT || 0;
    // rattlers (sizzle rivets / chain)
    var nr = model.rivets + (model.chain ? 1 : 0);
    this.rat = null;
    if (nr > 0) {
      var ps = A(), K = Math.max(1, model.rivets || 3);
      for (var j = 0; j < model.nTop; j++) { var s = 0; for (var kk = 0; kk < K; kk++) s += metalShape(modes[j], 0.88, TAU * kk / K + 0.2); ps[j] = modes[j].w * this.dt > 0.8 ? 0 : s / Math.sqrt(K); }   // (like the hat contacts: modes near the integrator's limit stay out of the rattle loop)
      var Yr = 0; for (var j2 = 0; j2 < N; j2++) Yr += ps[j2] * ps[j2] * this.invM[j2];
      var chain = model.chain;
      this.rat = { psi: ps, Y: Yr, lvl: Math.min(1.5, 0.35 + 0.1 * model.rivets) + (chain ? 0.6 : 0), m: chain ? 0.004 : 0.0006, gap: chain ? 0.0004 : 0.00008,
        kc: 4e5, w: [{ y: 0, v: 0, Fp: 0 }, { y: 0, v: 0, Fp: 0 }, { y: 0, v: 0, Fp: 0 }], env: 0, fc: chain ? 2500 : 6500, s1: 0, s2: 0, chain: chain };
    }
    // hi-hat / stack contacts between top and bottom plates
    this.hh = null;
    if (model.pair) {
      var hh = model.hh, KP = 4, pts = [];
      for (var p = 0; p < KP; p++) {
        var th = TAU * p / KP + 0.4, pt = A(), pb = A(), Y = 0;
        for (var i3 = 0; i3 < N; i3++) { var mdd = modes[i3], val = metalShape(mdd, 0.97, th); if (mdd.ms === 'proxy' || mdd.w * dt > 0.8) val = 0; if (mdd.which === 0) pt[i3] = val; else pb[i3] = val; Y += val * val * this.invM[i3]; }
        var dd = A(); for (var i4 = 0; i4 < N; i4++) dd[i4] = pt[i4] - pb[i4];
        pts.push({ d: dd, pt: pt, pb: pb, Y: Y, tilt: hh.tilt * 1e-3 * Math.cos(th), F: 0, s: 0, sv: 0, sp: 0 });
      }
      var cps = A(); for (var p2 = 0; p2 < 6; p2++) { var th2 = TAU * p2 / 6 + 0.2; for (var i9 = 0; i9 < N; i9++) { var v9 = metalShape(modes[i9], 0.97, th2); cps[i9] += modes[i9].w * dt > 0.8 ? 0 : (modes[i9].which === 0 ? v9 : -v9) / 6; } }
      this.clashPsi = cps;
      var cl0 = []; for (var ic = 0; ic < N; ic++) if (pts[0].d[ic] || pts[1].d[ic] || pts[2].d[ic] || pts[3].d[ic]) cl0.push(ic);
      var cIdx = Int32Array.from(cl0);   // only these modes touch the hi-hat contacts
      var mt = model.top.mass, fp = 18 + 40 * hh.clutch;
      this.hh = { cIdx: cIdx, cd: 2 * Math.sqrt(2.5e6 * mt) * 0.25, pts: pts, mt: mt, kp: mt * Math.pow(TAU * fp, 2), cz: 2 * mt * TAU * fp * (0.25 + 0.4 * hh.clutch), z: this.hh0 ? this.hh0.z : (model.piece === 'stack' ? -(0.4 + 1.2 * hh.press) * 1e-3 : Math.pow(hh.open, 3) * hh.gap * 1e-3), vz: 0,
        gap: hh.gap * 1e-3, pre: (model.piece === 'stack' ? 0.4 + 1.2 * hh.press : 0.15) * 1e-3, open: model.piece === 'stack' ? 0 : hh.open, target: 0, kc: 2.5e6, stack: model.piece === 'stack' };
      this.hh.target = this.hh.open; if (this.hh.stack && this.FhPrev == null) this.FhPrev = 1;
      this.hh0 = this.hh;
    }
    this.bow = this.bow && this.bow.on ? this.bow : null;
  };
  MetalCore.prototype.cascade = function (dtb) {
    var B = this.bands, q = this.q, v = this.v, w2 = this.w2, nb = B.length; if (nb < 2 || !this.cascK) return;
    // nonlinearity measure: mean-square displacement of the plate relative to its thickness
    var sq = 0, cnt = 0, E = this.bE || (this.bE = new Float64Array(nb));
    for (var b = 0; b < nb; b++) { var e = 0, idx = B[b]; for (var j = 0; j < idx.length; j++) { var i = idx[j], vv0 = v[i] * v[i]; e += 2 * vv0; sq += vv0 / w2[i]; } E[b] = e; cnt += idx.length; }   // vibration only (ignores static deflection)
    var eps = sq / cnt * this.h2inv * (this.model.piece === 'hihat' ? RTn('hhEps', 40) : 15); this.lastEps = eps; if (eps < 1e-7) return;
    var rate = this.cascK * eps / (1 + eps) * dtb; if (rate > 0.4) rate = 0.4;
    for (var b2 = nb - 2; b2 >= 0; b2--) {
      var Eb = E[b2]; if (Eb <= 1e-30) continue;
      var dE = Eb * rate * 0.5, keep = Math.sqrt(Math.max(0, 1 - 2 * dE / Eb)), lo = B[b2], hi = B[b2 + 1];
      for (var j2 = 0; j2 < lo.length; j2++) { var i2 = lo[j2]; v[i2] *= keep; }
      var per = dE / hi.length;               // inject into the next band up as velocity, conserving energy
      for (var j3 = 0; j3 < hi.length; j3++) {
        var i3 = hi[j3], vv = v[i3], sgn = vv !== 0 ? (vv > 0 ? 1 : -1) : (((i3 * 2654435761) >>> 0) & 1 ? 1 : -1);
        v[i3] = sgn * Math.sqrt(vv * vv + per * 0.5);
      }
      E[b2 + 1] += dE;
    }
  };
  MetalCore.prototype.diffuse = function () {
    var L = this.jL, G = this.jG, C0 = this.jC[0], C1 = this.jC[1], C2 = this.jC[2], C3 = this.jC[3], D = this.jD, J = this.jit, N = this.N;
    for (var k = 0; k < 4; k++) { this.jSeed = (this.jSeed * 1664525 + 1013904223) >>> 0; var wn = this.jSeed / 2147483648 - 1; L[k] += G[k] * (wn * 1.73 * Math.sqrt((2 - G[k]) / G[k]) - L[k]); }
    var e = this.lastEps || 0, amp = 0.35 + 1.6 * e / (e + 0.02);   // a floor (dense mode clusters) plus amplitude-driven broadening
    this.jAmp += 0.05 * (amp - this.jAmp);
    var a = this.jAmp, l0 = L[0] * a, l1 = L[1] * a, l2 = L[2] * a, l3 = L[3] * a;
    var S = this.jS;   // ramp each partial's detune over the next 32 samples (stepping it would add zipper sidebands)
    for (var i = 0; i < N; i++) { var d = D[i]; if (!d) continue; J[i] += 32 * S[i]; S[i] = (d * (C0[i] * l0 + C1[i] * l1 + C2[i] * l2 + C3[i] * l3) - J[i]) / 32; }
  };
  MetalCore.prototype.bedEnv = function () {
    var G = this.pGroups, v = this.v, q = this.q, w2 = this.w2, oc = this.pOC, ol = this.pOL, orr = this.pOR;
    // a free cymbal: the partials' full vibration energy (steady, so the wash is smooth, not grainy). a pressed pair
    // (closed hat, stack): motion only, since its static bend is not sound and must not become a constant hiss
    var pairB = !!this.model.pair;
    for (var g = 0; g < G.length; g++) {
      var gr = G[g], c = 0, l = 0, r = 0;
      for (var k = 0; k < gr.ids.length; k++) { var i = gr.ids[k], e = pairB ? v[i] * v[i] : 0.5 * (v[i] * v[i] + w2[i] * q[i] * q[i]); c += oc[i] * oc[i] * e; l += ol[i] * ol[i] * e; r += orr[i] * orr[i] * e; }
      gr.tC = Math.sqrt(c); gr.tL = Math.sqrt(l); gr.tR = Math.sqrt(r);
    }
  };
  MetalCore.prototype.settle = function () {   // let a pressed pair find its static deflection silently
    var n = Math.round(0.25 * this.sr), tmp = new Float32Array(32), tmp2 = null, v = this.v;
    this.q0 = new Float64Array(this.q.length);
    for (var o = 0; o < n; o += 32) { this.process(tmp, 32); this.q0.set(this.q); for (var i = 0; i < v.length; i++) v[i] *= 0.4; this.hh.vz *= 0.4; this.hhEnv = 0; }   // heavily damped relaxation: reach the static deflection, keep none of the ringing
    this.v.fill(0); this.pulses = []; this.hhEnv = 0; this.hh.vz = 0; this.cascN = 0; this.q0.set(this.q); if (!this.hh.stack) this.q0 = null;   // only a stack stays pressed: a hat's pedal moves its static shape
    var n2 = Math.round(0.6 * this.sr); for (var o2 = 0; o2 < n2; o2 += 256) this.process(tmp2 || (tmp2 = new Float32Array(256)), 256);   // then let what's left ring out, unheard
    this.pulses = []; this.hhEnv = 0;
    if (this.pGroups) this.pGroups.forEach(function (g) { g.eC = g.eL = g.eR = g.tC = g.tL = g.tR = 0; });
  };
  MetalCore.prototype.setChoke = function (x) { this.chkT = Math.max(0, Math.min(1, x)); };
  MetalCore.prototype.pedalSplash = function (reopen) {
    if (!this.hh || this.hh.stack) return; this.hh.target = 0; this.hh.splash = { reopen: reopen, cd: -1 }; this.sinceHit = 0; this.parked = false;
  };
  MetalCore.prototype.setPedal = function (open) { if (this.hh && !this.hh.stack) { this.hh.target = Math.max(0, Math.min(1, open)); this.sinceHit = 0; this.parked = false; } };
  MetalCore.prototype.makePsi = function (r, th, rc, edgeBoost) {
    var md = this.model.modes, out = new Float64Array(this.N);
    for (var i = 0; i < this.N; i++) { if (md[i].which) continue; out[i] = metalShape(md[i], r, th) * Math.exp(-Math.pow(md[i].k * rc, 2) / 8) * (edgeBoost ? 1 + edgeBoost * r : 1); }
    return out;
  };
  MetalCore.prototype.strike = function (r, th, vel, mode, mlOverride) {
    this.sinceHit = 0; this.parked = false;
    this.dingE = 1;
    if (!this.model) return;
    var ml = mlOverride || this.model.mallet, shoulder = mode === 'shoulder';
    var mass = ml.mass * (shoulder ? 1.6 : 1), tau = ml.tau * TAUMET * (shoulder ? 1.5 : 1), rc = shoulder ? Math.max(0.015, ml.rc) : ml.rc;   // hard metal: only the striker tip compresses
    var v0 = ml.vmax * Math.pow(Math.max(0.01, Math.min(1, vel)), 1.3);
    var psi = this.makePsi(Math.min(0.995, r), th, rc, shoulder ? 0.6 : 0);
    var klin = mass * Math.pow(Math.PI / tau, 2), d0 = 3 * tau / Math.PI, kc = klin * Math.pow(d0, 1 - ml.alpha);
    var Y = 0, h = 0, hv = 0; for (var i = 0; i < this.N; i++) { Y += psi[i] * psi[i] * this.invM[i]; h += psi[i] * this.q[i]; hv += psi[i] * this.v[i]; }
    if (this.mallets.length > 1) this.mallets.shift();
    this.mallets.push({ psi: psi, Y: Y, y: h, v: v0, v0: v0, m: mass, kc: kc, al: ml.alpha, loss: Math.min(0.85, 2 * ml.lam), h: h, hv: hv, F: 0, life: 0 });
    this.lastML = ml;
  };
  MetalCore.prototype.addPulse = function (r, th, amp, dur, delay) {
    if (!this.model) return; this.pulses.push({ t: -(delay || 0), dur: dur, amp: amp, psi: this.makePsi(Math.min(0.99, r), th, 0.006) });
  };
  MetalCore.prototype.bowStart = function (r, th, vel) {
    this.bow = { on: true, psi: this.makePsi(0.995, th, 0.004, 0.3), N: 0.6 + 3.2 * vel, vb: 0.05 + 0.12 * vel, hv: 0, F: 0, amp: 0 };
  };
  MetalCore.prototype.bowPressure = function (vel) { if (this.bow) { this.bow.N = 0.6 + 3.2 * vel; } };
  MetalCore.prototype.bowStop = function () { if (this.bow) this.bow.on = false; };
  MetalCore.prototype.reset = function () { this.peEnv = 0;
    if (!this.q) return; this.q.fill(0); this.v.fill(0); this.mallets = []; this.pulses = []; this.S = 0; this.P = 0; this.bow = null;
    if (this.rat) this.rat.w.forEach(function (w) { w.y = 0; w.v = 0; w.Fp = 0; });
  };
  MetalCore.prototype.process = function (out, n, snap, comps, outR) {
    var md = this.model; if (!md) { for (var z = 0; z < n; z++) { out[z] = 0; if (outR) outR[z] = 0; } return; }
    // two plates in contact can lock into a faint self-sustaining chatter (stiff or mismatched plates). A real pair is
    // quiet long before this: once a stack has had 1.2 s (hats 3 s) with nothing new happening, bleed the motion away.
    if (md.pair && this.hh) {
      this.sinceHit = (this.sinceHit || 0) + n;
      var lim = (this.hh.stack ? 1.2 : 4) * this.sr;
      if (this.parked) { for (var zp = 0; zp < n; zp++) { out[zp] = 0; if (outR) outR[zp] = 0; } return; }
      if (this.sinceHit > lim + 0.6 * this.sr && !this.mallets.length && !this.pulses.length) {   // bled out: park at the resting shape until the next hit
        this.v.fill(0); if (this.q0) this.q.set(this.q0); this.parked = true; this.hhEnv = 0;
        if (this.pGroups) this.pGroups.forEach(function (g) { g.eC = g.eL = g.eR = g.tC = g.tL = g.tR = 0; });
        for (var zq = 0; zq < n; zq++) { out[zq] = 0; if (outR) outR[zq] = 0; } return;
      }
      if (this.sinceHit > lim && !this.mallets.length && !this.pulses.length) {
        var fd = Math.exp(-n / ((this.hh.stack ? 0.2 : 0.5) * this.sr)), Q0d = this.q0;
        for (var zi = 0; zi < this.N; zi++) { this.v[zi] *= fd; if (Q0d) this.q[zi] = Q0d[zi] + (this.q[zi] - Q0d[zi]) * fd; }   // (velocity only for hats: their pressed shape is real)
        this.hhEnv = (this.hhEnv || 0) * fd;
      }
    }
    var N = this.N, q = this.q, v = this.v, w2 = this.w2, a2 = this.a2, invM = this.invM, chW = this.chW, ck = this.ck, sk = this.sk, qs = this.qs;
    var oD = this.oD, oC = this.oC, oHL = this.oHL, oHR = this.oHR, mal = this.mallets, pulses = this.pulses, dt = this.dt, rat = this.rat, hh = this.hh, bow = this.bow;
    var qScale = this.qScale, qB = this.qB, mics = this.mics, mmx = this.mmx, hhW = this.hhW, jit = this.jit, jS = this.jS;
    var fsv = rat ? 2 * Math.sin(Math.PI * Math.min(0.24, rat.fc / this.sr)) : 0;
    for (var s = 0; s < n; s++) {
      if ((++this.cascN & 31) === 0) { this.cascade(32 * dt); this.bedEnv(); if (this.jOn) this.diffuse(); }
      var jp = this.cascN & 31;
      // pulses (brush bristles)
      var npl = 0, plF = this.plF || (this.plF = []), plP = this.plP || (this.plP = []);
      for (var pi = pulses.length - 1; pi >= 0; pi--) {
        var P_ = pulses[pi]; P_.t += dt; if (P_.t < 0) continue;
        if (P_.t >= P_.dur) { pulses.splice(pi, 1); continue; }
        plF[npl] = P_.amp * Math.sin(Math.PI * P_.t / P_.dur); plP[npl] = P_.psi; npl++;
      }
      var chk = this.chk = this.chk + (this.chkT - this.chk) * 0.002;
      var clamp = 0;
      if (hh) {   // closed / nearly-closed hats: the two cymbals clamp each other (low modes die almost instantly)
        clamp = hh.z <= 0 ? 0.6 + 0.4 * Math.min(1, -hh.z / Math.max(1e-5, hh.pre)) : 0.5 * Math.exp(-Math.min(hh.z, 0.0003) / 0.0006) * Math.exp(-Math.max(0, hh.z - 0.0003) / 0.00025);   /* nearly closed: clamped; once properly apart (half-open) the plates are free to ring and sizzle */   // damping rises smoothly as the cymbals approach
        if (hh.stack) clamp *= 0.17;
        if (hh.splash) clamp *= 0.15;   // foot splash: the cymbals smack and part before the clamp can choke them
        this.clampS = clamp;
      }
      // nonlinear stretching: stiffness modulation (cubic) + quadratic curvature coupling
      var Sg = this.S, Ps = this.P, quad = qB * Ps * Ps;   // conservative cubic potential (curvature) + quartic (stretching)
      // rattlers
      var Frat = 0;
      if (rat) {
        var u = this.ru + this.ruv * dt;
        for (var wi = 0; wi < 3; wi++) {
          var Wr = rat.w[wi], dl = u - (Wr.y + Wr.v * dt), Fc = 0;
          if (dl > 0) Fc = rat.kc * dl / (1 + rat.kc * dt * dt * (rat.Y * 3 + 1 / rat.m));
          var acc0 = (Fc - rat.m * 9.8) / rat.m - 4 * Wr.v;
          if (Wr.y < -rat.gap && Wr.v < 0) { Wr.v = -Wr.v * 0.3; Wr.y = -rat.gap; }
          Wr.v += acc0 * dt; Wr.y += Wr.v * dt;
          var dF = Fc - Wr.Fp; Wr.Fp = Fc; rat.env += (dF < 0 ? -dF : dF) * 0.4;
          Frat += Fc;
        }
        Frat = -Frat;
      }
      // bow friction (explicit, uses last point velocity)
      var Fb = 0;
      if (bow) {
        if (bow.on) { var vr = bow.vb - bow.hv, mu = 0.35 + 0.55 / (1 + Math.abs(vr) / 0.006); Fb = bow.N * mu * Math.tanh(vr / 0.002); bow.amp = Math.min(1, bow.amp + 0.0004); }
        else { bow.amp *= 0.995; Fb = 0; if (bow.amp < 1e-3) { this.bow = bow = null; } }
        if (bow) Fb *= bow.amp;
      }
      // ---- pass 1 ----
      var nm = mal.length, m0 = nm > 0 ? mal[0] : null, m1 = nm > 1 ? mal[1] : null, ps0 = m0 ? m0.psi : null, ps1 = m1 ? m1.psi : null;
      var h0 = 0, h1 = 0, hhOn = hh && hh.z < 0.006, pts = hh ? hh.pts : null;
      var s0 = 0, s1 = 0, s2 = 0, s3 = 0, d0 = hhOn ? pts[0].d : null, d1 = hhOn ? pts[1].d : null, d2 = hhOn ? pts[2].d : null, d3 = hhOn ? pts[3].d : null;
      var rpsi = rat ? rat.psi : null, bpsi = bow ? bow.psi : null, Q0 = this.q0, DMX = 0.5 / dt, MCAP = this.mcap;   // pressed pairs: drift/stiffening act on motion about the static shape
      for (var i = 0; i < N; i++) {
        var f = 0;
        for (var pk = 0; pk < npl; pk++) f += plF[pk] * plP[pk][i];
        if (rpsi) f += Frat * rpsi[i];
        if (bpsi) f += Fb * bpsi[i];
        var qi = q[i], mod = ck[i] * Sg + jit[i] + jS[i] * jp;
        if (mod > 0) { mod = mod * MCAP / (MCAP + mod); if (mod > mmx[i]) mod = mmx[i]; }   // amplitude stiffening: real plates only bend a partial's pitch a few % on a hard hit (it was reaching 30-100% on thin cymbals: a dirty, twangy smear) else if (mod < -0.03) { var mz = -mod / 0.6; mod = -0.6 * mz * (27 + mz * mz) / (27 + 9 * mz * mz); if (mod < -0.6) mod = -0.6; }   // cheap tanh (small negative detunes pass straight through)
        var Dm = a2[i] + chk * chW[i] + clamp * hhW[i]; if (Dm > DMX) Dm = DMX;   // explicit damping is only stable below ~1/dt: heavier damping is the same 'dead' anyway
        var ac = f * invM[i] - w2[i] * (qi + mod * (Q0 ? qi - Q0[i] : qi)) - Dm * v[i];
        var vi = v[i] + ac * dt; qi += vi * dt; v[i] = vi; q[i] = qi;
        if (ps0) h0 += ps0[i] * qi;
        if (ps1) h1 += ps1[i] * qi;
      }
      if (hhOn) { var cI = hh.cIdx; for (var ci = 0; ci < cI.length; ci++) { var jq = cI[ci], qq = q[jq]; s0 += d0[jq] * qq; s1 += d1[jq] * qq; s2 += d2[jq] * qq; s3 += d3[jq] * qq; } }
      // ---- contacts: mallets ----
      var F0 = 0, F1 = 0;
      for (var k = 0; k < nm; k++) {
        var M_ = mal[k], hp = k === 0 ? h0 : h1, F = 0;
        var del = M_.gone ? -1 : (M_.y + M_.v * dt) - hp;
        if (del > 0) {
          var ks = M_.kc * Math.pow(del, M_.al - 1);
          F = ks * del / (1 + ks * dt * dt * (M_.Y + 1 / M_.m));
          if (M_.v < 0) { var uu = Math.min(1, -M_.v / (0.2 * M_.v0)); F *= 1 - M_.loss * uu * uu * (3 - 2 * uu); }
        }
        if (F > 0) M_.hit = true; else if (M_.hit && M_.v <= 0) M_.gone = true;
        M_.F = F; M_.v -= F / M_.m * dt; M_.y += M_.v * dt; M_.life += dt;
        if (k === 0) F0 = F * dt; else F1 = F * dt;
      }
      // ---- contacts: hi-hat top vs bottom ----
      var Fh = null, Fsum = 0;
      if (hh) {
        var tgtZ = hh.stack ? -hh.pre : (hh.target * hh.target * hh.target * hh.gap - hh.pre * (1 - Math.min(1, hh.target * 6)));   // most pedal travel in the useful half-open range   // pedal travel -> gap on a curve (fine control near closed)
        var Fz = 0;
        if (hhOn) {
          pts[0].s = s0; pts[1].s = s1; pts[2].s = s2; pts[3].s = s3;
          Fh = this.Fh || (this.Fh = [0, 0, 0, 0]);
          for (var c2 = 0; c2 < 4; c2++) {
            var pt2 = pts[c2], sep = (hh.z + hh.vz * dt) + pt2.tilt + pt2.s, Fc2 = 0;
            if (sep < 0) {
              var Yt = 4 * (pt2.Y + 1 / hh.mt), sv = (sep - pt2.sp) / dt;   // 4 contacts share the plates & the rigid top: solve conservatively
              Fc2 = (hh.kc * (-sep) - hh.cd * sv) / (1 + (hh.kc * dt * dt + hh.cd * dt) * Yt);   // implicit spring-damper contact
              // (loss comes from the implicit damper above; a hard release factor caused a period-2 limit cycle)
              if (Fc2 < 0) Fc2 = 0;
            }
            pt2.sp = sep;
            Fh[c2] = Fc2 * dt; Fz += Fc2; Fsum += Fc2;
          }
        }
        var az = (-hh.kp * (hh.z - tgtZ) - hh.cz * hh.vz + Fz) / hh.mt;
        hh.vz += az * dt; hh.z += hh.vz * dt;
      }
      // ---- pass 2 ----
      var S2 = 0, P2 = 0, oc = 0, ol = 0, orr = 0, hv0 = 0, hv1 = 0, ru = 0, ruv = 0, bhv = 0, od = 0;
      if (Fh && (Fh[0] || Fh[1] || Fh[2] || Fh[3])) {   // hi-hat contact impulses: only the modes that touch
        var cJ = hh.cIdx, f0 = Fh[0], f1 = Fh[1], f2 = Fh[2], f3 = Fh[3];
        for (var cj = 0; cj < cJ.length; cj++) { var jj = cJ[cj], dvh = (f0 * d0[jj] + f1 * d1[jj] + f2 * d2[jj] + f3 * d3[jj]) * invM[jj]; v[jj] += dvh; q[jj] += dvh * dt; }
      }
      var anyF = F0 || F1, useP = qB !== 0;
      for (var i2 = 0; i2 < N; i2++) {
        var vi2 = v[i2], qi2 = q[i2];
        if (anyF) {
          var imp = F0 * (ps0 ? ps0[i2] : 0) + F1 * (ps1 ? ps1[i2] : 0);
          if (imp) { var dv = imp * invM[i2]; vi2 += dv; qi2 += dv * dt; v[i2] = vi2; q[i2] = qi2; }
        }
        S2 += sk[i2] * qi2 * qi2; if (useP) P2 += qs[i2] * qi2;
        oc += oC[i2] * vi2; ol += oHL[i2] * vi2; orr += oHR[i2] * vi2; od += oD[i2] * vi2;
        if (ps0) hv0 += ps0[i2] * vi2;
        if (ps1) hv1 += ps1[i2] * vi2;
        if (rpsi) { ru += rpsi[i2] * qi2; ruv += rpsi[i2] * vi2; }
        if (bpsi) bhv += bpsi[i2] * vi2;
      }
      if (m0) m0.hv = hv0; if (m1) m1.hv = hv1;
      if (bow) bow.hv = bhv;
      this.S = S2; this.P = P2; this.ru = ru; this.ruv = ruv;
      for (var k3 = mal.length - 1; k3 >= 0; k3--) { var Mr = mal[k3]; if (Mr.gone || Mr.life > 0.05) mal.splice(k3, 1); }
      // rattle sizzle noise
      var buzz = 0;
      if (rat) {
        this.noise ^= this.noise << 13; this.noise ^= this.noise >> 17; this.noise ^= this.noise << 5;
        var wn = (this.noise | 0) / 2147483648, lp = rat.s2 + fsv * rat.s1, hpn = wn - lp - 1.1 * rat.s1, bp = fsv * hpn + rat.s1; rat.s1 = bp; rat.s2 = lp;
        rat.env *= rat.chain ? 0.996 : 0.993; if (rat.env > 80) rat.env = 80;
        var rz = rat.env * rat.lvl * 0.02, cap = 0.8 * (this.peEnv || 0);   // sizzle rides on the plate's motion: never louder than the plate itself
        buzz = (rz > cap ? cap : rz) * bp;
      }
      // hi-hat clash noise (chick / sizzle) from contact force changes
      if (hh) {
        if (Fsum > 0 && !(this.FhPrev > 0) && hh.vz < 0) {
          this.hhEnv = (this.hhEnv || 0) + Math.min(8, -hh.vz * CHICK);   // cymbals meeting: the "chick"
          var vimp = Math.min(1.5, -hh.vz), dur0 = 0.00035;            // open-loop clash pulse into both cymbals (all modes)
          this.pulses.push({ t: 0, dur: dur0, amp: -Math.min(hh.mt, 0.9) * vimp * 1.2 * Math.PI / (2 * dur0) * 0.16, psi: this.clashPsi });
          if (hh.splash && hh.splash.cd < 0) hh.splash.cd = Math.round(0.01 * this.sr);
        }
        if (hh.splash && hh.splash.cd >= 0 && --hh.splash.cd < 0) { hh.target = hh.splash.reopen; hh.splash = null; }
        var dFh = Fsum - (this.FhPrev || 0); this.FhPrev = Fsum;
        this.Fav = (this.Fav || 0) + 0.002 * (Fsum - (this.Fav || 0));
        var imp = dFh - 0.35 * this.Fav - 6; if (imp < 0) imp = 0;   // only real impacts (rising force), not static-contact jitter
        this.hhEnv = (this.hhEnv || 0) * 0.9975 + imp * 2.5e-3;
        this.noise ^= this.noise << 13; this.noise ^= this.noise >> 17; this.noise ^= this.noise << 5;
        var wn2 = (this.noise | 0) / 2147483648; this.hhHP = (this.hhHP || 0) + this.gHP * (wn2 - (this.hhHP || 0));
        var hpn2 = wn2 - this.hhHP; this.hhHP2 = (this.hhHP2 || 0) + this.gLP * (hpn2 - (this.hhHP2 || 0));
        this.hhHP3 = (this.hhHP3 || 0) + this.gLP * (this.hhHP2 - (this.hhHP3 || 0));
        buzz += this.hhEnv * this.hhHP3 * 0.5;
        // half-open / loose hats: the plates keep brushing and tapping each other while they ring, a steady sizzle
        // riding on the plates' own ring (it lasts as long as they do) instead of a clamp that just chokes them
        if (!hh.stack && hh.z > 0.0003) { var hz = hh.z / RTn('hhSzZ', 0.003); if (hz < 1) { var prx = (1 - hz) * (1 - hz) * Math.min(1, (hh.z - 0.0003) / 0.0004);   /* (not when nearly closed: then the plates clamp, and the clash chick does the talking) */ var szx = wn2; this.szA = (this.szA || 0) + this.gSzH * (szx - (this.szA || 0)); var szh = szx - this.szA; this.szB = (this.szB || 0) + this.gSzL * (szh - (this.szB || 0));   /* its own brighter band: ~4-14 kHz, the airy top of an open hat */
            buzz += prx * RTn('hhSz', 0.45) * (this.peEnv || 0) * this.szB * 4; } }
      }
      var bC = 0, bL = 0, bR = 0, G = this.pGroups;
      for (var g = 0; g < G.length; g++) {
        var gr = G[g];
        // the wash blooms in over a few tens of ms (a real stroke starts as a stick ping; the dense wash builds as energy
        // spreads up the plate), and dies with the plate: the attack no longer starts as a burst of noise ('paper')
        var kA = gr.tC > gr.eC ? this.bloomA : this.washRel;
        gr.eC += (gr.tC - gr.eC) * kA; gr.eL += (gr.tL - gr.eL) * kA; gr.eR += (gr.tR - gr.eR) * kA;
        if (gr.eC + gr.eL + gr.eR < 1e-9) continue;
        var yA, yB, O = gr.osc;
        if (O) {   // partial cloud: K steady sines (rotations), two independent weightings for left/right
          var Oc = O.c, Os = O.s, Ox = O.x, Oy = O.y, OwA = O.wA, OwB = O.wB; yA = 0; yB = 0;
          for (var ko = 0; ko < O.K; ko++) { var xo = Ox[ko], yo = Oy[ko], cc = Oc[ko], ss = Os[ko], xn = xo * cc - yo * ss; Oy[ko] = xo * ss + yo * cc; Ox[ko] = xn; yA += OwA[ko] * xn; yB += OwB[ko] * xn; }
          // plus a share of band noise between the lines (real partials are not perfectly clean lines)
          this.nseed = (this.nseed * 1664525 + 1013904223) >>> 0; var m1 = this.nseed / 2147483648 - 1;
          this.nseed = (this.nseed * 1664525 + 1013904223) >>> 0; var m2 = this.nseed / 2147483648 - 1;
          var zA = gr.b0 * m1 + gr.zL[0]; gr.zL[0] = -gr.a1 * zA + gr.zL[1]; gr.zL[1] = -gr.b0 * m1 - gr.a2 * zA;
          var zB = gr.b0 * m2 + gr.zR[0]; gr.zR[0] = -gr.a1 * zB + gr.zR[1]; gr.zR[1] = -gr.b0 * m2 - gr.a2 * zB;
          yA = O.kc * yA + O.kn * gr.norm * zA; yB = O.kc * yB + O.kn * gr.norm * zB;
        } else {
          this.nseed = (this.nseed * 1664525 + 1013904223) >>> 0; var n1 = this.nseed / 2147483648 - 1;
          this.nseed = (this.nseed * 1664525 + 1013904223) >>> 0; var n2 = this.nseed / 2147483648 - 1;
          yA = gr.b0 * n1 + gr.zL[0]; gr.zL[0] = -gr.a1 * yA + gr.zL[1]; gr.zL[1] = -gr.b0 * n1 - gr.a2 * yA;
          yB = gr.b0 * n2 + gr.zR[0]; gr.zR[0] = -gr.a1 * yB + gr.zR[1]; gr.zR[1] = -gr.b0 * n2 - gr.a2 * yB;
          yA *= gr.norm; yB *= gr.norm;
        }
        bC += 0.5 * (yA + yB) * gr.eC * 1.41; bL += yA * gr.eL; bR += yB * gr.eR;
      }
      var aoc = Math.abs(oc) + Math.abs(bC) + 0.5 * (Math.abs(ol) + Math.abs(orr) + Math.abs(bL) + Math.abs(bR)); this.peEnv = (this.peEnv || 0) + (aoc > (this.peEnv || 0) ? 0.05 : 0.00012) * (aoc - (this.peEnv || 0));
      var dgo = od * this.dingE; this.dingE *= this.dingK;
      var yC = oc + buzz + bC + dgo, yl = mics.cL * yC + mics.oh * (ol + bL + buzz * 0.8 + 0.7 * dgo), yr = mics.cR * yC + mics.oh * (orr + bR + buzz * 0.8 + 0.7 * dgo);
      if (this.narrow) { var yM = 0.5 * (yl + yr), yS = 0.5 * (yl - yr) * this.narrow; yl = yM + yS; yr = yM - yS; }   // hats/stacks: keep the image mono-safe
      if (yl !== yl || yr !== yr || yl > 1e6 || yl < -1e6) { this.reset(); yl = yr = 0; }
      out[s] = yl; if (outR) outR[s] = yr;
      if (comps) { comps.B[s] = oc; comps.Z[s] = buzz; }
      if (snap && s % snap.every === 0 && snap.arr.length < snap.max) { var fr = new Float32Array(this.nB); for (var b = 0; b < this.nB; b++) fr[b] = q[b]; snap.arr.push(fr); }
    }
  };

  // ===================== PLAYER: techniques layer (rolls, brushes, bow, choke, pedal) =====================
  var BRUSH = { name: 'Brush (wire)', mass: 0.012, tau: 0.0009, alpha: 1.8, rc: 0.03, lam: 0.3, vmax: 4, ring: [], click: 0.02, brush: true };
  var BOW = { name: 'Bow (cymbals & gongs)', mass: 0.05, tau: 0.002, alpha: 2, rc: 0.004, lam: 0.3, vmax: 1, ring: [], click: 0, bow: true, metalOnly: true };
  MALLETS.brush = BRUSH; MALLETS.bow = BOW;

  function Player(sr) {
    this.sr = sr; this.core = null; this.model = null; this.rolls = {}; this.t = 0; this.rollRate = 14; this.seed = 1234;
    this.dcL = [0, 0, 0, 0, 0, 0, 0, 0]; this.dcR = [0, 0, 0, 0, 0, 0, 0, 0]; this.tL = [0, 0]; this.tR = [0, 0]; this.swish = 0; this.sw1 = 0; this.sw2 = 0; this.gain = 1;
    this.tmpL = new Float32Array(128); this.tmpR = new Float32Array(128); this.events = []; this.pedalBase = null;
    // output stage: 2nd-order Butterworth high-pass at 26 Hz (sub-rumble / DC), then a 1.5 ms look-ahead peak limiter
    var hpq = function (q) { var w0 = TAU * 30 / sr, cw = Math.cos(w0), al = Math.sin(w0) / (2 * q), a0 = 1 + al; return [(1 + cw) / 2 / a0, -(1 + cw) / a0, (1 + cw) / 2 / a0, -2 * cw / a0, (1 - al) / a0]; };
    this.hpA = hpq(0.5412); this.hpB = hpq(1.3066);   // 4th-order Butterworth subsonic filter at 30 Hz
    this.LA = Math.max(8, Math.round(sr * 0.0015)); this.laL = new Float32Array(this.LA); this.laR = new Float32Array(this.LA); this.laG = new Float32Array(this.LA).fill(1);
    this.laI = 0; this.laN = 0; this.lg = 1; this.kAtk = 1 - Math.exp(-4 / this.LA); this.kRel = 1 - Math.exp(-1 / (0.09 * sr)); this.CEIL = 0.93;
  }
  Player.prototype.rand = function () { this.seed = (this.seed * 1664525 + 1013904223) >>> 0; return this.seed / 4294967296; };
  Player.prototype.setModel = function (model) {
    var wantMetal = !!model.metal;
    if (!this.core || (this.core instanceof MetalCore) !== wantMetal) this.core = wantMetal ? new MetalCore(this.sr) : new Voice(this.sr);
    this.core.setModel(model); this.model = model; this.gain = model.gain || 1;
    if (this.core.needSettle) { this.core.needSettle = false; this.core.settle(); }
    var mix = model.mix || {}, tone = mix.tone == null ? 0.35 : mix.tone;
    this.shelfG = Math.pow(10, tone * 9 / 20) - 1; this.lowG = Math.pow(10, Math.max(0, tone) * 2 / 20) - 1;
    this.gT = 1 - Math.exp(-TAU * 1200 / this.sr); this.gL = 1 - Math.exp(-TAU * 90 / this.sr);
    this.rollRate = model.cfg.rollSpeed || this.rollRate || 14;
    if (this.pedalBase == null && model.metal && model.pair) this.pedalBase = model.hh.open;
    if (model.metal && model.pair && !model.cfg._keepPedal) { this.pedalBase = model.hh.open; if (!this.footDown) this.core.setPedal(this.pedalBase); }
  };
  Player.prototype.anyRoll = function () { for (var k in this.rolls) return true; return false; };
  Player.prototype.isBrush = function () { return !!(this.model && this.model.mallet && this.model.mallet.brush); };
  Player.prototype.isBow = function () { return !!(this.model && this.model.metal && this.model.mallet && this.model.mallet.bow); };
  // single hit (no hold)
  Player.prototype.strike = function (r, th, vel, mode) {
    if (!this.core) return;
    if (this.isBow()) { this.core.bowStart(r, th, vel); var self = this; this.events.push({ at: this.t + Math.round(0.6 * this.sr), fn: function () { self.core.bowStop(); } }); return; }
    if (this.isBrush()) { this.brushHit(r, th, vel); return; }
    this.core.strike(r, th, vel, mode);
  };
  Player.prototype.strikeTongue = function (i, vel) { if (this.core && this.core.strikeTongue) { if (this.isBrush()) { var t = this.tongueOf(i); if (t) this.brushHit(t.rb - 0.82 * t.ln, t.th, vel); } else this.core.strikeTongue(i, vel); } };
  Player.prototype.tongueOf = function (i) { return this.model && this.model.tongues && this.model.tongues.filter(function (x) { return x.idx === i; })[0]; };
  Player.prototype.brushHit = function (r, th, vel) {
    var a = this.model.a || 0.17, spread = 0.045 / a, nb = 9;
    for (var b = 0; b < nb; b++) {
      var rr = Math.max(0, Math.min(0.97, r + (this.rand() - 0.5) * spread * 2)), tt = th + (this.rand() - 0.5) * spread * 2 / Math.max(0.2, r);
      this.core.addPulse(rr, tt, 9 * vel * (0.4 + 0.6 * this.rand()), 0.0005 + 0.0006 * this.rand(), this.rand() * 0.007);
    }
    this.core.strike(r, th, vel * 0.5, 'head', BRUSH);
    this.swish += 0.35 * vel;
  };
  Player.prototype.noteOn = function (id, st) {
    if (!this.core) return;
    if (this.isBow()) { this.core.bowStart(st.r, st.theta || 0, st.vel); this.bowId = id; return; }
    if (this.model.cfg.roll) { this.rolls[id] = { st: st, lvl: 0.4 * st.vel, max: st.vel, next: this.t, hand: 0, ang: this.rand() * TAU }; return; }   // smart roll: starts soft, swells to the played velocity
    if (st.tongue != null) this.strikeTongue(st.tongue, st.vel); else this.strike(st.r, st.theta || 0, st.vel, st.mode);
  };
  Player.prototype.noteOff = function (id) {
    delete this.rolls[id];
    if (this.bowId === id && this.core.bowStop) { this.core.bowStop(); this.bowId = null; }
  };
  Player.prototype.pressure = function (id, v) {
    var hit = false;
    if (id != null && this.rolls[id]) { var Rp = this.rolls[id]; Rp.max = v; if (Rp.lvl > v) Rp.lvl = v; hit = true; }   // pressure moves the roll's ceiling
    else if (id == null) for (var k in this.rolls) { this.rolls[k].lvl = v; hit = true; }
    if (this.bowId != null && this.core.bowPressure) { this.core.bowPressure(v); hit = true; }
    if (!hit && this.model && this.model.metal) this.core.setChoke(v);
  };
  Player.prototype.choke = function (v) { if (this.core && this.core.setChoke) this.core.setChoke(v); };
  Player.prototype.cc = function (num, v) {
    if (num === 1) this.rollRate = 5 + v * 30;
    if (num === 4 && this.core && this.core.setPedal) { this.pedalBase = 1 - v; if (!this.footDown) this.core.setPedal(this.pedalBase); }
  };
  Player.prototype.pedal = function (kind) {
    if (!this.core || !this.core.setPedal) return;
    var self = this, base = this.pedalBase == null ? 0.2 : this.pedalBase;
    if (kind === 'down') { this.footDown = true; this.core.setPedal(0); }
    else if (kind === 'up') { this.footDown = false; this.core.setPedal(base); }
    else if (kind === 'chick') { this.core.setPedal(0); this.events.push({ at: this.t + Math.round(0.25 * this.sr), fn: function () { if (!self.footDown) self.core.setPedal(base); } }); }
    else if (kind === 'splash') { if (this.core.pedalSplash) this.core.pedalSplash(Math.max(base, 0.8)); }
    else if (typeof kind === 'number') { this.pedalBase = kind; if (!this.footDown) this.core.setPedal(kind); }
  };
  Player.prototype.reset = function () { if (this.core) this.core.reset(); this.rolls = {}; this.swish = 0; };
  Player.prototype.runRolls = function () {
    for (var id in this.rolls) {
      var R = this.rolls[id]; if (this.t < R.next) continue;
      var st = R.st, rate = this.rollRate, hand = R.hand = 1 - R.hand;
      var vel = Math.max(0.02, Math.min(1, R.lvl * (hand ? 0.92 : 1) * (0.9 + 0.2 * this.rand())));
      if (R.max != null) R.lvl += (R.max - R.lvl) * 0.2;   // each stroke a little harder, until it reaches the played level (~10 strokes)
      if (this.isBrush()) {          // swirl: bristles sweep around in a circle
        R.ang += 0.5; var rr = Math.max(0.1, Math.min(0.9, (st.r || 0.4) * 0.6 + 0.25 * (1 + Math.cos(R.ang)) * 0.5));
        this.core.addPulse(rr, R.ang, 3 * vel, 0.0008, 0); this.core.addPulse(rr, R.ang + 0.3, 2 * vel, 0.0008, 0.002);
        this.swish += 0.12 * vel; R.next = this.t + Math.round(this.sr / 90);
        continue;
      }
      var jr = (this.rand() - 0.5) * 0.04, jt = (this.rand() - 0.5) * 0.25;
      if (st.tongue != null) this.core.strikeTongue(st.tongue, vel);
      else this.core.strike(Math.max(0, Math.min(0.97, (st.r || 0) + jr)), (st.theta || 0) + jt, vel, st.mode === 'rimshot' ? 'head' : st.mode);
      R.next = this.t + Math.round(this.sr / rate * (0.92 + 0.16 * this.rand()));
    }
  };
  Player.prototype.process = function (outL, n, snap, comps, outR) {
    if (!this.core || (this.asleep && !comps && !snap)) { for (var z = 0; z < n; z++) { outL[z] = 0; if (outR) outR[z] = 0; } if (this.core) this.t += n; return; }
    var done = 0, BL = 32;
    while (done < n) {
      for (var e = this.events.length - 1; e >= 0; e--) if (this.events[e].at <= this.t) { var ev = this.events[e]; this.events.splice(e, 1); ev.fn(); }
      this.runRolls();
      var len = Math.min(BL, n - done);
      var L = this.tmpL.length >= len ? this.tmpL.subarray(0, len) : new Float32Array(len), R = this.tmpR.length >= len ? this.tmpR.subarray(0, len) : new Float32Array(len);
      var cs = comps ? { B: comps.B.subarray(done, done + len), R: comps.R.subarray(done, done + len), S: comps.S.subarray(done, done + len), H: comps.H.subarray(done, done + len), P: comps.P.subarray(done, done + len), A: comps.A.subarray(done, done + len), Z: comps.Z.subarray(done, done + len) } : null;
      this.core.process(L, len, snap, cs, R);
      for (var i = 0; i < len; i++) {
        var sw = 0;
        if (this.swish > 1e-5 && !(this.model && this.model._cal)) {
          this.seed = (this.seed * 1664525 + 1013904223) >>> 0; var wn = this.seed / 2147483648 - 1;
          this.sw1 += 0.26 * (wn - this.sw1); var hpn = wn - this.sw1; this.sw2 += 0.5 * (hpn - this.sw2); this.sw3 = (this.sw3 || 0) + 0.5 * (this.sw2 - (this.sw3 || 0));
          sw = this.sw3 * this.swish * 0.5 / (this.gain || 1); this.swish *= 0.9993;   // bristle "shh" (2-6 kHz) at a fixed output level, independent of the build's loudness
        }
        if (this.inKit) {   // inside a kit: tone + gain only; the kit filters and limits the sum once
          var tl = this.tL, tr = this.tR, xl = L[i] + sw, xr = R[i] + sw;
          tl[0] += this.gT * (xl - tl[0]); tl[1] += this.gL * (xl - tl[1]); tr[0] += this.gT * (xr - tr[0]); tr[1] += this.gL * (xr - tr[1]);
          var ol = (xl + this.shelfG * (xl - tl[0]) + this.lowG * tl[1]) * this.gain, or2 = (xr + this.shelfG * (xr - tr[0]) + this.lowG * tr[1]) * this.gain;
          if (ol !== ol || or2 !== or2) { this.reset(); ol = or2 = 0; }
          if (outR) { outL[done + i] = ol; outR[done + i] = or2; } else outL[done + i] = 0.5 * (ol + or2);
          var qk = this.quietThr || 1.5e-5; if ((ol < 0 ? -ol : ol) > qk || (or2 < 0 ? -or2 : or2) > qk) this.quietN = 0; else this.quietN++;
          continue;
        }
        var l = this.post(L[i] + sw, this.tL, this.dcL), r = this.post(R[i] + sw, this.tR, this.dcR);
        if (this.punch > 0) { var pgn = this.punchGain(l, r, this.punch); l *= pgn; r *= pgn; }
        // look-ahead limiter (stereo-linked): strong hits are caught cleanly instead of being clipped
        var al = l < 0 ? -l : l, ar = r < 0 ? -r : r, ap = al > ar ? al : ar, need = ap > this.CEIL ? this.CEIL / ap : 1;
        var li = this.laI, dl = this.laL[li], dr = this.laR[li];
        if (this.laG[li] < 1) this.laN--; if (need < 1) this.laN++;
        this.laL[li] = l; this.laR[li] = r; this.laG[li] = need; this.laI = li + 1 === this.LA ? 0 : li + 1;
        var gm = 1; if (this.laN > 0) { for (var q = 0; q < this.LA; q++) if (this.laG[q] < gm) gm = this.laG[q]; }
        if (gm < 1 || this.lg < 1) { this.lg += (gm < this.lg ? this.kAtk : this.kRel) * (gm - this.lg); if (this.lg > 0.99995) this.lg = 1; }
        l = this.soft(dl * this.lg); r = this.soft(dr * this.lg);
        if (outR) { outL[done + i] = l; outR[done + i] = r; } else outL[done + i] = 0.5 * (l + r);
        var qt = this.quietThr || 1.5e-5; if ((l < 0 ? -l : l) > qt || (r < 0 ? -r : r) > qt) this.quietN = 0; else this.quietN++;
      }
      done += len; this.t += len;
      // fully decayed and nothing pending: stop computing until the next stroke / pedal / control (saves CPU)
      if (this.quietN > 0.3 * this.sr && !this.events.length && !this.swish && !this.anyRoll() && !(this.core.mallets && this.core.mallets.length) && !(this.core.pulses && this.core.pulses.length) && !(this.core.bow && this.core.bow.on)) { this.asleep = true; for (var zz = done; zz < n; zz++) { outL[zz] = 0; if (outR) outR[zz] = 0; } this.t += n - done; return; }
    }
  };
  // punch: parallel compression done here (identical in the browser and the plugin). A copy squashed above
  // -18 dBFS (6:1, fast attack, 100 ms release) is blended under the dry
  // signal. Its lift on quiet tails is bounded (about +3 dB at 0.35, +8 dB at 1), so ringing tones keep their shape.
  Player.prototype.punchGain = function (l, r, pu) {
    if (!(pu > 0)) return 1;
    if (!this.pA) { this.pA = 1; /* instant attack: no overshoot */ this.pR = 1 - Math.exp(-1 / (0.1 * this.sr)); this.pE = 0; }
    var x = l < 0 ? -l : l, y = r < 0 ? -r : r; if (y > x) x = y;
    this.pE += (x > this.pE ? this.pA : this.pR) * (x - this.pE);
    var gc = this.pE > 0.126 ? Math.pow(this.pE / 0.126, -0.8333) : 1;
    return 1 / (1 + 0.15 * pu) + pu * 1.6 * gc;
  };
  Player.prototype.post = function (y0, ts, dc) {
    ts[0] += this.gT * (y0 - ts[0]); ts[1] += this.gL * (y0 - ts[1]);
    var y = y0 + this.shelfG * (y0 - ts[0]) + this.lowG * ts[1];
    var A = this.hpA, B = this.hpB;
    var y1 = A[0] * y + A[1] * dc[0] + A[2] * dc[1] - A[3] * dc[2] - A[4] * dc[3]; dc[1] = dc[0]; dc[0] = y; dc[3] = dc[2]; dc[2] = y1;
    var yo = B[0] * y1 + B[1] * dc[4] + B[2] * dc[5] - B[3] * dc[6] - B[4] * dc[7]; dc[5] = dc[4]; dc[4] = y1; dc[7] = dc[6]; dc[6] = yo;
    yo *= this.gain;
    if (yo !== yo || yo > 1e4 || yo < -1e4) { this.reset(); ts[0] = ts[1] = 0; for (var z = 0; z < 8; z++) dc[z] = 0; return 0; }
    return yo;
  };
  Player.prototype.soft = function (x) {   // final safety: transparent below 0.97, smooth knee to 1.0
    if (x > 0.97) return 0.97 + 0.03 * Math.tanh((x - 0.97) / 0.03);
    if (x < -0.97) return -0.97 - 0.03 * Math.tanh((-x - 0.97) / 0.03);
    return x;
  };


  ['setModel', 'strike', 'strikeTongue', 'brushHit', 'noteOn', 'noteOff', 'pressure', 'choke', 'cc', 'pedal', 'reset'].forEach(function (nm) {
    var f = Player.prototype[nm]; if (!f) return;
    Player.prototype[nm] = function () { this.asleep = false; this.quietN = 0; return f.apply(this, arguments); };
  });


  // ===================== KIT: several instruments, a note map of stroke slots, sympathetic coupling =====================
  // slot: { p: piece index, r, theta, mode, tongue, open (hi-hat openness before the hit), pedal ('chick'|'splash'|'down') }
  function Kit(sr) {
    this.sr = sr; this.pieces = []; this.map = {}; this.symp = 0.5; this.tL = new Float32Array(128); this.tR = new Float32Array(128);
    this.held = {};
  }
  Kit.prototype.setPiece = function (i, model, opts) {
    var pc = this.pieces[i] || (this.pieces[i] = { player: new Player(this.sr), level: 1, pan: 0, lp: 0, lpo: 0, drive: 0 });
    pc.player.quietThr = model.piece === 'stack' ? 4e-4 : 1.2e-4; pc.player.inKit = true;   // in a kit, a piece whose ring has fallen below about -78 dBFS is masked: let it sleep
    pc.player.setModel(model); pc.player.gain = model.gain || 1; if (pc.player.core) pc.player.core.kitMode = true;
    pc.level = opts && opts.level != null ? opts.level : pc.level; pc.pan = opts && opts.pan != null ? opts.pan : pc.pan;
    pc.drum = !model.metal; pc.hat = !!(model.metal && model.piece === 'hihat');
    pc.recv = model.snare && model.snare.on ? 0.5 : 1;   // a snared drum picks up less: its tight bottom head and the wires' preload resist small drive
  };
  Kit.prototype.setMix = function (i, level, pan) { var pc = this.pieces[i]; if (!pc) return; if (level != null) pc.level = level; if (pan != null) pc.pan = pan; };
  Kit.prototype.trim = function (n) { this.pieces.length = Math.min(this.pieces.length, n); };
  Kit.prototype.setMap = function (map) { this.map = map || {}; };
  Kit.prototype.slotOf = function (note) { var s = this.map[note]; return s && this.pieces[s.p] ? s : null; };
  Kit.prototype.noteOn = function (note, vel) {
    var s = this.slotOf(note); if (!s) return; var P_ = this.pieces[s.p].player;
    if (s.pedal) { P_.pedal(s.pedal); this.held[note] = s; return; }
    if (s.open != null && this.pieces[s.p].hat) P_.pedal(s.open);
    var st = { r: s.r, theta: s.theta || 0, vel: vel, mode: s.mode || 'head' };
    if (s.tongue != null) st = { tongue: s.tongue, vel: vel };
    P_.noteOn('n' + note, st); this.held[note] = s;
  };
  Kit.prototype.noteOff = function (note) {
    var s = this.held[note]; delete this.held[note]; if (!s || !this.pieces[s.p]) return;
    var P_ = this.pieces[s.p].player;
    if (s.pedal === 'down') P_.pedal('up'); else P_.noteOff('n' + note);
  };
  Kit.prototype.pressure = function (note, v) {   // poly aftertouch: chokes / swells the piece that note plays
    if (note == null) { this.pieces.forEach(function (pc) { pc.player.pressure(null, v); }); return; }
    var s = this.slotOf(note); if (s) this.pieces[s.p].player.pressure('n' + note, v);
  };
  Kit.prototype.choke = function (i, v) { var pc = this.pieces[i]; if (pc) pc.player.choke(v); };
  Kit.prototype.cc = function (num, v) { this.pieces.forEach(function (pc) { if (num !== 4 || pc.hat) pc.player.cc(num, v); }); };
  Kit.prototype.reset = function () { this.pieces.forEach(function (pc) { pc.player.reset(); pc.lp = pc.lpo = pc.drive = 0; }); this.held = {}; };
  Kit.prototype.process = function (L, n, R) {
    for (var z = 0; z < n; z++) { L[z] = 0; R[z] = 0; }
    var done = 0, BL = 64, ps = this.pieces, np = ps.length, g = 1 - Math.exp(-TAU * 160 / this.sr);
    while (done < n) {
      var len = Math.min(BL, n - done), tL = this.tL.subarray(0, len), tR = this.tR.subarray(0, len);
      // sympathy: each drum's head is pushed by the low-frequency sound of the others (one block late)
      var tot = 0; for (var a = 0; a < np; a++) tot += ps[a].drive;
      for (var i = 0; i < np; i++) {
        var pc = ps[i], P_ = pc.player;
        if (pc.drum && P_.core) {
          var ext = this.symp * 26 * pc.recv * (tot - pc.drive);
          P_.core.extP = ext;
          if ((ext > 0.15 || ext < -0.15) && P_.asleep) { P_.asleep = false; P_.quietN = 0; }
        }
        P_.process(tL, len, null, null, tR);
        var pn = Math.max(-1, Math.min(1, pc.pan)), gl = pc.level * Math.cos((pn + 1) * Math.PI / 4) * Math.SQRT2, gr = pc.level * Math.sin((pn + 1) * Math.PI / 4) * Math.SQRT2;
        var lp = pc.lp, acc = 0;
        for (var k = 0; k < len; k++) {
          var l = tL[k], r = tR[k]; L[done + k] += l * gl; R[done + k] += r * gr;
          lp += g * (0.5 * (l + r) - lp); acc += lp;
        }
        pc.lp = lp; pc.drive = pc.drum ? acc / len * pc.level : 0;
      }
      done += len;
    }
    // kit bus: one subsonic filter + one look-ahead limiter for the whole kit (each piece skips its own)
    var bus = this.bus; if (!bus) { bus = this.bus = new Player(this.sr); bus.shelfG = 0; bus.lowG = 0; bus.gT = 1 - Math.exp(-TAU * 1200 / this.sr); bus.gL = 1 - Math.exp(-TAU * 90 / this.sr); }
    bus.gain = this.out == null ? 0.75 : this.out;
    for (var q = 0; q < n; q++) {
      var l = bus.post(L[q], bus.tL, bus.dcL), r = bus.post(R[q], bus.tR, bus.dcR);
      if (this.punch > 0) { var pgk = bus.punchGain(l, r, this.punch); l *= pgk; r *= pgk; }
      var al = l < 0 ? -l : l, ar = r < 0 ? -r : r, ap = al > ar ? al : ar, need = ap > bus.CEIL ? bus.CEIL / ap : 1;
      var li = bus.laI, dl = bus.laL[li], dr = bus.laR[li];
      if (bus.laG[li] < 1) bus.laN--; if (need < 1) bus.laN++;
      bus.laL[li] = l; bus.laR[li] = r; bus.laG[li] = need; bus.laI = li + 1 === bus.LA ? 0 : li + 1;
      var gm = 1; if (bus.laN > 0) { for (var z2 = 0; z2 < bus.LA; z2++) if (bus.laG[z2] < gm) gm = bus.laG[z2]; }
      if (gm < 1 || bus.lg < 1) { bus.lg += (gm < bus.lg ? bus.kAtk : bus.kRel) * (gm - bus.lg); if (bus.lg > 0.99995) bus.lg = 1; }
      L[q] = bus.soft(dl * bus.lg); R[q] = bus.soft(dr * bus.lg);
    }
  };
  // Offline helper: render a hit from rest
  function renderHit(model, sr, strike, seconds, snap) {
    var vc = new Player(sr); vc.setModel(model); vc.gain = model.gain || 1;
    if (strike.tongue != null) vc.strikeTongue(strike.tongue, strike.vel); else vc.strike(strike.r, strike.theta || 0, strike.vel, strike.mode);
    var n = Math.round(seconds * sr), out = new Float32Array(n);
    var blk = 512;
    for (var o = 0; o < n; o += blk) {
      var len = Math.min(blk, n - o), tmp = new Float32Array(len);
      vc.process(tmp, len, snap);
      out.set(tmp, o);
      snap = snap && snap.arr.length < snap.max ? snap : null;
    }
    return out;
  }
  var LOUD_TARGET = -23;   // leaves real headroom: a full-velocity hit peaks around -4 dBFS, so a mix never starts out squashed
  function peakOf(x) { var p = 1e-12; for (var i = 0; i < x.length; i++) { var a = x[i] < 0 ? -x[i] : x[i]; if (a > p) p = a; } return p; }
  // rough K-weighted short-term loudness (dB): 2-pole high-pass ~70 Hz, +4 dB presence shelf, loudest 400 ms window
  function loudness(x, sr) {
    var a = 0, b = 0, c = 0, g = 1 - Math.exp(-TAU * 70 / sr), gs = 1 - Math.exp(-TAU * 1500 / sr), n = x.length, y = new Float64Array(n);
    for (var i = 0; i < n; i++) { a += g * (x[i] - a); var h1 = x[i] - a; b += g * (h1 - b); var h2 = h1 - b; c += gs * (h2 - c); var k = h2 + 0.58 * (h2 - c); y[i] = k * k; }
    var W = Math.min(n, Math.round(0.4 * sr)), st = Math.max(1, Math.round(0.025 * sr)), best = 0;
    for (var s0 = 0; s0 + W <= n; s0 += st) { var q = 0; for (var j = s0; j < s0 + W; j++) q += y[j]; if (q > best) best = q; }
    return 10 * Math.log10(best / W + 1e-30);
  }
  // how much louder a nearly pure tone at f sounds than our loudness meter says (half-strength 60-phon equal-loudness
  // contour minus the meter's own weighting, plus a little extra for the top): mid/upper notes of a bar instrument are
  // near-sine and would otherwise come out piercing next to the woodier low notes
  var EAR_T = [[100, -8], [200, -4.3], [300, -2.6], [500, -1], [800, 0.6], [1200, 1.6], [2000, 2.8], [4000, 4.2], [8000, 5.5]];
  function earTilt(f) {
    if (f <= EAR_T[0][0]) return EAR_T[0][1];
    for (var i = 1; i < EAR_T.length; i++) if (f <= EAR_T[i][0]) { var u = Math.log(f / EAR_T[i - 1][0]) / Math.log(EAR_T[i][0] / EAR_T[i - 1][0]); return EAR_T[i - 1][1] + u * (EAR_T[i][1] - EAR_T[i - 1][1]); }
    return EAR_T[EAR_T.length - 1][1];
  }
  // per-note output trims (bars / tongues): a pure gain on each note's own modes, so the physics of the stroke is
  // untouched (the same velocity hits every bar the same way). trims follow model.tongues order; null = untrimmed.
  function applyTrims(model, tr) {
    if (!model || !model.tongue || !model.tongues) return;
    model.tongues.forEach(function (t, i) { t.og = tr && tr[i] > 0 ? tr[i] : 1; });
    model.B.modes.forEach(function (md) { if (md.outW0 == null) md.outW0 = md.outW; md.outW = md.outW0 * (md.tg && md.tg.og ? md.tg.og : 1); });
  }
  function trimsOf(model) { return model && model.tongue && model.tongues ? model.tongues.map(function (t) { return t.og || 1; }) : null; }
  function calibrate(model, sr) {
    var mix = model.mix; model.mix = { batter: 1, reso: 0.6, shell: 0.5, tone: mix && mix.tone != null ? mix.tone : 0.35 };   // calibrate at a fixed reference mix
    model._cal = true;   // (the brush swish is a fixed output-level layer: leave it out of the measurement)
    model.gain = 1e-4;
    var st = model.cfg && model.cfg.strike, rUser = st && st.r != null ? Math.max(0.03, Math.min(0.95, st.r)) : null;
    var thU = st && st.theta != null ? st.theta : 0.4, calS = { r: rUser != null ? rUser : 0.3, theta: thU, vel: 0.85, mode: 'head' };   // loudness is judged on the build's own default stroke
    if (model.metal) calS = { r: model.piece === 'bell' || model.piece === 'cowbell' ? 0.9 : rUser != null ? rUser : 0.6, theta: thU, vel: 0.85, mode: 'head' };
    var mlSave = model.mallet; if (mlSave && (mlSave.bow || mlSave.brush)) model.mallet = model.metal ? MALLETS.soft_mal : MALLETS.stick;
    var tPk = 0;
    if (model.tongue) {
      var ts = model.tongues.slice().sort(function (x, y) { return x.f - y.f; }); calS = { tongue: ts[Math.floor(ts.length / 2)].idx, vel: 0.85 };
      applyTrims(model, null);   // measure every note untrimmed
      if (ts.length > 2) {   // even out the keyboard: measure a few notes across the range, trim each note's strike to the middle note's loudness
        var nS = Math.min(ts.length, 10), smp = [];
        for (var si = 0; si < nS; si++) {
          var tt = ts[Math.round(si * (ts.length - 1) / (nS - 1))], o2 = renderHit(model, sr, { tongue: tt.idx, vel: 0.85 }, 0.35);
          smp.push({ lf: Math.log(tt.f), L: loudness(o2, sr) + earTilt(tt.f), pk: peakOf(o2) });
        }
        var Ls = smp.map(function (x) { return x.L; }).sort(function (x, y) { return x - y; }), Lref = Ls[Ls.length >> 1];
        var pks = smp.map(function (x) { return x.pk * Math.pow(10, (Lref - x.L) / 20); }).sort(function (x, y) { return x - y; }), pkRef = 1.25 * pks[pks.length >> 1];
        smp.forEach(function (x) { var k = Math.pow(10, (Lref - x.L) / 20); if (x.pk * k > pkRef) k = pkRef / x.pk; x.lk = Math.log(Math.max(0.2, Math.min(5, k))); });   // a spiky note gives up some loudness rather than poke out
        ts.forEach(function (t) {
          var lf = Math.log(t.f), j = 0; while (j < smp.length - 2 && lf > smp[j + 1].lf) j++;
          var a0 = smp[j], a1 = smp[j + 1], u = Math.max(0, Math.min(1, (lf - a0.lf) / (a1.lf - a0.lf || 1)));
          t.og = Math.exp(a0.lk + u * (a1.lk - a0.lk));
        });
        applyTrims(model, model.tongues.map(function (t) { return t.og; }));
        tPk = 0; smp.forEach(function (x) { tPk = Math.max(tPk, x.pk * Math.exp(x.lk)); });   // the spikiest trimmed note sets the headroom, not just the middle one
      }
    }
    var out = renderHit(model, sr, calS, 0.5);
    var pk = Math.max(peakOf(out), 0.85 * tPk), loud = loudness(out, sr);
    if (model.piece === 'hihat') {   // an open hat is the loudest thing a hat does: leave headroom for it too
      var vh = new Player(sr); vh.setModel(model); vh.gain = model.gain; if (vh.core.setPedal) vh.core.setPedal(0.85);
      var bh = new Float32Array(Math.round(0.25 * sr)), th0 = new Float32Array(Math.round(0.3 * sr)); vh.process(th0, th0.length);
      vh.strike(calS.r, calS.theta, 0.85, "head"); vh.process(bh, bh.length); pk = Math.max(pk, 0.62 * peakOf(bh));
    }
    if (model.metal && model.piece !== 'bell' && model.piece !== 'cowbell') {
      pk = Math.max(pk, 0.85 * peakOf(renderHit(model, sr, { r: 0.6, theta: thU, vel: 0.85, mode: "head" }, 0.35)), 0.85 * peakOf(renderHit(model, sr, { r: 0.6, theta: 0.4, vel: 0.85, mode: "head" }, 0.35)), 0.45 * peakOf(renderHit(model, sr, { r: 0.08, theta: 0.4, vel: 0.85, mode: 'head' }, 0.35)));
    } else if (!model.metal && !model.tongue) {
      pk = Math.max(pk, 0.6 * peakOf(renderHit(model, sr, { r: 0.06, theta: 0.4, vel: 0.85, mode: 'head' }, 0.25)), 0.6 * peakOf(renderHit(model, sr, { r: 0.5, theta: 0.4, vel: 0.85, mode: 'head' }, 0.25)));   // no stroke position may clip
    }
    if (mlSave && mlSave.brush) {   // brushes: judge loudness on the brush itself (a little softer than a stick, never near-silent)
      model.mallet = mlSave; var bo = renderHit(model, sr, calS, 0.5); loud = loudness(bo, sr) + 5; pk = 1.2 * peakOf(bo);
    }
    model.mix = mix; model.mallet = mlSave;
    // level: aim every build at the same perceived loudness, but never let a strong hit run into the ceiling
    var gPeak = (model.metal ? 0.42 : 0.5) * 1e-4 / pk, gLoud = 1e-4 * Math.pow(10, (LOUD_TARGET - loud) / 20);
    model.gain = Math.min(gPeak, gLoud); model._cal = false;
    return model.gain;
  }
  function modeList(model) {
    if (model.metal) return model.B.modes.filter(function (m) { return m.orient === 0 && !m.proxy; }).map(function (m) { return { m: m.m, n: m.n, f: m.f, head: m.cup ? 'cup' : 'plate' }; }).sort(function (x, y) { return x.f - y.f; });
    if (model.tongue) return model.tongues.slice().sort(function (x, y) { return x.f - y.f; }).map(function (t) { return { m: t.idx, n: 1, f: t.f, head: 'tongue', note: t.note, L: t.L }; });
    return model.B.modes.filter(function (m) { return m.orient === 0 && !m.proxy; }).map(function (m) { return { m: m.m, n: m.n, f: m.f, head: model.none ? 'body' : 'batter' }; })
      .concat(model.R ? model.R.modes.map(function (m) { return { m: m.m, n: m.n, f: m.f, head: 'reso' }; }) : [])
      .sort(function (x, y) { return x.f - y.f; });
  }

  return {
    HEAD_MATS: HEAD_MATS, SHELL_MATS: SHELL_MATS, HOOPS: HOOPS, MALLETS: MALLETS,
    buildModel: buildModel, Voice: Voice, Player: Player, Kit: Kit, ALLOYS: ALLOYS, PIECES: PIECES, renderHit: renderHit, calibrate: calibrate, RTUNE: RTUNE, applyTrims: applyTrims, trimsOf: trimsOf, modeList: modeList,
    radial: radial, modeShape: modeShape, SCALES: SCALES, scaleNotes: scaleNotes, midiHz: midiHz, shellHeadMat: shellHeadMat, ZEROS: ZEROS, MMAX: MMAX, NMAX: NMAX
  };
})();
if (typeof module !== 'undefined') module.exports = DrumEngine;
