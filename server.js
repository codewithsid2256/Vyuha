#!/usr/bin/env node
// VYUHA - unit server.
// Zero npm dependencies. Node >= 18. Serves the console, the data pack and the
// session API over the LAN so a whole C-UAS cell can train off one laptop.
//
//   node server.js [--port 8080] [--host 0.0.0.0]

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, 'public');
const SRC_DIR = join(HERE, 'src');
const DATA_FILE = join(HERE, 'data', 'data-pack.json');
const ENGINE_VERSION = '1.0.0';

const args = process.argv.slice(2);
const getArg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const PORT = Number(getArg('port', process.env.PORT || 8080));
const HOST = getArg('host', '0.0.0.0');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.md': 'text/markdown; charset=utf-8'
};

const DATA_PACK = JSON.parse(await readFile(DATA_FILE, 'utf8'));

// The engine is loaded once, server-side, so the same physics that the tests
// exercise is what the browser sessions are scored against.
const physicsMod = await import('./src/engine/physics.js');
const scenarioMod = await import('./src/engine/scenario.js');
const simMod = await import('./src/engine/sim.js');
const botsMod = await import('./src/engine/bots.js');
const directorMod = await import('./src/engine/director.js');
const scoringMod = await import('./src/engine/scoring.js');
scoringMod.setHasher(s => createHash('sha256').update(s).digest('hex'));

/** @type {Map<string, any>} */
const sessions = new Map();
/** @type {Map<string, any>} */
const trainees = new Map();

function sha256(obj) { return createHash('sha256').update(JSON.stringify(obj)).digest('hex'); }
function newId(prefix) { return prefix + '_' + sha256([prefix, Date.now(), Math.random()].join(':')).slice(0, 12); }

function buildScenario(req) {
  const seen = new Set((req.seenFingerprints || []).map(String));
  if (req.mode === 'scripted') {
    return scenarioMod.buildScripted(DATA_PACK, req.missionId || 'M1', req.jitterSeed || 1);
  }
  if (req.mode === 'custom') {
    return scenarioMod.generateScenario(DATA_PACK, {
      seed: (req.seed ?? (Date.now() & 0xffffffff)) >>> 0,
      seen, tier: req.tier ?? 3,
      force: {
        terrain: DATA_PACK.terrain.find(t => t.id === req.terrainId),
        light: DATA_PACK.light.find(t => t.id === req.lightId),
        weather: DATA_PACK.weather.find(t => t.id === req.weatherId),
        ew: DATA_PACK.ew_levels.find(t => t.id === req.ewId),
        zone: DATA_PACK.airspace_zones.zones.find(z => z.id === req.zoneId),
        swarmSize: req.swarmSize, ambientCount: req.ambientCount, populated: req.populated,
        friendlyTraffic: req.friendlyTraffic
      }
    });
  }
  // adaptive: the Director picks the tier and aims the sortie at the weakest skill
  const model = trainees.get(req.operatorId) || directorMod.newTraineeModel(req.operatorId || 'trainee');
  trainees.set(model.id, model);
  const plan = directorMod.nextSortie(model, DATA_PACK, model.sessions);
  const sc = scenarioMod.generateScenario(DATA_PACK, {
    seed: (req.seed ?? (Date.now() & 0xffffffff)) >>> 0,
    seen, tier: plan.tier, force: plan.force, directorHint: { bias: plan.bias }
  });
  sc.directorPlan = plan;
  return sc;
}

function publicTracks(state) {
  return state.tracks.map(t => {
    const tgt = state.targets.find(x => x.uid === t.uid) || {};
    const entries = tgt.ledger?.entries || [];
    return {
      id: t.id, uid: t.uid, createdAt: t.createdAt, sensor: t.sensor,
      label: t.label, confidence: t.confidence, engaged: t.engaged, effector: t.effector,
      range_m: t.range_m, bearing: t.bearing, alt_m: t.alt_m,
      belief: t.belief, top: t.top, entropy: t.entropy,
      // The operator never receives ground truth - only the evidence trail and
      // the fused belief his own cell has built.
      size_m: tgt.def?.size_m ?? null,
      hostile_rf: !!tgt.def?.rf,
      evidence: entries.slice(-60).map(e => ({
        t: e.t, sensor: e.sensor, kind: e.kind, detected: e.detected, text: e.text,
        delta: e.delta, uninformative: !!e.uninformative
      }))
    };
  });
}

function publicState(state) {
  return {
    t: state.env.t, finished: state.finished, endedAt: state.endedAt,
    overload: state.overload,
    workloadIndex: state.workloadSamples.length ? state.workloadSamples[state.workloadSamples.length - 1].index : 0,
    tracks: publicTracks(state),
    log: state.log.slice(-40),
    pending: state.pendingActions.map(p => ({ uid: p.uid, effectorId: p.effectorId, resolveAt: p.resolveAt })),
    alive: state.targets.map(t => ({
      uid: t.uid, alive: t.alive, neutralised: t.neutralised,
      x: t.x, y: t.y, alt_m: t.alt_m, range_m: t.range_m, bearing: t.bearing,
      hasTrack: !!t.track, trackId: t.track?.id || null
    }))
  };
}

const routes = {
  'GET /api/pack': () => ({ pack: DATA_PACK, engine: ENGINE_VERSION }),

  'GET /api/missions': () => ({
    missions: scenarioMod.SCRIPTED_MISSIONS.map(m => ({ id: m.id, name: m.name, brief: m.brief }))
  }),

  'POST /api/session': (req) => {
    const scenario = buildScenario(req);
    const benchmarks = botsMod.benchmarksFor(DATA_PACK, scenario);
    const state = simMod.createState(DATA_PACK, scenario, {
      operatorId: req.operatorId || 'trainee',
      operatorName: req.operatorName || 'Trainee',
      seat: req.seat || 'C2'
    });
    state.acquisitionRanges = {
      bySensor: physicsMod.sensorAcquisitionRanges(
        state.env, DATA_PACK.threats.find(t => t.id === 'COMMERCIAL_QUAD'), DATA_PACK.sensors)
    };
    const id = newId('ses');
    sessions.set(id, { id, state, scenario, benchmarks, createdAt: Date.now(), operatorId: req.operatorId || 'trainee' });
    return {
      sessionId: id, benchmarks,
      physicsFloorS: state.physicsFloorS, windowS: state.windowS,
      scenario: {
        seed: scenario.seed, seedHex: scenario.seedHex,
        fingerprint: scenario.fingerprint, fingerprintHash: scenario.fingerprintHash,
        novel: scenario.novel, tier: scenario.tier,
        terrain: scenario.terrain, light: scenario.light, weather: scenario.weather,
        ew: scenario.ew, zone: scenario.zone, populated: scenario.populated,
        swarmSize: scenario.swarmSize, ambientCount: scenario.ambientCount,
        threatMix: scenario.threatMix, durationS: scenario.durationS,
        defendedRadiusM: scenario.defendedRadiusM, wind_ms: scenario.wind_ms,
        scripted: scenario.scripted || null, name: scenario.name || null, brief: scenario.brief || null,
        directorPlan: scenario.directorPlan || null
      },
      state: publicState(state)
    };
  },

  'POST /api/tick': (req) => {
    const s = sessions.get(req.sessionId);
    if (!s) return { error: 'unknown session' };
    simMod.step(s.state, req.inputs || []);
    return { state: publicState(s.state) };
  },

  'POST /api/finish': (req) => {
    const s = sessions.get(req.sessionId);
    if (!s) return { error: 'unknown session' };
    const result = simMod.finalise(s.state, { benchmarks: s.benchmarks });
    const cert = simMod.certificate(s.scenario, result, s.operatorId, DATA_PACK.pack.version, ENGINE_VERSION);
    result.certificate = cert;
    // Feed the trainee model so the next sortie is aimed at the weakest skill.
    const model = trainees.get(s.operatorId) || directorMod.newTraineeModel(s.operatorId);
    directorMod.learnFromSession(model, result, DATA_PACK);
    trainees.set(model.id, model);
    result.nextSortie = directorMod.nextSortie(model, DATA_PACK, model.sessions);
    result.coverage = scenarioMod.coverageMatrix(DATA_PACK, model.sessions.map(x => ({
      terrainId: x.meta?.terrainId, lightId: x.meta?.lightId, weatherId: x.meta?.weatherId
    })));
    s.result = result;
    return { result };
  },

  'GET /api/trainee': (req, url) => {
    const id = url.searchParams.get('id') || 'trainee';
    const model = trainees.get(id) || directorMod.newTraineeModel(id);
    trainees.set(id, model);
    return { model, next: directorMod.nextSortie(model, DATA_PACK, model.sessions) };
  },

  'GET /api/provenance': () => {
    const refs = {};
    const walk = (o) => {
      if (Array.isArray(o)) return o.forEach(walk);
      if (o && typeof o === 'object') {
        if (typeof o.source === 'string') refs[o.source] = (refs[o.source] || 0) + 1;
        Object.values(o).forEach(walk);
      }
    };
    walk(DATA_PACK);
    const govt = Object.keys(refs).filter(k => /^G\d+$/.test(k));
    const open = Object.keys(refs).filter(k => /^O\d+$/.test(k));
    return {
      sources: DATA_PACK.sources,
      counts: refs,
      summary: {
        govtSources: govt.length,
        govtParams: govt.reduce((s, k) => s + refs[k], 0),
        openSources: open.length,
        openParams: open.reduce((s, k) => s + refs[k], 0),
        assumptions: refs['assumption'] || 0
      }
    };
  },

  'GET /api/calibration': () => {
    const physics = physicsMod;
    const env = {
      t: 0, terrain: DATA_PACK.terrain.find(t => t.id === 'RURAL'),
      light: DATA_PACK.light.find(l => l.id === 'DAY'),
      weather: DATA_PACK.weather.find(w => w.id === 'CLEAR'),
      ew: DATA_PACK.ew_levels[0], sensorDegradation: 0, wind_ms: 4
    };
    const rows = DATA_PACK.threats.map(def => ({
      id: def.id, label: def.label, rcs_m2: def.rcs_m2,
      ranges: physics.sensorAcquisitionRanges(env, def, DATA_PACK.sensors)
    }));
    const missions = [];
    for (const m of scenarioMod.SCRIPTED_MISSIONS) {
      const sc = scenarioMod.buildScripted(DATA_PACK, m.id, 1);
      const bm = botsMod.benchmarksFor(DATA_PACK, sc);
      missions.push({ id: m.id, name: m.name, exemplar: bm.exemplar, random: bm.random });
    }
    return { rows, missions, note: 'Pd >= 0.8 acquisition range in metres, CLEAR / DAY / RURAL.' };
  }
};

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const key = req.method + ' ' + url.pathname;

  if (url.pathname.startsWith('/api/')) {
    const handler = routes[key];
    if (!handler) return send(res, 404, { error: 'no such endpoint', key });
    try {
      let body = {};
      if (req.method === 'POST') body = await readBody(req);
      const out = await handler(body, url);
      return send(res, 200, out);
    } catch (e) {
      return send(res, 500, { error: String(e && e.message || e), stack: String(e && e.stack || '').split('\n').slice(0, 4) });
    }
  }

  // static
  let p = url.pathname === '/' ? '/index.html' : url.pathname;
  let file;
  if (p.startsWith('/engine/')) file = join(SRC_DIR, 'engine', normalize(p.slice('/engine/'.length)));
  else file = join(PUBLIC_DIR, normalize(p));
  if (!file.startsWith(PUBLIC_DIR) && !file.startsWith(SRC_DIR)) return send(res, 403, { error: 'forbidden' });
  try {
    const st = await stat(file);
    if (st.isDirectory()) return send(res, 404, { error: 'not found' });
    const buf = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  } catch {
    send(res, 404, { error: 'not found', path: p });
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 4e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(JSON.stringify(obj));
}

const server = createServer(handle).listen(PORT, HOST, () => {
  const actualPort = server.address().port;
  console.log('');
  console.log('  \u2588\u2588  \u0935\u094D\u092F\u0942\u0939  VYUHA  \u2014  AI-Enabled Drone & Counter-Drone Threat Simulation Trainer');
  console.log('  ' + '-'.repeat(72));
  console.log(`  console     http://localhost:${actualPort}`);
  console.log(`  data pack   v${DATA_PACK.pack.version}  \u00B7  engine v${ENGINE_VERSION}`);
  console.log('  training simulation only \u00B7 no weapon control \u00B7 no classified data');
  console.log('');
  // Machine-readable readiness line: the integration test spawns this process
  // on an ephemeral port and parses the bound port from stdout.
  console.log(`VYUHA_READY port=${actualPort} host=${HOST}`);
});
