// Replays a builder-page message stream through the browser host (app.js makeHost) and writes the stream
// for dhrender, so the C++ host can be checked against the same messages.
//   node tools/hostcheck.js <out.jsonl> <out.js.f32>
const path = require('path'), fs = require('fs'), ref = path.join(__dirname, '..', 'reference');
const E = require(path.join(ref, 'engine.js')), sr = 48000;
const app = fs.readFileSync(path.join(ref, 'app.js'), 'utf8');
const grab = (a, b) => app.slice(app.indexOf(a), app.indexOf(b));
const APPLY_SRC = eval('(function(){' + grab('var APPLY_SRC', 'var applyMsg') + 'return APPLY_SRC;})()');
const HOST_SRC = eval('(function(){' + grab('var HOST_SRC', 'var makeHost') + 'return HOST_SRC;})()');
const applyMsg = new Function('return ' + APPLY_SRC.replace('function applyMsg', 'function'))();
const makeHost = new Function('DrumEngine', 'applyMsg', HOST_SRC + '; return makeHost;')(E, applyMsg);
const KK = JSON.parse(fs.readFileSync(path.join(ref, 'kits.json'), 'utf8')), K = KK['Studio kit (pop / rock)'];
const pieces = K.pieces.map(p => { const c = JSON.parse(JSON.stringify(p.cfg)); c.lite = true; const m = E.buildModel(c, sr); E.calibrate(m, sr); return { cfg: c, gain: m.gain, tr: E.trimsOf(m), level: p.level, pan: p.pan }; });
const snare = JSON.parse(JSON.stringify(K.pieces[1].cfg)); const sm = E.buildModel(snare, sr); E.calibrate(sm, sr);
const stream = [
  [0, { type: 'punch', v: 0.35, kv: K.mix.punch }],
  [0, { type: 'kit', pieces, map: K.map, symp: K.mix.sympathy }],
];
const ev = require('./groove_events.js')(sr);
ev.forEach(e => { if (K.map[e[1]]) { stream.push([e[0], { type: 'kon', note: e[1], vel: e[2] }]); stream.push([e[0] + 4000, { type: 'koff', note: e[1] }]); } });
// then single mode: a snare build, some strokes, a roll-less strike + rimshot
const t1 = Math.round(26 * sr);
stream.push([t1, { type: 'mode', kit: false }], [t1, { type: 'cfg', cfg: snare, gain: sm.gain, tr: null }]);
for (let i = 0; i < 6; i++) stream.push([t1 + 2000 + i * 9000, { type: 'strike', r: 0.1 * i, theta: 0.6, vel: 0.5 + 0.08 * i, mode: i === 5 ? 'rimshot' : 'head' }]);
stream.sort((a, b) => a[0] - b[0]);
fs.writeFileSync(process.argv[2], stream.map(s => JSON.stringify({ at: s[0], msg: s[1] })).join('\n'));
const h = makeHost(sr), N = Math.round(28 * sr), L = new Float32Array(N), R = new Float32Array(N); let si = 0;
for (let b = 0; b < N; b += 64) { while (si < stream.length && stream[si][0] < b + 64) { h.msg(JSON.parse(JSON.stringify(stream[si][1]))); si++; } const n = Math.min(64, N - b); h.process(L.subarray(b, b + n), n, R.subarray(b, b + n)); }
const o = new Float32Array(2 * N); for (let i = 0; i < N; i++) { o[2 * i] = L[i]; o[2 * i + 1] = R[i]; }
fs.writeFileSync(process.argv[3], Buffer.from(o.buffer));
