// VYUHA - PILLAR 3: Evidence Ledger + Bayesian belief fusion.
// The operator NEVER sees ground truth. He sees evidence, and a belief he has
// to act on and DECLARE confidence in. That belief is what gets scored.

export const HYPOTHESES = ['HOSTILE_UAV', 'OWN_UAV', 'CIVILIAN_DRONE', 'BIRD', 'NON_DRONE'];

export function newLedger(prior = null) {
  const p = prior || { HOSTILE_UAV: 0.34, OWN_UAV: 0.14, CIVILIAN_DRONE: 0.20, BIRD: 0.20, NON_DRONE: 0.12 };
  const total = HYPOTHESES.reduce((s, h) => s + p[h], 0);
  return {
    belief: Object.fromEntries(HYPOTHESES.map(h => [h, p[h] / total])),
    entries: [],
    peakBelief: 0,
    firstContactT: null,
    // A sensor may only speak ONCE in the negative. Sweeps are not independent
    // trials - 200 correlated misses are not 200 pieces of evidence, and
    // accumulating them drives the belief to 1.0 on the wrong hypothesis.
    negativeSpoken: new Set(),
    positiveCount: {}
  };
}

/**
 * Likelihood ratios per sensor kind.
 * These are the "how much does this observation move the needle" weights.
 * NOTE: the ratios themselves are the team's calibration and are flagged as an
 * assumption in the provenance panel; the STRUCTURE (which sensor can and
 * cannot speak to which hypothesis) is driven by the government data pack.
 */
/**
 * Detection probability PROFILE per sensor kind.
 * Each entry answers: "if the true category were H, what is this sensor's Pd at
 * the range and conditions of THIS look?" Negative evidence is then computed by
 * Bayes' rule from the profile - never from a hand-set number.
 */
const PD_PROFILE = {
  radar:    { HOSTILE_UAV: 0.80, OWN_UAV: 0.80, CIVILIAN_DRONE: 0.80, BIRD: 0.70, NON_DRONE: 0.45 },
  rf:       { HOSTILE_UAV: 0.70, OWN_UAV: 0.70, CIVILIAN_DRONE: 0.70, BIRD: 0.02, NON_DRONE: 0.02 },
  eo:       { HOSTILE_UAV: 0.75, OWN_UAV: 0.75, CIVILIAN_DRONE: 0.75, BIRD: 0.75, NON_DRONE: 0.40 },
  acoustic: { HOSTILE_UAV: 0.70, OWN_UAV: 0.70, CIVILIAN_DRONE: 0.70, BIRD: 0.30, NON_DRONE: 0.05 }
};

/**
 * Positive-evidence likelihood ratios.
 * The STRUCTURE (which sensor can speak to which hypothesis) comes from the
 * government data pack; the magnitudes are the team's calibration and are
 * flagged as assumptions in the provenance panel.
 */
const LR_POSITIVE = {
  radar: {
    detected:   { HOSTILE_UAV: 1.5, OWN_UAV: 1.5, CIVILIAN_DRONE: 1.4, BIRD: 1.3, NON_DRONE: 0.3 },
    classified: { HOSTILE_UAV: 1.8, OWN_UAV: 1.3, CIVILIAN_DRONE: 1.2, BIRD: 0.5, NON_DRONE: 0.2 },
    identified: { HOSTILE_UAV: 2.0, OWN_UAV: 1.6, CIVILIAN_DRONE: 1.4, BIRD: 0.3, NON_DRONE: 0.1 }
  },
  rf: {
    detected:   { HOSTILE_UAV: 2.4, OWN_UAV: 1.4, CIVILIAN_DRONE: 2.0, BIRD: 0.05, NON_DRONE: 0.1 },
    classified: { HOSTILE_UAV: 2.2, OWN_UAV: 1.2, CIVILIAN_DRONE: 1.6, BIRD: 0.04, NON_DRONE: 0.06 },
    identified: { HOSTILE_UAV: 2.4, OWN_UAV: 1.8, CIVILIAN_DRONE: 1.8, BIRD: 0.03, NON_DRONE: 0.04 }
  },
  eo: {
    detected:   { HOSTILE_UAV: 1.8, OWN_UAV: 1.7, CIVILIAN_DRONE: 1.7, BIRD: 1.5, NON_DRONE: 0.4 },
    classified: { HOSTILE_UAV: 2.2, OWN_UAV: 2.0, CIVILIAN_DRONE: 2.0, BIRD: 0.25, NON_DRONE: 0.12 },
    identified: { HOSTILE_UAV: 3.2, OWN_UAV: 2.8, CIVILIAN_DRONE: 2.6, BIRD: 0.1, NON_DRONE: 0.05 }
  },
  acoustic: {
    detected:   { HOSTILE_UAV: 1.6, OWN_UAV: 1.5, CIVILIAN_DRONE: 1.5, BIRD: 0.7, NON_DRONE: 0.3 },
    classified: { HOSTILE_UAV: 1.4, OWN_UAV: 1.3, CIVILIAN_DRONE: 1.3, BIRD: 0.6, NON_DRONE: 0.3 },
    identified: { HOSTILE_UAV: 1.4, OWN_UAV: 1.3, CIVILIAN_DRONE: 1.3, BIRD: 0.6, NON_DRONE: 0.3 }
  }
};

/**
 * NEGATIVE EVIDENCE, computed properly.
 * A sweep that finds nothing is only informative to the degree the sensor
 * SHOULD have found each hypothesis. Bayes:
 *     LR(H) = (1 - Pd(H)) / sum_H' P(H') (1 - Pd(H'))
 * So a 20%-Pd radar sweep that misses tells you almost nothing, while a 90%-Pd
 * RF sweep that misses is strong evidence that the target has no control link -
 * which is exactly the fibre-optic-FPV lesson.
 */
export function negativeLR(kind, pdObserved, belief) {
  const profile = PD_PROFILE[kind] || PD_PROFILE.radar;
  const pd = {};
  for (const h of HYPOTHESES) {
    if (h === 'BIRD' || h === 'NON_DRONE') pd[h] = profile[h];
    else pd[h] = Math.max(pdObserved, profile[h] * 0.6);
  }
  let denom = 0;
  for (const h of HYPOTHESES) denom += belief[h] * (1 - pd[h]);
  if (denom <= 1e-12) return Object.fromEntries(HYPOTHESES.map(h => [h, 1]));
  const lr = {};
  for (const h of HYPOTHESES) lr[h] = (1 - pd[h]) / denom;
  return lr;
}

/** Damped Bayesian update.
 *  Bayes works on ODDS, not on raw probabilities - so the strength exponent has
 *  to be applied to the posterior odds, otherwise the damping also suppresses
 *  the prior odds and a long chain of good evidence never converges.
 *    odds_post = odds_prior x LR
 *    odds'     = odds_post ^ strength        (strength 1 -> exact Bayes)
 */
function blendedUpdate(belief, lr, strength) {
  const base = Math.max(...HYPOTHESES.map(h => belief[h]));
  const ref = base > 0 ? HYPOTHESES.find(h => belief[h] === base) : HYPOTHESES[0];
  const oddsRefPrior = refProbToOdds(belief[ref]);

  const odds = {};
  for (const h of HYPOTHESES) {
    const oddsPrior = refProbToOdds(belief[h]) / (oddsRefPrior || 1e-12);
    odds[h] = Math.pow(Math.max(oddsPrior * (lr[h] ?? 1), 1e-12), strength);
  }
  let total = 0;
  for (const h of HYPOTHESES) total += odds[h];
  const out = {};
  for (const h of HYPOTHESES) out[h] = odds[h] / total;
  return out;
}

function refProbToOdds(p) {
  const q = Math.min(Math.max(p, 1e-9), 1 - 1e-9);
  return q / (1 - q);
}

function describe(r) {
  switch (r.kind) {
    case 'radar':
      return r.detected
        ? `Radar return ${(r.sinr_db ?? 0).toFixed(1)} dB SINR, SCR ${(r.scr_db ?? 0).toFixed(1)} dB`
        : `Radar sweep: no return${r.why ? ' (' + r.why + ')' : ''}`;
    case 'rf':
      return r.detected
        ? `RF link ${r.band_ghz} GHz, ${r.protocol}, hop ${r.hop_rate_hz} Hz, margin ${(r.margin_db ?? 0).toFixed(1)} dB`
        : `RF sweep: no emitter${r.why ? ' (' + r.why + ')' : ''}`;
    case 'eo':
      return r.detected
        ? `EO/IR: ${(r.px_across ?? 0).toFixed(1)} px across target, \u03C4=${(r.tau ?? 0).toFixed(2)}, ${r.cued ? 'cued' : 'search'}`
        : `EO/IR: no acquisition${r.why ? ' (' + r.why + ')' : ''}`;
    case 'acoustic':
      return r.detected
        ? `Acoustic array: BPF present, SNR ${(r.snr_db ?? 0).toFixed(1)} dB`
        : `Acoustic array: below ambient`;
    default: return 'observation';
  }
}

/**
 * Push one sensor report into the ledger and update the belief.
 * `groundTruth` is used ONLY to decide how much the observation should be
 * trusted when the sensor reported a classification/identification.
 */
export function ingest(ledger, report, env, groundTruth, rng = Math.random) {
  const table = LR_POSITIVE[report.kind] || LR_POSITIVE.radar;
  const key = report.identified ? 'identified' : report.classified ? 'classified' : 'detected';
  let lr, strength;

  if (report.detected) {
    // The likelihood ratio is scaled by how confident the sensor actually is.
    // A 19%-confidence class read is 19% of the evidence, not 100%.
    const conf = key === 'detected'
      ? Math.min(1, Math.max(0.2, (report.pd ?? 0.5) / 0.8))
      : Math.min(1, Math.max(0.15, (key === 'identified' ? report.pid : report.pcls) ?? 0.3));
    lr = {};
    for (const h of HYPOTHESES) lr[h] = 1 + ((table[key][h] ?? 1) - 1) * conf;
    // Diminishing returns: the first few corroborating looks are evidence, the
    // two-hundredth identical blip is not.
    const n = (ledger.positiveCount[report.kind] = (ledger.positiveCount[report.kind] || 0) + 1);
    strength = 0.9 * Math.pow(0.8, Math.min(n - 1, 12));
  } else {
    // NEGATIVE EVIDENCE, once per sensor, and only when the sensor would
    // genuinely have seen the target. This is what makes "the RF detector is
    // silent" a real conclusion about a fibre-optic FPV instead of noise.
    const shouldHaveSeen = (report.pd ?? 0) >= 0.85;
    if (!shouldHaveSeen || ledger.negativeSpoken.has(report.kind)) {
      return { t: env.t, sensor: report.sensor, kind: report.kind, detected: false, text: describe(report), delta: {}, beliefAfter: { ...ledger.belief }, observedLabel: null, uninformative: true };
    }
    ledger.negativeSpoken.add(report.kind);
    lr = negativeLR(report.kind, report.pd, ledger.belief);
    strength = 0.9;
  }

  // The sensor reports the label IT believes, which may be wrong. The engine
  // decides that upstream from the sensor's own reliability, so a misread moves
  // the belief the wrong way for a defensible reason rather than at random.
  let observedLabel = null;
  if (report.detected && report.classified && report.observedLabel && report.observedLabel !== groundTruth.category) {
    observedLabel = report.observedLabel;
    lr = { HOSTILE_UAV: 1, OWN_UAV: 1, CIVILIAN_DRONE: 1, BIRD: 1, NON_DRONE: 1 };
    lr[observedLabel] = 1 + ((table[key][groundTruth.category] ?? 2) - 1) * 0.9;
  }

  const before = { ...ledger.belief };
  ledger.belief = blendedUpdate(ledger.belief, lr, strength);

  const delta = {};
  for (const h of HYPOTHESES) delta[h] = ledger.belief[h] - before[h];

  const entry = {
    t: env.t,
    sensor: report.sensor,
    kind: report.kind,
    detected: report.detected,
    text: describe(report) +
      (report.detected && report.classified
        ? ' \u2192 class read: ' + (observedLabel || groundTruth.category) +
          ' @ ' + Math.round((report.pcls || 0) * 100) + '%' + (report.dwell ? ' (dwell ' + report.dwell + ')' : '')
        : ''),
    delta,
    beliefAfter: { ...ledger.belief },
    observedLabel
  };
  ledger.entries.push(entry);

  const top = topBelief(ledger.belief);
  if (ledger.firstContactT === null && report.detected) ledger.firstContactT = env.t;
  if (top.value > ledger.peakBelief) ledger.peakBelief = top.value;

  return entry;
}

export function topBelief(belief) {
  let best = HYPOTHESES[0];
  for (const h of HYPOTHESES) if (belief[h] > belief[best]) best = h;
  return { hypothesis: best, value: belief[best] };
}

export function entropy(belief) {
  let h = 0;
  for (const k of HYPOTHESES) if (belief[k] > 1e-9) h -= belief[k] * Math.log2(belief[k]);
  return h / Math.log2(HYPOTHESES.length);   // normalised 0..1
}

/** Map a hypothesis to the classification label the operator must pick. */
export const GROUND_TRUTH_CATEGORY = {
  COMMERCIAL_QUAD: 'HOSTILE_UAV', HEX_BOMBER: 'HOSTILE_UAV', FPV: 'HOSTILE_UAV',
  FIBER_OPTIC_FPV: 'HOSTILE_UAV', FIXED_WING_SPOTTER: 'HOSTILE_UAV',
  LOITERING_MUNITION: 'HOSTILE_UAV', DECOY: 'HOSTILE_UAV',
  OWN_UAV: 'OWN_UAV', CIVILIAN_DRONE: 'CIVILIAN_DRONE', BIRD: 'BIRD', CLUTTER: 'NON_DRONE'
};
