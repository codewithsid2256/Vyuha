// VYUHA - PILLAR 6/7: Adaptive Director (Bayesian Knowledge Tracing) + the
// cognitive-load model + the anti-rote detector.
//
// The AI decides WHAT YOU PRACTISE NEXT. It never decides what is true: the
// sensor physics and the doctrine tree are deterministic and data-pack driven.

import { clamp } from './rng.js';

export const SKILL_NODES = [
  { id: 'DETECT_EARLY', label: 'Early detection', axis: 'sensor' },
  { id: 'CLASS_RECON', label: 'Recognise recon quad', axis: 'recognition' },
  { id: 'CLASS_STRIKE', label: 'Recognise strike platform', axis: 'recognition' },
  { id: 'CLASS_FIBER', label: 'Recognise fibre-optic FPV', axis: 'recognition' },
  { id: 'CLASS_MUNITION', label: 'Recognise loitering munition', axis: 'recognition' },
  { id: 'CLASS_DECOY', label: 'Recognise decoy / saturation', axis: 'recognition' },
  { id: 'DISCRIMINATE_BIRD', label: 'Reject bird clutter', axis: 'discrimination' },
  { id: 'DISCRIMINATE_CIVIL', label: 'Reject civilian drone', axis: 'discrimination' },
  { id: 'IFF', label: 'IFF / own-UAV recognition', axis: 'discrimination' },
  { id: 'EFF_JAM', label: 'Soft-kill selection', axis: 'doctrine' },
  { id: 'EFF_KINETIC', label: 'Hard-kill selection', axis: 'doctrine' },
  { id: 'ESCALATION', label: 'Escalation economy', axis: 'doctrine' },
  { id: 'ROE', label: 'Airspace / ROE legality', axis: 'doctrine' },
  { id: 'DECONFLICTION', label: 'Corridor deconfliction', axis: 'situation' },
  { id: 'TIMING', label: 'Decision timing', axis: 'execution' },
  { id: 'SWARM', label: 'Saturation handling', axis: 'execution' },
  { id: 'NIGHT', label: 'Night / IR operation', axis: 'environment' },
  { id: 'WEATHER', label: 'Degraded-visibility operation', axis: 'environment' },
  { id: 'EW', label: 'Operation under EW', axis: 'environment' },
  { id: 'CALIBRATION', label: 'Confidence calibration', axis: 'metacognition' }
];

export function newTraineeModel(id = 'trainee') {
  const skills = {};
  for (const s of SKILL_NODES) skills[s.id] = { p: 0.35, n: 0, correct: 0 };
  return { id, skills, sessions: [], createdAt: Date.now() };
}

/**
 * Bayesian Knowledge Tracing update.
 *   p(L|obs) = p(obs|L)p(L) / p(obs)
 *   p(L_new) = p(L|obs) + (1 - p(L|obs)) * p(T)
 */
export function bktUpdate(skill, observedCorrect, params = {}) {
  const { pSlip = 0.12, pGuess = 0.22, pTransit = 0.18 } = params;
  const pL = skill.p;
  const pObs = observedCorrect ? (pL * (1 - pSlip) + (1 - pL) * pGuess)
                               : (pL * pSlip + (1 - pL) * (1 - pGuess));
  const post = pObs > 0 ? (observedCorrect ? pL * (1 - pSlip) : pL * pSlip) / pObs : pL;
  skill.p = clamp(post + (1 - post) * pTransit, 0.01, 0.995);
  skill.n++;
  if (observedCorrect) skill.correct++;
  return skill.p;
}

/** Fold one finished session into the trainee model and return the updated skills. */
export function learnFromSession(model, session, pack) {
  const obs = observationsFromSession(session, pack);
  for (const [skillId, correct] of obs) {
    if (model.skills[skillId]) bktUpdate(model.skills[skillId], correct);
  }
  model.sessions.push({
    at: Date.now(),
    seed: session.meta?.seed,
    net: session.net,
    trainingGain: session.trainingGain,
    rootCauses: session.rootCauses
  });
  return model;
}

/** Map a scored session onto skill-node observations. */
export function observationsFromSession(session, pack) {
  const out = [];
  const events = session.events || [];
  for (const e of events) {
    const truth = e.groundTruth?.category;
    // Detection skill
    if (truth === 'HOSTILE_UAV') {
      out.push(['DETECT_EARLY', e.detectedT !== null && e.detectedT <= (e.windowS ?? 30) * 0.6]);
    }
    // Recognition skills
    if (e.detectedT !== null && e.traineeClassification) {
      const correct = e.traineeClassification === truth;
      switch (e.defId) {
        case 'COMMERCIAL_QUAD': case 'FIXED_WING_SPOTTER': out.push(['CLASS_RECON', correct]); break;
        case 'HEX_BOMBER': case 'FPV': out.push(['CLASS_STRIKE', correct]); break;
        case 'FIBER_OPTIC_FPV': out.push(['CLASS_FIBER', correct]); break;
        case 'LOITERING_MUNITION': out.push(['CLASS_MUNITION', correct]); break;
        case 'DECOY': out.push(['CLASS_DECOY', correct]); break;
        case 'BIRD': out.push(['DISCRIMINATE_BIRD', correct]); break;
        case 'CIVILIAN_DRONE': out.push(['DISCRIMINATE_CIVIL', correct]); break;
        case 'OWN_UAV': out.push(['IFF', correct]); break;
      }
    }
    // Doctrine skills
    if (e.action) {
      const eff = pack.effectors.find(x => x.id === e.action);
      if (eff) {
        if (eff.level <= 2) out.push(['EFF_JAM', e.rootCause === 'CORRECT']);
        if (eff.level >= 4) out.push(['EFF_KINETIC', e.rootCause === 'CORRECT']);
      }
      out.push(['ESCALATION', e.rootCause !== 'DOCTRINE']);
      out.push(['TIMING', e.rootCause !== 'TIMING']);
      if (e.rootCause === 'SITUATION') { out.push(['ROE', false]); out.push(['DECONFLICTION', false]); }
      else { out.push(['ROE', true]); out.push(['DECONFLICTION', true]); }
    }
  }
  // Environment skills come from the scenario conditions and the session outcome.
  const m = session.meta || {};
  const didWell = session.net >= 60;
  if (m.lightId === 'NIGHT') out.push(['NIGHT', didWell]);
  if (m.weatherId === 'FOG' || m.weatherId === 'HAZE' || m.weatherId === 'RAIN') out.push(['WEATHER', didWell]);
  if (m.ewId && m.ewId !== 'NONE') out.push(['EW', didWell]);
  if (m.swarmSize >= 4) out.push(['SWARM', didWell]);
  if (session.calibration?.brier != null) out.push(['CALIBRATION', session.calibration.brier <= 0.15]);
  return out;
}

/**
 * The Director's job: choose the next sortie's difficulty and aim it at the
 * weakest skill. Returns a tier plus a scenario-force hint.
 */
export function nextSortie(model, pack, history = []) {
  const ranked = SKILL_NODES
    .map(s => ({ ...s, ...model.skills[s.id] }))
    .sort((a, b) => a.p - b.p);
  const weakest = ranked[0];
  const meanP = ranked.reduce((s, r) => s + r.p, 0) / ranked.length;

  // Tier from overall mastery, but never jump more than one tier at a time.
  const lastTier = history.length ? (history[history.length - 1].tier ?? 3) : 2;
  let tier = Math.round(1 + meanP * 4);
  tier = clamp(tier, Math.max(1, lastTier - 1), Math.min(5, lastTier + 1));

  const force = {};
  const biasBySkill = {
    CLASS_FIBER: 0.45, CLASS_STRIKE: 0.75, CLASS_MUNITION: 0.85, CLASS_DECOY: 0.95,
    CLASS_RECON: 0.15, SWARM: 0.9, DECONFLICTION: 0.5, IFF: 0.4
  };
  const bias = biasBySkill[weakest.id] ?? 0.5;

  if (weakest.id === 'NIGHT') force.light = pack.light.find(l => l.id === 'NIGHT');
  if (weakest.id === 'WEATHER') force.weather = pack.weather.find(w => w.id === 'FOG');
  if (weakest.id === 'EW') force.ew = pack.ew_levels.find(e => e.id === 'HIGH');
  if (weakest.id === 'DECONFLICTION' || weakest.id === 'IFF') force.friendlyTraffic = true;
  if (weakest.id === 'ROE') force.zone = pack.airspace_zones.zones.find(z => z.id === 'RED');
  if (weakest.id === 'SWARM' || weakest.id === 'CLASS_DECOY') force.swarmSize = Math.max(6, tier + 3);
  if (weakest.id === 'DISCRIMINATE_CIVIL') force.ambientCount = 4;

  return {
    tier, force, bias,
    targeting: weakest,
    rationale: `Weakest node is "${weakest.label}" at ${(weakest.p * 100).toFixed(0)}% mastery over ${weakest.n} observations. Mean mastery ${(meanP * 100).toFixed(0)}%. Directing sortie tier ${tier} at this skill.`
  };
}

// ----------------------------------------------------- cognitive load model
/**
 * Workload index. Grounded in the NASA-TLX axes (mental / temporal / effort /
 * performance); the coefficients are the team's calibration and are flagged as
 * an assumption in the provenance panel.
 */
export function workload(state, cfg) {
  const over = Math.max(0, state.activeTracks - 2);
  const wl = cfg.alpha_tracks * state.activeTracks
    + cfg.beta_decisions * state.pendingDecisions
    + cfg.gamma_comms * state.commsLoad
    + cfg.delta_time_pressure * state.timePressure;
  return { index: clamp(wl, 0, 1.6), overload: Math.max(0, wl - cfg.w_max), tracksOverCapacity: over };
}

/** Degradation of a human operator under overload. Applied to the trainee's
 *  own inputs, never to the sensor physics. */
export function operatorDegradation(workloadIndex, cfg) {
  const over = Math.max(0, workloadIndex - cfg.w_max);
  return {
    latencyS: over * cfg.latency_penalty_per_overload,
    classificationErrorProb: over * cfg.error_penalty_per_overload
  };
}

// --------------------------------------------------------- anti-rote check
/**
 * PILLAR: anti-rote.
 * If a trainee reacts faster than the physics floor of the scenario, he is not
 * reading his sensors - he has memorised the sortie. Flag it and mutate.
 */
export function roteCheck(events, physicsFloorS, marginS = 0.4) {
  const suspects = [];
  for (const e of events) {
    if (e.detectedT === null || e.decisionT === null) continue;
    const reaction = e.decisionT - e.detectedT;
    if (reaction < marginS && e.action) {
      suspects.push({ uid: e.uid, reactionS: reaction, floorS: physicsFloorS });
    }
  }
  return { suspected: suspects.length > 0, suspects };
}
