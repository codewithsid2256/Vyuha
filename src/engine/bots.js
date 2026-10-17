// VYUHA - headless bot runner.
// Two doctrine-driven policies fly any scenario without a human:
//   EXEMPLAR : plays the doctrine tree on ground truth  -> the CEILING
//   RANDOM   : plays uniformly random valid actions      -> the FLOOR
// They are what turns a raw score into "Training Gain", and they double as the
// project's regression tests: if the engine changes, the benchmarks move.

import { mulberry32 } from './rng.js';
import { createState, step, finalise, TICK } from './sim.js';
import { walkTree } from './doctrine.js';

const ALL_EFFECTORS = ['MONITOR', 'WARN', 'JAM', 'SPOOF', 'NET', 'GUN', 'LASER'];
const ALL_CLASSES = ['HOSTILE_UAV', 'OWN_UAV', 'CIVILIAN_DRONE', 'BIRD', 'NON_DRONE'];

export function runBot(pack, scenario, policy = 'exemplar', opts = {}) {
  const state = createState(pack, scenario, { operatorId: 'bot-' + policy });
  const rng = mulberry32((scenario.seed ^ 0x5bf03635) >>> 0);
  const plan = new Map();          // uid -> { classifyAt, engageAt }
  const done = new Set();

  while (!state.finished) {
    const inputs = [];
    for (const t of state.targets) {
      if (!t.track || done.has(t.uid)) continue;
      if (!plan.has(t.uid)) {
        const react = policy === 'exemplar' ? 1.5 + rng() * 1.5 : 4 + rng() * 12;
        plan.set(t.uid, { classifyAt: state.env.t + react, engageAt: state.env.t + react + 1.5 + rng() * 2 });
      }
      const p = plan.get(t.uid);

      if (state.env.t >= p.classifyAt && !t.traineeClassification) {
        if (policy === 'exemplar') {
          inputs.push({ type: 'CLASSIFY', uid: t.uid, classification: t.groundTruth.category, confidence: 0.93 });
        } else {
          inputs.push({ type: 'CLASSIFY', uid: t.uid, classification: ALL_CLASSES[Math.floor(rng() * ALL_CLASSES.length)], confidence: 0.3 + rng() * 0.65 });
        }
      }
      if (state.env.t >= p.engageAt && !t.action) {
        let effectorId = null;
        if (policy === 'exemplar') {
          const timeToTarget = Math.max(0, (t.range_m - scenario.defendedRadiusM) / Math.max(t.speed_ms, 1));
          // A trained operator checks for friendlies in the corridor and does
          // not jam with his own UAV inside the jammer envelope.
          const friendlyInCorridor = state.targets.some(x =>
            x !== t && x.alive && x.def.friendly &&
            Math.abs(((x.bearing - t.bearing + Math.PI * 3) % (Math.PI * 2)) - Math.PI) < 0.35 &&
            Math.abs(x.range_m - t.range_m) < 700);
          const ideal = walkTree(pack, {
            zone: scenario.zone, target: t,
            beliefHostile: t.groundTruth.category === 'HOSTILE_UAV' ? 0.95 : 0.05,
            timeAvailableS: timeToTarget,
            friendlyInCorridor, populatedGround: scenario.populated,
            rangeM: t.range_m
          });
          effectorId = ideal.effector;
          // RE-PLAN, don't commit, while doctrine is only saying "wait": the
          // target is still outside the effector envelope, or confidence has not
          // reached the engagement threshold yet. Committing MONITOR now would
          // forfeit the engagement.
          const holding = effectorId === 'MONITOR' && ideal.holdForRange !== false &&
            (t.groundTruth.category === 'HOSTILE_UAV');
          if (holding) {
            const closing = t.range_m < (p.lastRange ?? Infinity) - 0.5;
            p.lastRange = t.range_m;
            if (closing) { p.engageAt = state.env.t + 1; effectorId = null; }
            // The target is not closing: it is transiting or receding. A trained
            // operator stops waiting and logs the hold rather than re-planning
            // for the rest of the sortie.
          }
          // Jamming with an own UAV inside the envelope costs an EW-fratricide
          // penalty, so a trained operator prefers a legal kinetic option when
          // the zone and the ground allow one.
          if (friendlyInCorridor && (effectorId === 'JAM' || effectorId === 'SPOOF')) {
            const alt = pack.effectors
              .filter(e2 => e2.level >= 3 && e2.works_on.includes(t.defId) && t.range_m <= e2.range_m)
              .filter(e2 => e2.level < 4 || scenario.zone.engagement_authorised)
              .filter(e2 => !(scenario.populated && e2.id === 'GUN'))
              .sort((a, b) => a.cost_inr - b.cost_inr)[0];
            if (alt) effectorId = alt.id;
          }
        } else {
          effectorId = ALL_EFFECTORS[Math.floor(rng() * ALL_EFFECTORS.length)];
        }
        if (effectorId) {
          inputs.push({ type: 'ENGAGE', uid: t.uid, effectorId });
          done.add(t.uid);
        }
      }
    }
    step(state, inputs);
    if (state.env.t > scenario.durationS + 5) break;
  }

  return { result: finalise(state), state };
}

/** Benchmarks for a scenario: { exemplar, random } net scores. */
export function benchmarksFor(pack, scenario) {
  const ex = runBot(pack, scenario, 'exemplar').result;
  const rd = runBot(pack, scenario, 'random').result;
  return {
    exemplar: +ex.net.toFixed(2),
    random: +rd.net.toFixed(2),
    exemplarDetail: { detection: ex.detection.score, classification: ex.classification.score, engagement: ex.engagement.score },
    randomDetail: { detection: rd.detection.score, classification: rd.classification.score, engagement: rd.engagement.score }
  };
}

export { TICK };
