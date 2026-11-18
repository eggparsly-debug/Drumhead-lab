// The Studio-kit test groove (same as reference/groove.js): 8 bars at 96 BPM, fixed-seed humanising.
module.exports = function (sr) {
  const s16 = 60 / 96 / 4, ev = []; let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const add = (step, n, v) => ev.push([Math.round((step * s16 + (rnd() - .5) * .006) * sr), n, Math.min(1, v * (0.93 + rnd() * .1))]);
  for (let bar = 0; bar < 8; bar++) { const o = bar * 16;
    if (bar === 0) add(o, 49, .9);
    for (let s = 0; s < 16; s += 2) { if (bar < 4) add(o + s, 42, s % 4 ? .5 : .72); else add(o + s, 51, s % 4 ? .55 : .75); }
    if (bar === 3) add(o + 14, 46, .7);
    [0, 7, 10].forEach(s => add(o + s, 36, s ? .75 : .9)); if (bar % 2) add(o + 13, 36, .6);
    add(o + 4, 38, .9); add(o + 12, 38, .92); if (bar % 2 === 0) add(o + 15, 38, .25);
    if (bar === 7) { [8, 9, 10, 11].forEach(s => add(o + s, 48, .8)); [12, 13].forEach(s => add(o + s, 45, .85)); [14, 15].forEach(s => add(o + s, 41, .9)); }
  }
  add(128, 49, .95); add(128, 36, .95); add(132, 55, .8);
  ev.sort((a, b) => a[0] - b[0]);
  return ev;
};
