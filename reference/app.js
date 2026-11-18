(function () {
'use strict';
var E = DrumEngine, P = DRUM_PRESETS;
// inside the VST: the plugin hosts this page; sound comes from the native engine, settings are saved in the project
var PLUG = window.__DH_PLUGIN || null, LS = PLUG ? PLUG.store : (function () { try { return window.localStorage || null; } catch (e) { return null; } })() || { getItem: function () { return null; }, setItem: function () {} };
var $ = function (id) { return document.getElementById(id); };
var clone = function (o) { return JSON.parse(JSON.stringify(o)); };
var NOTE = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
function noteOf(f) {
  if (!(f > 0)) return '';
  var n = 12 * Math.log2(f / 440) + 69, r = Math.round(n), c = Math.round((n - r) * 100);
  return NOTE[((r % 12) + 12) % 12] + (Math.floor(r / 12) - 1) + (c ? (c > 0 ? ' +' : ' −') + Math.abs(c) + '¢' : '');
}
function toast(msg) { var t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast._t); toast._t = setTimeout(function () { t.classList.remove('show'); }, 1800); }

// ---------------- state ----------------
var DEFAULT = 'Maple snare 14×5.5';
var cfg, presetName = DEFAULT;
try { var saved = LS.getItem('drumlab.cfg'); if (saved) { cfg = JSON.parse(saved); presetName = LS.getItem('drumlab.preset') || ''; } } catch (e) {}
if (cfg && cfg.kind === 'none') { cfg = null; }
if (!cfg || !cfg.shell) { cfg = clone(P[DEFAULT]); presetName = DEFAULT; }
var SR = PLUG ? PLUG.sr : 48000, model = null, shapes = null;

function get(path) { return path.split('.').reduce(function (o, k) { return o == null ? undefined : o[k]; }, cfg); }
function set(path, v) { var ks = path.split('.'), o = cfg; for (var i = 0; i < ks.length - 1; i++) { if (o[ks[i]] == null) o[ks[i]] = {}; o = o[ks[i]]; } o[ks[ks.length - 1]] = v; }

// ---------------- control schema ----------------
var SHAPES = {
  double: [['cylinder', 'Cylinder (kit, snare, tom)'], ['barrel', 'Barrel (taiko, dhol)']],
  single: [['open', 'Open tube (concert tom)'], ['barrel', 'Barrel (conga, ashiko)'], ['frame', 'Frame (bodhrán, tar)'], ['goblet', 'Goblet (djembe, darbuka)'], ['kettle', 'Kettle / bowl (timpani)']],
  none: [['kettle', 'Bowl'], ['goblet', 'Goblet'], ['open', 'Tube'], ['frame', 'Ring']],
  shellhead: [['kettle', 'Bowl / closed box (cajón, tank drum)'], ['goblet', 'Goblet (vessel on a stem)'], ['open', 'Open tube'], ['frame', 'Frame (plate on a ring)'], ['barrel', 'Barrel (closed keg with a vent)']]
};
var headed = function (c) { return c.kind !== 'none'; };
var hl = function (c) { return c.kind === 'none'; };
var shd = function (c) { return c.kind === 'shellhead'; };
var isTg = function (c) { return !!(c.special && (c.special.type === 'tongue' || c.special.type === 'bars')); };   // tongue drums and bar instruments share the note-per-key machinery
var isBars = function (c) { return !!(c.special && c.special.type === 'bars'); };
var isTongue = function (c) { return isTg(c) && !isBars(c); };
var notTg = function (c) { return !isTg(c); };
var isMetal = function (c) { return !!(c.special && c.special.type === 'metal'); };
var notMetal = function (c) { return !isMetal(c); };
var mPiece = function (c) { return isMetal(c) ? c.special.piece : ''; };
var mIs = function () { var l = arguments; return function (c) { return isMetal(c) && Array.prototype.indexOf.call(l, c.special.piece) >= 0; }; };
var mPlate = function (c) { return isMetal(c) && ['bell', 'cowbell'].indexOf(c.special.piece) < 0; };
var mPair = mIs('hihat', 'stack');
var mm = function (v) { return v.toFixed(v < 10 ? 2 : 1) + ' mm'; };
function craftItems(base, isBottom) {
  var show = isBottom ? mPair : function (c) { return isMetal(c); };
  var plate = function (c) { return show(c) && mPlate(c); };
  return [
    { k: base + '.alloy', label: 'Alloy', type: 'select', show: show, opts: function () { return opts(E.ALLOYS); } },
    { k: base + '.diameter', label: 'Diameter', type: 'range', min: 3, max: 40, step: 0.25, fmt: inch, show: show },
    { k: base + '.thickness', label: 'Thickness', type: 'range', min: 0.3, max: 30, step: 0.01, log: true, fmt: mm, show: show },
    { k: base + '.taper', label: 'Edge taper (thinner edge)', type: 'range', min: 0, max: 1, step: 0.01, fmt: pct, show: plate },
    { k: base + '.dome', label: 'Profile height (bow curvature)', type: 'range', min: 0.5, max: 60, step: 0.5, fmt: mm, show: plate },
    { k: base + '.bellDia', label: function (c) { return mPiece(c) === 'nipple' ? 'Boss diameter' : 'Bell (cup) diameter'; }, type: 'range', min: 0, max: 10, step: 0.1, fmt: function (v) { return v ? inch(v) : 'none'; }, show: plate },
    { k: base + '.bellHeight', label: function (c) { return mPiece(c) === 'nipple' ? 'Boss height' : 'Bell (cup) height'; }, type: 'range', min: 0, max: 40, step: 0.5, fmt: mm, show: plate },
    { k: base + '.flange', label: 'Edge flange (china upturn)', type: 'range', min: 0, max: 1, step: 0.01, fmt: pct, show: plate },
    { k: base + '.lathe', label: 'Lathing (tonal grooves)', type: 'range', min: 0, max: 1, step: 0.01, fmt: function (v) { return v < 0.05 ? 'raw / unlathed' : pct(v); }, show: plate },
    { k: base + '.hammer', label: 'Hammering', type: 'range', min: 0, max: 1, step: 0.01, fmt: pct, show: show },
    { k: base + '.holes', label: 'Holes (trash)', type: 'range', min: 0, max: 12, step: 1, fmt: function (v) { return v ? v + '' : 'none'; }, show: plate },
    { k: base + '.rivets', label: 'Sizzle rivets', type: 'range', min: 0, max: 12, step: 1, fmt: function (v) { return v ? v + '' : 'none'; }, show: isBottom ? function () { return false; } : plate },
    { k: base + '.chain', label: 'Sizzle chain resting on top', type: 'toggle', show: isBottom ? function () { return false; } : plate },
    { k: base + '.evenness', label: 'Evenness (casting / tuning)', type: 'range', min: 0, max: 1, step: 0.01, fmt: pct, show: show }
  ];
}
var METAL_DEF = function () { return clone(P['Crash 18 (B20)'].special); };
var NOTE_OPTS = []; for (var nn = 24; nn <= 84; nn++) NOTE_OPTS.push([String(nn), NOTE[nn % 12] + (Math.floor(nn / 12) - 1) + '  (' + Math.round(E.midiHz(nn)) + ' Hz)']);
var BARS_DEF = { type: 'bars', material: 'rosewood', thickness: 20, root: 45, scale: 'chromatic', count: 52, width: 5.5, overtone: 1, evenness: 0.98, muffle: 0, tuning: 'marimba', resonators: 0.8 };
var SPECIAL_DEF = { type: 'tongue', material: '__shell', thickness: 2, root: 50, scale: 'minor', count: 15, width: 3.5, overtone: 0.75, evenness: 0.98, muffle: 0 };
var two = function (c) { return c.kind === 'double'; };
var shp = function () { var a = arguments; return function (c) { return Array.prototype.indexOf.call(a, c.shell.shape) >= 0; }; };
var opts = function (tbl) { return Object.keys(tbl).map(function (k) { return [k, tbl[k].name]; }); };
var inch = function (v) { return v.toFixed(v < 10 ? 2 : 1).replace(/\.?0+$/, '') + '″ · ' + (v * 2.54).toFixed(v < 4 ? 1 : 0) + ' cm'; };
var pct = function (v) { return Math.round(v * 100) + '%'; };
function headSec(h, title) {
  return { sec: title, show: function (c) { return !isTg(c) && !isMetal(c) && (h === 'reso' ? two(c) : headed(c)); }, items: [
    { k: h + '.material', label: 'Material', type: 'select', opts: opts(E.HEAD_MATS), show: function (c) { return !shd(c) || h === 'reso'; } },
    { k: h + '.thickness', label: function (c) { return shd(c) && h === 'batter' ? 'Plate thickness' : 'Thickness'; }, type: 'range', min: 0.05, max: 25, step: 0.005, log: true, fmt: function (v) { return v.toFixed(3) + ' mm · ' + (v / 0.0254).toFixed(1) + ' mil'; } },
    { k: h + '.tension', label: function (c) { return shd(c) && h === 'batter' ? 'Prestress (hammered / bent in)' : 'Tension / prestress'; }, type: 'range', min: 100, max: 400000, step: 1, log: true, fmt: function (v) { return Math.round(v) + ' N/m'; }, extra: h },
    { k: h + '.muffle', label: 'Muffling (gel / ring / tape)', type: 'range', min: 0, max: 1, step: 0.01, fmt: pct },
    { k: h + '.evenness', label: 'Tuning evenness (lug to lug)', type: 'range', min: 0, max: 1, step: 0.01, fmt: pct },
    { k: h + '.harmonic', label: 'Harmonic tuning (hammered / loaded)', type: 'range', min: 0, max: 1, step: 0.01, fmt: function (v) { return v ? pct(v) : 'off'; }, def: 0 }
  ].concat(h === 'reso' ? [{ k: 'reso.hole', label: 'Port hole in head', type: 'range', min: 0, max: 8, step: 0.25, fmt: function (v) { return v ? inch(v) : 'none'; } }]
    : [{ k: 'bend', label: 'Pitch bend on hard hits', type: 'range', min: 0, max: 2.5, step: 0.05, fmt: function (v) { return v.toFixed(2) + '×'; }, def: 1 }]) };
}
var SCHEMA = [
  { sec: 'Special build', items: [
    { k: 'special.type', label: 'Build', type: 'select', opts: [['none', 'Regular drum'], ['tongue', 'Tuned tongue drum'], ['bars', 'Tuned bars (marimba / xylophone)'], ['metal', 'Cymbal / hi-hat / gong / metal']], def: 'none' },
    { k: 'special.material', label: function (c) { return isBars(c) ? 'Bar material' : 'Tongue material'; }, type: 'select', show: isTg, opts: function () { return [['__shell', 'Same as shell']].concat(opts(E.SHELL_MATS)); } },
    { k: 'special.thickness', label: function (c) { return isBars(c) ? 'Bar thickness' : 'Plate thickness'; }, type: 'range', min: 0.5, max: 40, step: 0.01, log: true, show: isTg, fmt: function (v) { return v.toFixed(2) + ' mm'; } },
    { k: 'special.root', label: 'Lowest note', type: 'select', show: isTg, opts: NOTE_OPTS, num: true },
    { k: 'special.scale', label: 'Scale', type: 'select', show: isTg, opts: function () { return Object.keys(E.SCALES).map(function (k) { return [k, E.SCALES[k].name]; }); } },
    { k: 'special.count', label: function (c) { return isBars(c) ? 'Number of bars' : 'Number of tongues'; }, type: 'range', min: 3, max: 64, step: 1, show: isTg, fmt: function (v) { return v + ' notes'; } },
    { k: 'special.width', label: function (c) { return isBars(c) ? 'Bar width (lowest bar)' : 'Tongue width'; }, type: 'range', min: 1, max: 8, step: 0.1, show: isTg, fmt: function (v) { return v.toFixed(1) + ' cm'; } },
    { k: 'special.overtone', label: function (c) { return isBars(c) ? 'Overtone tuning (raw bar → tuned arch)' : 'Overtone tuning (raw → 1:2:3)'; }, type: 'range', min: 0, max: 1, step: 0.01, show: isTg, fmt: pct },
    { k: 'special.tuning', label: 'Bar tuning style', type: 'select', show: isBars, opts: [['marimba', 'Marimba (1 : 4 : 10)'], ['xylo', 'Xylophone (1 : 3 : 6)']], def: 'marimba' },
    { k: 'special.resonators', label: 'Tube resonators', type: 'range', min: 0, max: 1, step: 0.01, show: isBars, fmt: function (v) { return v < 0.02 ? 'none' : pct(v); }, def: 0.8 },
    { k: 'special.evenness', label: 'Tuning accuracy', type: 'range', min: 0, max: 1, step: 0.01, show: isTg, fmt: pct },
    { k: 'special.muffle', label: 'Damping (felt, tape)', type: 'range', min: 0, max: 1, step: 0.01, show: isTg, fmt: pct }
  ] },
  { sec: 'Metal piece', show: isMetal, items: [
    { k: 'special.piece', label: 'Piece', type: 'select', opts: function () { return Object.keys(E.PIECES).map(function (k) { return [k, E.PIECES[k]]; }); } },
    { k: 'special.quality', label: 'Physics quality', type: 'select', opts: [['full', 'Full (more modes, more CPU)'], ['light', 'Light (for big kits / slower machines)']] },
    { k: 'special.clamp', label: 'Clamp / damping (release)', type: 'range', min: 0, max: 1, step: 0.01, fmt: function (v) { return v < 0.02 ? 'free (natural ring)' : pct(v); }, def: 0 },
    { k: 'special.bloom', label: 'Bloom / wash (nonlinearity)', type: 'range', min: 0, max: 2.5, step: 0.01, fmt: function (v) { return v.toFixed(2) + '×'; }, show: mPlate },
    { k: 'special.rim', label: 'Turned rim depth', type: 'range', min: 0, max: 1, step: 0.01, fmt: pct, show: mIs('tamtam', 'opera', 'nipple'), def: 0.6 },
    { k: 'special.bossNote', label: 'Boss tuned to', type: 'select', opts: NOTE_OPTS, num: true, show: mIs('nipple'), def: 45 },
    { k: 'special.glide', label: 'Pitch glide (rises ← → falls)', type: 'range', min: -1, max: 1, step: 0.01, fmt: function (v) { return v > 0.02 ? 'falls ' + pct(v) : v < -0.02 ? 'rises ' + pct(-v) : 'none'; }, show: mIs('opera'), def: 0.6 },
    { k: 'special.pedal', label: 'Pedal openness', type: 'range', min: 0, max: 1, step: 0.01, fmt: function (v) { return v < 0.02 ? 'closed' : pct(v); }, show: mIs('hihat'), live: true, def: 0.15 },
    { k: 'special.gap', label: 'Max gap (fully open)', type: 'range', min: 1, max: 15, step: 0.1, fmt: mm, show: mIs('hihat'), def: 8 },
    { k: 'special.clutch', label: 'Clutch tightness', type: 'range', min: 0, max: 1, step: 0.01, fmt: pct, show: mPair, def: 0.6 },
    { k: 'special.tilt', label: 'Bottom cymbal tilt', type: 'range', min: 0, max: 2, step: 0.01, fmt: mm, show: mIs('hihat'), def: 0.3 },
    { k: 'special.press', label: 'Stack pressure', type: 'range', min: 0, max: 1, step: 0.01, fmt: pct, show: mIs('stack'), def: 0.5 }
  ] },
  { sec: 'Craft', title: function (c) { return mPair(c) ? 'Top cymbal' : mIs('bell', 'cowbell')(c) ? 'Bell craft' : mIs('tamtam', 'opera', 'nipple')(c) ? 'Gong craft' : 'Cymbal craft'; }, show: isMetal, items: craftItems('special.top', false) },
  { sec: 'Bottom cymbal', show: mPair, items: craftItems('special.bottom', true) },
  { sec: 'Body', show: function (c) { return notMetal(c) && !isBars(c); }, items: [
    { k: 'kind', show: notTg, label: 'Construction', type: 'select', opts: [['double', 'Two heads (batter + resonant)'], ['single', 'One head'], ['shellhead', 'Shell head (shell material as head)']] },
    { k: 'shell.shape', label: 'Shape', type: 'select', opts: function (c) { return SHAPES[isTg(c) ? 'single' : c.kind]; } },
    { k: 'shell.diameter', label: 'Head diameter', type: 'range', min: 4, max: 40, step: 0.25, fmt: inch },
    { k: 'reso.diameter', label: function (c) { return c.shell.shape === 'barrel' ? 'Bottom face diameter (resonant head)' : 'Bottom head diameter'; }, type: 'range', min: 4, max: 40, step: 0.25, fmt: inch, show: two, def: function (c) { return c.shell.diameter; } },
    { k: 'shell.bottomDia', label: function (c) { return c.kind === 'single' ? 'Bottom face diameter (open)' : 'Bottom face diameter'; }, type: 'range', min: 2, max: 40, step: 0.25, fmt: inch, show: function (c) { return c.shell.shape === 'barrel' && c.kind !== 'double'; }, def: function (c) { return c.kind === 'single' ? Math.round(c.shell.diameter * 0.75 * 4) / 4 : c.shell.diameter; } },
    { k: 'shell.depth', label: function (c) { return hl(c) ? (c.shell.shape === 'frame' ? 'Ring width' : 'Height') : c.shell.shape === 'frame' ? 'Frame depth' : (c.shell.shape === 'goblet' || c.shell.shape === 'kettle') ? 'Total height' : 'Shell depth'; }, type: 'range', min: 0.5, max: 40, step: 0.25, fmt: inch },
    { k: 'shell.bulge', label: 'Barrel bulge', type: 'range', min: 0, max: 0.45, step: 0.01, fmt: pct, show: shp('barrel'), def: 0.15 },
    { k: 'shell.bowlDepth', label: 'Bowl depth', type: 'range', min: 2, max: 30, step: 0.25, fmt: inch, show: shp('goblet', 'kettle'), def: 10 },
    { k: 'shell.portDiam', label: function (c) { return c.shell.shape === 'goblet' ? (hl(c) ? 'Stem diameter' : 'Stem bore diameter') : 'Vent hole diameter'; }, type: 'range', min: 0.25, max: 30, step: 0.05, fmt: inch, show: function (c) { return c.shell.shape === 'goblet' || (c.shell.shape === 'kettle' && !hl(c)) || (c.shell.shape === 'barrel' && c.kind === 'shellhead'); }, def: 3 },
    { k: 'shell.portLen', label: 'Stem length', type: 'range', min: 1, max: 24, step: 0.25, fmt: inch, show: shp('goblet'), def: 9 }
  ] },
  { sec: 'Shell', show: function (c) { return notMetal(c) && !isBars(c); }, items: [
    { k: 'shell.material', label: 'Material', type: 'select', opts: opts(E.SHELL_MATS) },
    { k: 'shell.thickness', label: 'Wall thickness', type: 'range', min: 0.5, max: 60, step: 0.1, log: true, fmt: function (v) { return v.toFixed(1) + ' mm'; } },
    { k: 'shell.hoop', label: 'Hoop / rim', type: 'select', opts: opts(E.HOOPS), show: function (c) { return headed(c) && !isTg(c); } },
    { k: 'shell.evenness', label: 'Evenness (wall thickness / casting)', type: 'range', min: 0, max: 1, step: 0.01, fmt: pct, show: hl, def: 0.9 },
    { k: 'shell.muffle', label: 'Damping (hand, felt, tape)', type: 'range', min: 0, max: 1, step: 0.01, fmt: pct, show: hl, def: 0 }
  ] },
  (function () { var s = headSec('batter', 'Batter head'); s.title = function (c) { return shd(c) ? 'Shell head (plate of ' + (E.SHELL_MATS[c.shell.material] || {}).name.toLowerCase() + ')' : 'Batter head'; }; return s; })(),
  headSec('reso', 'Resonant head'),
  { sec: 'Inside', show: function (c) { return headed(c) && !isTg(c) && !isMetal(c); }, items: [
    { k: 'pillow', label: 'Pillow / blanket inside', type: 'range', min: 0, max: 1, step: 0.01, fmt: pct, show: two, def: 0 },
    { k: 'snare.on', label: function (c) { return two(c) ? 'Snare wires (under bottom head)' : 'Snare strings (under the head)'; }, type: 'toggle' },
    { k: 'snare.tension', label: 'Snare tension (strainer)', type: 'range', min: 0, max: 1, step: 0.01, fmt: pct, show: function (c) { return c.snare && c.snare.on; } },
    { k: 'snare.level', label: 'Wire count / contact', type: 'range', min: 0, max: 1, step: 0.01, fmt: pct, show: function (c) { return c.snare && c.snare.on; } }
  ] },
  { sec: 'Striker', items: [
    { k: 'mallet', label: 'Striker', type: 'select', opts: function (c) { return Object.keys(E.MALLETS).filter(function (k) { return !E.MALLETS[k].metalOnly || isMetal(c); }).map(function (k) { return [k, E.MALLETS[k].name]; }); } },
    { k: 'roll', label: 'Rolling (hold a key, pad or the mouse)', type: 'toggle', show: function (c) { return !(isMetal(c) && c.mallet === 'bow'); } },
    { k: 'rollSpeed', label: 'Roll speed (mod wheel)', type: 'range', min: 4, max: 35, step: 0.5, fmt: function (v) { return v.toFixed(1) + ' strokes/s'; }, live: true, def: 14, show: function (c) { return !!c.roll; } },
    { k: 'strike.mode', show: function (c) { return headed(c) && !isTg(c) && !isMetal(c); }, label: 'Stroke', type: 'select', opts: [['head', 'Head'], ['rimshot', 'Rimshot (head + hoop)'], ['rimclick', 'Rim click (cross-stick)'], ['rim', 'Rim only (stick on hoop)']], live: true },
    { k: 'strike.vel', label: 'Velocity', type: 'range', min: 0.02, max: 1, step: 0.01, fmt: pct, live: true },
    { k: 'strike.r', show: notTg, label: function (c) { return isMetal(c) ? 'Strike point (bell → edge)' : hl(c) ? 'Strike height (bottom → rim)' : 'Strike point (center → edge)'; }, type: 'range', min: 0, max: 0.97, step: 0.01, fmt: pct, live: true }
  ] },
  { sec: 'Mix', items: [
    { k: 'mics.close', label: 'Close mic level', type: 'range', min: 0, max: 1.5, step: 0.01, fmt: pct, def: 1 },
    { k: 'mics.oh', label: 'Overhead pair level', type: 'range', min: 0, max: 1.5, step: 0.01, fmt: pct, def: 0.5 },
    { k: 'mics.height', label: 'Overhead height', type: 'range', min: 0.2, max: 2, step: 0.01, fmt: function (v) { return v.toFixed(2) + ' m'; }, def: 0.9 },
    { k: 'mics.width', label: 'Overhead spacing (stereo width)', type: 'range', min: 0, max: 1, step: 0.01, fmt: pct, def: 0.6 },
    { k: 'mics.pan', label: 'Position in the stereo field', type: 'range', min: -1, max: 1, step: 0.01, fmt: function (v) { return Math.abs(v) < 0.02 ? 'center' : (v < 0 ? 'L ' : 'R ') + Math.round(Math.abs(v) * 100); }, def: 0 },
    { k: 'mix.batter', label: function (c) { return hl(c) ? 'Close mic' : 'Close: batter side'; }, type: 'range', min: 0, max: 1.5, step: 0.01, fmt: pct, show: notMetal },
    { k: 'mix.reso', label: function (c) { return two(c) ? 'Close: resonant side' : 'Close: bottom / port'; }, type: 'range', min: 0, max: 1.5, step: 0.01, fmt: pct, show: function (c) { return headed(c) && !isMetal(c); } },
    { k: 'mix.shell', label: 'Shell & hoop', type: 'range', min: 0, max: 2, step: 0.01, fmt: pct, show: function (c) { return headed(c) && !isMetal(c); } },
    { k: 'mix.tone', label: 'Tone (dark ↔ bright)', type: 'range', min: -1, max: 1, step: 0.01, def: 0.4, fmt: function (v) { var db = v * 9; return (db >= 0 ? '+' : '') + db.toFixed(1) + ' dB air'; } },
    { k: 'mix.punch', show: function () { return !kitMode; }, label: 'Punch (bus compression)', type: 'range', min: 0, max: 1, step: 0.01, fmt: pct, live: true, def: 0.35 },
    { k: 'mix.room', show: function () { return !kitMode; }, label: 'Room', type: 'range', min: 0, max: 1, step: 0.01, fmt: pct, live: true },
    { k: 'mix.master', show: function () { return !kitMode; }, label: 'Output level', type: 'range', min: 0, max: 1.5, step: 0.01, fmt: pct, live: true, def: 0.8 }
  ] }
];
var closed = {};
try { closed = JSON.parse(LS.getItem('drumlab.closed') || '{}'); } catch (e) {}

function lbl(it) { return typeof it.label === 'function' ? it.label(cfg) : it.label; }
function toSlider(it, v) { return it.log ? 1000 * Math.log(v / it.min) / Math.log(it.max / it.min) : v; }
function fromSlider(it, s) { var v = it.log ? it.min * Math.pow(it.max / it.min, s / 1000) : +s; return it.log ? +v.toPrecision(4) : v; }
function valueOf(it) {
  var v = get(it.k);
  if (v == null) { v = typeof it.def === 'function' ? it.def(cfg) : it.def; }
  return v;
}
function buildPanel() {
  var el = $('panel'); el.innerHTML = '';
  if (kitMode) el.appendChild(kitPanel());
  SCHEMA.forEach(function (sec) {
    if (sec.show && !sec.show(cfg)) return;
    var d = document.createElement('div'); d.className = 'sec' + (closed[sec.sec] ? ' closed' : '');
    var h = document.createElement('h3'); h.innerHTML = (sec.title ? sec.title(cfg) : sec.sec) + '<i>' + (closed[sec.sec] ? '+' : '−') + '</i>';
    h.onclick = function () { closed[sec.sec] = !closed[sec.sec]; try { LS.setItem('drumlab.closed', JSON.stringify(closed)); } catch (e) {} buildPanel(); };
    d.appendChild(h);
    var rows = document.createElement('div'); rows.className = 'rows';
    sec.items.forEach(function (it) {
      if (it.show && !it.show(cfg)) return;
      var row = document.createElement('div'); row.className = 'row' + (it.type === 'toggle' ? ' toggle' : '');
      var L = document.createElement('label'); L.textContent = lbl(it); row.appendChild(L);
      var V = document.createElement('span'); V.className = 'val'; row.appendChild(V);
      var v = valueOf(it);
      if (it.type === 'range') {
        var inp = document.createElement('input'); inp.type = 'range';
        inp.min = it.log ? 0 : it.min; inp.max = it.log ? 1000 : it.max; inp.step = it.log ? 1 : it.step;
        inp.value = toSlider(it, v);
        var show = function () { var x = valueOf(it); V.textContent = it.fmt ? it.fmt(x) : x; if (it.extra) V.textContent += pitchHint(it.extra); };
        show();
        inp.oninput = function () { set(it.k, fromSlider(it, inp.value)); show(); changed(it); };
        inp.dataset.k = it.k; row.appendChild(inp); it._show = show; it._inp = inp;
      } else if (it.type === 'select') {
        var s = document.createElement('select');
        var o = typeof it.opts === 'function' ? it.opts(cfg) : it.opts;
        o.forEach(function (p) { var op = document.createElement('option'); op.value = p[0]; op.textContent = p[1]; s.appendChild(op); });
        s.value = String(v); V.textContent = '';
        s.onchange = function () { set(it.k, it.num ? +s.value : s.value); changed(it, true); };
        row.appendChild(s);
      } else if (it.type === 'toggle') {
        var b = document.createElement('button'); b.className = 'sw' + (v ? ' on' : ''); b.setAttribute('aria-label', lbl(it));
        b.onclick = function () { set(it.k, !get(it.k)); changed(it, true); };
        V.appendChild(b); V.style.textAlign = 'right';
      }
      rows.appendChild(row);
    });
    d.appendChild(rows); el.appendChild(d);
  });
}
function refreshPanelValues() {
  SCHEMA.forEach(function (sec) { sec.items.forEach(function (it) { if (it._show && it._inp && document.body.contains(it._inp)) { it._show(); } }); });
}
function pitchHint(h) {
  if (!model) return '';
  var hd = h === 'reso' ? model.R : model.B; if (!hd) return '';
  var f = hd.modes[0].f; return '  ·  ' + Math.round(f) + ' Hz';
}

function changed(it, structural) {
  presetName = '';
  if (it.k === 'batter.material' || it.k === 'reso.material') {
    var h = it.k.split('.')[0]; cfg[h].thickness = E.HEAD_MATS[cfg[h].material].thick;
    structural = true;
  }
  if (it.k === 'special.type') {
    if (cfg.special.type === 'metal') {
      var keepMics = cfg.mics; cfg.special = METAL_DEF(); cfg.mallet = 'stick';
      cfg.mics = Object.assign({ close: 0.35, oh: 1, width: 0.8, height: 0.6, pan: 0 }, {}); cfg.strike.mode = 'head'; cfg.strike.r = 0.85;
    }
    if (cfg.special.type === 'bars') {
      cfg.special = clone(BARS_DEF); cfg.kind = 'single'; cfg.mallet = 'yarn'; cfg.strike.mode = 'head';
      kbOct = Math.floor(cfg.special.root / 12);
    }
    if (cfg.special.type === 'tongue') {
      cfg.special = Object.assign({}, SPECIAL_DEF, cfg.special.scale === 'chromatic' && cfg.special.count > 36 ? {} : cfg.special, { type: 'tongue' });
      cfg.kind = 'single'; if (['open', 'frame', 'goblet', 'kettle'].indexOf(cfg.shell.shape) < 0) { cfg.shell.shape = 'kettle'; cfg.shell.bowlDepth = cfg.shell.bowlDepth || cfg.shell.depth; cfg.shell.portDiam = cfg.shell.portDiam || 2.5; }
      if (cfg.mallet === 'stick' || cfg.mallet === 'felt_beat') cfg.mallet = 'pan_stick';
      kbOct = Math.floor(cfg.special.root / 12);
    }
    structural = true;
  }
  if (it.k === 'special.root') kbOct = Math.floor(cfg.special.root / 12);
  if (it.k === 'special.material' && isBars(cfg)) {
    // you can carve a tuning arch into wood or metal, but cast / fired / brittle bars are mostly left raw
    var bm = cfg.special.material === '__shell' ? cfg.shell.material : cfg.special.material;
    var OVD = { clay: 0, slate: 0, glass: 0.3, acrylic: 0.5, gourd: 0.3 }; cfg.special.overtone = OVD[bm] != null ? OVD[bm] : 1;
    if (bm === 'clay' || bm === 'slate') { cfg.special.thickness = Math.max(cfg.special.thickness, 24); }
    refreshPanelValues();
  }
  if (it.k === 'special.piece') {
    var pc0 = cfg.special.piece, sp0 = cfg.special;
    if ((pc0 === 'hihat' || pc0 === 'stack') && !sp0.bottom) sp0.bottom = clone(P['Hi-hats 14'].special.bottom);
    if (pc0 === 'hihat' || pc0 === 'stack') sp0.quality = sp0.quality || 'light';
    var match = Object.keys(P).filter(function (k) { return P[k].special && P[k].special.type === 'metal' && P[k].special.piece === pc0; })[0];
    if (match && confirmPieceDefaults) { var keep = sp0.quality; cfg.special = clone(P[match].special); if (keep) cfg.special.quality = keep; cfg.mallet = P[match].mallet; cfg.strike = Object.assign(cfg.strike, P[match].strike); }
    structural = true;
  }
  if (it.k === 'special.pedal') { sendMsg({ type: 'pedal', kind: cfg.special.pedal }); drawProfile(); }
  if (it.k === 'rollSpeed') { sendMsg({ type: 'cc', num: 1, v: (cfg.rollSpeed - 5) / 30 }); }
  if (it.k === 'mallet' || it.k === 'roll') structural = true;
  if (it.k === 'kind') {
    var ok = SHAPES[cfg.kind].map(function (x) { return x[0]; });
    if (ok.indexOf(cfg.shell.shape) < 0) cfg.shell.shape = cfg.kind === 'double' ? 'cylinder' : cfg.kind === 'none' ? 'kettle' : 'open';
    if (!cfg.batter) cfg.batter = clone(P[DEFAULT].batter);
  if (!cfg.special) cfg.special = { type: 'none' };
  if (!cfg.mics) cfg.mics = { close: 1, oh: 0.5, width: 0.6, height: 0.9, pan: 0 };
  if (isTg(cfg)) kbOct = Math.floor(cfg.special.root / 12);
    if (cfg.kind === 'shellhead') { var shm = E.shellHeadMat(E.SHELL_MATS[cfg.shell.material]); cfg.batter.thickness = shm.thick; cfg.batter.tension = 300; cfg.shell.hoop = cfg.shell.hoop || 'none'; }
    if (cfg.kind === 'none') { cfg.strike.mode = 'head'; var s0 = cfg.shell; if (s0.shape === 'kettle' || s0.shape === 'goblet') { s0.bowlDepth = s0.bowlDepth || Math.max(2, s0.diameter * 0.45); } if (s0.shape === 'goblet') { s0.portDiam = s0.portDiam || s0.diameter * 0.25; s0.portLen = s0.portLen || s0.diameter * 0.8; } }
    if (cfg.kind === 'double' && !cfg.reso) cfg.reso = { material: cfg.batter.material, thickness: cfg.batter.thickness, tension: cfg.batter.tension, muffle: 0, evenness: 0.9, hole: 0 };
  }
  if (it.k === 'shell.material' && cfg.kind === 'shellhead') { cfg.batter.thickness = E.shellHeadMat(E.SHELL_MATS[cfg.shell.material]).thick; structural = true; }
  if (it.k === 'shell.shape') {
    var s = cfg.shell;
    if (s.shape === 'goblet') { s.bowlDepth = s.bowlDepth || s.diameter * 0.8; s.portDiam = s.portDiam || s.diameter * 0.33; s.portLen = s.portLen || s.diameter * 0.8; s.depth = Math.max(s.depth, s.bowlDepth + s.portLen); }
    if (s.shape === 'kettle') { s.bowlDepth = s.bowlDepth || s.diameter * 0.7; s.portDiam = s.portDiam && s.portDiam < 2 ? s.portDiam : 1; }
    if (s.shape === 'frame' && s.depth > 6) s.depth = 3;
    if (s.shape === 'barrel') { if (s.bulge == null) s.bulge = 0.15; if (cfg.kind === 'single') s.bottomDia = Math.round(s.diameter * 0.75 * 4) / 4; else if (cfg.kind === 'shellhead') { s.bottomDia = s.bottomDia || s.diameter; s.portDiam = 3; } }
  }
  if (it.live) {
    if (it.k === 'mix.room' || it.k === 'mix.master' || it.k === 'mix.punch') applyBus();
    if (it.k === 'strike.r' || it.k === 'strike.mode') drawHead();
    if ((it.k === 'strike.mode' || it.k === 'strike.theta') && !kitMode) post({ type: 'stroke', mode: cfg.strike.mode, theta: cfg.strike.theta });
    if (it.k === 'strike.vel') syncVel();
    save(); return;
  }
  $('presetSel').value = '';
  if (structural) buildPanel();
  scheduleRebuild();
}
function save() { try { if (kitMode) { LS.setItem('drumlab.kit', JSON.stringify(kit)); LS.setItem('drumlab.mode', 'kit'); return; } LS.setItem('drumlab.mode', 'single'); LS.setItem('drumlab.cfg', JSON.stringify(cfg)); LS.setItem('drumlab.preset', presetName); } catch (e) {} }

// ---------------- model + audio ----------------
var rebuildT = null;
function scheduleRebuild() { clearTimeout(rebuildT); rebuildT = setTimeout(rebuild, 60); }
function rebuild() {
  if (kitMode) { model = kitModels[kitSel] = pieceModel(kitSel); }
  else { model = E.buildModel(cfg, SR); E.calibrate(model, SR); }
  sendCfg();
  computeShapes();
  refreshPanelValues();
  drawProfile(); drawHead(); fillReadouts(); fillModes(); buildPads(); syncHint();
  previewSpectrum();
  save();
}

var ctx = null, node = null, spVoice = null, busDry, busWet, master, conv, punch, makeup, parDry, engineKind = '';
function post(msg) { if (PLUG) { if (PLUG.live) PLUG.send(msg); return; } if (node && node.port) node.port.postMessage(msg); else if (spHost) spHost.msg(msg); }
function sendCfg() {
  if (!model) return;
  if (kitMode) { sendKitPiece(kitSel); return; }
  post({ type: 'cfg', cfg: cfg, gain: model.gain, tr: E.trimsOf(model) });
}
function sendPunch() { post({ type: 'punch', v: cfg.mix && cfg.mix.punch != null ? cfg.mix.punch : 0.35, kv: kit && kit.mix && kit.mix.punch != null ? kit.mix.punch : 0.35 }); }
function resendAll() { sendPunch(); if (kitMode) sendWholeKit(); else { post({ type: 'mode', kit: false }); sendCfg(); } }
// Studio live-room impulse response: pre-delay, discrete stereo early reflections, then a
// decorrelated diffuse tail whose highs die faster than its lows (like real wood/plaster rooms).
function makeIR(c, rt) {
  var sr = c.sampleRate, n = Math.round(sr * rt * 1.25), b = c.createBuffer(2, n, sr), seed = 99;
  function rnd() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2147483648 - 1; }
  var pre = Math.round(0.007 * sr);
  var bands = [{ fc: 300, rt: rt * 1.15 }, { fc: 2500, rt: rt }, { fc: 7000, rt: rt * 0.55 }, { fc: 16000, rt: rt * 0.28 }];
  for (var ch = 0; ch < 2; ch++) {
    var d = b.getChannelData(ch);
    // diffuse tail: white noise split into bands, each with its own exponential decay
    var lp = bands.map(function () { return 0; }), prev = 0;
    for (var i = pre; i < n; i++) {
      var t = (i - pre) / sr, x = rnd(), y = 0, lo = 0;
      for (var k = 0; k < bands.length; k++) {
        var g = 1 - Math.exp(-2 * Math.PI * bands[k].fc / sr); lp[k] += g * (x - lp[k]);
        var band = lp[k] - lo; lo = lp[k];
        y += band * Math.exp(-6.91 * t / bands[k].rt);
      }
      var fade = Math.min(1, t / 0.035);   // tail builds up after the early reflections
      d[i] = y * fade * fade * 0.55;
    }
    // early reflections: walls, floor and ceiling of a ~6 x 5 x 3 m room, different for each ear
    for (var e = 0; e < 18; e++) {
      var dly = 0.004 + 0.045 * Math.pow((e + 0.5 + 0.4 * rnd()) / 18, 1.3) + (ch ? 0.0011 * rnd() : 0);
      var idx = pre + Math.round(dly * sr), amp = 0.9 * Math.pow(0.82, e) * (rnd() < 0 ? -1 : 1) * (0.7 + 0.3 * Math.abs(rnd()));
      for (var j = 0; j < 24 && idx + j < n; j++) d[idx + j] += amp * Math.exp(-j / 4) * (j ? 0.35 : 1);   // slightly smeared (absorptive surfaces)
    }
  }
  // normalise energy so the room fader means the same thing at any length
  var E = 0; for (var c2 = 0; c2 < 2; c2++) { var dd = b.getChannelData(c2); for (var q = 0; q < n; q++) E += dd[q] * dd[q]; }
  var k2 = 1 / Math.sqrt(E / 2); for (var c3 = 0; c3 < 2; c3++) { var d3 = b.getChannelData(c3); for (var r = 0; r < n; r++) d3[r] *= k2 * 0.6; }
  return b;
}
function buildBus(c, dest) {
  var o = { dry: c.createGain(), wet: c.createGain(), master: c.createGain(), conv: c.createConvolver(), punch: c.createDynamicsCompressor(), makeup: c.createGain(), parDry: c.createGain() };
  o.conv.buffer = makeIR(c, 0.9);
  var sum = c.createGain(), roomHP = c.createBiquadFilter();
  roomHP.type = 'highpass'; roomHP.frequency.value = 120; roomHP.Q.value = 0.6;   // keep the room from muddying the low end
  var comp = c.createDynamicsCompressor();   // output safety limiter (the engine already limits each voice)
  comp.threshold.value = -1.5; comp.knee.value = 0; comp.ratio.value = 20; comp.attack.value = 0.0015; comp.release.value = 0.09;
  o.dry.connect(sum); o.wet.connect(roomHP); roomHP.connect(o.conv); o.conv.connect(sum);
  // the browser's compressor looks ahead ~6 ms (it delays its own output); delay the dry branch to match,
  // otherwise the two copies comb-filter and the attack doubles into a click
  sum.connect(o.parDry);   // punch now lives in the engine (same code as the plugin); o.punch/o.makeup stay unconnected
  var clip = c.createWaveShaper(), cv = new Float32Array(2049);   // last-resort soft clip: transparent below -1 dBFS, never exceeds 0 dBFS
  for (var ci = 0; ci < 2049; ci++) { var x = (ci - 1024) / 1024 * 1.5, ax = Math.abs(x), k = 0.85, top = 0.96; cv[ci] = ax <= k ? x : (x > 0 ? 1 : -1) * (k + (top - k) * Math.tanh((ax - k) / (top - k))); }
  clip.curve = cv; clip.oversample = '4x';
  var pre = c.createGain(), post = c.createGain(); pre.gain.value = 1 / 1.5; post.gain.value = 1;   // curve input spans ±1.5
  o.parDry.connect(o.master); o.makeup.connect(o.master); o.master.connect(comp); comp.connect(pre); pre.connect(clip); clip.connect(post); post.connect(dest);
  return o;
}
function setBus(o, mx, t) {
  o.wet.gain.setValueAtTime((mx.room || 0) * 0.9, t); o.dry.gain.setValueAtTime(1 - 0.3 * (mx.room || 0), t);
  o.master.gain.setValueAtTime(mx.master == null ? 0.85 : mx.master, t);
  var pu = mx.punch == null ? 0.35 : mx.punch;
  o.punch.threshold.value = -30; o.punch.ratio.value = 8; o.punch.knee.value = 6; o.punch.attack.value = 0.0008; o.punch.release.value = 0.12;
  o.makeup.gain.setValueAtTime(0, t); o.parDry.gain.setValueAtTime(1, t);
}
function applyBus() {
  if (PLUG) { var mp = (kitMode ? kit.mix : cfg.mix) || {}; post({ type: 'bus', room: mp.room || 0, master: mp.master == null ? 0.85 : mp.master }); sendPunch(); return; }
  if (!ctx) return; var t = ctx.currentTime, mx = (kitMode ? kit.mix : cfg.mix) || {};
  busWet.gain.setTargetAtTime((mx.room || 0) * 0.9, t, 0.02);
  busDry.gain.setTargetAtTime(1 - 0.3 * (mx.room || 0), t, 0.02);
  master.gain.setTargetAtTime(mx.master == null ? 0.85 : mx.master, t, 0.02);
  // punch = parallel ("New York") compression: a hard-squashed copy is blended under the untouched
  // signal, so the transients stay intact while the body and ring come up.
  var pu = mx.punch == null ? 0.35 : mx.punch;
  punch.threshold.setTargetAtTime(-30, t, 0.02); punch.ratio.setTargetAtTime(8, t, 0.02);
  punch.knee.value = 6; punch.attack.value = 0.0008; punch.release.value = 0.12;
  makeup.gain.setTargetAtTime(0, t, 0.02); parDry.gain.setTargetAtTime(1, t, 0.02);
  sendPunch();
}
function ensureAudio() {
  if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return Promise.resolve(); }
  var AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) { toast('Web Audio not available'); return Promise.reject(); }
  ctx = new AC({ latencyHint: 'interactive' });
  SR = ctx.sampleRate;
  var bus = buildBus(ctx, ctx.destination); busDry = bus.dry; busWet = bus.wet; master = bus.master; conv = bus.conv; punch = bus.punch; makeup = bus.makeup; parDry = bus.parDry;
  applyBus();
  if (!kitMode) { model = E.buildModel(cfg, SR); E.calibrate(model, SR); }
  var src = document.getElementById('engine-src').textContent;
  var proc = '\n' + APPLY_SRC + '\n' + HOST_SRC + '\nclass DrumProc extends AudioWorkletProcessor{constructor(){super();this.h=makeHost(sampleRate);' +
    'this.port.onmessage=e=>{this.h.msg(e.data);};}' +
    'process(i,o){const out=o[0];if(!out||!out[0])return true;this.h.process(out[0],out[0].length,out[1]||null);return true;}}' +
    'registerProcessor("drum-proc",DrumProc);';
  function useSP() {
    var sp = ctx.createScriptProcessor(512, 0, 2);
    spHost = makeHost(SR); spVoice = spHost.v; engineKind = 'ScriptProcessor (fallback)'; node = null; resendAll();
    sp.onaudioprocess = function (ev) { spHost.process(ev.outputBuffer.getChannelData(0), ev.outputBuffer.length, ev.outputBuffer.getChannelData(1)); };
    sp.connect(busDry); sp.connect(busWet); status(true);
  }
  var p;
  try {
    if (!ctx.audioWorklet) throw new Error('no worklet');
    var url = URL.createObjectURL(new Blob([src + proc], { type: 'application/javascript' }));
    p = ctx.audioWorklet.addModule(url).then(function () {
      node = new AudioWorkletNode(ctx, 'drum-proc', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
      node.connect(busDry); node.connect(busWet);
      engineKind = 'AudioWorklet'; resendAll(); status(true);
    }).catch(function (err) { console.warn("worklet failed, using ScriptProcessor:", err && err.message); useSP(); });
  } catch (e) { useSP(); p = Promise.resolve(); }
  ctx.resume();
  return p;
}
function status(live) {
  $('audioDot').className = 'dot' + (live ? ' live' : '');
  $('audioTxt').textContent = live ? engineKind + ' · ' + SR + ' Hz' : 'audio off — click Hit';
  fillReadouts();
}

// ---------------- performance messages (same API in the worklet and the future VST) ----------------
var APPLY_SRC = 'function applyMsg(p,d){switch(d.type){case "strike":p.strike(d.r,d.theta,d.vel,d.mode);break;case "tongue":p.strikeTongue(d.idx,d.vel);break;' +
  'case "on":p.noteOn(d.id,d.st);break;case "off":p.noteOff(d.id);break;case "press":p.pressure(d.id,d.v);break;case "cc":p.cc(d.num,d.v);break;' +
  'case "choke":p.choke(d.v);break;case "pedal":p.pedal(d.kind);break;case "panic":p.reset();break;}}';
var applyMsg = new Function('return ' + APPLY_SRC.replace('function applyMsg', 'function'))();
// engine host: one Player (single build) or one Kit, driven by the same messages in the worklet and in the fallback
var HOST_SRC = 'function makeHost(sr){var E=DrumEngine,h={v:new E.Player(sr),k:null,kit:false,R:new Float32Array(128)};' +
  'function bm(c,g,tr){var m=E.buildModel(c,sr);m.gain=g;if(tr)E.applyTrims(m,tr);return m;}' +
  'h.msg=function(d){switch(d.type){' +
  'case "cfg":h.v.setModel(bm(d.cfg,d.gain,d.tr));break;' +
  'case "mode":h.kit=!!d.kit;if(!h.kit&&h.k)h.k.reset();break;' +
  'case "kit":h.k=new E.Kit(sr);h.kit=true;d.pieces.forEach(function(p,i){h.k.setPiece(i,bm(p.cfg,p.gain,p.tr),{level:p.level,pan:p.pan});});h.k.setMap(d.map);h.k.symp=d.symp;if(h.pu)h.k.punch=h.pu.kv;break;' +
  'case "kpiece":if(h.k){h.k.setPiece(d.i,bm(d.cfg,d.gain,d.tr),{level:d.level,pan:d.pan});}break;' +
  'case "ktrim":if(h.k)h.k.trim(d.n);break;' +
  'case "kmix":if(h.k){d.mix.forEach(function(x,i){h.k.setMix(i,x.level,x.pan);});h.k.symp=d.symp;}break;' +
  'case "kmap":if(h.k)h.k.setMap(d.map);break;' +
  'case "kon":if(h.k)h.k.noteOn(d.note,d.vel);break;case "koff":if(h.k)h.k.noteOff(d.note);break;' +
  'case "kpress":if(h.k)h.k.pressure(d.note,d.v);break;case "kcc":if(h.k)h.k.cc(d.num,d.v);break;' +
  'case "punch":h.v.punch=d.v;if(h.k)h.k.punch=d.kv;h.pu=d;break;' +
  'case "panic":h.v.reset();if(h.k)h.k.reset();break;' +
  'default:applyMsg(h.v,d);}};' +
  'h.process=function(L,n,R){if(!R){if(h.R.length<n)h.R=new Float32Array(n);R=h.R;}if(h.kit&&h.k)h.k.process(L,n,R);else h.v.process(L,n,null,null,R);};return h;}';
var makeHost = new Function('DrumEngine', 'applyMsg', HOST_SRC + '; return makeHost;')(E, applyMsg);
var spHost = null;
function sendMsg(msg) {
  ensureAudio().then(function () { post(msg); }, function () {});
}
var confirmPieceDefaults = true, footDown = false, chokeHeld = false;
function holdMode() { return !!cfg.roll || (isMetal(cfg) && cfg.mallet === 'bow'); }
// start/stop a held note from any source (mouse, pad, key, MIDI). Single hits when not rolling/bowing.
function startNote(id, st) {
  if (window.__onNote) window.__onNote(st);   // test hook
  if (holdMode()) {
    sendMsg({ type: 'on', id: id, st: st });
    flash = st.tongue != null ? tongueFlash(st.tongue) : { r: st.r, theta: st.theta, t: performance.now() };
    if (!rafOn) { rafOn = true; requestAnimationFrame(loop); }
    return;
  }
  if (st.tongue != null) playTongue(st.tongue, st.vel); else strike(st.r, st.theta, st.vel, st.mode);
}
function endNote(id) { if (holdMode()) sendMsg({ type: 'off', id: id }); }
function tongueFlash(idx) { var t = model.tongues.filter(function (x) { return x.idx === idx; })[0]; return t ? { r: t.rb - 0.82 * t.ln, theta: t.th, t: performance.now() } : null; }
// ---------------- striking ----------------
function strike(r, theta, vel, mode, noVisual) {
  sendMsg({ type: 'strike', r: r, theta: theta, vel: vel, mode: mode });
  flash = { r: r, theta: theta, t: performance.now() };
  if (!noVisual) setTimeout(function () { visualHit({ r: r, theta: theta, vel: vel, mode: mode }); }, 0);
  else drawHead();
}
function hitMarker(mode, vel) {
  if (isTg(cfg) && model && model.tongues) { var ts = sortedTongues(); playTongue(ts[0].idx, vel == null ? cfg.strike.vel : vel); return; }
  var s = cfg.strike; strike(s.r, s.theta, vel == null ? s.vel : vel, mode || s.mode);
}
function sortedTongues() { return model.tongues.slice().sort(function (x, y) { return x.note - y.note; }); }
function playTongue(idx, vel, noVisual) {
  sendMsg({ type: 'tongue', idx: idx, vel: vel });
  var t = model.tongues.filter(function (x) { return x.idx === idx; })[0];
  if (t) flash = { r: t.rb - 0.82 * t.ln, theta: t.th, t: performance.now() };
  lightPad('t' + idx);
  if (!noVisual) setTimeout(function () { visualHit({ tongue: idx, vel: vel }); }, 0); else drawHead();
}
function nearestTongue(note) {
  var best = null, bd = 1e9; model.tongues.forEach(function (t) { var d = Math.abs(t.note - note); if (d < bd) { bd = d; best = t; } }); return best;
}
var KEY_MODES = ['head', 'rimshot', 'rimclick', 'rim'];
// B together with another key = one rimshot where that key lands. A B just after a head stroke adds the hoop crack
// (the plugin engine plays it as the hoop half of a rimshot; in the browser it is a plain rim hit on top)
var chordT = { head: -1e9, b: -1e9 };
function chordStroke(pc, st) {
  if (!st || isMetal(cfg) || isTg(cfg) || cfg.kind === 'none') return st;
  var now = performance.now();
  if (pc === 11) { chordT.b = now; if (now - chordT.head < 40) return { r: st.r, theta: st.theta, vel: st.vel, mode: PLUG ? 'hoop' : 'rim' }; return st; }
  chordT.head = now; return st;
}
// Regular drum: one octave of keys spans the head. C = dead centre ... A# = near the edge, B = the bare rim.
function drumKeySt(pc, vel) {
  var s = cfg.strike;
  return pc === 11 ? { r: 0.97, theta: s.theta, vel: vel, mode: 'rim' } : { r: pc / 10 * 0.95, theta: s.theta, vel: vel, mode: KEY_MODES.indexOf(s.mode) >= 0 ? s.mode : 'head' };   // keys play the stroke type chosen in the builder
}
// Cymbals: one octave runs bell -> edge. White keys = stick tip, black keys = shoulder (crash-style).
function metalPos(pc) {
  var rb = isMetal(cfg) && cfg.special.top ? Math.min(0.5, (cfg.special.top.bellDia || 0) / Math.max(1, cfg.special.top.diameter || 16)) : 0.3;
  var R = [0.03, rb * 0.6, Math.max(0.12, rb * 0.95), 0.35, 0.42, 0.52, 0.6, 0.67, 0.78, 0.82, 0.97, 0.94];
  var shoulder = [1, 3, 6, 8, 10].indexOf(pc) >= 0;
  return { r: R[pc], mode: shoulder ? 'shoulder' : 'head' };
}
function metalKeySt(pc, vel) { var p = metalPos(pc); return { r: p.r, theta: cfg.strike.theta, vel: vel, mode: p.mode }; }
function keySt(pc, vel) { return isMetal(cfg) ? metalKeySt(pc, vel) : drumKeySt(pc, vel); }
function drumKey(pc, vel) { lightPad('k' + pc); var st = chordStroke(pc, keySt(pc, vel)); strike(st.r, st.theta, st.vel, st.mode); }
function noteSt(note, vel) {
  if (isTg(cfg) && model && model.tongues) { var t = nearestTongue(note); if (t && isBars(cfg) && t.note !== note) return null; return t ? { tongue: t.idx, vel: vel } : null; }   // bars: keys outside the instrument's range stay silent
  if (cfg.kind === 'none' && !isMetal(cfg)) return null;
  var pc = ((note % 12) + 12) % 12; return chordStroke(pc, keySt(pc, vel));
}
function playNote(note, vel) { var st = noteSt(note, vel); if (st) { if (st.tongue != null) playTongue(st.tongue, vel); else strike(st.r, st.theta, st.vel, st.mode); } }
function setChoke(v) { chokeHeld = v > 0; sendMsg({ type: 'choke', v: v }); lightPad('choke'); }
function pedalAct(kind) { if (kind === 'down') footDown = true; if (kind === 'up') footDown = false; sendMsg({ type: 'pedal', kind: kind }); lightPad('ped-' + kind); drawProfile(); }

// ---------------- head canvas: mode shapes + animation ----------------
var G = 112, flash = null, anim = null;
function computeShapes() {
  var Bm = model.B.modes, list = [];
  for (var i = 0; i < Bm.length; i++) {
    var md = Bm[i]; if (md.f > 6000 || md.proxy) continue;
    var a = new Float32Array(G * G);
    for (var y = 0; y < G; y++) for (var x = 0; x < G; x++) {
      var px = (x + 0.5) / G * 2 - 1, py = (y + 0.5) / G * 2 - 1, rr = Math.sqrt(px * px + py * py);
      if (rr > 1) continue;
      a[y * G + x] = E.modeShape(md, rr, Math.atan2(py, px));
    }
    list.push({ idx: i, a: a, f: md.f });
  }
  shapes = list;
}
var headCv = $('headCv'), hctx = headCv.getContext('2d'), fieldCv = document.createElement('canvas');
fieldCv.width = G; fieldCv.height = G; var fctx = fieldCv.getContext('2d'), fimg = fctx.createImageData(G, G);
function sizeCanvas(cv) { var r = cv.getBoundingClientRect(), d = window.devicePixelRatio || 1; var w = Math.max(10, Math.round(r.width * d)), h = Math.max(10, Math.round(r.height * d)); if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; } return { w: w, h: h, d: d }; }
function visualHit(st) {
  if (!model) return;
  // Slow motion chosen so the lowest mode swings ~1.2 times per second on screen,
  // and only modes slow enough to draw smoothly (>= ~5 screen frames per cycle) are shown.
  var f1 = Math.min.apply(null, model.B.modes.filter(function (x) { return !x.proxy; }).map(function (x) { return x.f; }));
  var slow = Math.max(12, Math.min(500, f1 / 1.2));
  var DISP = 3600, simSec = DISP / 1000 / slow, need = Math.ceil(simSec * SR) + 2;
  var every = Math.max(1, Math.floor(need / 3000));
  var snap = { every: every, arr: [], max: Math.ceil(need / every) + 2 };
  var m = E.buildModel(cfg); m.gain = model.gain; E.applyTrims(m, E.trimsOf(model));
  var out = E.renderHit(m, SR, st, Math.max(0.4, simSec + 0.01), snap);
  var fMax = 12 * slow;   // 60 fps / 5 frames per cycle
  var wts = shapes.map(function (s) { var x = s.f / fMax; return x >= 1 ? 0 : (1 - x * x); });
  anim = { snaps: snap.arr, every: every, slow: slow, t0: performance.now(), dur: DISP, wts: wts, norm: 0, peak: 0 };
  drawSpectrum(out);
  if (!rafOn) { rafOn = true; requestAnimationFrame(loop); }
}
var rafOn = false;
function loop(now) {
  drawHead(now);
  if ((anim && now - anim.t0 < anim.dur + 600) || (flash && now - flash.t < 900)) requestAnimationFrame(loop); else { rafOn = false; anim = null; drawHead(); }
}
function lugCount(d) { return Math.max(6, Math.min(16, Math.round(d / 1.5 / 2) * 2)); }
function drawHead(now) {
  now = now || performance.now();
  var S = sizeCanvas(headCv), W = S.w, H = S.h, c = hctx, d = S.d;
  var cx = W / 2, cy = H / 2, R = Math.min(W, H) * 0.40;
  c.clearRect(0, 0, W, H);
  var SM = E.SHELL_MATS[cfg.shell.material] || E.SHELL_MATS.maple;
  $('headTitle').textContent = cfg.kind === 'none' ? 'Body · top view' : cfg.kind === 'shellhead' ? 'Shell head' : 'Batter head';
  if (cfg.kind === 'none') { drawVessel(c, cx, cy, R, d, SM, now); drawMarker(c, cx, cy, R, d, now); return; }
  if (isBars(cfg) && model && model.tongues) { drawBarsTop(c, W, H, d, now); return; }
  if (isTg(cfg) && model && model.tongues) { drawTongueTop(c, cx, cy, R, d, SM, now); return; }
  if (isMetal(cfg)) { drawCymbalTop(c, cx, cy, R, d, now); return; }
  var hm = cfg.kind === 'shellhead' ? E.shellHeadMat(SM) : (E.HEAD_MATS[cfg.batter.material] || E.HEAD_MATS.mylar_clear), hp = cfg.shell.hoop || 'none';
  // shell edge below
  c.beginPath(); c.arc(cx, cy, R * 1.07, 0, 7); c.fillStyle = SM.color; c.fill();
  c.beginPath(); c.arc(cx, cy, R * 1.07, 0, 7); c.strokeStyle = 'rgba(0,0,0,.35)'; c.lineWidth = 2 * d; c.stroke();
  // lugs / lacing
  if (hp !== 'none') {
    var n = lugCount(cfg.shell.diameter);
    for (var i = 0; i < n; i++) {
      var a = i / n * Math.PI * 2 + Math.PI / n;
      c.save(); c.translate(cx + Math.cos(a) * R * 1.16, cy + Math.sin(a) * R * 1.16); c.rotate(a);
      c.fillStyle = hp === 'wood' ? '#3a3127' : '#9aa0a6'; c.fillRect(-R * 0.05, -R * 0.035, R * 0.1, R * 0.07);
      c.restore();
    }
  } else if (cfg.kind !== 'shellhead') {
    c.strokeStyle = 'rgba(232,220,196,.75)'; c.lineWidth = 1.4 * d; c.beginPath();
    var nz = 26;
    for (var k = 0; k <= nz * 2; k++) { var aa = k / (nz * 2) * Math.PI * 2, rr = k % 2 ? R * 1.2 : R * 1.04; var X = cx + Math.cos(aa) * rr, Y = cy + Math.sin(aa) * rr; k ? c.lineTo(X, Y) : c.moveTo(X, Y); }
    c.stroke();
  }
  // hoop
  if (hp !== 'none') { c.beginPath(); c.arc(cx, cy, R * 1.04, 0, 7); c.strokeStyle = (E.HOOPS[hp] || {}).color || '#aaa'; c.lineWidth = R * 0.055; c.stroke(); }
  // head
  var g = c.createRadialGradient(cx - R * 0.3, cy - R * 0.35, R * 0.1, cx, cy, R);
  g.addColorStop(0, shade(hm.color, 1.08)); g.addColorStop(1, shade(hm.color, 0.82));
  c.beginPath(); c.arc(cx, cy, R, 0, 7); c.fillStyle = g; c.globalAlpha = Math.max(0.35, hm.alpha); c.fill(); c.globalAlpha = 1;
  if (hm.alpha < 1) { c.beginPath(); c.arc(cx, cy, R, 0, 7); c.fillStyle = 'rgba(20,18,16,' + (1 - hm.alpha) * 0.8 + ')'; c.fill(); }
  drawMotion(c, cx, cy, R);
  drawMarker(c, cx, cy, R, d, now, hm);
}
function rng(seed) { var s = seed >>> 0 || 1; return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function drawCymbalTop(c, cx, cy, R, d, now) {
  var sp = cfg.special, t = sp.top || {}, A = E.ALLOYS[t.alloy] || E.ALLOYS.b20, piece = sp.piece;
  $('headTitle').textContent = (E.PIECES[piece] || 'Cymbal') + ' · top view';
  // grab zone
  c.setLineDash([3 * d, 5 * d]); c.strokeStyle = chokeHeld ? 'rgba(224,106,74,.9)' : 'rgba(236,228,214,.18)'; c.lineWidth = 1.2 * d;
  c.beginPath(); c.arc(cx, cy, R * 1.1, 0, 7); c.stroke(); c.setLineDash([]);
  if (piece === 'cowbell') {
    c.save(); c.translate(cx, cy); var w = R * 0.85, h = R * 0.55;
    var g0 = c.createLinearGradient(-w, -h, w, h); g0.addColorStop(0, shade(A.color, 1.25)); g0.addColorStop(1, shade(A.color, 0.6));
    c.fillStyle = g0; c.beginPath(); c.moveTo(-w, -h * 0.6); c.lineTo(w, -h); c.lineTo(w, h); c.lineTo(-w, h * 0.6); c.closePath(); c.fill();
    c.fillStyle = 'rgba(10,8,6,.85)'; c.beginPath(); c.moveTo(w * 0.92, -h * 0.9); c.lineTo(w * 0.92, h * 0.9); c.lineTo(w * 0.8, h * 0.85); c.lineTo(w * 0.8, -h * 0.85); c.fill();
    c.restore(); drawMotion(c, cx, cy, R); drawMarker(c, cx, cy, R, d, now); return;
  }
  if (piece === 'bell') {
    var gb = c.createRadialGradient(cx - R * 0.3, cy - R * 0.3, R * 0.05, cx, cy, R);
    gb.addColorStop(0, shade(A.color, 1.35)); gb.addColorStop(0.7, shade(A.color, 0.85)); gb.addColorStop(1, shade(A.color, 0.6));
    c.beginPath(); c.arc(cx, cy, R, 0, 7); c.fillStyle = gb; c.fill();
    c.beginPath(); c.arc(cx, cy, R * 0.28, 0, 7); c.fillStyle = shade(A.color, 0.5); c.fill();
    drawMotion(c, cx, cy, R); drawMarker(c, cx, cy, R, d, now); return;
  }
  if (mPair(cfg)) { c.beginPath(); c.arc(cx + 3 * d, cy + 5 * d, R * Math.min(1.08, (sp.bottom.diameter || t.diameter) / t.diameter), 0, 7); c.fillStyle = shade((E.ALLOYS[sp.bottom.alloy] || A).color, 0.45); c.fill(); }
  var g = c.createRadialGradient(cx - R * 0.35, cy - R * 0.4, R * 0.02, cx, cy, R * 1.02);
  g.addColorStop(0, shade(A.color, 1.45)); g.addColorStop(0.45, shade(A.color, 1.0)); g.addColorStop(0.8, shade(A.color, 0.78)); g.addColorStop(1, shade(A.color, 1.1));
  c.beginPath(); c.arc(cx, cy, R, 0, 7); c.fillStyle = g; c.fill();
  // lathing: fine concentric tonal grooves
  var nl = Math.round(8 + (t.lathe || 0) * 90);
  if ((t.lathe || 0) > 0.03) for (var i = 0; i < nl; i++) { var rr = R * (0.08 + 0.9 * i / nl); c.beginPath(); c.arc(cx, cy, rr, 0, 7); c.strokeStyle = i % 2 ? 'rgba(255,240,200,.07)' : 'rgba(40,25,10,.09)'; c.lineWidth = Math.max(0.6, R / nl * 0.5); c.stroke(); }
  // hammer marks
  var rnd = rng(1234 + Math.round((t.hammer || 0) * 100)), nh = Math.round((t.hammer || 0) * 260);
  for (var k = 0; k < nh; k++) { var ra = R * (0.12 + 0.86 * Math.sqrt(rnd())), an = rnd() * 6.283, x = cx + Math.cos(an) * ra, y = cy + Math.sin(an) * ra, sz = R * (0.012 + 0.02 * rnd());
    c.beginPath(); c.ellipse(x, y, sz, sz * 0.6, an, 0, 7); c.fillStyle = rnd() < 0.5 ? 'rgba(30,18,6,.16)' : 'rgba(255,235,190,.14)'; c.fill(); }
  // flange (china)
  if ((t.flange || 0) > 0.05) { c.beginPath(); c.arc(cx, cy, R * 0.97, 0, 7); c.lineWidth = R * 0.13 * t.flange; c.strokeStyle = 'rgba(20,12,4,' + (0.15 + 0.3 * t.flange) + ')'; c.stroke(); }
  // gong rim
  if (mIs('tamtam', 'opera', 'nipple')(cfg) && (sp.rim || 0) > 0.05) { c.beginPath(); c.arc(cx, cy, R * 0.97, 0, 7); c.lineWidth = R * 0.07; c.strokeStyle = 'rgba(15,10,5,.45)'; c.stroke(); }
  // bell / boss
  var rbf = Math.min(0.6, (t.bellDia || 0) / Math.max(1, t.diameter || 16));
  if (rbf > 0.02 && (t.bellHeight || 0) > 0.5) {
    var gc = c.createRadialGradient(cx - R * rbf * 0.35, cy - R * rbf * 0.4, 1, cx, cy, R * rbf);
    gc.addColorStop(0, shade(A.color, 1.6)); gc.addColorStop(0.75, shade(A.color, 1.0)); gc.addColorStop(1, shade(A.color, 0.55));
    c.beginPath(); c.arc(cx, cy, R * rbf, 0, 7); c.fillStyle = gc; c.fill();
  }
  // holes, rivets, chain
  var nho = t.holes || 0; for (var hI = 0; hI < nho; hI++) { var ha = 6.283 * hI / nho + 0.3; c.beginPath(); c.arc(cx + Math.cos(ha) * R * 0.68, cy + Math.sin(ha) * R * 0.68, R * 0.06, 0, 7); c.fillStyle = '#141210'; c.fill(); }
  var nr = t.rivets || 0; for (var rI = 0; rI < nr; rI++) { var ra2 = 6.283 * rI / nr + 0.2; c.beginPath(); c.arc(cx + Math.cos(ra2) * R * 0.88, cy + Math.sin(ra2) * R * 0.88, R * 0.018, 0, 7); c.fillStyle = '#e8e2d2'; c.fill(); }
  if (t.chain) { c.strokeStyle = '#d8d4c8'; c.lineWidth = 1.4 * d; for (var cI = 0; cI < 14; cI++) { var ca = -1.2 + cI * 0.12; c.beginPath(); c.ellipse(cx + Math.cos(ca) * R * 0.62, cy + Math.sin(ca) * R * 0.62, 3.5 * d, 2 * d, ca + 1.57, 0, 7); c.stroke(); } }
  // centre hole / felt
  c.beginPath(); c.arc(cx, cy, Math.max(3 * d, R * 0.035), 0, 7); c.fillStyle = '#141210'; c.fill();
  drawMotion(c, cx, cy, R);
  drawMarker(c, cx, cy, R, d, now);
  c.fillStyle = 'rgba(236,228,214,.4)'; c.font = (10 * d) + 'px IBM Plex Mono, monospace'; c.textAlign = 'center'; c.fillText(chokeHeld ? 'grabbed' : 'hold here to grab / choke', cx, cy - R * 1.13);
}
function tongueMat() { var sp = cfg.special || {}; return sp.material && sp.material !== '__shell' && E.SHELL_MATS[sp.material] ? E.SHELL_MATS[sp.material] : (E.SHELL_MATS[cfg.shell.material] || E.SHELL_MATS.steel); }
function drawTongueTop(c, cx, cy, R, d, SM, now) {
  var TM = tongueMat(), metal = TM.E > 50e9;
  $('headTitle').textContent = 'Tongue drum · top plate';
  c.beginPath(); c.arc(cx, cy, R * 1.05, 0, 7); c.fillStyle = shade(SM.color, 0.65); c.fill();
  var g = c.createRadialGradient(cx - R * 0.3, cy - R * 0.35, R * 0.05, cx, cy, R);
  g.addColorStop(0, shade(TM.color, metal ? 1.3 : 1.08)); g.addColorStop(0.6, shade(TM.color, metal ? 0.9 : 0.95)); g.addColorStop(1, shade(TM.color, metal ? 1.15 : 0.85));
  c.beginPath(); c.arc(cx, cy, R, 0, 7); c.fillStyle = g; c.fill();
  drawMotion(c, cx, cy, R);
  c.lineJoin = 'round';
  model.tongues.forEach(function (t) {
    var rb = t.rb * R, rt = (t.rb - t.ln) * R, hw = t.hw, gap = 2.2 * d;
    var a0 = t.th - hw, a1 = t.th + hw, rTip = Math.max(rt, 2 * d);
    c.beginPath();
    c.moveTo(cx + Math.cos(a0) * rb, cy + Math.sin(a0) * rb);
    c.lineTo(cx + Math.cos(a0) * rTip, cy + Math.sin(a0) * rTip);
    c.arc(cx, cy, rTip, a0, a1, false);
    c.lineTo(cx + Math.cos(a1) * rb, cy + Math.sin(a1) * rb);
    c.strokeStyle = t.tooLong ? '#e06a4a' : 'rgba(10,8,6,.85)'; c.lineWidth = gap; c.stroke();
    var lit = padLit['t' + t.idx]; if (lit) { var k = Math.max(0, 1 - (now - lit) / 900); if (k > 0) { c.fillStyle = 'rgba(255,215,140,' + (0.35 * k) + ')'; c.beginPath(); c.moveTo(cx + Math.cos(a0) * rb, cy + Math.sin(a0) * rb); c.lineTo(cx + Math.cos(a0) * rTip, cy + Math.sin(a0) * rTip); c.arc(cx, cy, rTip, a0, a1, false); c.lineTo(cx + Math.cos(a1) * rb, cy + Math.sin(a1) * rb); c.closePath(); c.fill(); } }
    var lr = (t.rb - t.ln * 0.5) * R;
    c.fillStyle = metal ? 'rgba(20,20,24,.75)' : 'rgba(25,15,8,.75)'; c.font = '600 ' + Math.round(Math.max(9, Math.min(13, 300 / model.tongues.length + 4)) * d) + 'px IBM Plex Mono, monospace'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(NOTE[t.note % 12] + (Math.floor(t.note / 12) - 1), cx + Math.cos(t.th) * lr, cy + Math.sin(t.th) * lr);
  });
  c.textBaseline = 'alphabetic';
  if (flash) { var ft = Math.max(0, (now - flash.t) / 400); if (ft < 1) { c.strokeStyle = 'rgba(255,230,180,' + (1 - ft) + ')'; c.lineWidth = 2 * d; c.beginPath(); c.arc(cx + Math.cos(flash.theta) * flash.r * R, cy + Math.sin(flash.theta) * flash.r * R, (6 + ft * 30) * d, 0, 7); c.stroke(); } }
}
var barRects = [];
// marimba-style keyboard: naturals in front, sharps/flats raised behind, tube resonators hanging under each bar
function barLayout(W, H, d) {
  var ts = sortedTongues(), nat = ts.filter(function (t) { return [1, 3, 6, 8, 10].indexOf(t.note % 12) < 0; });
  var nN = Math.max(1, nat.length), pad = 14 * d, slot = (W - 2 * pad) / nN, maxL = ts.reduce(function (m, t) { return Math.max(m, t.L); }, 0.01);
  var rowH = H * 0.42, out = [], ni = 0;
  ts.forEach(function (t) {
    var acc = [1, 3, 6, 8, 10].indexOf(t.note % 12) >= 0, len = rowH * (0.45 + 0.55 * t.L / maxL), bw = Math.max(3 * d, slot * 0.82);
    var xc = acc ? pad + (ni) * slot : pad + (ni + 0.5) * slot; if (!acc) ni++;
    var y = acc ? H * 0.06 + (rowH - len) * 0.5 : H * 0.52 + (rowH - len) * 0.5;
    out.push({ t: t, x: xc - bw / 2, y: y, w: bw, h: len, acc: acc });
  });
  return out;
}
function drawBarsTop(c, W, H, d, now) {
  var TM = tongueMat(), metal = TM.E > 50e9, res = cfg.special.resonators == null ? 0.8 : cfg.special.resonators;
  $('headTitle').textContent = (cfg.special.tuning === 'xylo' ? 'Xylophone' : metal ? 'Vibraphone-style bars' : 'Marimba') + ' · keyboard';
  var L = barLayout(W, H, d); barRects = [];
  c.fillStyle = 'rgba(30,22,14,.55)'; c.fillRect(6 * d, H * 0.06 + H * 0.21 - 3 * d, W - 12 * d, 6 * d); c.fillRect(6 * d, H * 0.52 + H * 0.21 - 3 * d, W - 12 * d, 6 * d);   // rails
  L.forEach(function (b) {
    var t = b.t;
    if (res > 0.02) { c.fillStyle = 'rgba(190,170,120,' + (0.10 + 0.18 * res) + ')'; c.fillRect(b.x + b.w * 0.2, b.y + b.h * 0.5, b.w * 0.6, b.h * 0.5 + 6 * d); }
    var g = c.createLinearGradient(b.x, 0, b.x + b.w, 0);
    g.addColorStop(0, shade(TM.color, metal ? 0.8 : 0.85)); g.addColorStop(0.5, shade(TM.color, metal ? 1.35 : 1.12)); g.addColorStop(1, shade(TM.color, metal ? 0.85 : 0.8));
    c.fillStyle = g; c.beginPath(); if (c.roundRect) c.roundRect(b.x, b.y, b.w, b.h, 2.5 * d); else c.rect(b.x, b.y, b.w, b.h); c.fill();
    c.strokeStyle = t.tooLong ? '#e06a4a' : 'rgba(0,0,0,.45)'; c.lineWidth = 1 * d; c.stroke();
    // nodal cord holes at 22.4% and 77.6% of the length
    c.fillStyle = 'rgba(15,10,6,.7)'; [0.224, 0.776].forEach(function (u) { c.beginPath(); c.arc(b.x + b.w / 2, b.y + b.h * u, Math.max(1, b.w * 0.09), 0, 7); c.fill(); });
    var lit = padLit['t' + t.idx]; if (lit) { var k = Math.max(0, 1 - (now - lit) / 700); if (k > 0) { c.fillStyle = 'rgba(255,215,140,' + (0.45 * k) + ')'; c.fillRect(b.x, b.y, b.w, b.h); } }
    if (b.w > 9 * d) { c.save(); c.translate(b.x + b.w / 2, b.y + b.h * 0.5); c.rotate(-Math.PI / 2); c.fillStyle = metal ? 'rgba(20,20,24,.8)' : 'rgba(255,240,220,.75)';
      c.font = '600 ' + Math.round(Math.min(11, b.w * 0.55 / d) * d) + 'px IBM Plex Mono, monospace'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(NOTE[t.note % 12] + (Math.floor(t.note / 12) - 1), 0, 0); c.restore(); }
    barRects.push({ idx: t.idx, x: b.x, y: b.y, w: b.w, h: b.h });
  });
  c.textBaseline = 'alphabetic';
}
function drawBarSection(c, W, H, d) {
  var ts = sortedTongues(), t = ts[0], TM = tongueMat(), res = cfg.special.resonators == null ? 0.8 : cfg.special.resonators, amt = cfg.special.overtone == null ? 1 : cfg.special.overtone;
  var sc = (W - 60 * d) / t.L, x0 = 30 * d, y0 = H * 0.32, hh = Math.max(6 * d, (cfg.special.thickness || 20) / 1000 * sc * 1.6), L = t.L * sc;
  c.fillStyle = 'rgba(236,228,214,.55)'; c.font = (10 * d) + 'px IBM Plex Mono, monospace'; c.textAlign = 'left';
  c.fillText('lowest bar · ' + NOTE[t.note % 12] + (Math.floor(t.note / 12) - 1) + ' · ' + (t.L * 100).toFixed(1) + ' cm · side view', x0, 16 * d);
  // bar with an undercut arch (deeper = more tuned overtones)
  c.beginPath(); c.moveTo(x0, y0); c.lineTo(x0 + L, y0); c.lineTo(x0 + L, y0 + hh);
  for (var i = 20; i >= 0; i--) { var u = i / 20, arch = amt * 0.55 * hh * Math.sin(Math.PI * Math.min(1, Math.max(0, (u - 0.12) / 0.76))); c.lineTo(x0 + u * L, y0 + hh - arch); }
  c.closePath(); c.fillStyle = TM.color; c.fill(); c.strokeStyle = 'rgba(0,0,0,.5)'; c.lineWidth = 1 * d; c.stroke();
  c.fillStyle = 'rgba(20,14,8,.85)'; [0.224, 0.776].forEach(function (u) { c.beginPath(); c.arc(x0 + u * L, y0 + hh * 0.35, 2.5 * d, 0, 7); c.fill(); });
  if (res > 0.02) {   // quarter-wave tube under the bar, tuned to the fundamental
    var tubeL = Math.min(H * 0.55, (343 / (4 * t.f)) * sc), tw = Math.min(L * 0.5, 40 * d);
    c.fillStyle = 'rgba(190,170,120,' + (0.25 + 0.4 * res) + ')'; c.fillRect(x0 + L / 2 - tw / 2, y0 + hh + 8 * d, tw, tubeL);
    c.fillStyle = 'rgba(236,228,214,.55)'; c.fillText('resonator ' + (343 / (4 * t.f) * 100).toFixed(0) + ' cm', x0 + L / 2 + tw / 2 + 6 * d, y0 + hh + 20 * d);
  }
}
function drawVessel(c, cx, cy, R, d, SM, now) {
  var sh = cfg.shell, metal = SM.E > 50e9;
  var tube = sh.shape === 'open' || sh.shape === 'frame';
  c.beginPath(); c.arc(cx, cy, R * 1.04, 0, 7); c.fillStyle = shade(SM.color, 0.7); c.fill();
  var g = c.createRadialGradient(cx - R * 0.25, cy - R * 0.3, R * 0.05, cx, cy, R);
  if (tube) { g.addColorStop(0, '#0d0b09'); g.addColorStop(0.78, '#15110e'); g.addColorStop(0.86, shade(SM.color, 0.55)); g.addColorStop(1, shade(SM.color, 1.1)); }
  else { g.addColorStop(0, shade(SM.color, metal ? 1.3 : 0.75)); g.addColorStop(0.55, shade(SM.color, metal ? 0.85 : 0.9)); g.addColorStop(1, shade(SM.color, metal ? 1.2 : 1.05)); }
  c.beginPath(); c.arc(cx, cy, R, 0, 7); c.fillStyle = g; c.fill();
  if (sh.shape === 'goblet') { c.beginPath(); c.arc(cx, cy, R * 0.3, 0, 7); c.fillStyle = 'rgba(0,0,0,.35)'; c.fill(); }
  c.beginPath(); c.arc(cx, cy, R * 1.02, 0, 7); c.strokeStyle = shade(SM.color, metal ? 1.4 : 1.15); c.lineWidth = Math.max(2 * d, R * 0.03); c.stroke();
  drawMotion(c, cx, cy, R);
  c.fillStyle = 'rgba(236,228,214,.45)'; c.font = (10 * d) + 'px IBM Plex Mono, monospace'; c.textAlign = 'center';
  c.fillText('rim', cx, cy - R * 1.09); c.fillText(sh.shape === 'goblet' ? 'stem' : tube ? 'bottom edge' : 'bottom', cx, cy + 4 * d);
}
function drawMotion(c, cx, cy, R) {
  var now = performance.now();
  if (anim && shapes) {
    var pos = Math.max(0, (now - anim.t0) / 1000 / anim.slow * SR / anim.every);
    var fi = Math.min(anim.snaps.length - 2, Math.floor(pos)), fr2 = anim.snaps[fi + 1], fa = Math.min(1, pos - fi);
    var fade = now - anim.t0 > anim.dur ? Math.max(0, 1 - (now - anim.t0 - anim.dur) / 600) : 1;
    var fr = anim.snaps[Math.max(0, fi)], data = fimg.data, sc, N = G * G, field = new Float32Array(N);
    for (var s = 0; s < shapes.length; s++) {
      var wt = anim.wts[s]; if (!wt) continue;
      var id = shapes[s].idx, q = (fr[id] + ((fr2 ? fr2[id] : fr[id]) - fr[id]) * fa) * wt; if (!q) continue;
      var arr = shapes[s].a; for (var j = 0; j < N; j++) field[j] += q * arr[j];
    }
    var fmx = 1e-12; for (var j1 = 0; j1 < N; j1++) { var aj = field[j1] < 0 ? -field[j1] : field[j1]; if (aj > fmx) fmx = aj; }
    // smooth envelope (fast attack, slow release) so brightness doesn't pump each cycle
    anim.norm = fmx > anim.norm ? fmx : anim.norm * 0.985 + fmx * 0.015;
    anim.peak = Math.max(anim.peak, fmx);
    sc = 1 / Math.max(anim.norm * 1.1, anim.peak * 0.08);
    for (var j2 = 0; j2 < N; j2++) {
      var v = field[j2] * sc, o = j2 * 4, av = Math.min(1, Math.abs(v));
      if (v > 0) { data[o] = 214; data[o + 1] = 70 + 50 * (1 - av); data[o + 2] = 24; }
      else { data[o] = 24; data[o + 1] = 92 + 40 * (1 - av); data[o + 2] = 178; }
      data[o + 3] = Math.round(240 * Math.pow(av, 0.6) * fade);
    }
    fctx.putImageData(fimg, 0, 0);
    c.save(); c.beginPath(); c.arc(cx, cy, R, 0, 7); c.clip(); c.imageSmoothingEnabled = true;
    c.drawImage(fieldCv, cx - R, cy - R, 2 * R, 2 * R); c.restore();
    $('motionLbl').textContent = 't = ' + (pos * anim.every / SR * 1000).toFixed(1) + ' ms · 1/' + Math.round(anim.slow) + '× speed';
  } else $('motionLbl').textContent = 'click to strike · motion shown in slow motion';
}
function drawMarker(c, cx, cy, R, d, now, hm) {
  // snare strings for single-head (bendir)
  if (hm && cfg.snare && cfg.snare.on && cfg.kind === 'single') { c.strokeStyle = 'rgba(40,30,20,.35)'; c.lineWidth = 1 * d; for (var sl = -2; sl <= 2; sl++) { c.beginPath(); c.moveTo(cx - R * 0.98, cy + sl * R * 0.03); c.lineTo(cx + R * 0.98, cy + sl * R * 0.03); c.stroke(); } }
  // rings for strike-position reference
  c.strokeStyle = 'rgba(0,0,0,.12)'; c.lineWidth = 1 * d;
  [0.25, 0.5, 0.75].forEach(function (k) { c.beginPath(); c.arc(cx, cy, R * k, 0, 7); c.stroke(); });
  // marker
  var st = (kitMode && kitSlotMarker()) || cfg.strike, mr = st.mode === 'rim' ? 1.06 : st.r, mx = cx + Math.cos(st.theta) * mr * R, my = cy + Math.sin(st.theta) * mr * R;
  c.strokeStyle = '#1b140a'; c.lineWidth = 2.5 * d; c.beginPath(); c.arc(mx, my, 9 * d, 0, 7); c.stroke();
  c.strokeStyle = st.mode === 'head' ? '#e0a94a' : '#e06a4a'; c.lineWidth = 1.6 * d; c.beginPath(); c.arc(mx, my, 9 * d, 0, 7); c.stroke();
  c.beginPath(); c.moveTo(mx - 14 * d, my); c.lineTo(mx - 5 * d, my); c.moveTo(mx + 5 * d, my); c.lineTo(mx + 14 * d, my); c.moveTo(mx, my - 14 * d); c.lineTo(mx, my - 5 * d); c.moveTo(mx, my + 5 * d); c.lineTo(mx, my + 14 * d); c.stroke();
  if (st.mode !== 'head' && cfg.kind !== 'none') { var ea = st.theta; c.fillStyle = '#e06a4a'; c.beginPath(); c.arc(cx + Math.cos(ea) * R * 1.04, cy + Math.sin(ea) * R * 1.04, 5 * d, 0, 7); c.fill(); }
  if (flash) { var ft = Math.max(0, (now - flash.t) / 400); if (ft < 1) { var fx = cx + Math.cos(flash.theta) * flash.r * R, fy = cy + Math.sin(flash.theta) * flash.r * R; c.strokeStyle = 'rgba(255,230,180,' + (1 - ft) + ')'; c.lineWidth = 2 * d; c.beginPath(); c.arc(fx, fy, (8 + ft * 40) * d, 0, 7); c.stroke(); } }
}
function shade(hex, k) { var n = parseInt(hex.slice(1), 16), r = Math.min(255, (n >> 16) * k), g = Math.min(255, ((n >> 8) & 255) * k), b = Math.min(255, (n & 255) * k); return 'rgb(' + (r | 0) + ',' + (g | 0) + ',' + (b | 0) + ')'; }
var mouseHeld = false, tDrag = null;
function mouseUp() { if (tDrag) { if (tDrag.cur) endNote(tDrag.cur); tDrag = null; } if (mouseHeld) { endNote('m'); mouseHeld = false; } if (chokeHeld) setChoke(0); }
// which bar / tongue is under the pointer (bars: { idx, row, x }, tongues: { idx, th }); null if none
function tunedAt(e) {
  var rc = headCv.getBoundingClientRect(), x = (e.clientX - rc.left) / rc.width - 0.5, y = (e.clientY - rc.top) / rc.height - 0.5;
  if (isBars(cfg)) {
    // bar rectangles live in canvas (device) pixels: scale the pointer the same way (hi-DPI screens)
    var sx = headCv.width / rc.width, sy = headCv.height / rc.height, px = (x + 0.5) * rc.width * sx, py = (y + 0.5) * rc.height * sy, midY = headCv.height * 0.5;
    var top = py < midY, row = barRects.filter(function (b) { return (b.y + b.h / 2 < midY) === top; }), hit = null, bd = 1e9;
    (row.length ? row : barRects).forEach(function (b) { var dx = px < b.x ? b.x - px : px > b.x + b.w ? px - (b.x + b.w) : 0; if (dx < bd) { bd = dx; hit = b; } });
    if (!hit || bd > hit.w) return null;   // well outside any bar: nothing
    return { idx: hit.idx, row: top, x: hit.x };
  }
  var r = Math.sqrt(x * x + y * y) / 0.40, th = Math.atan2(y, x); if (r > 1.15) return null;
  var best = null, bd2 = 9; model.tongues.forEach(function (t) { var dd = Math.abs(Math.atan2(Math.sin(th - t.th), Math.cos(th - t.th))); if (dd < bd2) { bd2 = dd; best = t; } });
  return best ? { idx: best.idx, th: best.th } : null;
}
// drag across a tuned instrument: every bar/tongue the pointer crosses sounds, harder the faster you sweep
// (velocity follows the sweep speed and is capped by the Velocity setting, so a slow drag is a gentle glissando)
headCv.addEventListener('pointermove', function (e) {
  if (!tDrag || !(e.buttons & 1) || !model || !model.tongues) return;
  var now = performance.now(), dt = Math.max(1, now - tDrag.t), d = Math.hypot(e.clientX - tDrag.x, e.clientY - tDrag.y);
  tDrag.sp = tDrag.moved ? tDrag.sp + (d / dt - tDrag.sp) * Math.min(1, dt / 40) : d / dt; tDrag.moved = true;   // px per ms, smoothed over ~40 ms
  tDrag.x = e.clientX; tDrag.y = e.clientY; tDrag.t = now;
  var h = tunedAt(e); if (!h || h.idx === tDrag.last.idx) return;
  var vel = cfg.strike.vel * Math.max(0.15, Math.min(1, 0.12 + 0.88 * Math.sqrt(tDrag.sp / 2.2)));
  var seq = [h];
  if (isBars(cfg) && h.row === tDrag.last.row) {   // a fast sweep can jump bars between events: play the ones in between too
    var lo = Math.min(h.x, tDrag.last.x), hi = Math.max(h.x, tDrag.last.x), midY = headCv.height * 0.5;
    seq = barRects.filter(function (b) { return ((b.y + b.h / 2 < midY) === h.row) && b.x > lo && b.x < hi; })
      .sort(function (a, b) { return h.x > tDrag.last.x ? a.x - b.x : b.x - a.x; }).map(function (b) { return { idx: b.idx, row: h.row, x: b.x }; }).concat([h]);
  }
  seq.slice(-6).forEach(function (q, k) {
    var id = 'm' + (++tDrag.n);
    setTimeout(function () { if (!tDrag) return; if (tDrag.cur) endNote(tDrag.cur); tDrag.cur = id; startNote(id, { tongue: q.idx, vel: vel }); }, k * 12);
  });
  if (mouseHeld) { endNote('m'); mouseHeld = false; }
  tDrag.last = h;
});
window.addEventListener('pointerup', mouseUp); window.addEventListener('pointercancel', mouseUp);
headCv.addEventListener('pointerdown', function (e) {
  var rc = headCv.getBoundingClientRect(), x = (e.clientX - rc.left) / rc.width - 0.5, y = (e.clientY - rc.top) / rc.height - 0.5, R = 0.40;
  var r = Math.sqrt(x * x + y * y) / R, th = Math.atan2(y, x);
  if (kitMode && kitHeadClick(e, r, th, x, y, rc)) return;
  if (isMetal(cfg)) {
    if (r > 1.0 && r < 1.2) { setChoke(1); toast('Grabbing the edge — release to let go'); return; }
    if (r >= 1.2) return;
    cfg.strike.r = Math.min(0.99, r); cfg.strike.theta = th; refreshPanelValues(); save(); if (!kitMode) post({ type: 'stroke', mode: cfg.strike.mode, theta: th });
    if (e.shiftKey && !e.altKey) { drawHead(); return; }
    mouseHeld = true; startNote('m', { r: cfg.strike.r, theta: th, vel: cfg.strike.vel, mode: e.altKey ? 'shoulder' : 'head' });
    return;
  }
  if ((isBars(cfg) || isTg(cfg)) && model && model.tongues) {
    var hitT = tunedAt(e);
    if (hitT) {
      try { headCv.setPointerCapture(e.pointerId); } catch (er) {}
      tDrag = { last: hitT, x: e.clientX, y: e.clientY, t: performance.now(), sp: 0, n: 0 };
      mouseHeld = true; startNote('m', { tongue: hitT.idx, vel: cfg.strike.vel });
    }
    return;
  }
  var mode = cfg.strike.mode;
  if (r > 1.0 && r < 1.22 && cfg.kind !== 'none') {   // the rim ring: hit the hoop (Alt = rimshot, head and hoop together); the stroke settings stay as they are
    mouseHeld = true; flash = { r: 1.06, theta: th, t: performance.now() };
    startNote('m', { r: 0.97, theta: th, vel: cfg.strike.vel, mode: e.altKey ? 'rimshot' : 'rim' });
    if (!rafOn) { rafOn = true; requestAnimationFrame(loop); }
    return;
  }
  else if (r > 1.0 && r < 1.12) r = 0.99;
  else if (r >= 1.22) return;
  cfg.strike.r = Math.min(0.97, r); cfg.strike.theta = th; refreshPanelValues(); save();
  if (e.shiftKey) { drawHead(); return; }
  mouseHeld = true; startNote('m', { r: cfg.strike.r, theta: th, vel: cfg.strike.vel, mode: mode });
});

// ---------------- pads (on-screen keys) ----------------
var padLit = {};
function lightPad(id) { padLit[id] = performance.now(); var el = document.querySelector('[data-pad="' + id + '"]'); if (el) { el.classList.add('lit'); setTimeout(function () { el.classList.remove('lit'); }, 160); } if (!rafOn) { rafOn = true; requestAnimationFrame(loop); } }
var PIANO = ['KeyA', 'KeyW', 'KeyS', 'KeyE', 'KeyD', 'KeyF', 'KeyT', 'KeyG', 'KeyY', 'KeyH', 'KeyU', 'KeyJ', 'KeyK', 'KeyO', 'KeyL', 'KeyP', 'Semicolon'];
var PIANO_LBL = ['A', 'W', 'S', 'E', 'D', 'F', 'T', 'G', 'Y', 'H', 'U', 'J', 'K', 'O', 'L', 'P', ';'];
var kbOct = isTg(cfg) ? Math.floor(cfg.special.root / 12) : 4;
function padHold(b, id, stFn) {
  b.onpointerdown = function (e) { e.preventDefault(); try { b.setPointerCapture(e.pointerId); } catch (er) {} var st = stFn(); lightPad(b.dataset.pad); startNote(id, st); };
  b.onpointerup = b.onpointercancel = function () { endNote(id); };
}
function buildPads() {
  var el = $('pads'); if (!el) return; el.innerHTML = '';
  var old = $('padsX'); if (old) old.remove();
  if (kitMode) { buildKitStrip(el); return; }
  el.className = 'pads' + (isTg(cfg) ? '' : ' keys');
  if (isTg(cfg) && model && model.tongues) {
    sortedTongues().forEach(function (t) {
      var b = document.createElement('button'); b.className = 'pad'; b.dataset.pad = 't' + t.idx;
      var off = t.note - kbOct * 12, key = off >= 0 && off < PIANO.length ? PIANO_LBL[off] : '';
      b.innerHTML = NOTE[t.note % 12] + (Math.floor(t.note / 12) - 1) + (key ? '<i>' + key + '</i>' : '');
      padHold(b, 'p' + t.idx, function () { return { tongue: t.idx, vel: cfg.strike.vel }; });
      el.appendChild(b);
    });
    $('padHint').innerHTML = (isBars(cfg) ? 'Click a bar or a pad,' : 'Click a tongue or a pad,') + ' or play <kbd>A</kbd><kbd>W</kbd><kbd>S</kbd>…<kbd>;</kbd> like a piano (<kbd>Z</kbd>/<kbd>X</kbd> shift octave, now C' + (kbOct - 1) + '). MIDI notes play ' + (isBars(cfg) ? 'their own bar (chromatic: every key has a bar in range).' : 'the nearest tongue.');
  } else if (isMetal(cfg)) {
    var ml = ['bell', 'sh', 'cup', 'sh', 'inner', 'mid', 'sh', 'bow', 'sh', 'outer', 'crash', 'edge'];
    for (var pc2 = 0; pc2 < 12; pc2++) (function (pc) {
      var blk = [1, 3, 6, 8, 10].indexOf(pc) >= 0, b = document.createElement('button'); b.className = 'pad' + (blk ? ' blk' : ''); b.dataset.pad = 'k' + pc;
      b.innerHTML = NOTE[pc] + '<i>' + PIANO_LBL[pc] + '</i><u>' + ml[pc] + '</u>';
      padHold(b, 'pk' + pc, function () { return metalKeySt(pc, cfg.strike.vel); });
      el.appendChild(b);
    })(pc2);
    var ex = document.createElement('div'); ex.className = 'pads extra'; el.parentNode.insertBefore(ex, el.nextSibling); ex.id = 'padsX';
    var mk = function (id, label, key, down, up) { var b = document.createElement('button'); b.className = 'pad wide'; b.dataset.pad = id; b.innerHTML = label + '<i>' + key + '</i>';
      b.onpointerdown = function (e) { e.preventDefault(); try { b.setPointerCapture(e.pointerId); } catch (er) {} down(); };
      b.onpointerup = b.onpointercancel = function () { if (up) up(); }; ex.appendChild(b); };
    mk('choke', 'Choke (hold)', 'K', function () { setChoke(1); }, function () { setChoke(0); });
    if (mPair(cfg) && cfg.special.piece === 'hihat') {
      mk('ped-chick', 'Pedal chick', 'L', function () { pedalAct('chick'); });
      mk('ped-splash', 'Pedal splash', ';', function () { pedalAct('splash'); });
      mk('ped-down', 'Foot down (hold)', 'Q', function () { pedalAct('down'); }, function () { pedalAct('up'); });
    }
    $('padHint').innerHTML = 'One octave runs from the bell to the edge: <b>white keys</b> hit with the stick tip, <b>black keys</b> with the shoulder. ' +
      '<kbd>K</kbd> choke' + (cfg.special.piece === 'hihat' ? ', <kbd>L</kbd> pedal chick, <kbd>;</kbd> pedal splash, hold <kbd>Q</kbd> to keep the foot down' : '') +
      '. MIDI: aftertouch grabs/chokes (or swells a roll), CC1 = roll speed' + (cfg.special.piece === 'hihat' ? ', CC4 = hi-hat pedal, C7 choke, D7 chick, E7 splash, C♯7 foot.' : ', C7 = choke.');
  } else if (cfg.kind !== 'none') {
    var lbl = ['center', '', '', '', '', 'middle', '', '', '', 'edge', 'rim'];
    for (var pc = 0; pc < 12; pc++) (function (pc) {
      var b = document.createElement('button'); b.className = 'pad' + ([1, 3, 6, 8, 10].indexOf(pc) >= 0 ? ' blk' : ''); b.dataset.pad = 'k' + pc;
      b.innerHTML = NOTE[pc] + '<i>' + PIANO_LBL[pc] + '</i>' + (pc === 0 ? '<u>center</u>' : pc === 5 ? '<u>mid</u>' : pc === 10 ? '<u>edge</u>' : pc === 11 ? '<u>rim</u>' : '');
      padHold(b, 'pk' + pc, function () { lightPad('k' + pc); return drumKeySt(pc, cfg.strike.vel); });
      el.appendChild(b);
    })(pc);
    $('padHint').innerHTML = 'Each octave spans the head: <b>C</b> hits dead center, each key steps outward, <b>A♯</b> is at the edge (each with the stroke type chosen under Strike) and <b>B</b> hits the rim; <b>B</b> with any other key is a rimshot there — on any octave of a MIDI keyboard, or <kbd>A</kbd> <kbd>W</kbd> <kbd>S</kbd> … <kbd>J</kbd> on your computer keyboard.';
  } else { $('padHint').textContent = ''; }
}

// ---------------- profile (cross-section) ----------------
var profCv = $('profCv'), pctx = profCv.getContext('2d');
function drawProfile() {
  var S = sizeCanvas(profCv), W = S.w, H = S.h, c = pctx, d = S.d;
  c.clearRect(0, 0, W, H);
  if (isMetal(cfg)) { drawCymbalSection(c, W, H, d); return; }
  if (isBars(cfg) && model && model.tongues) { $('profLbl').textContent = tongueMat().name + ' bars · ' + (+cfg.special.thickness || 0).toFixed(1) + ' mm'; drawBarSection(c, W, H, d); return; }
  var sh = cfg.shell, SM = E.SHELL_MATS[sh.material] || E.SHELL_MATS.maple;
  var isTwo = cfg.kind === 'double', dia = sh.diameter, dep = sh.depth;
  var dB = isTwo ? (cfg.reso.diameter || dia) : (sh.shape === 'barrel' ? (sh.bottomDia || (cfg.kind === 'single' ? dia * 0.75 : dia)) : dia);
  var widthIn = Math.max(dia, dB) * (sh.shape === 'barrel' ? 1 + 0.6 * (sh.bulge || 0) : 1), heightIn = Math.max(0.5, dep);
  var sc = Math.min((W - 40 * d) / widthIn, (H - 46 * d) / heightIn);
  var cx = W / 2, top = (H - heightIn * sc) / 2, bot = top + heightIn * sc, rT = dia * sc / 2, rB = dB * sc / 2;
  var wall = Math.max(2 * d, (sh.thickness || 5) / 25.4 * sc);
  var metal = SM.E > 50e9, wood = SM.E < 20e9 && SM.rho < 1000;
  function shellFill(x0, x1) { var g = c.createLinearGradient(x0, 0, x1, 0); if (metal) { g.addColorStop(0, shade(SM.color, 0.6)); g.addColorStop(0.5, shade(SM.color, 1.25)); g.addColorStop(1, shade(SM.color, 0.7)); } else { g.addColorStop(0, shade(SM.color, 0.85)); g.addColorStop(1, shade(SM.color, 1.05)); } return g; }
  c.lineJoin = 'round';
  var path = new Path2D();
  if (sh.shape === 'goblet') {
    var bowl = (sh.bowlDepth || 10) * sc, pr = (sh.portDiam || 4) * sc / 2, foot = Math.min(rT * 0.8, pr * 1.9);
    path.moveTo(cx - rT, top); path.bezierCurveTo(cx - rT, top + bowl * 0.7, cx - pr * 1.1, top + bowl * 0.8, cx - pr, top + bowl);
    path.lineTo(cx - pr, bot - (bot - top - bowl) * 0.3); path.quadraticCurveTo(cx - pr, bot, cx - foot, bot);
    path.lineTo(cx + foot, bot); path.quadraticCurveTo(cx + pr, bot, cx + pr, bot - (bot - top - bowl) * 0.3); path.lineTo(cx + pr, top + bowl);
    path.bezierCurveTo(cx + pr * 1.1, top + bowl * 0.8, cx + rT, top + bowl * 0.7, cx + rT, top);
  } else if (sh.shape === 'kettle') {
    var bd = Math.min(heightIn * sc, (sh.bowlDepth || 10) * sc);
    path.moveTo(cx - rT, top); path.bezierCurveTo(cx - rT, top + bd * 0.9, cx - rT * 0.45, top + bd, cx, top + bd);
    path.bezierCurveTo(cx + rT * 0.45, top + bd, cx + rT, top + bd * 0.9, cx + rT, top);
  } else if (sh.shape === 'barrel') {
    var bu = (sh.bulge || 0) * 0.6;
    path.moveTo(cx - rT, top); path.bezierCurveTo(cx - rT * (1 + bu * 1.35), top + (bot - top) * 0.3, cx - rB * (1 + bu * 1.35), top + (bot - top) * 0.7, cx - rB, bot);
    path.moveTo(cx + rT, top); path.bezierCurveTo(cx + rT * (1 + bu * 1.35), top + (bot - top) * 0.3, cx + rB * (1 + bu * 1.35), top + (bot - top) * 0.7, cx + rB, bot);
  } else {
    path.moveTo(cx - rT, top); path.lineTo(cx - rB, bot); path.moveTo(cx + rT, top); path.lineTo(cx + rB, bot);
  }
  // air
  c.fillStyle = 'rgba(111,182,214,.06)';
  if (sh.shape !== 'barrel' && sh.shape !== 'cylinder' && sh.shape !== 'open' && sh.shape !== 'frame') { var pa = new Path2D(path); pa.closePath(); c.fill(pa); }
  else c.fillRect(cx - rT, top, 2 * rT, bot - top);
  c.strokeStyle = shellFill(cx - rT, cx + rT); c.lineWidth = wall; c.stroke(path);
  if (wood && wall > 3 * d) { c.strokeStyle = 'rgba(0,0,0,.18)'; c.lineWidth = 1 * d; c.setLineDash([6 * d, 5 * d]); c.stroke(path); c.setLineDash([]); }
  // heads
  function head(y, r, mat, hoop) {
    var hm = mat === '__tongue' ? { color: tongueMat().color, thick: 1 } : mat === '__shell' ? E.shellHeadMat(SM) : (E.HEAD_MATS[mat] || E.HEAD_MATS.mylar_clear);
    c.strokeStyle = hm.color; c.lineWidth = Math.max(2 * d, mat === '__tongue' ? Math.min(10 * d, (cfg.special.thickness || 2) / 25.4 * sc * 2) : mat === '__shell' ? Math.min(14 * d, cfg.batter.thickness / 25.4 * sc) : 3 * d * Math.sqrt(hm.thick)); c.beginPath(); c.moveTo(cx - r - wall / 2, y); c.lineTo(cx + r + wall / 2, y); c.stroke();
    if (hoop && hoop !== 'none') { c.fillStyle = (E.HOOPS[hoop] || {}).color || '#aaa'; var hh = 6 * d; c.fillRect(cx - r - wall / 2 - 4 * d, y + (y < H / 2 ? -hh : 0), 6 * d, hh); c.fillRect(cx + r + wall / 2 - 2 * d, y + (y < H / 2 ? -hh : 0), 6 * d, hh); }
  }
  if (cfg.kind !== 'none') head(top, rT, isTg(cfg) ? '__tongue' : cfg.kind === 'shellhead' ? '__shell' : cfg.batter.material, isTg(cfg) ? 'none' : sh.hoop);
  if (cfg.kind === 'shellhead' && sh.shape === 'barrel') { c.strokeStyle = shellFill(cx - rB, cx + rB); c.lineWidth = wall; c.beginPath(); c.moveTo(cx - rB, bot); c.lineTo(cx + rB, bot); c.stroke(); }   // the keg's closed bottom
  if (isTwo) {
    head(bot, rB, cfg.reso.material, sh.hoop);
    if (cfg.reso.hole > 0) { var hr = cfg.reso.hole * sc / 2; c.clearRect(cx + rB * 0.35 - hr, bot - 4 * d, 2 * hr, 8 * d); }
  }
  // lugs / ropes
  if (cfg.kind === 'none') { /* bare body */ }
  else if (!isTg(cfg) && sh.hoop && sh.hoop !== 'none' && (isTwo || sh.shape === 'open' || sh.shape === 'kettle')) {
    c.fillStyle = '#9aa0a6'; var nl = isTwo ? (dep > 7 ? 2 : 1) : 1;
    for (var li = 0; li < nl; li++) { var ly = top + (bot - top) * (nl === 1 ? 0.5 : (li ? 0.72 : 0.28)); c.fillRect(cx - rT - wall / 2 - 7 * d, ly - 7 * d, 6 * d, 14 * d); c.fillRect(cx + rT + wall / 2 + d, ly - 7 * d, 6 * d, 14 * d); }
  } else if (sh.hoop === 'none' && (isTwo || sh.shape === 'goblet')) {
    c.strokeStyle = 'rgba(232,220,196,.5)'; c.lineWidth = 1 * d; var yb = isTwo ? bot : top + (sh.bowlDepth || 10) * sc;
    for (var zi = 0; zi < 9; zi++) { var t0 = zi / 8; c.beginPath(); c.moveTo(cx - rT + t0 * 2 * rT * 0.06 - rT * 0.02, top + 2 * d); c.lineTo(cx - (isTwo ? rB : rT * 0.75) - 3 * d, yb); c.stroke(); c.beginPath(); c.moveTo(cx + rT - t0 * 2 * rT * 0.06 + rT * 0.02, top + 2 * d); c.lineTo(cx + (isTwo ? rB : rT * 0.75) + 3 * d, yb); c.stroke(); }
  }
  // snare wires
  if (cfg.kind !== 'none' && !isTg(cfg) && cfg.snare && cfg.snare.on) {
    var sy = isTwo ? bot + 5 * d : top + 5 * d; c.strokeStyle = '#c9ccd1'; c.lineWidth = 1 * d; c.setLineDash([2 * d, 2 * d]);
    c.beginPath(); c.moveTo(cx - (isTwo ? rB : rT) * 0.8, sy); c.lineTo(cx + (isTwo ? rB : rT) * 0.8, sy); c.stroke(); c.setLineDash([]);
  }
  // pillow
  if (isTwo && cfg.pillow > 0.02) { c.fillStyle = 'rgba(200,190,170,' + (0.15 + cfg.pillow * 0.3) + ')'; var ph = (bot - top) * 0.35 * cfg.pillow + 4 * d; c.beginPath(); c.ellipse(cx, bot - ph / 2 - 3 * d, rB * 0.6, ph / 2, 0, 0, 7); c.fill(); }
  // dims
  c.fillStyle = '#7d7262'; c.font = (11 * d) + 'px IBM Plex Mono, monospace'; c.textAlign = 'center';
  c.fillText(dia + '″ × ' + dep + '″', cx, H - 8 * d);
  $('profLbl').textContent = SM.name + ' · ' + (sh.thickness || 0).toFixed(1) + ' mm wall';
}

function cymbalProfilePath(c, t, piece, cx, y0, halfW, scale, flip) {
  // returns list of [x,y] along the top surface, one side; mirrored when drawn
  var a = (t.diameter || 16) * 0.0127, pts = [], rb = Math.min(0.6, (t.bellDia || 0) / Math.max(1, t.diameter || 16)), bh = (t.bellHeight || 0) * 1e-3;
  var dome = (t.dome == null ? 20 : t.dome) * 1e-3, gong = ['tamtam', 'opera', 'nipple'].indexOf(piece) >= 0, fl = t.flange || 0;
  for (var i = 0; i <= 60; i++) {
    var r = i / 60, z = dome * (1 - r * r);
    if (rb > 0.02 && r < rb) z += bh * (1 - Math.pow(r / rb, 2)) * (piece === 'china' ? 0.6 : 1) + (piece === 'china' ? bh * 0.4 : 0);
    if (fl > 0 && r > 0.82) z += fl * 0.012 * Math.pow((r - 0.82) / 0.18, 2);
    pts.push([r * halfW, -z * scale * (flip ? -1 : 1)]);
  }
  if (gong) pts.push([halfW, (flip ? -1 : 1) * (sp_rim(piece) * 0.04 * scale)]);
  return pts;
}
function sp_rim() { return cfg.special.rim == null ? 0.6 : cfg.special.rim; }
function drawCymbalSection(c, W, H, d) {
  var sp = cfg.special, t = sp.top || {}, A = E.ALLOYS[t.alloy] || E.ALLOYS.b20, piece = sp.piece;
  var cx = W / 2, maxD = Math.max(t.diameter || 16, sp.bottom && mPair(cfg) ? sp.bottom.diameter : 0), halfW = (W - 40 * d) / 2 * Math.min(1, (t.diameter || 16) / maxD);
  var scale = (W - 40 * d) / (maxD * 0.0254) * 1.6;   // exaggerate vertical x1.6
  // stand
  c.strokeStyle = '#5c544a'; c.lineWidth = 3 * d; c.beginPath(); c.moveTo(cx, H * 0.25); c.lineTo(cx, H - 18 * d); c.stroke();
  function draw(tc, y0, flip, col) {
    var hw = (W - 40 * d) / 2 * Math.min(1, (tc.diameter || 16) / maxD), pts = cymbalProfilePath(c, tc, piece, cx, y0, hw, scale, flip);
    var th = Math.max(1.5 * d, (tc.thickness || 1) * 1e-3 * scale * 1.5);
    [1, -1].forEach(function (sg) {
      c.beginPath(); pts.forEach(function (p, i) { var x = cx + sg * p[0], y = y0 + p[1]; i ? c.lineTo(x, y) : c.moveTo(x, y); });
      for (var i = pts.length - 1; i >= 0; i--) { var r = i / (pts.length - 1), tt = th * (1 - 0.6 * (tc.taper || 0) * r); c.lineTo(cx + sg * pts[i][0], y0 + pts[i][1] + (flip ? -tt : tt)); }
      c.closePath(); var g = c.createLinearGradient(0, y0 - 30 * d, 0, y0 + 10 * d); g.addColorStop(0, shade(col, 1.35)); g.addColorStop(1, shade(col, 0.7)); c.fillStyle = g; c.fill();
    });
  }
  if (piece === 'bell' || piece === 'cowbell') {
    var bw = (W - 80 * d) / 2, bh = H * 0.55, top = H * 0.18;
    c.beginPath();
    if (piece === 'bell') { c.moveTo(cx - bw * 0.25, top); c.bezierCurveTo(cx - bw * 0.45, top + bh * 0.5, cx - bw * 0.5, top + bh * 0.8, cx - bw, top + bh); c.lineTo(cx + bw, top + bh); c.bezierCurveTo(cx + bw * 0.5, top + bh * 0.8, cx + bw * 0.45, top + bh * 0.5, cx + bw * 0.25, top); }
    else { c.moveTo(cx - bw * 0.45, top); c.lineTo(cx - bw * 0.8, top + bh); c.lineTo(cx + bw * 0.8, top + bh); c.lineTo(cx + bw * 0.45, top); }
    c.closePath(); var gg = c.createLinearGradient(cx - bw, 0, cx + bw, 0); gg.addColorStop(0, shade(A.color, 0.6)); gg.addColorStop(0.45, shade(A.color, 1.35)); gg.addColorStop(1, shade(A.color, 0.65)); c.fillStyle = gg; c.fill();
  } else if (mPair(cfg)) {
    var openMM = piece === 'stack' ? 0 : (footDown ? 0 : Math.pow(sp.pedal == null ? 0.15 : sp.pedal, 2) * (sp.gap || 8));
    var yTop = H * 0.42, gapPx = Math.max(0, openMM * 1e-3 * scale * 2.2);
    draw(sp.bottom, yTop + 26 * d + gapPx, true, (E.ALLOYS[sp.bottom.alloy] || A).color);
    draw(t, yTop, false, A.color);
    c.fillStyle = '#7d7262'; c.font = (10 * d) + 'px IBM Plex Mono, monospace'; c.textAlign = 'left';
    c.fillText(piece === 'stack' ? 'pressed together' : (footDown ? 'foot down · closed' : 'gap ' + openMM.toFixed(1) + ' mm'), 12 * d, H - 8 * d);
  } else {
    draw(t, H * 0.5, false, A.color);
  }
  c.fillStyle = '#7d7262'; c.font = (11 * d) + 'px IBM Plex Mono, monospace'; c.textAlign = 'center';
  c.fillText((t.diameter || 0) + '″ · ' + (+t.thickness || 0).toFixed(2) + ' mm', cx, 16 * d);
  $('profLbl').textContent = A.name + (piece === 'bell' || piece === 'cowbell' ? '' : ' · vertical ×1.6');
}
// ---------------- readouts ----------------
function syncHint() {
  var h = $('headHint'); if (!h) return;
 h.innerHTML = isMetal(cfg) ? 'Click to strike with the tip; <kbd>Alt</kbd>-click for a shoulder/crash hit. Hold on the dashed outer ring to grab (choke). With Rolling on, hold the mouse to roll; with the Bow striker, hold to bow the edge.'
    : isBars(cfg) ? 'Click a bar to play it, or use a MIDI keyboard: every key in range has its own bar. Bar lengths come from the note, wood and thickness; the tubes underneath are the resonators.'
    : isTg(cfg) ? 'Click a tongue to play it. Tongue lengths are computed from the note, material and plate thickness — red outlines don’t fit the drum.'
    : 'Click anywhere on the head to strike there. <kbd>Space</kbd> hits the marker, <kbd>1</kbd>–<kbd>6</kbd> hit from center to edge, <kbd>R</kbd> rimshot, <kbd>C</kbd> rim click. Shift-click moves the marker without hitting.';
}
function fillReadouts() {
  if (!model) return;
  if (model.metal) {
    var ml = E.modeList(model), f0 = ml[0] ? ml[0].f : 0, cup = ml.filter(function (m) { return m.head === 'cup'; })[0];
    var t = cfg.special.top || {}, mass = model.top.mass;
    var rr = [['Piece', E.PIECES[cfg.special.piece]], ['Alloy', model.top.A.name], ['Mass', mass > 2 ? mass.toFixed(2) + ' kg' : Math.round(mass * 1000) + ' g'],
      ['Lowest mode', f0 ? Math.round(f0) + ' Hz · ' + noteOf(f0) : '—']];
    if (cup) rr.push([cfg.special.piece === 'nipple' ? 'Boss pitch' : 'Bell (cup) ping', Math.round(cup.f) + ' Hz · ' + noteOf(cup.f)]);
    rr.push(['Modes simulated', model.modes.length + (model.pair ? ' (two cymbals)' : '')]);
    rr.push(['Physics', (cfg.special.quality === 'light' ? 'Light' : 'Full') + ' · bloom ' + (+cfg.special.bloom || 0).toFixed(2) + '×']);
    rr.push(['Engine', engineKind || 'idle']);
    $('readouts').innerHTML = rr.map(function (r) { return '<dt>' + r[0] + '</dt><dd>' + r[1] + '</dd>'; }).join('');
    return;
  }
  if (model.tongue) {
    var ts = sortedTongues(), lo = ts[0], hi = ts[ts.length - 1], longest = ts.reduce(function (m, t) { return Math.max(m, t.L); }, 0);
    var nm = function (t) { return NOTE[t.note % 12] + (Math.floor(t.note / 12) - 1); };
    var tl = ts.filter(function (t) { return t.tooLong; }).length;
    var bw = isBars(cfg), wd = bw ? 'Bar' : 'Tongue';
    var rr = [[wd + 's', ts.length + ' · ' + E.SCALES[cfg.special.scale].name], ['Range', nm(lo) + ' – ' + nm(hi) + ' (' + Math.round(lo.f) + '–' + Math.round(hi.f) + ' Hz)'],
      ['Longest ' + wd.toLowerCase(), (longest * 100).toFixed(1) + ' cm' + (tl ? ' · ' + tl + ' too long!' : '')], [wd + ' material', tongueMat().name + ' · ' + (+cfg.special.thickness).toFixed(1) + ' mm']];
    if (bw) rr.push(['Tuning', (cfg.special.tuning === 'xylo' ? 'xylophone 1 : 3 : 6' : 'marimba 1 : 4 : 10') + ' · resonators ' + Math.round((cfg.special.resonators == null ? 0.8 : cfg.special.resonators) * 100) + '%']);
    if (model.port && !bw) rr.push(['Body air (Helmholtz)', Math.round(model.port.wH / 2 / Math.PI) + ' Hz']);
    rr.push(['Modes simulated', model.B.modes.length + ' + ' + (model.shell.length + model.airModes.length) + ' body']);
    rr.push(['Engine', engineKind || 'idle']);
    $('readouts').innerHTML = rr.map(function (r) { return '<dt>' + r[0] + '</dt><dd' + (r[1].indexOf('too long') >= 0 ? ' style="color:var(--warn)"' : '') + '>' + r[1] + '</dd>'; }).join('');
    return;
  }
  if (model.none) {
    var bm = E.modeList(model), f0 = bm[0] ? bm[0].f : 0;
    var rr = [['Lowest mode (n=2)', f0 ? Math.round(f0) + ' Hz · ' + noteOf(f0) : '—']];
    bm.slice(1, 4).forEach(function (m) { rr.push(['Mode n=' + m.m + (m.n > 1 ? ' (' + (cfg.shell.shape === 'goblet' ? 'stem' : 'twist') + ')' : ''), Math.round(m.f) + ' Hz · ×' + (m.f / f0).toFixed(2)]); });
    rr.push(['Material Q', String(model.SM.Q)]);
    rr.push(['Modes simulated', String(model.B.modes.length)]);
    rr.push(['Engine', engineKind || 'idle']);
    $('readouts').innerHTML = rr.map(function (r) { return '<dt>' + r[0] + '</dt><dd>' + r[1] + '</dd>'; }).join('');
    return;
  }
  var B0 = model.B.modes[0], B1 = model.B.modes.filter(function (m) { return m.m === 1; })[0];
  var rows = [
    ['Batter (0,1) “thump”', Math.round(B0.f) + ' Hz · ' + noteOf(B0.f)],
    ['Batter (1,1) “tone”', B1 ? Math.round(B1.f) + ' Hz · ' + noteOf(B1.f) : '—']
  ];
  if (model.R) rows.push(['Resonant (0,1)', Math.round(model.R.modes[0].f) + ' Hz · ' + noteOf(model.R.modes[0].f)]);
  if (model.port) rows.push([cfg.kind === 'double' ? 'Port (Helmholtz)' : (cfg.shell.shape === 'goblet' ? 'Stem / bowl (Helmholtz)' : cfg.shell.shape === 'kettle' ? 'Vent / bowl (Helmholtz)' : cfg.shell.shape === 'barrel' && cfg.kind === 'shellhead' ? 'Vent / keg (Helmholtz)' : 'Open-end air column'), Math.round(model.port.wH / 2 / Math.PI) + ' Hz']);
  rows.push(['Air volume', (model.V * 1000).toFixed(1) + ' L']);
  rows.push(['Head mass', (model.B.sigma * 1000).toFixed(0) + ' g/m²']);
  rows.push(['Modes simulated', (model.B.modes.length + (model.R ? model.R.modes.length : 0)) + ' + ' + (model.shell.length + model.hoop.length + model.airModes.length) + ' body']);
  rows.push(['Engine', engineKind || 'idle']);
  $('readouts').innerHTML = rows.map(function (r) { return '<dt>' + r[0] + '</dt><dd>' + r[1] + '</dd>'; }).join('');
}
function fillModes() {
  if (model.metal) {
    $('modesTitle').innerHTML = 'Lowest modes <span>plate &amp; cup, before nonlinear bloom</span>';
    $('modeHead').innerHTML = '<tr><th>part</th><th>(m,n)</th><th>freq</th><th>note</th><th>ratio</th></tr>';
    var ml = E.modeList(model).slice(0, 14), f0 = ml[0] ? ml[0].f : 1;
    $('modeTbl').innerHTML = ml.map(function (m) { return '<tr><td class="' + (m.head === 'cup' ? 'h-r' : 'h-b') + '">' + m.head + '</td><td>(' + m.m + ',' + m.n + ')</td><td>' + m.f.toFixed(1) + ' Hz</td><td>' + noteOf(m.f) + '</td><td>' + (m.f / f0).toFixed(2) + '</td></tr>'; }).join('');
    return;
  }
  if (model.tongue) {
    $('modesTitle').innerHTML = (isBars(cfg) ? 'Bars' : 'Tongues') + ' <span>sized to pitch for this material &amp; thickness</span>';
    $('modeHead').innerHTML = '<tr><th>note</th><th>freq</th><th>length</th><th>width</th><th>fits?</th></tr>';
    $('modeTbl').innerHTML = sortedTongues().map(function (t) {
      return '<tr><td class="h-b">' + NOTE[t.note % 12] + (Math.floor(t.note / 12) - 1) + '</td><td>' + t.f.toFixed(1) + ' Hz</td><td>' + (t.L * 100).toFixed(1) + ' cm</td><td>' + (t.w * 100).toFixed(1) + ' cm</td><td' + (t.tooLong ? ' style="color:var(--warn)">too long' : '>✓') + '</td></tr>';
    }).join('');
    return;
  }
  $('modesTitle').innerHTML = 'Lowest modes <span>uncoupled, before air &amp; head coupling</span>';
  $('modeHead').innerHTML = '<tr><th>head</th><th>(m,n)</th><th>freq</th><th>note</th><th>ratio</th></tr>';
  var ml = E.modeList(model).slice(0, 12), f0 = (ml.filter(function (m) { return m.head !== 'reso'; })[0] || ml[0]).f;
  $('modeTbl').innerHTML = ml.map(function (m) {
    return '<tr><td class="' + (m.head === 'reso' ? 'h-r' : 'h-b') + '">' + m.head + '</td><td>(' + m.m + ',' + m.n + ')</td><td>' + m.f.toFixed(1) + ' Hz</td><td>' + noteOf(m.f) + '</td><td>' + (m.f / f0).toFixed(2) + '</td></tr>';
  }).join('');
}

// ---------------- spectrum ----------------
function fft(re, im) {
  var n = re.length;
  for (var i = 1, j = 0; i < n; i++) { var bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { var t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (var len = 2; len <= n; len <<= 1) {
    var ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (var i2 = 0; i2 < n; i2 += len) { var cr = 1, ci = 0; for (var k = 0; k < len / 2; k++) { var a = i2 + k, b = a + len / 2, xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr; re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi; var nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr; } }
  }
}
function previewSpectrum() {
  if (!model) return;
  var m = E.buildModel(cfg); m.gain = model.gain; E.applyTrims(m, E.trimsOf(model)); var s = cfg.strike;
  var st = isTg(cfg) && m.tongues ? { tongue: m.tongues.slice().sort(function (x, y) { return x.note - y.note; })[0].idx, vel: s.vel } : { r: s.r, theta: s.theta, vel: s.vel, mode: s.mode };
  drawSpectrum(E.renderHit(m, SR, st, 0.4));
}
var specCv = $('specCv'), sctx = specCv.getContext('2d'), waveCv = $('waveCv'), wctx = waveCv.getContext('2d');
function drawSpectrum(x) {
  var N = 16384, re = new Float64Array(N), im = new Float64Array(N);
  for (var i = 0; i < N && i < x.length; i++) re[i] = x[i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));
  fft(re, im);
  var S = sizeCanvas(specCv), W = S.w, H = S.h, c = sctx, d = S.d;
  c.clearRect(0, 0, W, H);
  var fmin = 25, fmax = Math.min(18000, SR / 2), lx = function (f) { return 36 * d + (W - 44 * d) * Math.log(f / fmin) / Math.log(fmax / fmin); };
  var mags = new Float64Array(N / 2), pk = 1e-20, pkF = 0;
  for (var k = 1; k < N / 2; k++) { var mg = re[k] * re[k] + im[k] * im[k]; mags[k] = mg; var fk = k * SR / N; if (mg > pk && fk > 30) { pk = mg; pkF = fk; } }
  var top = 10 * d, bh = H - 26 * d, db = function (v) { return 10 * Math.log10(v / pk + 1e-20); };
  c.font = (10 * d) + 'px IBM Plex Mono, monospace'; c.fillStyle = '#7d7262'; c.strokeStyle = '#2c2620'; c.lineWidth = 1;
  [50, 100, 200, 500, 1000, 2000, 5000, 10000].forEach(function (f) { var X = lx(f); c.beginPath(); c.moveTo(X, top); c.lineTo(X, top + bh); c.stroke(); c.textAlign = 'center'; c.fillText(f >= 1000 ? f / 1000 + 'k' : f, X, H - 6 * d); });
  [0, -20, -40, -60].forEach(function (v) { var Y = top + bh * (-v / 72); c.beginPath(); c.moveTo(36 * d, Y); c.lineTo(W - 8 * d, Y); c.stroke(); c.textAlign = 'right'; c.fillText(v, 30 * d, Y + 3 * d); });
  // mode markers
  if (model) {
    E.modeList(model).forEach(function (m) { if (m.f < fmin || m.f > fmax) return; var X = lx(m.f); c.strokeStyle = m.head === 'batter' ? 'rgba(224,169,74,.35)' : 'rgba(111,182,214,.45)'; c.beginPath(); c.moveTo(X, top + bh - 7 * d); c.lineTo(X, top + bh); c.stroke(); });
  }
  // curve (max-pooled per pixel)
  c.beginPath(); var first = true, grad = c.createLinearGradient(0, top, 0, top + bh); grad.addColorStop(0, 'rgba(224,169,74,.55)'); grad.addColorStop(1, 'rgba(224,169,74,0)');
  var px = Math.floor(36 * d), lastX = px, acc = -200;
  for (var k2 = 1; k2 < N / 2; k2++) {
    var f2 = k2 * SR / N; if (f2 < fmin) continue; if (f2 > fmax) break;
    var X2 = Math.floor(lx(f2)), v2 = db(mags[k2]);
    if (X2 === lastX) { acc = Math.max(acc, v2); continue; }
    var Y2 = top + bh * Math.min(1, Math.max(0, -acc / 72)); if (first) { c.moveTo(lastX, Y2); first = false; } else c.lineTo(lastX, Y2);
    lastX = X2; acc = v2;
  }
  c.strokeStyle = '#e0a94a'; c.lineWidth = 1.4 * d; c.stroke();
  c.lineTo(lastX, top + bh); c.lineTo(36 * d, top + bh); c.closePath(); c.fillStyle = grad; c.fill();
  $('specLbl').textContent = 'strongest peak ' + Math.round(pkF) + ' Hz · ' + noteOf(pkF) + '  ·  ticks: ■ batter / ■ resonant modes';
  // waveform
  var S2 = sizeCanvas(waveCv), W2 = S2.w, H2 = S2.h; wctx.clearRect(0, 0, W2, H2);
  var mx = 1e-9; for (var i3 = 0; i3 < x.length; i3++) mx = Math.max(mx, Math.abs(x[i3]));
  wctx.fillStyle = 'rgba(224,169,74,.75)'; var per = x.length / W2;
  for (var p = 0; p < W2; p++) { var a = 0; for (var q = Math.floor(p * per); q < Math.floor((p + 1) * per); q++) a = Math.max(a, Math.abs(x[q])); var hh = a / mx * (H2 / 2 - 2); wctx.fillRect(p, H2 / 2 - hh, 1, Math.max(1, 2 * hh)); }
  wctx.fillStyle = '#7d7262'; wctx.font = (10 * S2.d) + 'px IBM Plex Mono, monospace'; wctx.fillText('0', 2, H2 - 3); wctx.textAlign = 'right'; wctx.fillText((x.length / SR * 1000).toFixed(0) + ' ms', W2 - 2, H2 - 3);
}

// ---------------- presets / json ----------------
function fillPresets() {
  var s = $('presetSel'); s.innerHTML = '<option value="">— custom —</option>';
  var groups = {};
  Object.keys(P).forEach(function (k) { var g = P[k].group || 'Other'; (groups[g] = groups[g] || []).push(k); });
  Object.keys(groups).forEach(function (g) { var og = document.createElement('optgroup'); og.label = g; groups[g].forEach(function (k) { var o = document.createElement('option'); o.value = k; o.textContent = k; og.appendChild(o); }); s.appendChild(og); });
  s.value = presetName || '';
  s.onchange = function () { if (!s.value) return; if (kitMode) { kitReplacePiece(s.value); return; } loadCfg(clone(P[s.value]), s.value); };
}
function loadCfg(c, name) {
  cfg = c; presetName = name || '';
  ['mix', 'strike', 'snare'].forEach(function (k) { cfg[k] = Object.assign({}, clone(P[DEFAULT][k]), cfg[k] || {}); });
  if (cfg.kind === 'double' && !cfg.reso) cfg.reso = clone(P[DEFAULT].reso);
  if (!cfg.batter) cfg.batter = clone(P[DEFAULT].batter);
  $('presetSel').value = presetName; buildPanel(); syncVel(); applyBus(); rebuild();
  if (ctx) sendMsg({ type: 'panic' });
}
$('jsonBtn').onclick = function () { if (kitMode) { $('jsonTxt').value = JSON.stringify(Object.assign({ engine: 'drumhead-lab/kit-0.1' }, kit), null, 2); $('jsonModal').classList.add('show'); return; } var o = clone(cfg); delete o.group; o.engine = 'drumhead-lab/0.1'; $('jsonTxt').value = JSON.stringify(o, null, 2); $('jsonModal').classList.add('show'); };
$('jsonClose').onclick = function () { $('jsonModal').classList.remove('show'); };
$('jsonCopy').onclick = function () { var t = $('jsonTxt'); t.select(); (navigator.clipboard ? navigator.clipboard.writeText(t.value) : Promise.reject()).then(function () { toast('Copied preset JSON'); }, function () { toast('Select-all and copy manually (Ctrl/Cmd+C)'); }); };
$('jsonLoad').onclick = function () { try { var o = JSON.parse($('jsonTxt').value); if (o.pieces && o.map) { kitEnter(o); $('jsonModal').classList.remove('show'); toast('Kit loaded'); return; } if (!o.shell || !o.kind) throw 0; loadCfg(o, ''); $('jsonModal').classList.remove('show'); toast('Loaded'); } catch (e) { toast('That doesn’t look like a drum preset'); } };

// ---------------- velocity / groove / keys / midi ----------------
function syncVel() { $('velTop').value = cfg.strike.vel; $('velTopV').textContent = Math.round(cfg.strike.vel * 100) + '%'; refreshPanelValues(); }
$('velTop').oninput = function () { cfg.strike.vel = +this.value; syncVel(); save(); };
$('hitBtn').onclick = function () { if (kitMode) { kitPlay(slotSel, cfg.strike.vel); setTimeout(function () { kitStop(slotSel); }, 150); return; } hitMarker(); };
$('panicBtn').onclick = function () { sendMsg({ type: 'panic' }); };
var groove = null;
var PAT = [1, 0, .28, 0, .55, 0, .3, .42, .9, 0, .28, .5, .6, 0, .78, .33];
$('grooveBtn').onclick = function () {
  if (groove) { clearInterval(groove.t); groove = null; this.classList.remove('on'); return; }
  this.classList.add('on'); var self = this;
  if (kitMode) { kitGroove(self); return; }
  ensureAudio().then(function () {
    var step = 0, next = performance.now() + 50, dt = 60000 / 98 / 4;
    groove = { t: setInterval(function () {
      var now = performance.now();
      while (now >= next) {
        var v = PAT[step % 16];
        if (v && isTg(cfg) && model && model.tongues) { var ts0 = sortedTongues(); groove.ti = Math.max(0, Math.min(ts0.length - 1, (groove.ti || 0) + [-2, -1, 1, 2, 0][Math.floor(Math.random() * 5)])); playTongue(ts0[groove.ti].idx, Math.min(1, cfg.strike.vel * (0.35 + 0.75 * v)), step % 4 !== 0); }
        else if (v && isMetal(cfg) && cfg.special.piece === 'hihat') {
          var st8 = step % 2 === 0;
          if (step % 16 === 14) sendMsg({ type: 'pedal', kind: Math.max(0.35, cfg.special.pedal || 0) });
          if (step % 16 === 0) sendMsg({ type: 'pedal', kind: cfg.special.pedal == null ? 0.1 : Math.min(0.12, cfg.special.pedal) });
          if (st8) strike(0.72 + (Math.random() - 0.5) * 0.04, cfg.strike.theta, Math.min(1, cfg.strike.vel * (step % 4 === 0 ? 1 : 0.6)), step % 16 === 14 ? 'shoulder' : 'head', true);
          if (step % 8 === 4) pedalAct('chick');
        }
        else if (v && isMetal(cfg)) { var sm = cfg.strike; if (step % 2 === 0) strike(Math.max(0, Math.min(0.99, sm.r + (Math.random() - 0.5) * 0.03)), sm.theta, Math.min(1, sm.vel * (step % 4 === 0 ? 1 : 0.65)), step % 8 === 0 && (cfg.special.piece === 'ride') ? 'head' : sm.mode === 'shoulder' ? 'shoulder' : 'head', step % 8 !== 0); }
        else if (v) { var s = cfg.strike, j = (Math.random() - 0.5) * 0.06; strike(Math.max(0, Math.min(0.97, s.r + j)), s.theta + (Math.random() - 0.5) * 0.3, Math.min(1, s.vel * (0.25 + 0.85 * v)), s.mode, step % 4 !== 0); }
        step++; next += dt;
      }
    }, 5) };
  }, function () { self.classList.remove('on'); });
};
var heldKeys = {};
document.addEventListener('keyup', function (e) {
  if (kitMode && heldKeys[e.code] && heldKeys[e.code].kitNote != null) { var kn = heldKeys[e.code].kitNote; delete heldKeys[e.code]; kitStop(kn); return; }
  if (heldKeys[e.code]) { var h = heldKeys[e.code]; delete heldKeys[e.code]; if (h === 'choke') setChoke(0); else if (h === 'foot') pedalAct('up'); else endNote('k' + e.code); }
});
document.addEventListener('keydown', function (e) {
  if (e.target.tagName === 'INPUT' && e.target.type === 'text' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
  if (e.repeat) return;
  var s = cfg.strike;
  if (kitMode) {
    var kp = PIANO.indexOf(e.code);
    if (kp >= 0 && !e.ctrlKey && !e.metaKey && !e.altKey) { var note = kitKbOct * 12 + kp; heldKeys[e.code] = { kitNote: note }; kitPlay(note, s.vel); return; }
    if (e.code === 'KeyZ' || e.code === 'KeyX') { kitKbOct = Math.max(1, Math.min(8, kitKbOct + (e.code === 'KeyX' ? 1 : -1))); buildPads(); toast('Keyboard starts at ' + noteName(kitKbOct * 12)); return; }
    if (e.code === 'Space') { e.preventDefault(); $('hitBtn').onclick(); }
    return;
  }
  if (isMetal(cfg)) {
    if (e.code === 'KeyK') { heldKeys[e.code] = 'choke'; setChoke(1); return; }
    if (cfg.special.piece === 'hihat') {
      if (e.code === 'KeyL') { pedalAct('chick'); return; }
      if (e.code === 'Semicolon') { pedalAct('splash'); return; }
      if (e.code === 'KeyQ') { heldKeys[e.code] = 'foot'; pedalAct('down'); return; }
    }
  }
  var pk = PIANO.indexOf(e.code);
  if (pk >= 0 && !e.ctrlKey && !e.metaKey && !e.altKey) {
    var st = isTg(cfg) ? noteSt(kbOct * 12 + pk, s.vel) : (pk < 12 ? chordStroke(pk, keySt(pk, s.vel)) : null);
    if (st) { heldKeys[e.code] = true; lightPad(st.tongue != null ? 't' + st.tongue : 'k' + pk); startNote('k' + e.code, st); }
    return;
  }
  if (e.code === 'KeyZ' || e.code === 'KeyX') { kbOct = Math.max(1, Math.min(8, kbOct + (e.code === 'KeyX' ? 1 : -1))); buildPads(); toast('Keyboard octave: C' + (kbOct - 1)); return; }
  if (e.code === 'Space') { e.preventDefault(); hitMarker(); }
  else if (/^Digit[1-6]$/.test(e.code)) { var k = +e.code.slice(5); strike([0, 0.2, 0.4, 0.6, 0.8, 0.95][k - 1], s.theta, s.vel, 'head'); }
  else if (cfg.kind === 'none' || isMetal(cfg)) return;
  else if (e.code === 'KeyR') strike(Math.max(0.75, s.r), s.theta, s.vel, 'rimshot');
  else if (e.code === 'KeyC') strike(0.9, s.theta, s.vel, 'rimclick');
});
function midiIn(m) {
  var st = m.data[0] & 0xf0, d1 = m.data[1], d2 = m.data[2];
  if (kitMode) {
    if (st === 0x90 && d2 > 0) kitPlay(d1, Math.max(0.02, d2 / 127));
    else if (st === 0x80 || (st === 0x90 && d2 === 0)) kitStop(d1);
    else if (st === 0xA0) sendMsg({ type: 'kpress', note: d1, v: d2 / 127 });
    else if (st === 0xD0) sendMsg({ type: 'kpress', note: null, v: d1 / 127 });
    else if (st === 0xB0 && (d1 === 1 || d1 === 4)) sendMsg({ type: 'kcc', num: d1, v: d2 / 127 });
    return;
  }
  if (st === 0x90 && d2 > 0) {
    var vel = Math.max(0.02, d2 / 127);
    if (isMetal(cfg)) {
      if (d1 === 96) { setChoke(1); return; }
      if (cfg.special.piece === 'hihat') { if (d1 === 98) { pedalAct('chick'); return; } if (d1 === 100) { pedalAct('splash'); return; } if (d1 === 97) { pedalAct('down'); return; } }
    }
    var s2 = noteSt(d1, vel); if (s2) { lightPad(s2.tongue != null ? 't' + s2.tongue : 'k' + (d1 % 12)); startNote('n' + d1, s2); }
  } else if (st === 0x80 || (st === 0x90 && d2 === 0)) {
    if (isMetal(cfg) && d1 === 96) { setChoke(0); return; }
    if (isMetal(cfg) && d1 === 97) { pedalAct('up'); return; }
    endNote('n' + d1);
  } else if (st === 0xA0) sendMsg({ type: 'press', id: 'n' + d1, v: d2 / 127 });
  else if (st === 0xD0) sendMsg({ type: 'press', id: null, v: d1 / 127 });
  else if (st === 0xB0) {
    if (d1 === 1) { cfg.rollSpeed = 5 + d2 / 127 * 30; sendMsg({ type: 'cc', num: 1, v: d2 / 127 }); refreshPanelValues(); }
    if (d1 === 4) { sendMsg({ type: 'cc', num: 4, v: d2 / 127 }); if (isMetal(cfg)) { cfg.special.pedal = 1 - d2 / 127; refreshPanelValues(); drawProfile(); } }
  }
}
if (PLUG) $('midiTxt').textContent = 'MIDI · from the host'; else try {
  if (navigator.requestMIDIAccess) navigator.requestMIDIAccess().then(function (acc) {
    var bind = function () { var n = 0; acc.inputs.forEach(function (inp) { n++; inp.onmidimessage = midiIn; }); $('midiTxt').textContent = n ? 'MIDI · ' + n + ' input' + (n > 1 ? 's' : '') : 'MIDI · no devices'; };
    bind(); acc.onstatechange = bind;
  }, function () { $('midiTxt').textContent = 'MIDI blocked in this view — use keys'; });
  else $('midiTxt').textContent = 'no Web MIDI — use keys';
} catch (e) { $('midiTxt').textContent = 'MIDI blocked in this view — use keys'; }


// ===================================================== KIT MODE =====================================================
// A kit = up to 12 instruments + a note map. Every note is a "stroke slot": which instrument, where on it, which stroke.
// Velocity only sets how hard. The map defaults to General MIDI so drum clips and DAW drum maps just work.
var DK = typeof DRUM_KITS !== 'undefined' ? DRUM_KITS : {}, KIT_MAX = 12;
var kitMode = false, kit = null, kitSel = 1, slotSel = 38, kitModels = [], kitLo = 35, kitKbOct = 3, soloCfg = null, soloName = '';
function noteName(n) { return NOTE[((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1); }
var GM = { 35: 'Kick 2', 36: 'Kick', 37: 'Side stick', 38: 'Snare', 39: 'Clap', 40: 'Snare 2', 41: 'Low floor tom', 42: 'Closed hat', 43: 'High floor tom', 44: 'Pedal hat', 45: 'Low tom', 46: 'Open hat', 47: 'Low-mid tom', 48: 'Hi-mid tom', 49: 'Crash', 50: 'High tom', 51: 'Ride', 52: 'China', 53: 'Ride bell', 54: 'Tambourine', 55: 'Splash', 56: 'Cowbell', 57: 'Crash 2', 58: 'Vibraslap', 59: 'Ride 2' };
function liteCfg(c) { var o = clone(c); o.lite = true; return o; }
function normCfg(c) {
  ['mix', 'strike', 'snare'].forEach(function (k) { c[k] = Object.assign({}, clone(P[DEFAULT][k]), c[k] || {}); });
  if (c.kind === 'double' && !c.reso) c.reso = clone(P[DEFAULT].reso);
  if (!c.batter) c.batter = clone(P[DEFAULT].batter);
  if (!c.special) c.special = { type: 'none' };
  if (!c.mics) c.mics = { close: 1, oh: 0.5, width: 0.6, height: 0.9, pan: 0 };
  return c;
}
function pieceModel(i) { var m = E.buildModel(liteCfg(kit.pieces[i].cfg), SR); E.calibrate(m, SR); return m; }
function kitPieceMsg(i) { var p = kit.pieces[i]; return { cfg: liteCfg(p.cfg), gain: kitModels[i].gain, tr: E.trimsOf(kitModels[i]), level: p.level, pan: p.pan }; }
function sendWholeKit() { if (!kit) return; post({ type: 'kit', pieces: kit.pieces.map(function (p, i) { return kitPieceMsg(i); }), map: kit.map, symp: kit.mix.sympathy }); }
function sendKitPiece(i) { var m = kitPieceMsg(i); m.type = 'kpiece'; m.i = i; post(m); }
function sendKitMix() { post({ type: 'kmix', mix: kit.pieces.map(function (p) { return { level: p.level, pan: p.pan }; }), symp: kit.mix.sympathy }); }
function sendKitMap() { post({ type: 'kmap', map: kit.map }); }
function kitEnter(k) {
  if (!kitMode) { soloCfg = cfg; soloName = presetName; }
  kitMode = true; kit = clone(k); kit.mix = Object.assign({ room: 0.22, punch: 0.4, master: 0.85, sympathy: 0.5 }, kit.mix || {});
  kit.pieces.forEach(function (p) { normCfg(p.cfg); if (p.level == null) p.level = 0.8; if (p.pan == null) p.pan = 0; });
  toast('Building the kit…');
  setTimeout(function () {
    kitModels = kit.pieces.map(function (p, i) { return pieceModel(i); });
    kitSel = Math.min(kitSel, kit.pieces.length - 1); if (!kit.map[slotSel]) slotSel = +Object.keys(kit.map)[0] || 36;
    var sl = kit.map[slotSel]; if (sl) kitSel = sl.p;
    cfg = kit.pieces[kitSel].cfg; model = kitModels[kitSel];
    $('kitBtn').classList.add('on'); $('presetSel').title = 'Replaces the selected kit piece'; $('presetSel').value = '';
    if (ctx) { post({ type: 'mode', kit: true }); sendWholeKit(); }
    afterPieceSwitch(); applyBus(); save();
  }, 20);
}
function kitExit() {
  kitMode = false; $('kitBtn').classList.remove('on'); $('presetSel').title = 'Presets';
  if (ctx) post({ type: 'mode', kit: false });
  try { LS.setItem('drumlab.mode', 'single'); } catch (e) {}
  loadCfg(soloCfg || clone(P[DEFAULT]), soloCfg ? soloName : DEFAULT);
}
function afterPieceSwitch() { buildPanel(); syncVel(); computeShapes(); refreshPanelValues(); drawProfile(); drawHead(); fillReadouts(); fillModes(); buildPads(); syncHint(); previewSpectrum(); }
function selectPiece(i) { if (i === kitSel && cfg === kit.pieces[i].cfg) return; kitSel = i; cfg = kit.pieces[i].cfg; model = kitModels[i]; afterPieceSwitch(); }
function selectSlot(n) { slotSel = n; var sl = kit.map[n]; if (sl && sl.p !== kitSel) selectPiece(sl.p); else { buildPads(); drawHead(); } }
function kitSlotMarker() { var sl = kit && kit.map[slotSel]; if (!sl || sl.p !== kitSel || sl.r == null) return null; return { r: sl.r, theta: sl.theta || 0, mode: sl.mode || 'head' }; }
function kitPlay(note, vel) {
  if (!kit) return; var sl = kit.map[note];
  sendMsg({ type: 'kon', note: note, vel: vel });
  lightPad('n' + note);
  if (!sl || sl.p !== kitSel || !model) return;
  if (sl.tongue != null && model.tongues) { var t = model.tongues.filter(function (x) { return x.idx === sl.tongue; })[0]; if (t) flash = { r: t.rb - 0.6 * t.ln, theta: t.th, t: performance.now() }; lightPad('t' + sl.tongue); setTimeout(function () { visualHit({ tongue: sl.tongue, vel: vel }); }, 0); return; }
  if (sl.r == null) { if (sl.pedal) drawProfile(); return; }
  flash = { r: sl.r, theta: sl.theta || 0, t: performance.now() };
  setTimeout(function () { visualHit({ r: sl.r, theta: sl.theta || 0, vel: vel, mode: sl.mode || 'head' }); }, 0);
}
function kitStop(note) { sendMsg({ type: 'koff', note: note }); }
function kitReplacePiece(name) {
  var c = normCfg(clone(P[name])); if (c.special && c.special.type === 'metal' && c.special.piece !== 'hihat' && c.special.piece !== 'stack') c.special.quality = 'light';
  kit.pieces[kitSel].cfg = c; kit.pieces[kitSel].name = name.replace(/\s*\(.*\)$/, '');
  cfg = c; model = kitModels[kitSel] = pieceModel(kitSel); sendKitPiece(kitSel); afterPieceSwitch(); save(); $('presetSel').value = '';
  toast('Replaced piece ' + (kitSel + 1));
}
function kitAddPiece(name) {
  if (kit.pieces.length >= KIT_MAX) { toast('A kit holds up to ' + KIT_MAX + ' pieces'); return; }
  var c = normCfg(clone(P[name])); if (c.special && c.special.type === 'metal' && c.special.piece !== 'hihat' && c.special.piece !== 'stack') c.special.quality = 'light';
  kit.pieces.push({ name: name.replace(/\s*\(.*\)$/, ''), cfg: c, level: 0.7, pan: 0 });
  var i = kit.pieces.length - 1; kitModels[i] = pieceModel(i); sendKitPiece(i);
  // give it the first free note above the GM range
  for (var n = 60; n < 96; n++) if (!kit.map[n]) { kit.map[n] = isTg(c) && kitModels[i].tongues ? { p: i, tongue: sortedTonguesOf(kitModels[i])[0].idx } : { p: i, r: c.strike.r, theta: c.strike.theta || 0.6, mode: c.strike.mode === 'rimshot' ? 'head' : (c.strike.mode || 'head') }; slotSel = n; break; }
  sendKitMap(); selectPiece(i); save();
}
function kitRemovePiece(i) {
  if (kit.pieces.length <= 1) return;
  kit.pieces.splice(i, 1); kitModels.splice(i, 1);
  Object.keys(kit.map).forEach(function (n) { var sl = kit.map[n]; if (sl.p === i) delete kit.map[n]; else if (sl.p > i) sl.p--; });
  kitSel = Math.min(kitSel, kit.pieces.length - 1);
  if (ctx) sendWholeKit();
  cfg = kit.pieces[kitSel].cfg; model = kitModels[kitSel]; afterPieceSwitch(); save();
}
function sortedTonguesOf(m) { return m.tongues.slice().sort(function (x, y) { return x.note - y.note; }); }
function slotLabel(sl) {
  if (!sl) return '';
  if (sl.pedal) return 'pedal ' + sl.pedal;
  if (sl.tongue != null) { var m = kitModels[sl.p], t = m && m.tongues && m.tongues.filter(function (x) { return x.idx === sl.tongue; })[0]; return t ? noteName(t.note) : 'note'; }
  var pc = kit.pieces[sl.p], metal = isMetal(pc.cfg);
  var where = metal ? (sl.r < 0.15 ? 'bell' : sl.r > 0.85 ? 'edge' : 'bow') : (sl.r < 0.15 ? 'center' : sl.r > 0.8 ? 'edge' : Math.round(sl.r * 100) + '%');
  var how = sl.mode === 'rimshot' ? 'rimshot' : sl.mode === 'rimclick' ? 'x-stick' : sl.mode === 'rim' ? 'rim' : sl.mode === 'shoulder' ? 'shoulder' : '';
  var hat = sl.open != null ? (sl.open < 0.05 ? 'closed ' : sl.open > 0.5 ? 'open ' : 'half ') : '';
  return hat + (how || where);
}
// ---- left panel: pieces, kit mix ----
function mkRange(min, max, step, val, fmt, oninput) {
  var row = document.createElement('div'); row.className = 'row';
  var inp = document.createElement('input'); inp.type = 'range'; inp.min = min; inp.max = max; inp.step = step; inp.value = val;
  var V = document.createElement('span'); V.className = 'val'; V.textContent = fmt(val);
  inp.oninput = function () { V.textContent = fmt(+inp.value); oninput(+inp.value); };
  return { row: row, inp: inp, V: V };
}
function kitPanel() {
  var d = document.createElement('div'); d.className = 'sec kitsec';
  d.innerHTML = '<h3>Kit <i>·</i></h3>';
  var rows = document.createElement('div'); rows.className = 'rows';
  // kit preset + exit
  var top = document.createElement('div'); top.className = 'row';
  var ks = document.createElement('select'); Object.keys(DK).forEach(function (k) { var o = document.createElement('option'); o.value = k; o.textContent = k; ks.appendChild(o); });
  var lo = document.createElement('option'); lo.value = ''; lo.textContent = '— load kit —'; ks.insertBefore(lo, ks.firstChild); ks.value = '';
  ks.onchange = function () { if (ks.value) kitEnter(DK[ks.value]); };
  var lab = document.createElement('label'); lab.textContent = 'Kit preset'; top.appendChild(lab); top.appendChild(document.createElement('span')); top.appendChild(ks); rows.appendChild(top);
  // pieces
  kit.pieces.forEach(function (p, i) {
    var r = document.createElement('div'); r.className = 'kitpc' + (i === kitSel ? ' sel' : '');
    var b = document.createElement('button'); b.className = 'kitname'; b.textContent = (i + 1) + ' · ' + p.name; b.title = 'Edit this piece below';
    b.onclick = function () { selectPiece(i); };
    var lv = document.createElement('input'); lv.type = 'range'; lv.min = 0; lv.max = 1.5; lv.step = 0.01; lv.value = p.level; lv.title = 'Level';
    lv.oninput = function () { p.level = +lv.value; sendKitMix(); save(); };
    var pn = document.createElement('input'); pn.type = 'range'; pn.min = -1; pn.max = 1; pn.step = 0.01; pn.value = p.pan; pn.title = 'Pan (position in the kit)'; pn.className = 'pan';
    pn.oninput = function () { p.pan = +pn.value; sendKitMix(); save(); };
    var x = document.createElement('button'); x.className = 'kitx'; x.textContent = '×'; x.title = 'Remove piece';
    x.onclick = function () { if (confirm('Remove ' + p.name + ' from the kit?')) kitRemovePiece(i); };
    r.appendChild(b); r.appendChild(lv); r.appendChild(pn); r.appendChild(x); rows.appendChild(r);
  });
  var hdr = document.createElement('div'); hdr.className = 'kithint'; hdr.textContent = 'level · pan · click a name to edit that piece below';
  rows.appendChild(hdr);
  if (kit.pieces.length < KIT_MAX) {
    var ar = document.createElement('div'); ar.className = 'row';
    var as = document.createElement('select'); var o0 = document.createElement('option'); o0.value = ''; o0.textContent = '+ add a piece…'; as.appendChild(o0);
    Object.keys(P).forEach(function (k) { var o = document.createElement('option'); o.value = k; o.textContent = k; as.appendChild(o); });
    as.onchange = function () { if (as.value) kitAddPiece(as.value); };
    var al = document.createElement('label'); al.textContent = 'Add (' + kit.pieces.length + '/' + KIT_MAX + ')'; ar.appendChild(al); ar.appendChild(document.createElement('span')); ar.appendChild(as); rows.appendChild(ar);
  }
  // kit mix
  [['Sympathetic resonance', 'sympathy', 0, 1.5, function (v) { return v < 0.02 ? 'off' : pct(v); }, function () { sendKitMix(); }],
   ['Room', 'room', 0, 1, pct, applyBus], ['Punch (bus compression)', 'punch', 0, 1, pct, applyBus], ['Output level', 'master', 0, 1.5, pct, applyBus]].forEach(function (q) {
    var R = mkRange(q[2], q[3], 0.01, kit.mix[q[1]], q[4], function (v) { kit.mix[q[1]] = v; q[5](); save(); });
    var L = document.createElement('label'); L.textContent = q[0]; R.row.appendChild(L); R.row.appendChild(R.V); R.row.appendChild(R.inp); rows.appendChild(R.row);
  });
  var ex = document.createElement('div'); ex.className = 'row'; var eb = document.createElement('button'); eb.textContent = 'Leave kit mode'; eb.onclick = kitExit; ex.appendChild(eb); rows.appendChild(ex);
  d.appendChild(rows);
  var h = document.createElement('div'); h.className = 'kitsub'; h.textContent = 'Piece ' + (kitSel + 1) + ': ' + kit.pieces[kitSel].name; d.appendChild(h);
  return d;
}
// ---- key strip + slot editor ----
function buildKitStrip(el) {
  el.className = 'pads kitkeys';
  var nav = document.createElement('div'); nav.className = 'kitnav';
  nav.innerHTML = '<button data-d="-12">‹ oct</button><span>' + noteName(kitLo) + ' – ' + noteName(kitLo + 24) + ' · General MIDI</span><button data-d="12">oct ›</button>';
  nav.querySelectorAll('button').forEach(function (b) { b.onclick = function () { kitLo = Math.max(0, Math.min(103, kitLo + +b.dataset.d)); buildPads(); }; });
  el.appendChild(nav);
  var strip = document.createElement('div'); strip.className = 'kitstrip';
  for (var n = kitLo; n <= kitLo + 24; n++) (function (n) {
    var sl = kit.map[n], blk = [1, 3, 6, 8, 10].indexOf(n % 12) >= 0, b = document.createElement('button');
    b.className = 'kkey' + (blk ? ' blk' : '') + (n === slotSel ? ' sel' : '') + (sl ? '' : ' empty'); b.dataset.pad = 'n' + n;
    var pn = sl && kit.pieces[sl.p] ? kit.pieces[sl.p].name : (GM[n] ? '(' + GM[n] + ')' : '—');
    b.innerHTML = '<b>' + noteName(n) + '</b><i>' + pn + '</i><u>' + (sl ? slotLabel(sl) : '') + '</u>';
    b.title = (GM[n] ? 'GM: ' + GM[n] + ' · ' : '') + 'note ' + n;
    b.onpointerdown = function (e) { e.preventDefault(); try { b.setPointerCapture(e.pointerId); } catch (er) {} selectSlot(n); if (kit.map[n]) kitPlay(n, cfg.strike.vel); };
    b.onpointerup = b.onpointercancel = function () { if (kit.map[n]) kitStop(n); };
    strip.appendChild(b);
  })(n);
  el.appendChild(strip);
  // slot editor
  var ed = document.createElement('div'); ed.className = 'pads extra kited'; ed.id = 'padsX'; el.parentNode.insertBefore(ed, el.nextSibling);
  var sl = kit.map[slotSel];
  var title = document.createElement('b'); title.textContent = noteName(slotSel) + ' (' + slotSel + ')' + (GM[slotSel] ? ' · GM ' + GM[slotSel] : ''); ed.appendChild(title);
  var ps = document.createElement('select'); var on = document.createElement('option'); on.value = '-1'; on.textContent = '— silent —'; ps.appendChild(on);
  kit.pieces.forEach(function (p, i) { var o = document.createElement('option'); o.value = i; o.textContent = (i + 1) + ' · ' + p.name; ps.appendChild(o); });
  ps.value = sl ? String(sl.p) : '-1';
  ps.onchange = function () {
    var i = +ps.value; if (i < 0) { delete kit.map[slotSel]; sendKitMap(); save(); buildPads(); return; }
    var m = kitModels[i], c = kit.pieces[i].cfg;
    kit.map[slotSel] = isTg(c) && m.tongues ? { p: i, tongue: sortedTonguesOf(m)[0].idx } : { p: i, r: c.strike.r, theta: c.strike.theta || 0.6, mode: 'head' };
    sendKitMap(); save(); selectSlot(slotSel); buildPads();
  };
  ed.appendChild(ps);
  if (sl) {
    var pc = kit.pieces[sl.p].cfg, metal = isMetal(pc), hat = metal && pc.special.piece === 'hihat', m = kitModels[sl.p];
    if (isTg(pc) && m.tongues) {
      var ts = document.createElement('select'); sortedTonguesOf(m).forEach(function (t) { var o = document.createElement('option'); o.value = t.idx; o.textContent = noteName(t.note); ts.appendChild(o); });
      ts.value = String(sl.tongue); ts.onchange = function () { sl.tongue = +ts.value; sendKitMap(); save(); buildPads(); }; ed.appendChild(ts);
    } else {
      var strokes = hat ? [['head', 'tip'], ['shoulder', 'shoulder'], ['chick', 'pedal chick'], ['splash', 'pedal splash'], ['down', 'foot down (hold)']]
        : metal ? [['head', 'stick tip'], ['shoulder', 'shoulder (crash)']]
        : pc.kind === 'none' ? [['head', 'hit']] : [['head', 'head'], ['rimshot', 'rimshot'], ['rimclick', 'cross-stick'], ['rim', 'rim only']];
      var ss = document.createElement('select'); strokes.forEach(function (q) { var o = document.createElement('option'); o.value = q[0]; o.textContent = q[1]; ss.appendChild(o); });
      ss.value = sl.pedal || sl.mode || 'head';
      ss.onchange = function () { var v = ss.value; if (['chick', 'splash', 'down'].indexOf(v) >= 0) { sl.pedal = v; delete sl.r; delete sl.mode; } else { delete sl.pedal; sl.mode = v; if (sl.r == null) { sl.r = 0.7; sl.theta = 0.6; } } sendKitMap(); save(); buildPads(); drawHead(); };
      ed.appendChild(ss);
      if (hat && !sl.pedal) {
        var R = mkRange(0, 1, 0.01, sl.open == null ? 0 : sl.open, function (v) { return v < 0.03 ? 'closed' : v > 0.6 ? 'open ' + pct(v) : 'half ' + pct(v); }, function (v) { sl.open = v; sendKitMap(); save(); });
        var L = document.createElement('label'); L.textContent = 'hats'; R.row.appendChild(L); R.row.appendChild(R.inp); R.row.appendChild(R.V); R.row.className = 'row inline'; R.inp.onchange = function () { buildPads(); }; ed.appendChild(R.row);
      }
    }
  }
  var hint = $('padHint');
  hint.innerHTML = 'Each key is a stroke slot: pick its piece and stroke, then <b>click on the drum to set where that key hits</b>. Velocity only sets how hard. ' +
    'Keys <kbd>A</kbd><kbd>W</kbd><kbd>S</kbd>…<kbd>;</kbd> play from ' + noteName(kitKbOct * 12) + ' (<kbd>Z</kbd>/<kbd>X</kbd> shift); MIDI notes play their slot (aftertouch chokes, CC4 = hi-hat pedal).';
}
function kitHeadClick(e, r, th, x, y, rc) {
  var sl = kit.map[slotSel];
  if (!sl || sl.p !== kitSel) { toast('Pick a key that plays this piece (or assign this piece to the selected key)'); return true; }
  if (sl.pedal) { kitPlay(slotSel, cfg.strike.vel); return true; }
  if (sl.tongue != null) {
    if (isBars(cfg)) { var sx = headCv.width / rc.width, px = (x + 0.5) * rc.width * sx, py = (y + 0.5) * rc.height * sx, best = null, bd = 1e9; barRects.forEach(function (b) { var dx = px < b.x ? b.x - px : px > b.x + b.w ? px - (b.x + b.w) : 0, dy = py < b.y ? b.y - py : py > b.y + b.h ? py - (b.y + b.h) : 0; if (dx + dy < bd) { bd = dx + dy; best = b; } }); if (best) sl.tongue = best.idx; }
    else if (model.tongues) { var bt = null, bdd = 9; model.tongues.forEach(function (t) { var dd = Math.abs(Math.atan2(Math.sin(th - t.th), Math.cos(th - t.th))); if (dd < bdd) { bdd = dd; bt = t; } }); if (bt) sl.tongue = bt.idx; }
  } else {
    if (r > 1.25) return true;
    if (!isMetal(cfg) && cfg.kind !== 'none' && r > 1.0) { sl.mode = e.altKey ? 'rimshot' : 'rim'; sl.r = 0.97; }   // on the rim ring: a rim hit (Alt: rimshot)
    else { sl.r = Math.min(0.97, r); if (sl.mode === 'rim') sl.mode = 'head'; }   // moved back onto the head
    sl.theta = th;
  }
  sendKitMap(); save(); buildPads(); kitPlay(slotSel, cfg.strike.vel); setTimeout(function () { kitStop(slotSel); }, 200);
  return true;
}
// ---- groove (GM): rock beat with fills and a crash ----
function kitGroove(btn) {
  ensureAudio().then(function () {
    var step = 0, next = performance.now() + 60, dt = 60000 / 100 / 4;
    groove = { t: setInterval(function () {
      var now = performance.now();
      while (now >= next) {
        var b = step % 64, s16 = step % 16, v = cfg.strike.vel;
        var hits = [];
        if (s16 % 2 === 0) hits.push([s16 === 14 && b === 46 ? 46 : 42, (s16 % 4 === 0 ? 0.85 : 0.6) * v]);
        if (s16 === 0 || s16 === 7 || s16 === 10) hits.push([36, 0.95 * v]);
        if (s16 === 4 || s16 === 12) hits.push([38, 0.95 * v]);
        if (s16 === 6 || s16 === 15) hits.push([38, 0.28 * v]);
        if (b === 0) hits.push([49, v]);
        if (b >= 60) { hits = [[b === 60 ? 48 : b === 61 ? 47 : b === 62 ? 45 : 41, 0.9 * v]]; if (b === 60) hits.push([36, 0.9 * v]); }
        hits.forEach(function (h) { if (kit.map[h[0]]) { kitPlay(h[0], Math.min(1, h[1])); (function (n) { setTimeout(function () { kitStop(n); }, 90); })(h[0]); } });
        step++; next += dt;
      }
    }, 5) };
  }, function () { btn.classList.remove('on'); });
}

window.__drum = { get kit() { return kit; }, get kitMode() { return kitMode; }, get kitModels() { return kitModels; }, get barRects() { return barRects; }, makeIR: makeIR, buildBus: buildBus, setBus: setBus, get anim() { return anim; }, get shapes() { return shapes; }, get model() { return model; }, get ctx() { return ctx; }, get node() { return node; }, get cfg() { return cfg; } };
// ---------------- MIDI panel (plugin): what CCs do, velocity feel, pitch bend, per-piece outputs ----------------
var MIDI_DEF = { velCurve: 0, bendRange: 2, bendPiece: -1, ccs: [{ cc: 4, target: 'pedal', piece: -1 }, { cc: 1, target: 'pedal', piece: -1 }] };
var midiCfg = (function () { try { var m = JSON.parse(LS.getItem('drumlab.midi') || 'null'); if (m && m.ccs) return m; } catch (e) {} return clone(MIDI_DEF); })();
var learnRow = -1;
function midiSave() { try { LS.setItem('drumlab.midi', JSON.stringify(midiCfg)); } catch (e) {} post({ type: 'midicfg', cfg: midiCfg }); }
function midiPieces() { return kitMode && kit ? kit.pieces.map(function (p, i) { return { i: i, name: (i + 1) + '. ' + (p.name || 'Piece') }; }) : []; }
function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
function renderMidi() {
  var ps = midiPieces(), h = '';
  var tgtOpts = [['pedal', 'Hi-hat pedal'], ['strike', 'Strike position'], ['choke', 'Choke / grab']];
  function pieceSel(cur, allLbl) {
    if (!ps.length) return '<select disabled><option>This instrument</option></select>';
    return '<select>' + ['<option value="-1"' + (cur < 0 ? ' selected' : '') + '>' + allLbl + '</option>'].concat(ps.map(function (p) { return '<option value="' + p.i + '"' + (p.i === cur ? ' selected' : '') + '>' + esc(p.name) + '</option>'; })).join('') + '</select>';
  }
  h += '<div class="midisec"><h5>Controllers</h5><p>Point any CC (mod wheel, foot controller, a knob) at a control. Hi-hat pedal: 0 = foot up (open), 127 = closed. Strike position: 0 = centre (a cymbal’s bell), 127 = edge. Click <b>Learn</b>, then move the control.</p>';
  h += '<div class="midirow midihead"><span>CC</span><span></span><span>Controls</span><span>Piece</span><span>Reverse</span><span></span></div>';
  midiCfg.ccs.forEach(function (c, i) {
    h += '<div class="midirow" data-i="' + i + '"><input type="number" min="0" max="127" value="' + c.cc + '" data-k="cc"><button class="learn' + (learnRow === i ? ' on' : '') + '" data-k="learn">' + (learnRow === i ? 'Move…' : 'Learn') + '</button>' +
      '<select data-k="target">' + tgtOpts.map(function (o) { return '<option value="' + o[0] + '"' + (c.target === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select>' +
      pieceSel(c.piece == null ? -1 : c.piece, c.target === 'pedal' ? 'Every hi-hat' : 'All pieces').replace('<select', '<select data-k="piece"') +
      '<label><input type="checkbox" data-k="invert"' + (c.invert ? ' checked' : '') + '>rev</label><button data-k="del" title="Remove">×</button></div>';
  });
  h += '<div class="midiline"><button id="midiAdd">+ Add controller</button><button id="midiReset">Reset to defaults</button></div></div>';
  var vc = midiCfg.velCurve || 0;
  h += '<div class="midisec"><h5>Velocity</h5><div class="midiline"><span>softer</span><input type="range" id="midiVel" min="-1" max="1" step="0.05" value="' + vc + '"><span>harder</span><span id="midiVelV" style="width:150px;font-family:var(--mono)"></span></div><p>Shapes how key velocity maps to stroke strength. Middle = as played.</p></div>';
  h += '<div class="midisec"><h5>Pitch bend</h5><div class="midiline"><span>Range ±</span><input type="number" id="midiBend" min="0" max="24" step="1" value="' + (midiCfg.bendRange == null ? 2 : midiCfg.bendRange) + '" style="width:64px"><span>semitones</span><span style="margin-left:14px">bends</span>' +
    pieceSel(midiCfg.bendPiece == null ? -1 : midiCfg.bendPiece, 'The whole kit').replace('<select', '<select id="midiBendP"') + '</div><p>The bend wheel retunes the modes live, like turning the tension rods (or the tuning of a bar) while it rings.</p></div>';
  h += '<div class="midisec"><h5>Separate outputs</h5><p>Turn on the extra outputs in your DAW (in Cakewalk: insert the synth with <b>All synth audio outputs: stereo</b>). Each piece then plays on its own stereo pair and leaves the main mix; the room reverb stays on the main mix.</p>';
  h += ps.length ? '<div class="midiouts">' + ps.map(function (p) { return 'Out ' + (p.i + 2) + ' → ' + esc(p.name); }).join('<br>') + '</div>' : '<p>(In kit mode each piece gets its own output.)</p>';
  h += '</div>';
  $('midiBody').innerHTML = h;
  var curveTxt = function (v) { var e = Math.pow(3, -v); return 'vel 64 → ' + Math.round(127 * Math.pow(64 / 127, e)); };
  $('midiVelV').textContent = curveTxt(vc);
  $('midiVel').oninput = function () { midiCfg.velCurve = +this.value; $('midiVelV').textContent = curveTxt(+this.value); midiSave(); };
  $('midiBend').onchange = function () { midiCfg.bendRange = Math.max(0, Math.min(24, +this.value || 0)); midiSave(); };
  if ($('midiBendP')) $('midiBendP').onchange = function () { midiCfg.bendPiece = +this.value; midiSave(); };
  $('midiAdd').onclick = function () { midiCfg.ccs.push({ cc: 11, target: 'strike', piece: -1 }); learnRow = midiCfg.ccs.length - 1; midiSave(); renderMidi(); };
  $('midiReset').onclick = function () { midiCfg = clone(MIDI_DEF); learnRow = -1; midiSave(); renderMidi(); };
  Array.prototype.forEach.call($('midiBody').querySelectorAll('.midirow[data-i]'), function (row) {
    var i = +row.getAttribute('data-i'), c = midiCfg.ccs[i];
    row.querySelectorAll('[data-k]').forEach(function (el) {
      var k = el.getAttribute('data-k');
      if (k === 'learn') el.onclick = function () { learnRow = learnRow === i ? -1 : i; renderMidi(); };
      else if (k === 'del') el.onclick = function () { midiCfg.ccs.splice(i, 1); learnRow = -1; midiSave(); renderMidi(); };
      else if (k === 'invert') el.onchange = function () { c.invert = this.checked; midiSave(); };
      else el.onchange = function () { c[k] = k === 'target' ? this.value : Math.max(k === 'cc' ? 0 : -1, Math.min(127, Math.round(+this.value))); if (k === 'target') { renderMidi(); } midiSave(); };
    });
  });
}
if (PLUG) {
  $('midiBtn').style.display = '';
  $('midiBtn').onclick = function () { learnRow = -1; renderMidi(); $('midiModal').classList.add('show'); };
  $('midiClose').onclick = function () { learnRow = -1; $('midiModal').classList.remove('show'); };
  if (PLUG.on) PLUG.on('dhmidi', function (o) {
    $('midiLast').textContent = 'last controller: CC ' + o.cc + ' = ' + o.v;
    if (learnRow >= 0 && midiCfg.ccs[learnRow]) { midiCfg.ccs[learnRow].cc = o.cc; learnRow = -1; midiSave(); if ($('midiModal').classList.contains('show')) renderMidi(); }
  });
}

// ---------------- boot ----------------
if (PLUG) { ctx = { plugin: true, sampleRate: SR, currentTime: 0, state: 'running', resume: function () {} }; engineKind = 'Plugin engine'; }
fillPresets();
['mix', 'strike', 'snare'].forEach(function (k) { cfg[k] = Object.assign({}, clone(P[DEFAULT][k]), cfg[k] || {}); });
if (!cfg.special) cfg.special = { type: 'none' };
if (!cfg.mics) cfg.mics = { close: 1, oh: 0.5, width: 0.6, height: 0.9, pan: 0 };
var bootMode = LS.getItem('drumlab.mode');   // (read before the first rebuild saves 'single' over it)
buildPanel(); syncVel(); rebuild();
$('kitBtn').onclick = function () { if (kitMode) kitExit(); else { var saved = null; try { saved = JSON.parse(LS.getItem('drumlab.kit') || 'null'); } catch (e) {} kitEnter(saved && saved.pieces ? saved : DK[Object.keys(DK)[0]]); } };
try { if (bootMode === 'kit') { var sk = JSON.parse(LS.getItem('drumlab.kit') || 'null'); if (sk && sk.pieces) kitEnter(sk); } } catch (e) {}
window.addEventListener('resize', function () { drawHead(); drawProfile(); previewSpectrum(); });
if (PLUG) {   // go live once the page has finished building (a saved kit is built just after boot); if the plugin already
  // restored this project's instrument, don't rebuild it just because the window opened
  var goLive = function () { PLUG.live = true; if (!PLUG.hasInstrument) resendAll(); applyBus(); status(true); };
  if (kitMode) setTimeout(goLive, 60); else goLive();
}
document.fonts && document.fonts.ready.then(function () { drawProfile(); });
})();
