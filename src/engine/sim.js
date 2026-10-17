// VYUHA - the deterministic simulation engine.
// Runs identically on the server and in the browser from (scenario, seed, actions),
// so a multi-seat session and a replay are bit-for-bit reproducible.

import { mulberry32, clamp, gauss } from './rng.js';
import { evaluateSensors, physicsFloorTime } from './physics.js';
import { newLedger, ingest, topBelief, entropy, GROUND_TRUTH_CATEGORY } from './evidence.js';
import { walkTree, attributeRootCause, resolveEffector, ROOT_CAUSE_LABEL } from './doctrine.js';
import { workload, operatorDegradation } from './director.js';
import { assembleSession, sortieCertificate } from './scoring.js';

export const TICK = 0.25;

export function createState(pack, scenario, opts = {}) {
  const rng = mulberry32(scenario.seed ^ 0x9e3779b9);
  const sensors = pack.sensors;

  const env = {
    t: 0, terrain: scenario.terrain, light: scenario.light, weather: scenario.weather,
    ew: scenario.ew, sensorDegradation: scenario.sensorDegradation, wind_ms: scenario.wind_ms
  };

  const targets = scenario.threats.map(t => ({
    ...t,
    def: pack.threats.find(d => d.id === t.defId),
    groundTruth: { category: GROUND_TRUTH_CATEGORY[t.defId] },
    ledger: newLedger(),
    track: null,
    alive: true, neutralised: false, appeared: false,
    x: 0, y: 0, lastLook: {}, evidenceCount: 0
  }));

  // Convention used throughout the engine: bearing is clockwise from +Y (north),
  // so x = sin(bearing) * r and y = cos(bearing) * r. The heading that flies a
  // target at the defended point is bearing + PI.
  for (const t of targets) {
    t.x = Math.sin(t.bearing) * t.range_m;
    t.y = Math.cos(t.bearing) * t.range_m;
  }

  // Physics floor: computed once, for the mean hostile kinematics.
  const hostiles = targets.filter(t => t.def.hostile);
  const rep = hostiles[0];
  let floor = { t_floor: null, pd_cell: 0, range_at_floor: null };
  if (rep) {
    const meanClosing = hostiles.reduce((s, t) => s + t.speed_ms, 0) / hostiles.length;
    const meanRange = hostiles.reduce((s, t) => s + t.range_m, 0) / hostiles.length;
    floor = physicsFloorTime(env, rep.def, sensors, meanRange, meanClosing, 0.5, scenario.durationS);
  }
  const physicsFloorS = floor.t_floor === null ? 20 : floor.t_floor;
  const windowS = Math.max(12, (scenario.durationS * 0.4) - physicsFloorS);

  return {
    pack, scenario, env, rng, sensors, targets,
    tracks: [],
    declarations: [],
    violations: [],
    teamEvents: [],
    log: [],
    physicsFloorS, windowS, floorProbe: floor,
    operator: { seat: opts.seat || 'C2', id: opts.operatorId || 'trainee', name: opts.operatorName || 'Trainee' },
    overload: 0,
    pendingActions: [],
    finished: false,
    endedAt: null,
    workloadSamples: [],
    acquisitionRanges: null
  };
}

/** One simulation step. `inputs` is a list of operator actions due at this tick. */
export function step(state, inputs = []) {
  if (state.finished) return state;
  const { pack, env, rng, scenario } = state;
  env.t = +(env.t + TICK).toFixed(4);

  // ---------------------------------------------------- spawn & kinematics
  for (const t of state.targets) {
    if (!t.appeared && env.t >= t.spawnT) { t.appeared = true; }
    if (!t.appeared || !t.alive) continue;

    // Swarm behaviour: strikers beeline, decoys weave, flankers offset.
    let speed = t.speed_ms;
    if (t.swarmRole === 'DECOY_SCREEN') {
      t.heading += Math.sin(env.t * 0.9 + t.bearing) * 0.035;
      speed *= 0.8;
    } else if (t.swarmRole === 'FLANKER') {
      t.heading += Math.sin(env.t * 0.35) * 0.012;
    } else if (t.def.hostile) {
      // Terminal guidance: home on the defended point once inside 1.5 km.
      // The direction from (x, y) to the origin is (-x, -y).
      const r = Math.hypot(t.x, t.y);
      if (r < 1500) t.heading = Math.atan2(-t.x, -t.y);
    }

    t.x += Math.sin(t.heading) * speed * TICK;
    t.y += Math.cos(t.heading) * speed * TICK;
    t.range_m = Math.hypot(t.x, t.y);
    t.bearing = Math.atan2(t.x, t.y);
    t.alt_m = clamp(t.alt_m + Math.sin(env.t * 0.5 + t.bearing) * 0.4, 8, 600);
    t.aspect_jitter = 0.7 + 0.6 * ((Math.sin(env.t * 1.7 + t.bearing * 3) + 1) / 2);

    // Terrain masking - deterministic ridge occlusion from the data-pack mask
    // probability and this terrain's profile.
    const maskThreshold = 1 - env.terrain.mask_prob;
    const ridgePhase = (Math.sin(t.bearing * 3.1 + 0.7) + 1) / 2;
    t.terrain_masked = env.terrain.maskProb > 0 && ridgePhase > maskThreshold && t.alt_m < 180;

    // Reached the defended area?
    if (t.def.hostile && t.range_m <= scenario.defendedRadiusM) {
      t.alive = false;
      // A penetration is only an operator DECISION error when the operator was
      // legally able to engage. In a zone that does not authorise engagement the
      // correct action is to detect, classify and report up the chain - docking
      // the operator for a strike they were forbidden to take would be scoring
      // restraint as failure. The breach is still logged for the AAR.
      if (scenario.zone.engagement_authorised) {
        state.violations.push({ type: 'MISSED_THREAT', detail: `${t.def.label} reached the defended area` });
      } else {
        state.reportedPenetrations = (state.reportedPenetrations || 0) + 1;
      }
      pushLog(state, 'breach', `${t.def.label} penetrated to ${t.range_m.toFixed(0)} m${scenario.zone.engagement_authorised ? '' : ` - reported to higher authority (${scenario.zone.label} zone, engagement not authorised)`}`);
    }
  }

  // --------------------------------------------------------- sensor sweeps
  for (const t of state.targets) {
    if (!t.appeared || !t.alive) continue;
    const raw = evaluateSensors(env, t, state.sensors, rng, { cued: !!t.track });
    const reports = raw.map(r => sensorLook(t, r, rng, state, env));
    for (const r of reports) {
      const entry = ingest(t.ledger, r, env, t.groundTruth, rng);
      t.evidenceCount++;
      if (r.detected && !t.track) {
        t.detectedT = env.t;
        t.detectedBy = r.sensor;
        t.detectedRange_m = t.range_m;
        t.track = {
          id: 'TRK' + String(state.tracks.length + 1).padStart(2, '0'),
          uid: t.uid, createdAt: env.t, sensor: r.sensor,
          label: 'UNKNOWN', confidence: 0, engaged: false, effector: null
        };
        state.tracks.push(t.track);
        pushLog(state, 'contact', `${t.track.id} new contact from ${r.sensor} at ${t.range_m.toFixed(0)} m`);
      } else if (r.detected && t.track) {
        pushLog(state, 'update', `${t.track.id} ${r.sensor}: ${entry.text}`);
      }
    }
    if (t.track) {
      const top = topBelief(t.ledger.belief);
      t.track.belief = t.ledger.belief;
      t.track.top = top;
      t.track.entropy = entropy(t.ledger.belief);
      t.track.range_m = t.range_m;
      t.track.bearing = t.bearing;
      t.track.alt_m = t.alt_m;

      // ACTIONABLE AWARENESS. Raw sensor detection is not the operational
      // milestone - being able to ACT is. We record the first tick at which the
      // fused belief is decisive about the true category, and the Detection
      // score is measured from that, not from the first blip.
      if (t.actionableT === undefined) {
        // Actionable = the cell has the RIGHT hypothesis on top with enough
        // confidence to act on it (warn / cue / escalate). The warn threshold
        // from the doctrine block, not the engagement threshold.
        const truthBelief = t.ledger.belief[t.groundTruth.category] ?? 0;
        if (top.hypothesis === t.groundTruth.category && truthBelief >= 0.45) t.actionableT = env.t;
      }
    }
  }

  // -------------------------------------------------------- operator inputs
  const wl = workload({
    activeTracks: state.tracks.filter(t => !t.engaged).length,
    pendingDecisions: state.tracks.filter(t => !t.engaged && (t.top?.value ?? 0) > 0.5).length,
    commsLoad: state.teamEvents.length ? 0.4 : 0.15,
    timePressure: clamp(1 - env.t / scenario.durationS, 0, 1) * 0.5
  }, pack.workload);
  state.overload = wl.overload;
  state.workloadSamples.push({ t: env.t, index: wl.index, tracks: state.tracks.length });

  const degrade = operatorDegradation(wl.index, pack.workload);
  for (const inp of inputs) applyInput(state, inp, degrade);

  // ------------------------------------------------- resolve queued effects
  for (const pa of state.pendingActions) {
    if (env.t < pa.resolveAt) continue;
    pa.done = true;
    const t = state.targets.find(x => x.uid === pa.uid);
    if (!t || !t.alive) continue;
    const res = resolveEffector(pack, pa.effectorId, t, t.range_m, env, rng);
    pa.result = res;
    const eff = pack.effectors.find(e => e.id === pa.effectorId);

    if (res.wasted) {
      state.violations.push({ type: 'WASTED_EFFECTOR', detail: `${eff.label} on ${t.def.label}: ${res.reason}` });
      pushLog(state, 'wasted', `${eff.label} \u2192 ${t.track?.id || t.uid}: ${res.reason}`);
    } else if (res.neutralised) {
      t.alive = false; t.neutralised = true;
      pushLog(state, 'kill', `${eff.label} neutralised ${t.track?.id} (${t.def.label})`);
      if (!t.def.hostile) {
        state.violations.push({
          type: t.def.id === 'OWN_UAV' ? 'FRATRICIDE' : 'CIVILIAN_KILL',
          detail: `${t.def.label} destroyed by ${eff.label}`
        });
      }
      if (env.terrain.populated && (eff.collateral_risk ?? 0) > 0.15 && rng() < eff.collateral_risk) {
        state.violations.push({ type: 'COLLATERAL', detail: `${eff.label} over populated ground` });
      }
    } else {
      pushLog(state, 'miss', `${eff.label} engaged ${t.track?.id} - no effect (Pk ${(res.pk ?? 0).toFixed(2)})`);
    }
    // EW fratricide
    if (eff?.ew_fratricide && (pa.effectorId === 'JAM' || pa.effectorId === 'SPOOF')) {
      const friendly = state.targets.find(x => x.alive && x.def.friendly && x.range_m < eff.range_m);
      if (friendly) {
        friendly.alive = false;
        state.violations.push({ type: 'EW_FRATRICIDE', detail: `own UAV ${friendly.uid} lost to ${eff.label}` });
        pushLog(state, 'ewfrat', `${eff.label} took down own UAV ${friendly.uid}`);
      }
    }
  }
  state.pendingActions = state.pendingActions.filter(p => !p.done);

  // ------------------------------------------------------------ termination
  const hostilesLeft = state.targets.filter(t => t.def.hostile && t.alive);
  if (env.t >= scenario.durationS || hostilesLeft.length === 0) {
    state.finished = true;
    state.endedAt = env.t;
  }
  return state;
}

// ------------------------------------------------- look integration model
// A real sensor does not announce a fresh class read every scan. It integrates:
// the operator dwells, the read firms up, and the console reports a class only
// once it is worth reporting - or when the read CHANGES. Modelling that is what
// makes "keep the gimbal on the target" a real, scoreable skill, and it stops a
// single noisy sensor from drowning the fused belief.
const REPORT_TIERS = [0.5, 0.85, 0.97];

function sensorLook(t, r, rng, state, env) {
  if (!r.detected) return { ...r, observedLabel: null };
  t.looks = t.looks || {};
  const L = t.looks[r.sensor] = t.looks[r.sensor] || {
    n: 0, clsOk: 0, clsBad: 0, idOk: 0, idBad: 0, lastKey: '', label: null
  };
  L.n++;

  const truth = t.groundTruth.category;
  const pcls = Math.min(0.995, r.pcls || 0);
  const pid = Math.min(0.995, r.pid || 0);

  let label = null;
  if (rng() < pcls) { L.clsOk++; label = truth; }
  else {
    L.clsBad++;
    const others = Object.keys(evidenceBeliefKeys()).filter(h => h !== truth);
    label = others[Math.floor(rng() * others.length)];
  }
  if (rng() < pid) L.idOk++; else L.idBad++;

  // Integrated classification confidence.
  // Two things keep a fresh track from being instantly certain:
  //   (a) DWELL FLOOR - no class call on the very first look;
  //   (b) SHRINKAGE - confidence grows as n/(n+K), so a 2-look read can never
  //       claim 95%. Noise averages out with dwell exactly as it does for real,
  //       and a wrong early read can be superseded by a later, better one.
  const DWELL_FLOOR = 2, K = 4;
  const majorityLabel = L.clsOk >= L.clsBad ? truth : label;
  const rawAcc = Math.abs(L.clsOk - L.clsBad) / L.n;
  const shrink = L.n / (L.n + K);
  const labelConf = L.n < DWELL_FLOOR ? 0 : Math.min(0.99, rawAcc * pcls * shrink);
  const idAcc = Math.abs(L.idOk - L.idBad) / L.n;
  const effId = L.n < DWELL_FLOOR ? 0 : Math.min(0.99, idAcc * pid * shrink);
  const identified = effId >= 0.5 && labelConf >= 0.85;

  const tier = REPORT_TIERS.findIndex(x => labelConf >= x);
  const key = (identified ? 'I' : 'C') + tier + '|' + majorityLabel;
  const shouldReport = tier >= 0 && key !== L.lastKey;
  const reportedLabel = majorityLabel;

  const out = {
    ...r,
    classified: shouldReport,
    identified: shouldReport && identified,
    pcls: labelConf,
    pid: effId,
    observedLabel: shouldReport ? reportedLabel : null,
    dwell: L.n
  };
  if (shouldReport) L.lastKey = key;
  return out;
}

function evidenceBeliefKeys() {
  return { HOSTILE_UAV: 1, OWN_UAV: 1, CIVILIAN_DRONE: 1, BIRD: 1, NON_DRONE: 1 };
}

// ------------------------------------------------------------------ inputs
export function applyInput(state, inp, degrade = { latencyS: 0, classificationErrorProb: 0 }) {
  const t = state.targets.find(x => x.uid === inp.uid);
  if (!t) return;

  if (inp.type === 'CLASSIFY') {
    // Cognitive-load degradation applies to the HUMAN, not to the sensors.
    let declaredClass = inp.classification;
    if (state.rng() < degrade.classificationErrorProb) {
      const others = ['HOSTILE_UAV', 'OWN_UAV', 'CIVILIAN_DRONE', 'BIRD', 'NON_DRONE'].filter(x => x !== declaredClass);
      declaredClass = others[Math.floor(state.rng() * others.length)];
    }
    t.traineeClassification = declaredClass;
    t.declaredConfidence = inp.confidence;
    t.classifiedAt = state.env.t + degrade.latencyS;
    if (t.track) { t.track.label = declaredClass; t.track.confidence = inp.confidence; }
    const correct = declaredClass === t.groundTruth.category;
    state.declarations.push({ uid: t.uid, declared: inp.confidence, correct, at: state.env.t });
    if (inp.confidence >= state.pack.doctrine.confidence_threshold_engage && correct === false && declaredClass === 'HOSTILE_UAV') {
      state.violations.push({ type: 'OVERCONFIDENT_ENGAGE', detail: `${inp.confidence.toFixed(2)} confidence on a ${t.def.label}` });
    }
    pushLog(state, 'classify', `${t.track?.id || t.uid} declared ${declaredClass} @ ${(inp.confidence * 100).toFixed(0)}%`);
  }

  if (inp.type === 'ENGAGE') {
    const eff = state.pack.effectors.find(e => e.id === inp.effectorId);
    if (!eff) return;
    const zone = state.scenario.zone;
    if (!zone.engagement_authorised && eff.level >= 3) {
      state.violations.push({ type: 'ROE_BREACH', detail: `${eff.label} used in ${zone.label} zone` });
    }
    const friendlyInCorridor = state.targets.some(x =>
      x.alive && (x.def.friendly || (!x.def.hostile && x.def.id !== 'BIRD' && x.def.id !== 'CLUTTER')) &&
      Math.abs(((x.bearing - t.bearing + Math.PI * 3) % (Math.PI * 2)) - Math.PI) < 0.35 &&
      Math.abs(x.range_m - t.range_m) < 700
    );
    t.action = inp.effectorId;
    t.decisionT = state.env.t + degrade.latencyS;
    t.decisionRange_m = t.range_m;
    t.friendlyInCorridor = friendlyInCorridor;
    if (t.track) { t.track.engaged = true; t.track.effector = inp.effectorId; }
    state.pendingActions.push({ uid: t.uid, effectorId: inp.effectorId, resolveAt: t.decisionT + eff.effect_time_s, done: false });
    pushLog(state, 'engage', `${t.track?.id || t.uid} \u2190 ${eff.label}${friendlyInCorridor ? ' [FRIENDLY IN CORRIDOR]' : ''}`);
  }

  if (inp.type === 'HANDOVER') {
    state.teamEvents.push({
      at: state.env.t, from: inp.from, to: inp.to, uid: inp.uid,
      handoverS: inp.handoverS ?? null, commsCorrect: !!inp.commsCorrect
    });
    pushLog(state, 'comms', `${inp.from} \u2192 ${inp.to}: ${inp.phrase || 'handover'}`);
  }
}

function pushLog(state, kind, text) {
  state.log.push({ t: state.env.t, kind, text });
  if (state.log.length > 4000) state.log.splice(0, 500);
}

// ------------------------------------------------------------- finalisation
export function finalise(state, opts = {}) {
  const { pack, scenario } = state;
  const events = state.targets.map(t => {
    const timeAvailable = t.detectedT !== null ? Math.max(0, (t.range_m / Math.max(t.speed_ms, 1))) : 0;
    const ideal = t.detectedT !== null
      ? walkTree(pack, {
        zone: scenario.zone, target: t,
        // The doctrine tree is evaluated on the picture THE OPERATOR holds.
        beliefHostile: t.traineeClassification === 'HOSTILE_UAV'
          ? (t.declaredConfidence ?? 0)
          : (t.ledger?.belief?.HOSTILE_UAV ?? 0),
        timeAvailableS: timeAvailable,
        friendlyInCorridor: !!t.friendlyInCorridor,
        populatedGround: scenario.populated,
        rangeM: t.decisionRange_m ?? t.detectedRange_m ?? t.range_m
      })
      : null;
    const idealEffForTiming = ideal?.effector ?? null;
    const effForTiming = pack.effectors.find(e => e.id === (t.action ?? idealEffForTiming));
    const effectTime = effForTiming ? effForTiming.effect_time_s : 0;
    // Time from first detection until the target reaches the defended area.
    const timeToTarget = t.detectedT !== null
      ? Math.max(0, ((t.detectedRange_m ?? t.range_m) - scenario.defendedRadiusM) / Math.max(t.speed_ms, 1))
      : 0;
    const inTime = t.decisionT !== null && t.detectedT !== null
      ? (t.decisionT - t.detectedT) + effectTime <= timeToTarget
      : false;
    const rootCause = ideal ? attributeRootCause(pack, {
      target: t, traineeClassification: t.traineeClassification || null,
      declaredConfidence: t.declaredConfidence ?? 0, action: t.action ?? null,
      ideal, detected: t.detectedT !== null, inTime,
      friendlyInCorridor: !!t.friendlyInCorridor, zone: scenario.zone
    }) : (t.detectedT === null ? 'UNDETECTED' : 'NO_DECISION');

    return {
      uid: t.uid, defId: t.defId, defLabel: t.def.label,
      groundTruth: t.groundTruth,
      detectedT: t.detectedT ?? null, detectedBy: t.detectedBy || null,
      actionableT: t.actionableT ?? null,
      decisionT: t.decisionT ?? null,
      traineeClassification: t.traineeClassification || null,
      declaredConfidence: t.declaredConfidence ?? null,
      action: t.action ?? null,
      actionLevel: pack.effectors.find(e => e.id === t.action)?.level ?? null,
      idealEffector: ideal?.effector ?? null, idealLevel: ideal?.level ?? null,
      rootCause, rootCauseLabel: ROOT_CAUSE_LABEL[rootCause],
      friendlyInCorridor: !!t.friendlyInCorridor,
      neutralised: !!t.neutralised,
      windowS: state.windowS,
      peakBelief: t.ledger?.peakBelief ?? 0,
      evidenceCount: t.evidenceCount,
      belief: t.ledger?.belief ?? null,
      evidence: t.ledger?.entries ?? []
    };
  });

  // Rote detection
  const rote = { suspected: false, suspects: [] };
  for (const e of events) {
    if (e.detectedT === null || e.decisionT === null || !e.action) continue;
    if (e.decisionT - e.detectedT < 0.4) rote.suspects.push({ uid: e.uid, reactionS: e.decisionT - e.detectedT });
  }
  rote.suspected = rote.suspects.length > 0;
  if (rote.suspected) state.violations.push({ type: 'ROTE_SUSPECTED', detail: `${rote.suspects.length} reaction(s) faster than the physics floor` });

  const meta = {
    seed: scenario.seed, seedHex: scenario.seedHex,
    fingerprint: scenario.fingerprint, fingerprintHash: scenario.fingerprintHash,
    novel: scenario.novel !== false,
    terrainId: scenario.terrain.id, lightId: scenario.light.id, weatherId: scenario.weather.id,
    ewId: scenario.ew.id, zoneId: scenario.zone.id,
    swarmSize: scenario.swarmSize, ambientCount: scenario.ambientCount,
    threatMix: scenario.threatMix, tier: scenario.tier,
    physicsFloorS: state.physicsFloorS, windowS: state.windowS,
    durationS: state.endedAt, scripted: scenario.scripted || null,
    name: scenario.name || null,
    rote
  };

  const result = assembleSession({
    pack, events, declarations: state.declarations,
    physicsFloorS: state.physicsFloorS, windowS: state.windowS,
    violations: state.violations, teamEvents: state.teamEvents,
    benchmarks: opts.benchmarks || null, meta
  });
  result.workload = summariseWorkload(state.workloadSamples, pack.workload);
  result.acquisitionRanges = state.acquisitionRanges;
  return result;
}

function summariseWorkload(samples, cfg) {
  if (!samples.length) return null;
  const over = samples.filter(s => s.index > cfg.w_max);
  return {
    peak: Math.max(...samples.map(s => s.index)),
    mean: samples.reduce((s, x) => s + x.index, 0) / samples.length,
    pctOverloaded: 100 * over.length / samples.length,
    threshold: cfg.w_max,
    axes: cfg.tlx_axes
  };
}

export function certificate(scenario, result, operatorId, packVersion, engineVersion) {
  return sortieCertificate(scenario, result, operatorId, packVersion, engineVersion);
}
