// Reference renders from the browser engine (reference/engine.js), for comparing against dhrender.
//   node tools/jsrender.js export <outdir>                 -> presets.json, kits.json
//   node tools/jsrender.js hit <cfg.json> <out.f32> <sec>  -> calibrated default stroke, mono float32
//   node tools/jsrender.js groove <kits.json> <kit> <out.f32> -> the Studio-kit groove (L,R interleaved float32)
const path = require('path'), fs = require('fs');
const ref = path.join(__dirname, '..', 'reference');
const E = require(path.join(ref, 'engine.js')), sr = 48000;
const cmd = process.argv[2];
function strikeOf(m) {
  if (m.tongue) { const ts = m.tongues.slice().sort((x, y) => x.f - y.f); return { tongue: ts[Math.floor(ts.length / 2)].idx, vel: 0.85 }; }
  const st = m.cfg.strike || {};
  return { r: st.r != null ? st.r : (m.metal ? 0.6 : 0.3), theta: st.theta != null ? st.theta : 0.4, vel: 0.85, mode: st.mode || 'head' };
}
if (cmd === 'export') {
  global.window = undefined;
  const P = require(path.join(ref, 'presets.js')), K = require(path.join(ref, 'kits.js'));
  fs.writeFileSync(path.join(process.argv[3], 'presets.json'), JSON.stringify(P));
  fs.writeFileSync(path.join(process.argv[3], 'kits.json'), JSON.stringify(K));
} else if (cmd === 'hit') {
  const cfg = JSON.parse(fs.readFileSync(process.argv[3], 'utf8')), sec = +process.argv[5] || 2;
  const m = E.buildModel(cfg, sr); E.calibrate(m, sr);
  const x = E.renderHit(m, sr, strikeOf(m), sec);
  fs.writeFileSync(process.argv[4], Buffer.from(x.buffer));
  console.log('gain', m.gain);
} else if (cmd === 'groove') {
  const KK = JSON.parse(fs.readFileSync(process.argv[3], 'utf8')), K = KK[process.argv[4]], k = new E.Kit(sr);
  K.pieces.forEach((pc, i) => { const c = JSON.parse(JSON.stringify(pc.cfg)); c.lite = true; const m = E.buildModel(c, sr); E.calibrate(m, sr); k.setPiece(i, m, { level: pc.level, pan: pc.pan }); });
  k.setMap(K.map); k.punch = K.mix.punch; k.symp = K.mix.sympathy;
  const ev = require('./groove_events.js')(sr);
  const N = Math.round((128 * 60 / 96 / 4 + 4) * sr), L = new Float32Array(N), R = new Float32Array(N); let ei = 0;
  for (let b = 0; b < N; b += 64) { while (ei < ev.length && ev[ei][0] < b + 64) { if (K.map[ev[ei][1]]) k.noteOn(ev[ei][1], ev[ei][2]); ei++; } const n = Math.min(64, N - b); k.process(L.subarray(b, b + n), n, R.subarray(b, b + n)); }
  const o = new Float32Array(2 * N); for (let i = 0; i < N; i++) { o[2 * i] = L[i]; o[2 * i + 1] = R[i]; }
  fs.writeFileSync(process.argv[5], Buffer.from(o.buffer));
}
