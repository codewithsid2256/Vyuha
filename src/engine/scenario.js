// VYUHA - seeded procedural scenario generation.
// Scripted missions are jittered on every run; procedural sorties are drawn from
// Government-of-India-derived distributions (threat mix from the MoD 2025
// neutralisation breakdown, weather from the IMD present-weather table, terrain
// from the Bhuvan/CartoDEM classes).

import { mulberry32, hashSeed, pickWeighted, pick, clamp } from './rng.js';

export const SCENARIO_AXES = ['terrain', 'light', 'weather', 'ew', 'zone', 'threat_mix', 'swarm_size', 'ambient', 'sensor_degradation', 'workload', 'friendly_traffic', 'populated'];

/** Canonical fingerprint of a scenario - used for de-duplication and replay. */
export function fingerprint(sc) {
  return [
    sc.terrain.id, sc.light.id, sc.weather.id, sc.ew.id, sc.zone.id,
    sc.threatMix, sc.swarmSize, sc.ambientCount, sc.sensorDegradation,
    sc.workloadTarget, sc.friendlyTraffic ? 1 : 0, sc.populated ? 1 : 0, sc.seed
  ].join('|');
}

export function fingerprintHash(sc) {
  return hashSeed(fingerprint(sc)).toString(16).padStart(8, '0').toUpperCase();
}

function hostileMixLabel(w) {
  if (w < 0.25) return 'RECON_HEAVY';
  if (w < 0.55) return 'MIXED';
  if (w < 0.8) return 'STRIKE_HEAVY';
  return 'SATURATION';
}

/** Draw one procedural sortie. `seen` is a Set of fingerprint hashes. */
export function generateScenario(pack, opts = {}) {
  const {
    seed = Date.now() & 0xffffffff,
    seen = new Set(),
    tier = 3,
    force = {},
    directorHint = null
  } = opts;

  let attempt = 0;
  let sc;
  do {
    const s = seed + attempt * 2654435761;
    sc = buildOne(pack, s, tier, force, directorHint);
    attempt++;
  } while (seen.has(fingerprintHash(sc)) && attempt < 400);

  sc.fingerprint = fingerprint(sc);
  sc.fingerprintHash = fingerprintHash(sc);
  sc.novel = !seen.has(sc.fingerprintHash);
  sc.attempts = attempt;
  return sc;
}

function buildOne(pack, seed, tier, force, directorHint) {
  const rng = mulberry32(seed);

  const terrain = force.terrain || pick(rng, pack.terrain);
  const light = force.light || pick(rng, pack.light);
  const weather = force.weather || pick(rng, pack.weather);
  const ew = force.ew || pack.ew_levels[Math.min(pack.ew_levels.length - 1, Math.floor(rng() * Math.min(3, tier + 1)))];
  const zone = force.zone || pack.airspace_zones.zones[Math.floor(rng() * pack.airspace_zones.zones.length)];

  // Threat count scales with the difficulty tier, bounded by the DRDO 50-drone
  // swarm envelope from the data pack.
  const base = [1, 1, 2, 3, 5][clamp(tier, 0, 4)];
  const swarmSize = force.swarmSize ?? clamp(base + Math.floor(rng() * (tier + 1)), 1, 12);

  // Threat mix bias - drawn from the MoD 2025 breakdown, then tilted by the
  // adaptive director toward the trainee's weakest recognition skill.
  let mixBias = rng();
  if (directorHint?.bias) mixBias = clamp(mixBias * 0.4 + directorHint.bias * 0.6, 0, 1);
  const threatMix = hostileMixLabel(mixBias);

  const ambientCount = force.ambientCount ?? Math.floor(rng() * (2 + tier));
  const populated = force.populated ?? (terrain.id === 'URBAN' ? rng() < 0.8 : rng() < 0.15);
  const friendlyTraffic = force.friendlyTraffic ?? (rng() < 0.35 + tier * 0.08);
  const sensorDegradation = force.sensorDegradation ?? clamp(rng() * (0.1 + tier * 0.08), 0, 0.55);
  const workloadTarget = force.workloadTarget ?? clamp(0.25 + rng() * 0.2 + tier * 0.1, 0.1, 1.0);
  const windMs = 2 + rng() * 9;

  // Build the threat list.
  const threats = [];
  const hostilePool = pack.threat_mix_weights.HOSTILE_POOL.map(p => ({ ...p, w: reweight(p.id, threatMix) }));
  for (let i = 0; i < swarmSize; i++) {
    const chosen = pickWeighted(rng, hostilePool).id;
    threats.push(spawnTarget(pack, rng, chosen, i, swarmSize, 'HOSTILE'));
  }
  for (let i = 0; i < ambientCount; i++) {
    const chosen = pickWeighted(rng, pack.threat_mix_weights.AMBIENT_POOL).id;
    threats.push(spawnTarget(pack, rng, chosen, i, ambientCount, 'AMBIENT'));
  }

  return {
    seed,
    seedHex: '0x' + (seed >>> 0).toString(16).toUpperCase().padStart(8, '0'),
    terrain, light, weather, ew, zone, populated, wind_ms: windMs,
    swarmSize, ambientCount, threatMix, sensorDegradation, workloadTarget,
    friendlyTraffic,
    durationS: 150 + tier * 20,
    defendedRadiusM: 400,
    threats,
    tier
  };
}

function reweight(id, mix) {
  const strike = ['HEX_BOMBER', 'FPV', 'FIBER_OPTIC_FPV', 'LOITERING_MUNITION'];
  const recon = ['COMMERCIAL_QUAD', 'FIXED_WING_SPOTTER'];
  const sat = ['DECOY'];
  switch (mix) {
    case 'RECON_HEAVY': return strike.includes(id) ? 0.35 : sat.includes(id) ? 0.3 : 1.6;
    case 'STRIKE_HEAVY': return strike.includes(id) ? 1.8 : recon.includes(id) ? 0.5 : 0.8;
    case 'SATURATION': return sat.includes(id) ? 3.0 : strike.includes(id) ? 1.2 : 0.7;
    default: return 1.0;
  }
}

function spawnTarget(pack, rng, defId, index, count, role) {
  const def = pack.threats.find(t => t.id === defId);
  const bearing = (index / Math.max(count, 1)) * 2 * Math.PI + rng() * 0.7;
  const range = 2600 + rng() * 1400;
  const heading = bearing + Math.PI + (rng() - 0.5) * 0.5;   // roughly inbound
  const alt = def.alt_m * (0.6 + rng() * 0.8);
  return {
    uid: `T${String(index).padStart(2, '0')}-${defId.slice(0, 4)}`,
    defId,
    role,
    bearing,
    heading,
    range_m: range,
    alt_m: alt,
    speed_ms: def.speed_ms * (0.85 + rng() * 0.35),
    aspect_jitter: 1,
    terrain_masked: false,
    alive: true,
    neutralised: false,
    spawnT: role === 'HOSTILE' ? 2 + rng() * 25 : rng() * 40,
    appeared: false,
    detectedBy: null,
    detectedT: null,
    groundTruth: null,
    lastLook: {},
    // Swarm behaviour
    swarmRole: role === 'HOSTILE' && count >= 4 ? pick(rng, ['STRIKER', 'DECOY_SCREEN', 'FLANKER']) : 'SOLO',
    autonomousFallback: def.autonomous
  };
}

// --------------------------------------------------------- scripted missions
export const SCRIPTED_MISSIONS = [
  {
    id: 'M1', name: 'Amritsar Winter Fog - Single Recon',
    brief: 'December fog on the western IB. A single unescorted commercial quad probes the outpost. Expect RF before EO.',
    force: { terrain: 'RURAL', weather: 'FOG', light: 'DAY', ew: 'NONE', swarmSize: 1, ambientCount: 1, populated: false, tier: 1 }
  },
  {
    id: 'M2', name: 'Punjab IB Dusk - Narcotics Drop',
    brief: 'Dusk, light haze. A heavy hex crosses the IB low and slow. Ground is unpopulated. Minimum sufficient force applies.',
    force: { terrain: 'RURAL', weather: 'HAZE', light: 'DUSK', ew: 'NONE', swarmSize: 1, ambientCount: 2, populated: false, tier: 2 }
  },
  {
    id: 'M3', name: 'Urban Night - FPV With Own UAV Airborne',
    brief: 'Night over a populated city. An FPV is inbound while our own tactical UAV is on station in the same corridor. Deconfliction is the whole test.',
    force: { terrain: 'URBAN', weather: 'MIST', light: 'NIGHT', ew: 'LOW', swarmSize: 1, ambientCount: 2, populated: true, friendlyTraffic: true, tier: 3 }
  },
  {
    id: 'M4', name: 'Fibre-Optic FPV - The Silent Killer',
    brief: 'Your RF detector will find nothing. That does not mean the sky is empty. Radar and EO only.',
    force: { terrain: 'URBAN', weather: 'CLEAR', light: 'DAY', ew: 'NONE', swarmSize: 1, ambientCount: 1, populated: true, tier: 3 },
    inject: ['FIBER_OPTIC_FPV']
  },
  {
    id: 'M5', name: 'Saturation - Decoy Screen Over Red Zone',
    brief: 'A decoy screen saturates your sensors while a striker follows. Kinetic engagement is PROHIBITED in this zone. Soft-kill and hold.',
    force: { terrain: 'URBAN', weather: 'CLEAR', light: 'DAY', ew: 'HIGH', swarmSize: 8, ambientCount: 2, populated: true, tier: 4, zone: 'RED' }
  },
  {
    id: 'M6', name: 'Mountain Night - Ridge Masking',
    brief: 'Night over the mountains. Ridge masking will hide the inbound pair until the last moment. Trust the radar, do not trust a single sensor.',
    force: { terrain: 'MOUNTAIN', weather: 'CLEAR', light: 'NIGHT', ew: 'NONE', swarmSize: 2, ambientCount: 2, populated: false, tier: 3 }
  },
  {
    id: 'M7', name: 'Airfield - Birds, Civilians and a Loitering Munition',
    brief: 'Daylight over an airfield. Heavy bird activity and a registered civilian drone are in the picture. One loitering munition is hiding in the returns.',
    force: { terrain: 'RURAL', weather: 'CLEAR', light: 'DAY', ew: 'NONE', swarmSize: 1, ambientCount: 5, populated: false, tier: 3 },
    inject: ['LOITERING_MUNITION']
  },
  {
    id: 'M8', name: 'Heavy EW - Full Spectrum Assault',
    brief: 'Jamming on your own sensors, IFF failures, mixed strike package, populated ground. Escalate economically or you will run dry.',
    force: { terrain: 'URBAN', weather: 'RAIN', light: 'NIGHT', ew: 'HIGH', swarmSize: 6, ambientCount: 3, populated: true, friendlyTraffic: true, tier: 5 }
  }
];

export function buildScripted(pack, missionId, jitterSeed = 1) {
  const m = SCRIPTED_MISSIONS.find(x => x.id === missionId) || SCRIPTED_MISSIONS[0];
  const f = { ...(m.force || {}) };
  // Resolve string ids to data-pack objects.
  const resolved = {};
  if (f.terrain) resolved.terrain = pack.terrain.find(t => t.id === f.terrain);
  if (f.light) resolved.light = pack.light.find(t => t.id === f.light);
  if (f.weather) resolved.weather = pack.weather.find(t => t.id === f.weather);
  if (f.ew) resolved.ew = pack.ew_levels.find(t => t.id === f.ew);
  if (f.zone) resolved.zone = pack.airspace_zones.zones.find(t => t.id === f.zone);
  const sc = generateScenario(pack, {
    seed: hashSeed(m.id + ':' + jitterSeed),
    tier: f.tier ?? 3,
    force: {
      terrain: resolved.terrain, light: resolved.light, weather: resolved.weather,
      ew: resolved.ew, zone: resolved.zone,
      swarmSize: f.swarmSize, ambientCount: f.ambientCount, populated: f.populated,
      friendlyTraffic: f.friendlyTraffic
    }
  });
  // Force-inject specific threat types for teaching missions.
  if (m.inject) {
    sc.threats = sc.threats.filter(t => t.role !== 'HOSTILE');
    m.inject.forEach((id, i) => sc.threats.unshift(spawnTarget(pack, mulberry32(sc.seed + i * 7), id, i, m.inject.length, 'HOSTILE')));
    sc.swarmSize = m.inject.length;
  }
  sc.scripted = m.id;
  sc.name = m.name;
  sc.brief = m.brief;
  sc.jitterSeed = jitterSeed;
  sc.fingerprint = fingerprint(sc);
  sc.fingerprintHash = fingerprintHash(sc);
  return sc;
}

/** Coverage matrix - how much of the scenario space has this unit actually flown? */
export function coverageMatrix(pack, history) {
  const cells = {};
  for (const t of pack.terrain) for (const l of pack.light) for (const w of pack.weather) {
    cells[`${t.id}|${l.id}|${w.id}`] = { terrain: t.label, light: l.label, weather: w.label, flown: 0 };
  }
  for (const h of history) {
    const k = `${h.terrainId}|${h.lightId}|${h.weatherId}`;
    if (cells[k]) cells[k].flown++;
  }
  const vals = Object.values(cells);
  return {
    cells,
    total: vals.length,
    covered: vals.filter(v => v.flown > 0).length,
    coveragePct: 100 * vals.filter(v => v.flown > 0).length / vals.length
  };
}
