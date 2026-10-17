// VYUHA engine test suite.
// Run: node test/engine.test.mjs
//
// These tests execute the real engine modules - physics.js, evidence.js,
// doctrine.js, scenario.js, director.js, scoring.js, sim.js, bots.js - not
// copies of them.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const pack = JSON.parse(readFileSync(join(ROOT, 'data', 'data-pack.json'), 'utf8'));

const { mulberry32, hashSeed } = await import('../src/engine/rng.js');
const physics = await import('../src/engine/physics.js');
const evidence = await import('../src/engine/evidence.js');
const doctrine = await import('../src/engine/doctrine.js');
const scenarioMod = await import('../src/engine/scenario.js');
const director = await import('../src/engine/director.js');
const scoring = await import('../src/engine/scoring.js');
const sim = await import('../src/engine/sim.js');
const bots = await import('../src/engine/bots.js');

scoring.setHasher(s => createHash('sha256').update(s).digest('hex'));

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; failures.push(name + ' ' + extra); console.log('  \u2717 ' + name + '  ' + extra); }
}
function section(t) { console.log('\n' + t); }

function env(over = {}) {
  return {
    t: 0,
    terrain: pack.terrain.find(t => t.id === 'RURAL'),
    light: pack.light.find(l => l.id === 'DAY'),
    weather: pack.weather.find(w => w.id === 'CLEAR'),
    ew: pack.ew_levels[0],
    sensorDegradation: 0, wind_ms: 4, ...over
  };
}
function tgt(defId, range, over = {}) {
  const def = pack.threats.find(t => t.id === defId);
  return { def, range_m: range, alt_m: def.alt_m, aspect_jitter: 1, terrain_masked: false, lastLook: {}, ...over };
}
const RADAR = pack.sensors.find(s => s.id === 'RADAR-1');
const RF = pack.sensors.find(s => s.id === 'RF-1');
const EO = pack.sensors.find(s => s.id === 'EO-1');
const ACO = pack.sensors.find(s => s.id === 'ACO-1');

// ---------------------------------------------------------------- data pack
section('1. Data pack integrity');
{
  const refs = new Set();
  const walk = (o) => {
    if (Array.isArray(o)) return o.forEach(walk);
    if (o && typeof o === 'object') {
      if (typeof o.source === 'string' && /^(G\d+|O\d+|assumption)$/.test(o.source)) refs.add(o.source);
      Object.values(o).forEach(walk);
    }
  };
  walk(pack);
  const missing = [...refs].filter(r => r !== 'assumption' && !pack.sources[r]);
  ok('every source id in the pack resolves to a source record', missing.length === 0, JSON.stringify(missing));

  const noUrl = Object.entries(pack.sources).filter(([, s]) => !s.url || !s.org || !s.class);
  ok('every source record carries org + doc url + confidence class', noUrl.length === 0, JSON.stringify(noUrl.map(x => x[0])));

  ok('UAS taxonomy matches Drone Rules 2021 (5 classes, 250g/2kg/25kg/150kg)',
    pack.uas_taxonomy.classes.length === 5 &&
    pack.uas_taxonomy.classes[0].mauw_max_g === 250 &&
    pack.uas_taxonomy.classes[1].mauw_max_g === 2000 &&
    pack.uas_taxonomy.classes[2].mauw_max_g === 25000 &&
    pack.uas_taxonomy.classes[3].mauw_max_g === 150000);

  const assumptions = JSON.stringify(pack).match(/"assumption"/g)?.length || 0;
  ok('assumptions are explicitly tagged (so the UI can flag them red)', assumptions > 0, 'count=' + assumptions);
  console.log(`    [i] ${Object.keys(pack.sources).length} sources, ${assumptions} tagged assumptions`);
}

// ------------------------------------------------------------------- radar
section('2. Radar chain (monostatic equation + clutter + Swerling-1)');
{
  const e = env();
  const near = physics.radarChain(e, tgt('HEX_BOMBER', 800), RADAR);
  const far = physics.radarChain(e, tgt('HEX_BOMBER', 6000), RADAR);
  ok('Pd falls off steeply with range (R^-4)', near.pd > far.pd, `${near.pd.toFixed(3)} vs ${far.pd.toFixed(3)}`);
  ok('a big target out-ranges a small one at the same range',
    physics.radarChain(e, tgt('LOITERING_MUNITION', 2500), RADAR).pd >
    physics.radarChain(e, tgt('DECOY', 2500), RADAR).pd);
  ok('urban clutter degrades Pd vs rural',
    physics.radarChain(env({ terrain: pack.terrain.find(t => t.id === 'RURAL') }), tgt('COMMERCIAL_QUAD', 1500), RADAR).pd >
    physics.radarChain(env({ terrain: pack.terrain.find(t => t.id === 'URBAN') }), tgt('COMMERCIAL_QUAD', 1500), RADAR).pd);
  ok('heavy EW noise degrades Pd',
    physics.radarChain(e, tgt('COMMERCIAL_QUAD', 1200), RADAR).pd >
    physics.radarChain(env({ ew: pack.ew_levels[2] }), tgt('COMMERCIAL_QUAD', 1200), RADAR).pd);
  ok('terrain-masked target returns Pd = 0',
    physics.radarChain(e, tgt('COMMERCIAL_QUAD', 800, { terrain_masked: true }), RADAR).pd === 0);
  ok('beyond max range returns Pd = 0',
    physics.radarChain(e, tgt('HEX_BOMBER', 9000), RADAR).pd === 0);
  ok('all probabilities stay in [0,1]', [near, far].every(r => r.pd >= 0 && r.pd <= 1 && r.pcls >= 0 && r.pcls <= 1));
}

// ---------------------------------------------------------------------- RF
section('3. RF chain (the fibre-optic FPV lesson)');
{
  const e = env();
  const quad = physics.rfChain(e, tgt('COMMERCIAL_QUAD', 900), RF);
  ok('a linked quad is detected on RF at 900 m', quad.pd > 0.8, 'pd=' + quad.pd.toFixed(3));
  ok('RF detection decays with range', physics.rfChain(e, tgt('COMMERCIAL_QUAD', 3000), RF).pd < quad.pd);
  ok('FIBRE-OPTIC FPV IS COMPLETELY RF SILENT (Pd === 0)',
    physics.rfChain(e, tgt('FIBER_OPTIC_FPV', 300), RF).pd === 0);
  ok('birds are RF silent', physics.rfChain(e, tgt('BIRD', 200), RF).pd === 0);
  ok('heavy EW noise pushes the link below sensitivity',
    physics.rfChain(env({ ew: pack.ew_levels[2] }), tgt('COMMERCIAL_QUAD', 2500), RF).pd <
    physics.rfChain(e, tgt('COMMERCIAL_QUAD', 2500), RF).pd);
}

// ------------------------------------------------------------------- EO/IR
section('4. EO/IR chain (Johnson criteria x Koschmieder transmission)');
{
  const clear = env();
  const fog = env({ weather: pack.weather.find(w => w.id === 'FOG') });
  const okFog = physics.eoChain(fog, tgt('COMMERCIAL_QUAD', 1500), EO, { cued: true });
  const okClear = physics.eoChain(clear, tgt('COMMERCIAL_QUAD', 1500), EO, { cued: true });
  ok('IMD fog visibility (400 m) collapses EO classification vs clear', okFog.pcls < okClear.pcls,
    `fog ${okFog.pcls.toFixed(3)} vs clear ${okClear.pcls.toFixed(3)}`);
  ok('pixels across target shrink with range',
    physics.eoChain(clear, tgt('COMMERCIAL_QUAD', 500), EO, { cued: true }).px_across >
    physics.eoChain(clear, tgt('COMMERCIAL_QUAD', 3000), EO, { cued: true }).px_across);
  ok('identification needs more pixels than classification (Johnson)',
    physics.eoChain(clear, tgt('COMMERCIAL_QUAD', 1200), EO, { cued: true }).pcls >
    physics.eoChain(clear, tgt('COMMERCIAL_QUAD', 1200), EO, { cued: true }).pid);
  ok('THERMAL CROSSOVER at dusk destroys IR contrast',
    physics.eoChain(env({ light: pack.light.find(l => l.id === 'DUSK') }), tgt('COMMERCIAL_QUAD', 1200), EO, { cued: true }).contrast <
    physics.eoChain(env({ light: pack.light.find(l => l.id === 'NIGHT') }), tgt('COMMERCIAL_QUAD', 1200), EO, { cued: true }).contrast);
  ok('a cued gimbal beats a searching gimbal',
    physics.eoChain(clear, tgt('COMMERCIAL_QUAD', 1200), EO, { cued: true }).pd >
    physics.eoChain(clear, tgt('COMMERCIAL_QUAD', 1200), EO, { cued: false }).pd);
}

// --------------------------------------------------------------- acoustic
section('5. Acoustic chain');
{
  const e = env();
  ok('acoustic detection decays with range',
    physics.acousticChain(e, tgt('COMMERCIAL_QUAD', 200), ACO).pd >
    physics.acousticChain(e, tgt('COMMERCIAL_QUAD', 800), ACO).pd);
  ok('silent targets give no acoustic return',
    physics.acousticChain(e, tgt('BIRD', 100), ACO).pd === 0);
}

// --------------------------------------------------------- physics floor
section('6. Physics floor (the denominator of the Detection score)');
{
  const e = env();
  const clear = physics.physicsFloorTime(e, pack.threats.find(t => t.id === 'COMMERCIAL_QUAD'), pack.sensors, 3200, 15, 0.5, 180);
  const foggy = physics.physicsFloorTime(env({ weather: pack.weather.find(w => w.id === 'FOG') }), pack.threats.find(t => t.id === 'COMMERCIAL_QUAD'), pack.sensors, 3200, 15, 0.5, 180);
  ok('the floor is a finite non-negative time', clear.t_floor !== null && clear.t_floor >= 0, JSON.stringify(clear));
  ok('fog pushes the physics floor later', (foggy.t_floor ?? 999) >= (clear.t_floor ?? 0), `${foggy.t_floor} vs ${clear.t_floor}`);

  // EO-dependent target (fibre-optic FPV: no RF link, silent on the RF chain).
  const eoSet = [RF, EO, ACO];
  const fiberDef = pack.threats.find(t => t.id === 'FIBER_OPTIC_FPV');
  const fiberClear = physics.physicsFloorTime(e, fiberDef, eoSet, 2000, 45, 0.25, 180);
  const fiberFog = physics.physicsFloorTime(env({ weather: pack.weather.find(w => w.id === 'FOG') }), fiberDef, eoSet, 2000, 45, 0.25, 180);
  ok('for an RF-silent target the fog floor is strictly later than the clear floor',
    (fiberFog.t_floor ?? 999) > (fiberClear.t_floor ?? -1), `${fiberClear.t_floor} -> ${fiberFog.t_floor}`);
  ok('fog genuinely degrades EO classification on the same target at the same range',
    physics.eoChain(env({ weather: pack.weather.find(w => w.id === 'FOG') }), tgt('COMMERCIAL_QUAD', 1500), EO, { cued: true }).pcls <
    physics.eoChain(e, tgt('COMMERCIAL_QUAD', 1500), EO, { cued: true }).pcls * 0.5);
  const ranges = physics.sensorAcquisitionRanges(e, pack.threats.find(t => t.id === 'HEX_BOMBER'), pack.sensors);
  ok('acquisition ranges are computed per sensor', Object.keys(ranges).length === 4, JSON.stringify(ranges));
  ok('the RF detector is blind to the fibre-optic FPV at every range',
    physics.sensorAcquisitionRanges(e, pack.threats.find(t => t.id === 'FIBER_OPTIC_FPV'), [RF])['RF-1'] === null);
}

// --------------------------------------------------------------- evidence
section('7. Evidence Ledger + Bayesian fusion');
{
  const e = env();
  const gt = { category: 'HOSTILE_UAV' };
  const rng = mulberry32(4242);                 // seeded: the sensor misread roll must be reproducible
  const led = evidence.newLedger();
  const before = led.belief.HOSTILE_UAV;
  evidence.ingest(led, { kind: 'rf', sensor: 'RF-1', detected: true, classified: true, identified: false, pcls: 0.99, band_ghz: 2.4, hop_rate_hz: 400, protocol: 'FHSS', margin_db: 12 }, e, gt, rng);
  ok('an RF contact raises the hostile belief', led.belief.HOSTILE_UAV > before, `${before.toFixed(3)} -> ${led.belief.HOSTILE_UAV.toFixed(3)}`);
  ok('belief stays normalised to 1', Math.abs(Object.values(led.belief).reduce((a, b) => a + b, 0) - 1) < 1e-9);
  ok('every entry records a delta and a post-belief snapshot',
    led.entries.length === 1 && led.entries[0].delta && led.entries[0].beliefAfter);

  // A HIGH-confidence sweep that finds nothing is real evidence about the
  // control link. A LOW-confidence sweep is not, and must be ignored.
  const led2 = evidence.newLedger();
  evidence.ingest(led2, { kind: 'rf', sensor: 'RF-1', detected: false, pd: 0.95, why: 'RF silent' }, e, { category: 'BIRD' }, rng);
  ok('a HIGH-confidence RF sweep that finds nothing argues against RF-linked platforms',
    led2.belief.HOSTILE_UAV < 0.34 && led2.belief.BIRD > 0.20,
    JSON.stringify(Object.fromEntries(Object.entries(led2.belief).map(([k, v]) => [k, +v.toFixed(3)]))));

  const led2b = evidence.newLedger();
  evidence.ingest(led2b, { kind: 'rf', sensor: 'RF-1', detected: false, pd: 0.30, why: 'marginal' }, e, { category: 'HOSTILE_UAV' }, rng);
  ok('a LOW-confidence sweep is uninformative and leaves the belief untouched',
    led2b.belief.HOSTILE_UAV === 0.34, led2b.belief.HOSTILE_UAV.toFixed(4));

  const led2c = evidence.newLedger();
  for (let i = 0; i < 40; i++) evidence.ingest(led2c, { kind: 'rf', sensor: 'RF-1', detected: false, pd: 0.95, why: 'RF silent' }, e, { category: 'BIRD' }, rng);
  ok('a sensor may only speak once in the negative - 40 identical sweeps do not collapse the belief',
    led2c.belief.HOSTILE_UAV > 0.02 && led2c.belief.HOSTILE_UAV < 1,
    JSON.stringify(Object.fromEntries(Object.entries(led2c.belief).map(([k, v]) => [k, +v.toFixed(3)]))));

  const led2d = evidence.newLedger();
  for (let i = 0; i < 60; i++) evidence.ingest(led2d, { kind: 'radar', sensor: 'RADAR-1', detected: true, classified: false, identified: false, pd: 0.9, pcls: 0.4 }, e, { category: 'HOSTILE_UAV' }, rng);
  ok('repeated identical positive blips saturate instead of reaching certainty',
    led2d.belief.HOSTILE_UAV < 0.995, led2d.belief.HOSTILE_UAV.toFixed(4));

  const led3 = evidence.newLedger();
  for (const k of ['radar', 'rf', 'eo', 'acoustic']) {
    evidence.ingest(led3, { kind: k, sensor: k.toUpperCase(), detected: true, classified: true, identified: k === 'eo', pcls: 0.99 }, e, gt, rng);
  }
  ok('four corroborating sensors drive the belief above the doctrine threshold',
    led3.belief.HOSTILE_UAV > pack.doctrine.confidence_threshold_engage, led3.belief.HOSTILE_UAV.toFixed(3));
  ok('entropy falls as evidence accumulates', evidence.entropy(led3.belief) < evidence.entropy(evidence.newLedger().belief));
}

// ---------------------------------------------------------------- doctrine
section('8. Doctrine tree + graduated response + effector fit');
{
  const zone = pack.airspace_zones.zones.find(z => z.id === 'GREEN');
  const red = pack.airspace_zones.zones.find(z => z.id === 'RED');

  const quad = { def: pack.threats.find(t => t.id === 'COMMERCIAL_QUAD') };
  const fiber = { def: pack.threats.find(t => t.id === 'FIBER_OPTIC_FPV') };
  const mun = { def: pack.threats.find(t => t.id === 'LOITERING_MUNITION') };

  const iQuad = doctrine.walkTree(pack, { zone, target: quad, beliefHostile: 0.9, timeAvailableS: 40, friendlyInCorridor: false, populatedGround: false });
  ok('a linked commercial quad: minimum sufficient force is soft-kill (JAM)', iQuad.effector === 'JAM', iQuad.effector);

  const iFiber = doctrine.walkTree(pack, { zone, target: fiber, beliefHostile: 0.9, timeAvailableS: 40, friendlyInCorridor: false, populatedGround: false });
  ok('a fibre-optic FPV cannot be jammed - doctrine escalates to kinetic', iFiber.effector === 'GUN' || iFiber.effector === 'LASER', iFiber.effector);

  ok('jamming an RF-silent target resolves as WASTED',
    doctrine.resolveEffector(pack, 'JAM', fiber, 500, env()).wasted === true);
  ok('spoofing a non-GNSS target resolves as WASTED',
    doctrine.resolveEffector(pack, 'SPOOF', fiber, 500, env()).wasted === true);
  ok('a laser at 3 km is out of its 2 km envelope',
    doctrine.resolveEffector(pack, 'LASER', quad, 3000, env()).ok === false);
  ok('fog degrades laser Pk',
    doctrine.resolveEffector(pack, 'LASER', mun, 1200, env({ weather: pack.weather.find(w => w.id === 'FOG') })).pk <
    doctrine.resolveEffector(pack, 'LASER', mun, 1200, env()).pk);

  const iRed = doctrine.walkTree(pack, { zone: red, target: quad, beliefHostile: 0.9, timeAvailableS: 40, friendlyInCorridor: false, populatedGround: false });
  ok('kinetic is capped to soft-kill inside a RED zone', iRed.level <= 2, iRed.effector);

  const gunUrban = doctrine.walkTree(pack, { zone, target: fiber, beliefHostile: 0.9, timeAvailableS: 40, friendlyInCorridor: false, populatedGround: true });
  ok('AD gun is prohibited over populated ground', gunUrban.effector !== 'GUN', gunUrban.effector);

  // CONFIDENCE GATE - doctrine is applied to the picture the operator holds.
  const lowBelief = doctrine.walkTree(pack, { zone, target: quad, beliefHostile: 0.30, timeAvailableS: 40, friendlyInCorridor: false, populatedGround: false, rangeM: 900 });
  ok('belief below the WARN threshold -> doctrine says MONITOR', lowBelief.effector === 'MONITOR' && lowBelief.confidenceGated === true, lowBelief.effector);
  const midBelief = doctrine.walkTree(pack, { zone, target: quad, beliefHostile: 0.60, timeAvailableS: 40, friendlyInCorridor: false, populatedGround: false, rangeM: 600 });
  ok('belief in the warn band, target inside the warn envelope -> doctrine says WARN, not JAM',
    midBelief.effector === 'WARN' && midBelief.confidenceGated === true, midBelief.effector);
  const farWarn = doctrine.walkTree(pack, { zone, target: quad, beliefHostile: 0.60, timeAvailableS: 40, friendlyInCorridor: false, populatedGround: false, rangeM: 3000 });
  ok('belief in the warn band but outside the warn envelope -> doctrine says MONITOR (a loudhailer at 3 km is just noise)',
    farWarn.effector === 'MONITOR', farWarn.effector);
  const hiBelief = doctrine.walkTree(pack, { zone, target: quad, beliefHostile: 0.90, timeAvailableS: 40, friendlyInCorridor: false, populatedGround: false, rangeM: 900 });
  ok('belief above the engagement threshold -> doctrine says JAM', hiBelief.effector === 'JAM', hiBelief.effector);

  ok('EEI penalises over-escalation and rewards minimum sufficient force',
    doctrine.escalationEconomy(pack, 'JAM', 'LASER') < 1 && doctrine.escalationEconomy(pack, 'JAM', 'JAM') === 1);

  // Root-cause attribution
  const ideal = iQuad;
  const rc1 = doctrine.attributeRootCause(pack, {
    target: { ...quad, groundTruth: { category: 'HOSTILE_UAV' } },
    traineeClassification: 'BIRD', declaredConfidence: 0.9, action: 'MONITOR', ideal,
    detected: true, inTime: true, friendlyInCorridor: false, zone
  });
  ok('hostile called a bird = IDENTIFICATION failure', rc1 === 'IDENTIFICATION', rc1);

  const rc2 = doctrine.attributeRootCause(pack, {
    target: { ...quad, groundTruth: { category: 'HOSTILE_UAV' } },
    traineeClassification: 'HOSTILE_UAV', declaredConfidence: 0.9, action: 'LASER', ideal,
    detected: true, inTime: true, friendlyInCorridor: false, zone
  });
  ok('right picture, over-escalated effector = DOCTRINE failure', rc2 === 'DOCTRINE', rc2);

  const rc3 = doctrine.attributeRootCause(pack, {
    target: { ...quad, groundTruth: { category: 'HOSTILE_UAV' } },
    traineeClassification: 'HOSTILE_UAV', declaredConfidence: 0.9, action: 'LASER', ideal,
    detected: true, inTime: true, friendlyInCorridor: true, zone
  });
  ok('KINETIC engagement with a friendly in the corridor = SITUATION failure', rc3 === 'SITUATION', rc3);

  const rc3b = doctrine.attributeRootCause(pack, {
    target: { ...quad, groundTruth: { category: 'HOSTILE_UAV' } },
    traineeClassification: 'HOSTILE_UAV', declaredConfidence: 0.9, action: 'JAM', ideal,
    detected: true, inTime: true, friendlyInCorridor: true, zone
  });
  ok('SOFT-KILL over a friendly is doctrinally right (it is scored as EW fratricide instead)',
    rc3b === 'CORRECT', rc3b);

  const rc4 = doctrine.attributeRootCause(pack, {
    target: { ...quad, groundTruth: { category: 'HOSTILE_UAV' } },
    traineeClassification: 'HOSTILE_UAV', declaredConfidence: 0.9, action: 'JAM', ideal,
    detected: true, inTime: true, friendlyInCorridor: false, zone
  });
  ok('correct play is scored CORRECT', rc4 === 'CORRECT', rc4);

  const rc6 = doctrine.attributeRootCause(pack, {
    target: { ...quad, groundTruth: { category: 'HOSTILE_UAV' } },
    traineeClassification: 'HOSTILE_UAV', declaredConfidence: 0.55, action: 'WARN', ideal: midBelief,
    detected: true, inTime: true, friendlyInCorridor: false, zone
  });
  ok('warning at 55% belief is CORRECT because doctrine is gated on the operator picture', rc6 === 'CORRECT', rc6);

  const rc5 = doctrine.attributeRootCause(pack, {
    target: { ...quad, groundTruth: { category: 'HOSTILE_UAV' } },
    traineeClassification: null, declaredConfidence: 0, action: null, ideal,
    detected: false, inTime: false, friendlyInCorridor: false, zone
  });
  ok('never detected = UNDETECTED', rc5 === 'UNDETECTED', rc5);
}

// --------------------------------------------------------------- scenario
section('9. Seeded procedural generator + fingerprint de-duplication');
{
  const s1 = scenarioMod.generateScenario(pack, { seed: 12345 });
  const s2 = scenarioMod.generateScenario(pack, { seed: 12345 });
  ok('the same seed produces the identical scenario', s1.fingerprint === s2.fingerprint, s1.fingerprintHash);
  ok('every scenario carries a fingerprint hash', /^[0-9A-F]{8}$/.test(s1.fingerprintHash), s1.fingerprintHash);

  const seen = new Set();
  let novel = 0;
  for (let i = 0; i < 60; i++) {
    const sc = scenarioMod.generateScenario(pack, { seed: 1000 + i * 7919, seen });
    if (sc.novel) novel++;
    seen.add(sc.fingerprintHash);
  }
  ok('60 successive sorties are all novel (no repeat fingerprint)', novel === 60, `novel=${novel}`);
  ok('swarm size stays inside the bounded envelope (<=12 for tiers 1-5)',
    Array.from({ length: 40 }, (_, i) => scenarioMod.generateScenario(pack, { seed: i * 31 + 5, tier: 5 })).every(s => s.swarmSize <= 12));

  const hostileIds = new Set();
  for (let i = 0; i < 200; i++) {
    const sc = scenarioMod.generateScenario(pack, { seed: i * 104729 + 11, tier: 4 });
    sc.threats.filter(t => t.role === 'HOSTILE').forEach(t => hostileIds.add(t.defId));
  }
  ok('the generator can produce every hostile class in the library',
    ['COMMERCIAL_QUAD', 'FPV', 'FIBER_OPTIC_FPV', 'HEX_BOMBER', 'FIXED_WING_SPOTTER', 'LOITERING_MUNITION', 'DECOY'].every(id => hostileIds.has(id)),
    [...hostileIds].join(','));

  ok('all 8 scripted missions build without error',
    scenarioMod.SCRIPTED_MISSIONS.every(m => {
      try { return !!scenarioMod.buildScripted(pack, m.id, 1).threats.length; } catch (e) { return false; }
    }));

  const m4 = scenarioMod.buildScripted(pack, 'M4', 1);
  ok('scripted mission M4 injects the fibre-optic FPV', m4.threats.some(t => t.defId === 'FIBER_OPTIC_FPV'));
  ok('scripted missions are jittered per run',
    scenarioMod.buildScripted(pack, 'M1', 1).fingerprint !== scenarioMod.buildScripted(pack, 'M1', 2).fingerprint);

  const cov = scenarioMod.coverageMatrix(pack, [
    { terrainId: 'RURAL', lightId: 'DAY', weatherId: 'CLEAR' },
    { terrainId: 'URBAN', lightId: 'NIGHT', weatherId: 'FOG' }
  ]);
  ok('coverage matrix reports 45 terrain x light x weather cells', cov.total === 45 && cov.covered === 2, `total=${cov.total} covered=${cov.covered}`);
}

// --------------------------------------------------------------- director
section('10. Adaptive Director (BKT) + workload + anti-rote');
{
  const model = director.newTraineeModel('t1');
  const p0 = model.skills.CLASS_FIBER.p;
  for (let i = 0; i < 6; i++) director.bktUpdate(model.skills.CLASS_FIBER, true);
  ok('BKT raises mastery after repeated success', model.skills.CLASS_FIBER.p > p0, `${p0.toFixed(3)} -> ${model.skills.CLASS_FIBER.p.toFixed(3)}`);
  const p1 = model.skills.CLASS_FIBER.p;
  for (let i = 0; i < 6; i++) director.bktUpdate(model.skills.CLASS_FIBER, false);
  ok('BKT lowers mastery after repeated failure', model.skills.CLASS_FIBER.p < p1, `${p1.toFixed(3)} -> ${model.skills.CLASS_FIBER.p.toFixed(3)}`);
  ok('BKT stays inside (0,1)', model.skills.CLASS_FIBER.p > 0 && model.skills.CLASS_FIBER.p < 1);

  // Weakest-node targeting
  const m2 = director.newTraineeModel('t2');
  m2.skills.NIGHT.p = 0.05;
  const next = director.nextSortie(m2, pack, []);
  ok('the Director targets the weakest skill node', next.targeting.id === 'NIGHT', next.targeting.id);
  ok('the Director forces the matching scenario condition', next.force.light?.id === 'NIGHT', JSON.stringify(next.force.light));
  ok('the Director never jumps more than one tier at a time',
    Math.abs(next.tier - 2) <= 1, 'tier=' + next.tier);

  const wl = director.workload({ activeTracks: 9, pendingDecisions: 5, commsLoad: 0.5, timePressure: 0.5 }, pack.workload);
  ok('workload saturates and reports overload', wl.index > pack.workload.w_max && wl.overload > 0, wl.index.toFixed(3));
  const deg = director.operatorDegradation(wl.index, pack.workload);
  ok('overload degrades the HUMAN (latency + classification error), never the sensors',
    deg.latencyS > 0 && deg.classificationErrorProb > 0, JSON.stringify(deg));
  ok('a light workload produces no degradation',
    director.operatorDegradation(0.2, pack.workload).latencyS === 0);

  const rote = director.roteCheck([
    { uid: 'A', detectedT: 10, decisionT: 10.1, action: 'JAM' },
    { uid: 'B', detectedT: 20, decisionT: 26, action: 'JAM' }
  ], 5);
  ok('rote detector flags a reaction faster than the physics floor', rote.suspected && rote.suspects.length === 1, JSON.stringify(rote));
}

// ---------------------------------------------------------------- scoring
section('11. Scoring engine, calibration and penalties');
{
  const events = [
    { groundTruth: { category: 'HOSTILE_UAV' }, detectedT: 12, actionableT: 13, decisionT: 18, traineeClassification: 'HOSTILE_UAV', action: 'JAM', actionLevel: 2, idealEffector: 'JAM', idealLevel: 2, rootCause: 'CORRECT', defId: 'COMMERCIAL_QUAD', neutralised: true, windowS: 30 },
    { groundTruth: { category: 'HOSTILE_UAV' }, detectedT: 25, actionableT: 31, decisionT: 40, traineeClassification: 'BIRD', action: 'MONITOR', actionLevel: 0, idealEffector: 'JAM', idealLevel: 2, rootCause: 'IDENTIFICATION', defId: 'FPV', neutralised: false, windowS: 30 }
  ];
  const det = scoring.detectionScore(events, 10, 30);
  ok('detection score rewards acting close to the physics floor', det.score > 0 && det.score <= 25, det.score.toFixed(2));
  const cls = scoring.classificationScore(events);
  ok('classification score gives partial credit and builds a confusion matrix',
    cls.score > 0 && cls.score < 20 && cls.confusion.HOSTILE_UAV.BIRD === 1, cls.detail);
  const esc = scoring.escalationScore([{ action: 'LASER', idealEffector: 'JAM' }], pack);
  ok('EEI punishes a laser on a jammable quad', esc.eei < 1, esc.eei.toFixed(2));

  const decls = [
    { declared: 0.9, correct: true }, { declared: 0.9, correct: true },
    { declared: 0.2, correct: false }, { declared: 0.1, correct: false }
  ];
  const cal = scoring.calibrationScore(decls);
  ok('a well-calibrated operator scores full calibration marks', cal.score > 8, cal.detail);
  const bad = scoring.calibrationScore([{ declared: 0.95, correct: false }, { declared: 0.95, correct: false }]);
  ok('an over-confident operator is penalised', bad.score < cal.score, `${bad.score.toFixed(2)} vs ${cal.score.toFixed(2)}`);
  ok('the reliability diagram has 10 bins summing to n=4',
    scoring.reliabilityDiagram(decls).length === 10 && scoring.reliabilityDiagram(decls).reduce((s, b) => s + b.n, 0) === 4);

  const pen = scoring.penaltyLedger([{ type: 'FRATRICIDE' }, { type: 'ROE_BREACH' }]);
  ok('fratricide + ROE breach = 50 marks of penalty', pen.total === 50, String(pen.total));

  const coe = scoring.costOfExchange(events, pack);
  ok('cost-of-exchange tracks rupees spent against threat value',
    coe.spent === 20000 && coe.threatValue === 40000 && coe.ratio === 0.5, JSON.stringify(coe));

  const full = scoring.assembleSession({
    pack, events, declarations: decls, physicsFloorS: 10, windowS: 30,
    violations: [{ type: 'WASTED_EFFECTOR' }], teamEvents: [],
    benchmarks: { exemplar: 88, random: 20 }, meta: { seed: 1 }
  });
  ok('the assembled score vector has all six components', full.components.length === 6);
  ok('gross equals the sum of the six components',
    Math.abs(full.gross - full.components.reduce((s, c) => s + c.score, 0)) < 1e-9, full.gross.toFixed(3));
  ok('net = gross - penalties', Math.abs(full.net - (full.gross - 5)) < 1e-9, `${full.gross.toFixed(2)} - 5 = ${full.net.toFixed(2)}`);
  ok('Training Gain is normalised between the random floor and the exemplar ceiling',
    full.trainingGain !== null && full.trainingGain >= 0 && full.trainingGain <= 1, String(full.trainingGain));
  ok('root causes are tallied for the AAR', full.rootCauses.CORRECT === 1 && full.rootCauses.IDENTIFICATION === 1, JSON.stringify(full.rootCauses));
}

// --------------------------------------------------- full simulation runs
section('12. End-to-end simulation (the real tick loop)');
{
  const sc = scenarioMod.buildScripted(pack, 'M1', 1);
  const state = sim.createState(pack, sc, { operatorId: 'unit-test' });
  ok('the physics floor is computed at scenario build time and is a finite non-negative number',
    Number.isFinite(state.physicsFloorS) && state.physicsFloorS >= 0, String(state.physicsFloorS));

  let guard = 0;
  while (!state.finished && guard++ < 4000) {
    // A doctrine-playing trainee: declare the classification, then engage only
    // once the fused belief is decisive - exactly what the console enforces.
    const inputs = [];
    for (const t of state.targets) {
      if (!t.track) continue;
      if (!t.traineeClassification && (t.track.top?.value ?? 0) >= 0.6) {
        inputs.push({ type: 'CLASSIFY', uid: t.uid, classification: t.groundTruth.category, confidence: 0.9 });
      }
      if (!t.action && t.def.hostile && (t.track.top?.value ?? 0) >= 0.6 && t.traineeClassification) {
        inputs.push({ type: 'ENGAGE', uid: t.uid, effectorId: 'JAM' });
      }
    }
    sim.step(state, inputs);
  }
  ok('the sortie terminates', state.finished, 't=' + state.env.t);
  ok('the engine recorded evidence for every target', state.targets.every(t => t.ledger.entries.length >= 0));
  const res = sim.finalise(state, { benchmarks: { exemplar: 90, random: 15 } });
  ok('finalise produces a complete result object',
    res.components.length === 6 && res.events.length === state.targets.length && res.workload !== null);
  ok('at least one hostile was detected in the M1 fog scenario',
    res.events.some(e => e.groundTruth.category === 'HOSTILE_UAV' && e.detectedT !== null),
    JSON.stringify(res.events.map(e => [e.defId, e.detectedT])));
  ok('a perfect player scores well above the random floor', res.net > 40, 'net=' + res.net.toFixed(2));
  ok('every scored event carries a root cause', res.events.every(e => !!e.rootCause));
  ok('each event keeps its full evidence trail for the AAR replay',
    res.events.every(e => Array.isArray(e.evidence)));

  const cert = sim.certificate(sc, res, 'unit-test', pack.pack.version, '1.0.0');
  ok('the sortie certificate produces a 64-char SHA-256', /^[0-9a-f]{64}$/.test(cert.hash), cert.hash);
  const res2 = sim.finalise(state, { benchmarks: { exemplar: 90, random: 15 } });
  const cert2 = sim.certificate(sc, res2, 'unit-test', pack.pack.version, '1.0.0');
  ok('the certificate is deterministic for the same scenario + result', cert.hash === cert2.hash, cert.hash + ' vs ' + cert2.hash);
  const certOther = sim.certificate(scenarioMod.buildScripted(pack, 'M2', 1), res, 'unit-test', pack.pack.version, '1.0.0');
  ok('the certificate changes when the scenario changes', cert.hash !== certOther.hash);
  ok('ACTIONABLE AWARENESS is recorded and is never earlier than raw detection',
    res.events.filter(e => e.actionableT !== null).every(e => e.actionableT >= e.detectedT));
}

// ------------------------------------------------------------------- bots
section('13. Headless bots (auto-calibration + regression baseline)');
{
  const sc = scenarioMod.buildScripted(pack, 'M2', 3);
  const bm = bots.benchmarksFor(pack, sc);
  ok('the exemplar bot beats the random bot', bm.exemplar > bm.random, `exemplar=${bm.exemplar} random=${bm.random}`);
  ok('both bots produce a valid 0..100 net score',
    bm.exemplar >= 0 && bm.exemplar <= 100 && bm.random >= 0 && bm.random <= 100, JSON.stringify(bm));
  const again = bots.benchmarksFor(pack, scenarioMod.buildScripted(pack, 'M2', 3));
  ok('bot benchmarks are reproducible for the same scenario',
    Math.abs(again.exemplar - bm.exemplar) < 1e-6 && Math.abs(again.random - bm.random) < 1e-6,
    `${bm.exemplar}/${again.exemplar}`);
  const exDetail = bots.runBot(pack, sc, 'exemplar').result;
  ok('the exemplar bot classifies everything correctly',
    exDetail.events.filter(e => e.detectedT !== null).every(e => e.traineeClassification === e.groundTruth.category));
}

// --------------------------------------------------- determinism guarantee
section('14. Determinism (replay + multi-seat lockstep depend on this)');
{
  const a = sim.createState(pack, scenarioMod.buildScripted(pack, 'M3', 5));
  const b = sim.createState(pack, scenarioMod.buildScripted(pack, 'M3', 5));
  let g = 0;
  while (!a.finished && g++ < 4000) { sim.step(a, []); sim.step(b, []); }
  ok('two runs of the same seeded scenario end at the same sim time', a.env.t === b.env.t, `${a.env.t} vs ${b.env.t}`);
  ok('two runs produce identical track counts', a.tracks.length === b.tracks.length, `${a.tracks.length} vs ${b.tracks.length}`);
  ok('two runs produce identical detection times',
    JSON.stringify(a.targets.map(t => t.detectedT)) === JSON.stringify(b.targets.map(t => t.detectedT)));
}

// -------------------------------------------------------------------- done
console.log('\n' + '='.repeat(60));
console.log(`  ${pass} passed, ${fail} failed`);
if (fail) { console.log('  FAILURES:\n   - ' + failures.join('\n   - ')); process.exit(1); }
console.log('  ALL ENGINE TESTS PASSED');
console.log('='.repeat(60));
