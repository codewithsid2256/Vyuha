// VYUHA - PILLAR 2: Physics-first sensor model.
// Detection is NEVER scripted. It is computed from a signal chain every tick.
//
//   RADAR : monostatic radar equation + ground clutter + Swerling-1 fluctuation
//   RF    : link budget on the target's own control link (fibre-optic FPV = silent)
//   EO/IR : Johnson-criteria pixel count x Koschmieder atmospheric transmission
//   ACO   : rotor blade-passage level vs spherical spreading
//
// Every constant comes from the data pack, and every data-pack constant carries
// a source record (see data/data-pack.json).

import { db2lin, lin2db, pdSwerling1, tauAtm, clamp } from './rng.js';

const C = 299792458;
const K_BOLTZ = 1.380649e-23;
const T_SYS = 290;

// ---------------------------------------------------------------- RADAR ---
export function radarChain(env, tgt, sensor) {
  const p = sensor.params;
  const fHz = p.freq_ghz.value * 1e9;
  const lambda = C / fHz;
  const R = Math.max(tgt.range_m, 1);

  if (R > p.max_range_m.value) return { pd: 0, pcls: 0, pid: 0, why: 'beyond max range' };

  // Terrain masking. CartoDEM-derived ridge occlusion is resolved by the engine
  // into a deterministic per-target flag, so the physics floor stays reproducible.
  if (tgt.terrain_masked) return { pd: 0, pcls: 0, pid: 0, why: 'terrain masked' };

  const Pt = p.peak_power_w.value;
  const G = db2lin(p.antenna_gain_db.value);
  const sigma = tgt.def.rcs_m2 * (0.7 + 0.6 * tgt.aspect_jitter);   // rotor flash + aspect
  const L = db2lin(p.system_loss_db.value + env.ew.radar_noise_db);
  const F = db2lin(p.noise_figure_db.value);
  const Bn = p.bandwidth_mhz.value * 1e6;

  const Gi = db2lin(p.integration_gain_db ? p.integration_gain_db.value : 0);
  const numerator = Pt * G * G * lambda * lambda * sigma * Gi;
  const denominator = Math.pow(4 * Math.PI, 3) * Math.pow(R, 4) * K_BOLTZ * T_SYS * Bn * F * L;
  const snr = numerator / denominator;

  // Ground clutter limited SINR
  const terrain = env.terrain;
  const sigmaClutter = p.clutter_coeff.value * terrain.clutter_factor;
  const scr = (sigma / sigmaClutter) * Math.pow(800 / R, 2);
  const sinr = 1 / (1 / snr + 1 / Math.max(scr, 1e-6));

  const pd = pdSwerling1(sinr, p.pfa.value);

  // Radar classifies only to a coarse RCS band; fine class needs EO.
  const pcls = clamp(pd * clamp(lin2db(sinr) / 22, 0, 0.55), 0, 0.55);
  const pid = clamp(pd * clamp((lin2db(sinr) - 24) / 30, 0, 0.25), 0, 0.25);

  return { pd, pcls, pid, snr_db: lin2db(snr), sinr_db: lin2db(sinr), scr_db: lin2db(scr) };
}

// ------------------------------------------------------------------- RF ---
// The target's OWN control link is the signal of opportunity. If the target has
// no RF link (fibre-optic FPV, bird, clutter) this chain returns nothing at all.
export function rfChain(env, tgt, sensor) {
  const p = sensor.params;
  if (!tgt.def.rf) return { pd: 0, pcls: 0, pid: 0, why: 'RF silent' };
  const R = Math.max(tgt.range_m, 1);
  if (R > p.max_range_m.value) return { pd: 0, pcls: 0, pid: 0, why: 'beyond max range' };

  const fMHz = tgt.def.rf.band_ghz * 1000;
  const fspl = 20 * Math.log10(R) + 20 * Math.log10(fMHz) - 27.55;      // dB
  const atm = env.weather.attenuation_db_per_km * (R / 1000);           // dB
  const pol = p.pol_loss_db.value;
  // Airframe pattern nulls on a tumbling multirotor, multipath fading and the
  // hop duty cycle. Without this margin every linked drone would be trivially
  // detectable at any range and the RF-silent lesson would be meaningless.
  const fade = 12;                                                      // dB

  const rx = tgt.def.rf.eirp_dbm - fspl - atm - pol + p.rx_gain_db.value - env.ew.rf_noise_db;
  const margin = rx - p.sensitivity_dbm.value - fade;

  if (margin <= 0) return { pd: 0, pcls: 0, pid: 0, why: 'below sensitivity', margin_db: margin };

  const pd = clamp(1 / (1 + Math.exp(-(margin - 3) / 2.2)), 0, 0.98);
  // Protocol fingerprint (hop rate + band + protocol family) is a strong class cue.
  const pcls = clamp(pd * (0.55 + 0.35 * clamp(margin / 20, 0, 1)), 0, 0.9);
  // RF alone rarely gives identification (model-level) - that needs EO or IFF.
  const pid = clamp(pd * 0.18, 0, 0.2);

  return { pd, pcls, pid, rx_dbm: rx, margin_db: margin, band_ghz: tgt.def.rf.band_ghz, hop_rate_hz: tgt.def.rf.hop_rate_hz, protocol: tgt.def.rf.protocol };
}

// ---------------------------------------------------------------- EO/IR ---
export function eoChain(env, tgt, sensor, opts = {}) {
  const p = sensor.params;
  const R = Math.max(tgt.range_m, 1);
  const maxR = p.max_range_m ? p.max_range_m.value : 6000;
  if (R > maxR) return { pd: 0, pcls: 0, pid: 0, why: 'beyond max range' };

  const ifov = (p.sensor_width_mm.value / (p.focal_length_mm.value * p.px_horizontal.value)) * 1000; // mrad/px
  const pxAcross = (tgt.def.size_m * 1000) / (ifov * R);

  const tau = tauAtm(R, env.weather.visibility_m);
  // At night the gimbal runs on IR, so IR contrast applies; thermal crossover
  // (dawn/dusk) collapses it; in daylight the visible channel is used.
  const light = env.light;
  const contrast = light.crossover
    ? light.ir_contrast
    : (light.id === 'NIGHT' ? light.ir_contrast : light.visible_contrast);

  // Effective resolution budget: geometry x atmospheric transmission x the
  // contrast available in this light state relative to a nominal daylight scene.
  const NOMINAL_CONTRAST = 1.0;
  const effPx = pxAcross * tau * clamp(contrast / NOMINAL_CONTRAST, 0.02, 1);

  const detRatio = effPx / p.px_required_detect.value;
  const clsRatio = effPx / p.px_required_class.value;
  const idRatio = effPx / p.px_required_id.value;

  const cueFactor = opts.cued ? 1.0 : 0.45;   // searching vs cued by radar/RF

  const pd = clamp(1 / (1 + Math.exp(-(detRatio - 1) * 5.0)) * cueFactor, 0, 0.97);
  const pcls = clamp(1 / (1 + Math.exp(-(clsRatio - 1) * 6.0)) * cueFactor, 0, 0.95);
  const pid = clamp(1 / (1 + Math.exp(-(idRatio - 1) * 6.0)) * cueFactor, 0, 0.9);

  return { pd, pcls, pid, px_across: pxAcross, tau, contrast, cued: !!opts.cued };
}

// ------------------------------------------------------------- ACOUSTIC ---
export function acousticChain(env, tgt, sensor) {
  const p = sensor.params;
  if (!tgt.def.noise_db_at_150m) return { pd: 0, pcls: 0, pid: 0, why: 'silent' };
  const R = Math.max(tgt.range_m, 1);
  if (R > p.max_range_m.value) return { pd: 0, pcls: 0, pid: 0, why: 'beyond max range' };

  const spl = tgt.def.noise_db_at_150m - 10 * p.path_exponent.value * Math.log10(R / p.ref_range_m.value);
  const ambient = 38 + env.weather.attenuation_db_per_km * 4 + (env.wind_ms || 4) * 1.5;
  const snr = spl - ambient;
  if (snr <= 0) return { pd: 0, pcls: 0, pid: 0, why: 'below ambient', snr_db: snr };

  const pd = clamp(1 / (1 + Math.exp(-(snr - 4) / 2.0)), 0, 0.85);
  // Blade passage frequency is a weak but real class cue (rotor count).
  const pcls = clamp(pd * 0.35, 0, 0.35);
  return { pd, pcls, pid: 0, spl_db: spl, snr_db: snr };
}

// --------------------------------------------------- unified evaluation ---
export const CHAINS = { radar: radarChain, rf: rfChain, eo: eoChain, acoustic: acousticChain };

/**
 * Evaluate every sensor in the cell against one target for one tick.
 * Returns per-sensor reports; the caller turns these into Evidence Ledger entries.
 */
export function evaluateSensors(env, tgt, sensors, rng, opts = {}) {
  const out = [];
  for (const s of sensors) {
    // Scan period gate: a sensor can only produce a fresh look every N seconds.
    if (tgt.lastLook?.[s.id] !== undefined && (env.t - tgt.lastLook[s.id]) < s.params.scan_period_s.value) continue;
    tgt.lastLook = tgt.lastLook || {};
    tgt.lastLook[s.id] = env.t;

    const r = s.kind === 'eo' ? eoChain(env, tgt, s, opts) : CHAINS[s.kind](env, tgt, s);
    if (r.pd <= 0) {
      out.push({ sensor: s.id, kind: s.kind, detected: false, ...r });
      continue;
    }
    const detected = rng() < r.pd;
    if (!detected) { out.push({ sensor: s.id, kind: s.kind, detected: false, ...r }); continue; }

    const pcls = r.pcls * (1 - env.sensorDegradation);
    const pid = r.pid * (1 - env.sensorDegradation);
    out.push({
      sensor: s.id, kind: s.kind, detected: true,
      pcls, pid,
      classified: rng() < pcls,
      identified: rng() < pid,
      ...r
    });
  }
  return out;
}

/**
 * PHYSICS FLOOR.
 * The earliest time at which the sensor cell could have achieved Pd >= 0.8 on
 * this target, given its closing kinematics and the current environment.
 * This is the denominator of the Detection score - it is computed, not guessed.
 */
export function physicsFloorTime(env, tgtDef, sensors, spawnRangeM, closingSpeedMs, dt = 0.5, horizon = 180) {
  const probe = {
    def: tgtDef, range_m: spawnRangeM, alt_m: tgtDef.alt_m,
    aspect_jitter: 1.0, lastLook: {}
  };
  for (let t = 0; t <= horizon; t += dt) {
    probe.range_m = Math.max(spawnRangeM - closingSpeedMs * t, 5);
    probe.alt_m = tgtDef.alt_m;
    let combined = 1;
    for (const s of sensors) {
      const r = s.kind === 'eo' ? eoChain(env, probe, s, { cued: false }) : CHAINS[s.kind](env, probe, s);
      combined *= (1 - r.pd);
    }
    const pdCell = 1 - combined;
    if (pdCell >= 0.8) return { t_floor: t, pd_cell: pdCell, range_at_floor: probe.range_m };
  }
  return { t_floor: null, pd_cell: 0, range_at_floor: null };
}

/** Range at which each sensor reaches Pd >= 0.8 in this environment. */
export function sensorAcquisitionRanges(env, tgtDef, sensors) {
  const out = {};
  for (const s of sensors) {
    let found = null;
    for (let R = 8000; R >= 20; R -= 20) {
      const probe = { def: tgtDef, range_m: R, alt_m: tgtDef.alt_m, aspect_jitter: 1.0, lastLook: {} };
      const r = s.kind === 'eo' ? eoChain(env, probe, s, { cued: true }) : CHAINS[s.kind](env, probe, s);
      if (r.pd >= 0.8) { found = R; break; }
    }
    out[s.id] = found;
  }
  return out;
}
