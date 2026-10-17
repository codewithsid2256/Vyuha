// VYUHA - scoring engine.
// 100 marks + an unbounded penalty ledger, plus three metrics nobody else reports:
//   - Escalation-Economy Index (minimum sufficient force vs force actually used)
//   - Cost-of-Exchange (rupees expended per rupee of threat neutralised)
//   - Training Gain (normalised between a random-bot floor and an exemplar-bot ceiling)

import { clamp } from './rng.js';
import { escalationEconomy } from './doctrine.js';

export const COMPONENTS = [
  { id: 'DETECTION', label: 'Detection', max: 25 },
  { id: 'CLASSIFICATION', label: 'Classification', max: 20 },
  { id: 'ENGAGEMENT', label: 'Engagement decision', max: 25 },
  { id: 'ESCALATION', label: 'Escalation economy', max: 10 },
  { id: 'CALIBRATION', label: 'Confidence calibration', max: 10 },
  { id: 'COORDINATION', label: 'Team coordination', max: 10 }
];

export const PENALTIES = {
  FRATRICIDE: { amount: 25, label: 'Fratricide - own asset engaged' },
  CIVILIAN_KILL: { amount: 20, label: 'Civilian / benign platform destroyed' },
  ROE_BREACH: { amount: 25, label: 'ROE breach - engagement in a prohibited zone' },
  COLLATERAL: { amount: 15, label: 'Collateral risk realised on populated ground' },
  WASTED_EFFECTOR: { amount: 5, label: 'Wasted effector - no effect on target' },
  MISSED_THREAT: { amount: 10, label: 'Hostile threat reached the defended area' },
  EW_FRATRICIDE: { amount: 8, label: 'EW fratricide - own UAV jammed' },
  OVERCONFIDENT_ENGAGE: { amount: 6, label: 'Engaged below the doctrine confidence threshold' },
  ROTE_SUSPECTED: { amount: 4, label: 'Rote suspected - reaction faster than the physics floor' }
};

/** Brier score across all declared confidences. Lower is better. */
export function brierScore(declarations) {
  if (!declarations.length) return null;
  let s = 0;
  for (const d of declarations) {
    const p = clamp(d.declared, 0, 1);
    const y = d.correct ? 1 : 0;
    s += (p - y) * (p - y);
  }
  return s / declarations.length;
}

/** Reliability diagram bins for the AAR calibration plot. */
export function reliabilityDiagram(declarations, bins = 10) {
  const out = Array.from({ length: bins }, (_, i) => ({
    lo: i / bins, hi: (i + 1) / bins, declared: 0, actual: 0, n: 0
  }));
  for (const d of declarations) {
    const idx = Math.min(bins - 1, Math.floor(clamp(d.declared, 0, 0.9999) * bins));
    out[idx].declared += d.declared;
    out[idx].actual += d.correct ? 1 : 0;
    out[idx].n++;
  }
  for (const b of out) {
    if (b.n) { b.declared /= b.n; b.actual /= b.n; }
  }
  return out;
}

export function calibrationError(declarations) {
  const bins = reliabilityDiagram(declarations);
  let e = 0, n = 0;
  for (const b of bins) { if (b.n) { e += Math.abs(b.declared - b.actual) * b.n; n += b.n; } }
  return n ? e / n : null;
}

/**
 * Detection score.
 * Two things are measured, because they are not the same thing:
 *   1. did the cell ever acquire the threat at all            -> binary
 *   2. how fast did it reach ACTIONABLE awareness (belief >= 0.6 on the true
 *      category), measured against the PHYSICS FLOOR the engine computed.
 * The physics floor is the denominator, so a trainee can never be penalised for
 * something the sensors could not have delivered in these conditions.
 */
export function detectionScore(events, physicsFloorS, windowS) {
  const hostile = events.filter(e => e.groundTruth.category === 'HOSTILE_UAV');
  if (!hostile.length) return { score: 25, detail: 'no hostile threats in this sortie', mean: 1, acquired: 1, actionable: 1 };
  let sum = 0, n = 0, acquired = 0, actionable = 0;
  for (const e of hostile) {
    if (e.detectedT !== null) acquired++;
    const mark = e.actionableT ?? null;
    if (mark === null) { sum += 0; n++; continue; }
    actionable++;
    const excess = Math.max(0, mark - physicsFloorS);
    sum += clamp(1 - excess / Math.max(windowS, 1), 0, 1);
    n++;
  }
  const mean = n ? sum / n : 0;
  return {
    score: 25 * mean, mean,
    acquired: acquired / hostile.length,
    actionable: actionable / hostile.length,
    detail: `${acquired}/${hostile.length} acquired, ${actionable}/${hostile.length} actionable`
  };
}

export function classificationScore(events) {
  const detected = events.filter(e => e.detectedT !== null && e.traineeClassification);
  if (!detected.length) return { score: 0, exact: 0, partial: 0, detail: 'nothing classified', confusion: null };
  let exact = 0, partial = 0;
  const confusion = {};
  for (const e of detected) {
    const truth = e.groundTruth.category, said = e.traineeClassification;
    confusion[truth] = confusion[truth] || {};
    confusion[truth][said] = (confusion[truth][said] || 0) + 1;
    if (said === truth) { exact++; partial++; }
    else if ((truth === 'HOSTILE_UAV') === (said === 'HOSTILE_UAV')) { partial += 0.5; }
  }
  const v = (0.7 * exact + 0.3 * partial) / detected.length;
  return { score: 20 * v, exact: exact / detected.length, partial: partial / detected.length, detail: `${exact}/${detected.length} exact`, confusion };
}

export function engagementScore(events) {
  const acted = events.filter(e => e.action);
  if (!acted.length) return { score: 0, detail: 'no engagement decisions', correct: 0 };
  let s = 0;
  for (const e of acted) {
    if (e.rootCause === 'CORRECT') s += 1;
    else if (e.rootCause === 'TIMING') s += 0.5;
    else if (e.rootCause === 'DOCTRINE' && e.actionLevel === e.idealLevel) s += 0.5;
  }
  const v = s / acted.length;
  return { score: 25 * v, correct: v, detail: `${acted.filter(e => e.rootCause === 'CORRECT').length}/${acted.length} doctrinally correct` };
}

export function escalationScore(events, pack) {
  const acted = events.filter(e => e.action && e.action !== 'MONITOR');
  if (!acted.length) return { score: 10, eei: 1, detail: 'no escalation' };
  let s = 0;
  for (const e of acted) s += escalationEconomy(pack, e.idealEffector, e.action);
  const eei = s / acted.length;
  return { score: 10 * eei, eei, detail: `EEI ${eei.toFixed(2)}` };
}

export function calibrationScore(declarations) {
  const b = brierScore(declarations);
  if (b === null) return { score: 5, brier: null, ece: null, detail: 'no confidence declared' };
  const ece = calibrationError(declarations);
  const v = clamp(1 - (b / 0.25) * 0.6 - (ece ?? 0) * 0.8, 0, 1);
  return { score: 10 * v, brier: b, ece, detail: `Brier ${b.toFixed(3)}, ECE ${(ece ?? 0).toFixed(3)}` };
}

export function coordinationScore(teamEvents) {
  if (!teamEvents || !teamEvents.length) return { score: 10, detail: 'single-seat sortie - coordination not assessed', handoverS: null };
  const handovers = teamEvents.filter(t => t.handoverS !== null);
  if (!handovers.length) return { score: 4, detail: 'no handovers recorded', handoverS: null };
  const mean = handovers.reduce((s, h) => s + h.handoverS, 0) / handovers.length;
  const commsOk = handovers.filter(h => h.commsCorrect).length / handovers.length;
  const v = clamp(0.6 * clamp(1 - (mean - 1) / 6, 0, 1) + 0.4 * commsOk, 0, 1);
  return { score: 10 * v, handoverS: mean, commsOk, detail: `mean handover ${mean.toFixed(1)} s, comms ${(commsOk * 100).toFixed(0)}% correct` };
}

export function penaltyLedger(violations) {
  const rows = [];
  let total = 0;
  for (const v of violations) {
    const p = PENALTIES[v.type];
    if (!p) continue;
    rows.push({ type: v.type, label: p.label, amount: p.amount, detail: v.detail || '' });
    total += p.amount;
  }
  return { rows, total };
}

export function costOfExchange(events, pack) {
  let spent = 0, threatValue = 0;
  for (const e of events) {
    if (!e.action) continue;
    const eff = pack.effectors.find(x => x.id === e.action);
    spent += eff ? eff.cost_inr : 0;
    if (e.neutralised) threatValue += pack.economics.threat_cost_inr[e.defId] || 0;
  }
  return { spent, threatValue, ratio: threatValue > 0 ? spent / threatValue : null };
}

/**
 * Assemble the full session result.
 * `benchmarks` carries the exemplar-bot (ceiling) and random-bot (floor) scores
 * for this exact scenario, produced by the headless bot runner.
 */
export function assembleSession(input) {
  const { pack, events, declarations, physicsFloorS, windowS, violations, teamEvents, benchmarks, meta } = input;

  const det = detectionScore(events, physicsFloorS, windowS);
  const cls = classificationScore(events);
  const eng = engagementScore(events);
  const esc = escalationScore(events, pack);
  const cal = calibrationScore(declarations);
  const coo = coordinationScore(teamEvents);
  const pen = penaltyLedger(violations);
  const coe = costOfExchange(events, pack);

  const gross = det.score + cls.score + eng.score + esc.score + cal.score + coo.score;
  const net = Math.max(0, gross - pen.total);

  // Training gain, normalised between the two bots.
  let trainingGain = null;
  if (benchmarks && benchmarks.exemplar != null && benchmarks.random != null) {
    const span = benchmarks.exemplar - benchmarks.random;
    trainingGain = span > 0 ? clamp((net - benchmarks.random) / span, 0, 1) : null;
  }

  // Root-cause histogram.
  const rootCauses = {};
  for (const e of events) {
    if (!e.rootCause) continue;
    rootCauses[e.rootCause] = (rootCauses[e.rootCause] || 0) + 1;
  }

  return {
    meta,
    components: [
      { ...COMPONENTS[0], ...det }, { ...COMPONENTS[1], ...cls }, { ...COMPONENTS[2], ...eng },
      { ...COMPONENTS[3], ...esc }, { ...COMPONENTS[4], ...cal }, { ...COMPONENTS[5], ...coo }
    ],
    gross, penalties: pen, net,
    detection: det, classification: cls, engagement: eng, escalation: esc,
    calibration: cal, coordination: coo,
    costOfExchange: coe,
    trainingGain, benchmarks,
    rootCauses,
    reliability: reliabilityDiagram(declarations),
    events
  };
}

/**
 * Sortie Certificate.
 * A tamper-evident fingerprint of everything that produced this score, so a unit
 * HQ can trust the record. Computed with the platform's own crypto binding.
 */
export function sortieCertificate(scenario, result, operatorId, packVersion, engineVersion) {
  const payload = JSON.stringify({
    seed: scenario.seed,
    fingerprintHash: scenario.fingerprintHash,
    dataPack: packVersion,
    engine: engineVersion,
    operator: operatorId,
    scoreVector: result.components.map(c => [c.id, +c.score.toFixed(3)]),
    net: +result.net.toFixed(3),
    penalties: result.penalties.rows.map(r => r.type),
    rootCauses: result.rootCauses
  });
  return { payload, hash: sha256hex(payload), issuedAt: new Date().toISOString() };
}

// sha256 is injected by the host (Node crypto in the server, SubtleCrypto in the
// browser) so this module stays environment-agnostic.
let sha256hex = (s) => {
  // Fallback FNV-1a - only used if the host never injects a real hash.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return 'fnv1a-' + h.toString(16);
};
export function setHasher(fn) { sha256hex = fn; }
