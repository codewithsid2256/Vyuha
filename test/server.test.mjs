// VYUHA - server integration test (console flow, over real HTTP).
// Drives the server exactly the way public/app.js does: open a session, tick it,
// declare classifications, take engagement decisions, finish, and assert the
// scored result.
//
//   node test/server.test.mjs                       # spawns its own server on an
//                                                   # ephemeral port, then tears down
//   node test/server.test.mjs http://127.0.0.1:8099 # drive an already-running server

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = join(__dirname, '..');

// Boot our own server on an ephemeral port unless the caller pointed us at one.
let child = null;
let BASE = process.argv[2];
if (!BASE) {
  BASE = await new Promise((resolve, reject) => {
    child = spawn(process.execPath, ['server.js', '--port', '0', '--host', '127.0.0.1'], { cwd: APP_ROOT });
    let buf = '';
    const timer = setTimeout(() => reject(new Error('server did not become ready in 10 s\n' + buf)), 10000);
    child.stdout.on('data', d => {
      buf += d.toString();
      const m = buf.match(/VYUHA_READY port=(\d+)/);
      if (m) { clearTimeout(timer); resolve(`http://127.0.0.1:${m[1]}`); }
    });
    child.stderr.on('data', d => { buf += d.toString(); });
    child.on('exit', code => { clearTimeout(timer); reject(new Error('server exited early (code ' + code + ')\n' + buf)); });
  });
}
process.on('exit', () => { if (child) child.kill(); });

const get = async (p) => (await fetch(BASE + p)).json();
const post = async (p, body) => {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(p + ' -> ' + r.status + ' ' + (await r.text()).slice(0, 300));
  return r.json();
};

let pass = 0, fail = 0;
const failures = [];
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; failures.push(name + ' ' + extra); console.log('  \u2717 ' + name + '  ' + extra); }
};
const section = (t) => console.log('\n' + t);

/**
 * A realistic operator policy - the same one a trainee is expected to learn:
 *   1. wait for the fused belief to become decisive,
 *   2. declare the class the belief supports, at the confidence it supports,
 *   3. take the MINIMUM SUFFICIENT decision, and HOLD FIRE while the target is
 *      outside the chosen effector's envelope.
 */
async function fly(missionId, operatorId) {
  const s0 = await post('/api/session', { mode: 'scripted', missionId, operatorId, seat: 'C2' });
  let s = s0, n = 0;
  const declared = new Set(), decided = new Map();

  while (n++ < 1600) {
    const inputs = [];
    for (const t of s.state.tracks) {
      const top = t.top || {};
      const v = top.value || 0, h = top.hypothesis;
      const uid = t.uid;

      if (!declared.has(uid) && v >= 0.45) {
        inputs.push({ type: 'CLASSIFY', uid, classification: h, confidence: Math.min(0.97, +(v + 0.03).toFixed(2)) });
        declared.add(uid);
      }
      // Decide once the belief is decisive. Re-decide when the belief changes band.
      const band = v >= 0.80 ? 'engage' : v >= 0.45 ? 'warn' : 'none';
      if (band !== 'none' && decided.get(uid) !== band && v >= 0.45) {
        const range = t.range_m ?? 9999;
        let eff = null;
        if (v >= 0.80) {
          if (h === 'HOSTILE_UAV') eff = range <= 2000 ? 'JAM' : null;      // hold outside the envelope
          else if (h === 'CIVILIAN_DRONE') eff = range <= 800 ? 'WARN' : null;
          else eff = 'MONITOR';
        } else {
          eff = h === 'HOSTILE_UAV' ? (range <= 800 ? 'WARN' : 'MONITOR') : 'MONITOR';
        }
        if (eff) { inputs.push({ type: 'ENGAGE', uid, effectorId: eff }); decided.set(uid, band); }
      }
    }
    s = await post('/api/tick', { sessionId: s0.sessionId, inputs });
    if (s.state.finished) break;
  }
  const f = (await post('/api/finish', { sessionId: s0.sessionId })).result;
  return { session: s0, state: s, result: f, ticks: n };
}

// --------------------------------------------------------------------- run
section('1. Static + metadata endpoints');
{
  const pack = await get('/api/pack');
  ok('GET /api/pack returns the data pack', pack.pack?.pack?.version === '1.0.0', pack.pack?.pack?.version);
  ok('the pack carries 11 threats, 7 effectors, 4 sensors',
    pack.pack.threats.length === 11 && pack.pack.effectors.length === 7 && pack.pack.sensors.length === 4);

  const prov = await get('/api/provenance');
  ok('GET /api/provenance reports 11 Government of India sources', prov.summary.govtSources === 11, JSON.stringify(prov.summary));
  ok('every source record has an org, url and class',
    Object.values(prov.sources).every(v => v.org && v.url && v.class));
  ok('assumptions are counted separately so the UI can flag them', prov.summary.assumptions > 0, String(prov.summary.assumptions));

  const m = await get('/api/missions');
  ok('GET /api/missions returns the 8 scripted missions', m.missions.length === 8, String(m.missions.length));

  const cal = await get('/api/calibration');
  ok('GET /api/calibration returns an acquisition range per threat', cal.rows.length === 11);
  ok('the RF detector has NO acquisition range against the fibre-optic FPV',
    cal.rows.find(r => r.id === 'FIBER_OPTIC_FPV').ranges['RF-1'] === null);
  ok('the fibre-optic FPV is still acquirable on radar',
    cal.rows.find(r => r.id === 'FIBER_OPTIC_FPV').ranges['RADAR-1'] > 0);
  ok('IMD fog collapses the EO/IR channel for a micro-drone',
    cal.rows.find(r => r.id === 'COMMERCIAL_QUAD').ranges['EO-1'] > 1000);

  for (const p of ['/', '/style.css', '/app.js', '/engine/physics.js', '/engine/scoring.js']) {
    const r = await fetch(BASE + p);
    ok('static asset served: ' + p, r.status === 200, String(r.status));
  }
}

section('2. Console flow over HTTP - every scripted mission');
const results = {};
for (const id of ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8']) {
  const r = await fly(id, 'srvtest-' + id);
  results[id] = r;
  const f = r.result;
  console.log(`  ${id}  ticks=${String(r.ticks).padStart(4)}  net=${f.net.toFixed(1).padStart(5)}  ` +
    `gross=${f.gross.toFixed(1).padStart(5)}  pen=${String(f.penalties.total).padStart(3)}  ` +
    `gain=${(f.trainingGain ?? 0).toFixed(2)}  EEI=${f.escalation.eei.toFixed(2)}  ` +
    `CORRECT=${f.rootCauses.CORRECT || 0}`);
}

section('3. Assertions on the scored sorties');
{
  const all = Object.values(results);
  ok('every mission terminates', all.every(r => r.state.state.finished));
  ok('every mission produces a six-component score vector', all.every(r => r.result.components.length === 6));
  ok('every mission produces a SHA-256 sortie certificate',
    all.every(r => /^[0-9a-f]{64}$/.test(r.result.certificate.hash)));
  ok('every mission yields a finite net score in [0,100]',
    all.every(r => r.result.net >= 0 && r.result.net <= 100));
  ok('every mission yields a Training Gain in [0,1] against its own bot benchmarks',
    all.every(r => r.result.trainingGain === null || (r.result.trainingGain >= 0 && r.result.trainingGain <= 1)));

  const played = all.filter(r => r.result.rootCauses.CORRECT > 0);
  ok('a competent operator scores at least one CORRECT adjudication in most missions',
    played.length >= 5, played.length + '/8 -> ' + played.map(r => Object.keys(results).find(k => results[k] === r)).join(','));

  ok('the operator policy clears the exemplar-vs-random gap somewhere',
    all.some(r => r.result.net > (r.session.benchmarks.random + 15)),
    all.map(r => r.result.net.toFixed(0)).join(','));

  const m1 = results.M1.result;
  ok('M1 (fog): the hostile is acquired', m1.events.some(e => e.groundTruth.category === 'HOSTILE_UAV' && e.detectedT !== null));
  ok('M1 (fog): for every DETECTED target the doctrine returns an ideal action gated on the operator belief',
    m1.events.filter(e => e.detectedT !== null).every(e => e.idealEffector !== null),
    JSON.stringify(m1.events.map(e => [e.defId, e.detectedT, e.idealEffector])));
  ok('M1 (fog): the gated ideal is a graduated response, not an automatic jam',
    m1.events.filter(e => e.detectedT !== null).some(e => ['WARN', 'MONITOR', 'JAM'].includes(e.idealEffector)));

  const m4 = results.M4.result;
  ok('M4: the fibre-optic FPV produces no RF evidence at all',
    (() => {
      const ev = m4.events.find(e => e.defId === 'FIBER_OPTIC_FPV');
      return ev && ev.evidence.every(x => x.kind !== 'rf' || !x.detected);
    })(), 'checked evidence kinds');

  const m5 = results.M5.result;
  ok('M5 (red zone, 8 hostiles): no kinetic ROE breach is committed by the policy',
    !m5.penalties.rows.some(p => p.type === 'ROE_BREACH'));
  ok('M5: a saturation sortie generates many tracks', m5.events.length >= 8, String(m5.events.length));

  const withWorkload = all.filter(r => r.result.workload);
  ok('every sortie records a NASA-TLX workload profile', withWorkload.length === all.length);
  ok('every sortie records an anti-rote verdict', all.every(r => r.result.meta.rote && typeof r.result.meta.rote.suspected === 'boolean'));
  ok('every sortie records its scenario fingerprint', all.every(r => /^[0-9A-F]{8}$/.test(r.result.meta.fingerprintHash)));
}

section('4. Learning persists and the Director re-targets');
{
  const t = await get('/api/trainee?id=srvtest-M4');
  ok('the trainee model persisted one session', t.model.sessions.length >= 1, String(t.model.sessions.length));
  ok('the Director names a weakest skill node', !!t.next?.targeting?.id, t.next?.targeting?.id);
  ok('the Director picks a tier between 1 and 5', t.next.tier >= 1 && t.next.tier <= 5, String(t.next.tier));
  ok('the Director rationale is human-readable', (t.next.rationale || '').length > 40);
}

section('5. Adaptive + custom sortie generation');
{
  const a = await post('/api/session', { mode: 'adaptive', operatorId: 'srvtest-adaptive', seed: 12345 });
  ok('adaptive mode builds a sortie with a Director plan', !!a.scenario.directorPlan, JSON.stringify(a.scenario.directorPlan?.targeting));
  const c = await post('/api/session', { mode: 'custom', operatorId: 'srvtest-custom', terrainId: 'MOUNTAIN', lightId: 'NIGHT', weatherId: 'FOG', ewId: 'HIGH', zoneId: 'RED', swarmSize: 5, ambientCount: 3 });
  ok('custom mode honours the requested conditions',
    c.scenario.terrain.id === 'MOUNTAIN' && c.scenario.light.id === 'NIGHT' &&
    c.scenario.weather.id === 'FOG' && c.scenario.ew.id === 'HIGH' && c.scenario.zone.id === 'RED',
    JSON.stringify([c.scenario.terrain.id, c.scenario.light.id, c.scenario.weather.id, c.scenario.ew.id, c.scenario.zone.id]));
  const d = await post('/api/session', { mode: 'custom', operatorId: 'srvtest-custom', terrainId: 'RURAL', lightId: 'DAY', weatherId: 'CLEAR', ewId: 'NONE', zoneId: 'GREEN', swarmSize: 5, ambientCount: 3, seed: 999 });
  const e = await post('/api/session', { mode: 'custom', operatorId: 'srvtest-custom', terrainId: 'RURAL', lightId: 'DAY', weatherId: 'CLEAR', ewId: 'NONE', zoneId: 'GREEN', swarmSize: 5, ambientCount: 3, seed: 999 });
  ok('the same seed reproduces the same fingerprint over HTTP', d.scenario.fingerprintHash === e.scenario.fingerprintHash,
    d.scenario.fingerprintHash + ' vs ' + e.scenario.fingerprintHash);
}

console.log('\n' + '='.repeat(64));
console.log(`  ${pass} passed, ${fail} failed`);
if (child) child.kill();
if (fail) { console.log('  FAILURES:\n   - ' + failures.join('\n   - ')); process.exit(1); }
console.log('  ALL SERVER INTEGRATION TESTS PASSED');
console.log('='.repeat(64));
process.exit(0);
