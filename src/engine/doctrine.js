// VYUHA - PILLAR 4: Graduated-response doctrine tree + dual-path root-cause scoring.
//
// Every decision is evaluated TWICE:
//   (a) against GROUND TRUTH   -> was the action objectively right?
//   (b) against WHAT THE TRAINEE BELIEVED -> why was it wrong?
// That second pass is what turns "wrong" into a teachable root cause.

export const ROOT_CAUSES = [
  'UNDETECTED', 'CLASSIFICATION', 'IDENTIFICATION', 'DOCTRINE',
  'SITUATION', 'TIMING', 'NO_DECISION', 'CORRECT'
];

export const ROOT_CAUSE_LABEL = {
  UNDETECTED: 'Never detected - sensor posture / scan strategy',
  CLASSIFICATION: 'Detected, wrong class',
  IDENTIFICATION: 'Right class, wrong hostile/friendly call',
  DOCTRINE: 'Right picture, wrong effector or wrong escalation level',
  SITUATION: 'Airspace / deconfliction awareness',
  TIMING: 'Everything right, too late',
  NO_DECISION: 'No decision taken before the threat resolved',
  CORRECT: 'Doctrinally correct'
};

/**
 * Walk the doctrine tree and return the ideal effector for a target,
 * plus the node at which a given actual action diverged.
 */
/**
 * Apply the hard legal and physical constraints to a chosen effector.
 * Runs on EVERY return path, including the confidence gate, so an early return
 * can never smuggle an illegal action past the zone or envelope rules.
 */
function applyConstraints(pack, effectorId, ctx) {
  const { zone, populatedGround, rangeM, target } = ctx;
  const byId = id => pack.effectors.find(e => e.id === id);
  const worksOn = eff => !target || eff.works_on.includes('*') || eff.works_on.includes(target.def.id);
  const fallback = eff => byId(eff.level >= 4 && zone.engagement_authorised ? 'LASER' : 'JAM');

  let eff = byId(effectorId) || pack.effectors[0];

  // A kinetic strike needs a zone that authorises it.
  if (eff.level >= 4 && !zone.engagement_authorised) eff = byId('JAM');
  // A gun over populated ground is prohibited - substitute the softest effector
  // that is still effective on THIS platform, not just the cheapest one.
  if (eff.id === 'GUN' && populatedGround) {
    const sub = pack.effectors
      .filter(e => e.level >= 3 && e.id !== 'GUN' && worksOn(e))
      .filter(e => e.level < 4 || zone.engagement_authorised)
      .sort((a, b) => a.level - b.level || a.cost_inr - b.cost_inr)[0];
    eff = sub || fallback(eff);
  }
  // Whatever survives must be able to reach the target.
  if (eff.level > 0 && rangeM > eff.range_m) eff = byId('MONITOR');
  return eff;
}

/**
 * Choose the effector to use against a target.
 *
 * The doctrine table `min_sufficient_level` is a FLOOR, not a suggestion: it
 * encodes the least force that actually achieves the mission against each
 * platform. A loitering munition is a one-way attack weapon - jamming it does
 * not remove the threat, so doctrine demands a hard kill. Escalation economy is
 * therefore about NOT going above the floor, never about going below it.
 *
 * From that floor upward we then pick the cheapest effector that ACTUALLY works
 * on this target, inside its envelope, inside the time available:
 *   - a soft-kill is skipped when the target has no RF link or no GNSS dependency
 *   - an effector whose effect time exceeds the time to target is skipped
 */
function minimumSufficient(pack, target, rangeM, timeAvailableS) {
  const preferredId = pack.doctrine.min_sufficient_level[target.def.id] || 'MONITOR';
  const preferred = pack.effectors.find(e => e.id === preferredId) || pack.effectors[0];
  const floor = preferred.level;
  const cands = pack.effectors
    .filter(e => e.level >= Math.max(2, floor))
    .filter(e => e.works_on.includes(target.def.id))
    .filter(e => !(e.id === 'JAM' && !target.def.rf))
    .filter(e => !(e.id === 'SPOOF' && !target.def.gnss_dependent))
    .filter(e => e.range_m >= rangeM)
    .filter(e => timeAvailableS === null || e.effect_time_s <= timeAvailableS)
    .sort((a, b) => a.level - b.level || a.cost_inr - b.cost_inr);
  const chosen = cands[0] || preferred;
  return { eff: chosen, preferred, skippedSoftKill: chosen.id !== preferredId && preferred.level <= 2 };
}

/**
 * Walk the doctrine tree and return the ideal effector for a target, plus the
 * node at which a given actual action diverged.
 */
export function walkTree(pack, ctx) {
  const { zone, target, beliefHostile, timeAvailableS, friendlyInCorridor, populatedGround } = ctx;
  const rangeM = ctx.rangeM ?? target.range_m ?? 0;
  const tauEng = pack.doctrine.confidence_threshold_engage;
  const tauWarn = pack.doctrine.confidence_threshold_warn;

  // Q2 CONFIDENCE GATE. Doctrine is applied to the picture the operator actually
  // holds, not to an omniscient one. Below the engagement threshold the correct
  // action is to warn or to hold - scoring him for not jamming would be scoring
  // him for guessing.
  if (beliefHostile < tauEng) {
    const gated = applyConstraints(pack, beliefHostile >= tauWarn ? 'WARN' : 'MONITOR', ctx);
    return {
      effector: gated.id, level: gated.level, confidenceGated: true, beliefHostile,
      holdForRange: rangeM > 0 && gated.level > 0 && rangeM > gated.range_m,
      nodes: [{ id: 'Q2_IDENTIFICATION', pass: false, detail: `belief ${(beliefHostile * 100).toFixed(0)}% is below the ${(tauEng * 100).toFixed(0)}% engagement threshold - ${gated.label} is the doctrinal action` }]
    };
  }

  const ms = minimumSufficient(pack, target, rangeM, timeAvailableS);
  const eff = applyConstraints(pack, ms.eff.id, ctx);

  const nodes = [
    { id: 'Q1_AIRSPACE', pass: zone.engagement_authorised || eff.level < 4, detail: `${zone.label} zone` },
    { id: 'Q2_IDENTIFICATION', pass: beliefHostile >= tauEng, detail: `belief ${(beliefHostile * 100).toFixed(0)}%` },
    { id: 'Q3_DECONFLICTION', pass: !friendlyInCorridor || eff.level < 4, detail: friendlyInCorridor ? 'friendly in corridor - kinetic prohibited' : 'corridor clear' },
    { id: 'Q4_FIT', pass: !ms.skippedSoftKill, detail: ms.skippedSoftKill
      ? `${pack.doctrine.min_sufficient_level[target.def.id] || 'soft kill'} will not work on ${target.def.label} - escalated to ${eff.label}`
      : `${eff.label} is effective on ${target.def.label}` },
    { id: 'Q5_ESCALATION', pass: true, detail: `minimum sufficient level = ${eff.label}` },
    { id: 'Q6_TIMING', pass: timeAvailableS === null || eff.effect_time_s <= timeAvailableS, detail: `${(timeAvailableS ?? 0).toFixed(1)} s available, ${eff.effect_time_s} s needed` }
  ];

  // Q6: if even the chosen effector is too slow, escalate to the fastest one
  // that is effective and legal.
  let finalEff = eff;
  if (timeAvailableS !== null && eff.effect_time_s > timeAvailableS && eff.level > 0) {
    const faster = pack.effectors
      .filter(e => e.level >= 3 && e.works_on.includes(target.def.id))
      .filter(e => e.effect_time_s <= timeAvailableS && e.range_m >= rangeM)
      .filter(e => e.level < 4 || zone.engagement_authorised)
      .filter(e => !(populatedGround && e.id === 'GUN'))
      .sort((a, b) => a.level - b.level || a.cost_inr - b.cost_inr)[0];
    if (faster) { finalEff = faster; nodes[5] = { ...nodes[5], pass: true, detail: `escalated to ${faster.label} for time` }; }
  }

  // Non-hostile platforms must never be engaged above WARN.
  if (target.def.hostile === false) {
    const safe = applyConstraints(pack, target.def.id === 'CIVILIAN_DRONE' ? 'WARN' : 'MONITOR', ctx);
    return { effector: safe.id, level: safe.level, nodes, benign: true, holdForRange: false };
  }

  // If doctrine wants a real effector but the target is still outside its
  // envelope, the ideal is to HOLD and let it close - not to commit MONITOR and
  // forfeit the engagement. Signal that so the operator (and the exemplar bot)
  // waits instead of standing down.
  const holdForRange = finalEff.id === 'MONITOR' && ms.eff.level > 0;
  return { effector: finalEff.id, level: finalEff.level, nodes, holdForRange };
}

/**
 * Root-cause attribution: given the trainee's declared belief, his classification
 * and his action, decide WHY the outcome was wrong.
 */
export function attributeRootCause(pack, ctx) {
  const { target, traineeClassification, declaredConfidence, action, ideal, detected, inTime, friendlyInCorridor, zone } = ctx;
  const truthCategory = target.groundTruth.category;

  if (!detected) return 'UNDETECTED';
  if (action === null || action === undefined) return 'NO_DECISION';

  const actLevel = pack.effectors.find(e => e.id === action)?.level ?? 0;
  const idealLevel = ideal.level;
  const isKinetic = actLevel >= 3;
  const isHardKill = actLevel >= 4;

  // Engaged a friendly / civilian / bird.
  if (!target.def.hostile && isKinetic) {
    return traineeClassification !== truthCategory ? 'CLASSIFICATION' : 'DOCTRINE';
  }
  // KINETIC deconfliction and airspace legality dominate everything.
  // (Soft-kill over a friendly is not fratricide - it is scored separately as
  //  EW fratricide in the penalty ledger, because the effect is recoverable.)
  if (isHardKill && friendlyInCorridor) return 'SITUATION';
  if (isHardKill && !zone.engagement_authorised) return 'SITUATION';

  // Wrong class reported.
  if (traineeClassification !== truthCategory) {
    // If the class error flips hostile/benign it is an identification failure.
    const flipsHostility =
      (truthCategory === 'HOSTILE_UAV') !== (traineeClassification === 'HOSTILE_UAV');
    return flipsHostility ? 'IDENTIFICATION' : 'CLASSIFICATION';
  }

  if (!inTime) return 'TIMING';
  if (action !== ideal.effector) {
    // Over-confident engagement below the doctrine threshold is a confidence-discipline
    // failure, which we bucket under DOCTRINE but tag separately for the AAR.
    if (declaredConfidence < pack.doctrine.confidence_threshold_engage && actLevel >= 3) return 'DOCTRINE';
    return 'DOCTRINE';
  }
  return 'CORRECT';
}

/**
 * Effector-threat fit. Returns whether the chosen effector can physically work,
 * the probability of kill, and any wasted-engagement reason.
 */
export function resolveEffector(pack, effectorId, target, rangeM, env, rng = Math.random) {
  const eff = pack.effectors.find(e => e.id === effectorId);
  if (!eff) return { ok: false, reason: 'unknown effector' };
  if (eff.level === 0) return { ok: true, neutralised: false, reason: 'monitor only', cost: 0 };

  if (rangeM > eff.range_m) return { ok: false, reason: `out of range (${rangeM.toFixed(0)} m > ${eff.range_m} m)`, wasted: true, cost: eff.cost_inr };
  if (!eff.works_on.includes(target.def.id) && !eff.works_on.includes('*')) {
    return { ok: false, reason: `ineffective against ${target.def.label}`, wasted: true, cost: eff.cost_inr };
  }
  // RF jamming against an RF-silent target is the classic modern failure.
  if (effectorId === 'JAM' && !target.def.rf) {
    return { ok: false, reason: 'target has no RF link - jamming has no effect', wasted: true, cost: eff.cost_inr };
  }
  // GNSS spoofing against a non-GNSS target.
  if (effectorId === 'SPOOF' && !target.def.gnss_dependent) {
    return { ok: false, reason: 'target is not GNSS-dependent - spoofing has no effect', wasted: true, cost: eff.cost_inr };
  }
  // Laser dwell is weather sensitive.
  let pk = eff.pk ?? 1.0;
  if (effectorId === 'LASER') {
    const weatherPenalty = 1 - Math.min(0.75, env.weather.attenuation_db_per_km * 0.18);
    pk *= weatherPenalty;
    if (env.light.crossover) pk *= 0.9;
  }
  if (effectorId === 'GUN') pk *= (env.light.id === 'NIGHT' ? 0.7 : 1.0);
  if (effectorId === 'NET') pk *= (target.def.speed_ms > 35 ? 0.35 : 1.0);

  return { ok: true, pk, neutralised: rng() < pk, cost: eff.cost_inr, reason: eff.label };
}

/** Escalation-Economy Index for one engagement: min sufficient / actually used. */
export function escalationEconomy(pack, idealEffectorId, usedEffectorId) {
  const a = pack.effectors.find(e => e.id === idealEffectorId);
  const b = pack.effectors.find(e => e.id === usedEffectorId);
  if (!a || !b) return 1;
  if (b.level === 0) return a.level === 0 ? 1 : 0;
  return Math.min(1, a.level / b.level);
}
