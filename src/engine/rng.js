// VYUHA - deterministic seeded RNG + math helpers
// Everything in the simulator is reproducible from (scenario seed, tick).

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export function pick(rng, arr) { return arr[Math.floor(rng() * arr.length) % arr.length]; }

export function pickWeighted(rng, items) {
  const total = items.reduce((s, it) => s + it.w, 0);
  let r = rng() * total;
  for (const it of items) { r -= it.w; if (r <= 0) return it; }
  return items[items.length - 1];
}

export function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

/** Box-Muller, deterministic from the supplied rng */
export function gauss(rng, mean = 0, sd = 1) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Swerling Case 1 fluctuating-target detection probability for a
 * non-coherently integrated, square-law detected return.
 *   Pd = Pf^(1/(1+SNR))
 */
export function pdSwerling1(snrLinear, pfa) {
  if (!(snrLinear > 0)) return 0;
  return Math.pow(pfa, 1 / (1 + snrLinear));
}

export function db2lin(db) { return Math.pow(10, db / 10); }
export function lin2db(x) { return x > 0 ? 10 * Math.log10(x) : -300; }

/**
 * Koschmieder's law: atmospheric transmission over a slant range,
 * anchored on the reported meteorological visibility (IMD METAR).
 *   beta = 3.912 / V_meteorological        (extinction coefficient, 1/m)
 *   tau  = exp(-beta * R)
 */
export function tauAtm(rangeM, visibilityM) {
  const beta = 3.912 / Math.max(visibilityM, 30);
  return Math.exp(-beta * rangeM);
}

export function fmtTime(s) {
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return String(m).padStart(2, '0') + ':' + sec.toFixed(1).padStart(4, '0');
}

export function fmtINR(v) {
  if (v >= 1e7) return '\u20B9' + (v / 1e7).toFixed(2) + ' cr';
  if (v >= 1e5) return '\u20B9' + (v / 1e5).toFixed(2) + ' lakh';
  if (v >= 1e3) return '\u20B9' + (v / 1e3).toFixed(1) + 'k';
  return '\u20B9' + v.toFixed(0);
}
