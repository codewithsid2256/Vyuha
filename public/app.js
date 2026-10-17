// VYUHA console. Thin client: all physics and scoring run server-side against
// exactly the modules the test suite exercises, so what you see is what was
// verified. Multi-seat uses BroadcastChannel so one laptop can run a whole
// C-UAS cell across browser tabs with zero extra hardware.

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const HYP = [
  { id: 'HOSTILE_UAV', label: 'HOSTILE UAV', cls: 'host' },
  { id: 'OWN_UAV', label: 'OWN UAV', cls: 'own' },
  { id: 'CIVILIAN_DRONE', label: 'CIVILIAN', cls: 'civ' },
  { id: 'BIRD', label: 'BIRD', cls: 'bird' },
  { id: 'NON_DRONE', label: 'NON-DRONE', cls: 'non' }
];
const HYP_TAG = { HOSTILE_UAV: ['h', 'HOSTILE'], OWN_UAV: ['f', 'OWN'], CIVILIAN_DRONE: ['c', 'CIVIL'], BIRD: ['b', 'BIRD'], NON_DRONE: ['n', 'NON-UAS'] };

const S = {
  pack: null, prov: null, missions: [],
  sessionId: null, scenario: null, state: null, benchmarks: null,
  selected: null, pending: [], result: null, trainee: null,
  running: false, speed: 1, mode: 'adaptive', missionId: 'M1', custom: {},
  seat: 'C2', operatorId: 'trainee-01',
  rfHistory: [], lastLogLen: 0, eoTarget: null
};

const api = async (path, body) => {
  const r = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  if (!r.ok) throw new Error(path + ' -> ' + r.status);
  return r.json();
};
const toast = (m) => { const t = $('#toast'); t.textContent = m; t.classList.add('on'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('on'), 3200); };
const fmtT = (s) => { const m = Math.floor((s || 0) / 60); return String(m).padStart(2, '0') + ':' + ((s || 0) - m * 60).toFixed(1).padStart(4, '0'); };
const fmtINR = (v) => v >= 1e7 ? '₹' + (v / 1e7).toFixed(2) + ' cr' : v >= 1e5 ? '₹' + (v / 1e5).toFixed(2) + ' L' : v >= 1e3 ? '₹' + (v / 1e3).toFixed(1) + 'k' : '₹' + v;

// ================================================================= BOOT
async function boot() {
  const [p, m, pv] = await Promise.all([api('/api/pack'), api('/api/missions'), api('/api/provenance')]);
  S.pack = p.pack; S.missions = m.missions; S.prov = pv;
  $('#tWarn').textContent = 'warn ' + Math.round(p.pack.doctrine.confidence_threshold_warn * 100) + '%';
  $('#tEng').textContent = 'engage ' + Math.round(p.pack.doctrine.confidence_threshold_engage * 100) + '%';
  $('#workloadLimit').style.left = Math.round(p.pack.workload.w_max / 1.6 * 100) + '%';

  buildClassButtons(); buildEffectorButtons(); buildCustomPane(); buildMissionList();
  bindUI();
  await loadTrainee();
  renderProvenance();
  renderUnit();
  resizeCanvases();
}

async function loadTrainee() {
  const id = $('#opId').value.trim() || 'trainee-01';
  S.operatorId = id;
  const t = await api('/api/trainee?id=' + encodeURIComponent(id));
  S.trainee = t;
  const n = t.next;
  $('#directorRationale').innerHTML =
    '<b>AI Director.</b> ' + n.rationale + '<br><span class="dim">Next sortie: tier ' + n.tier +
    (n.force && Object.keys(n.force).length ? ' · forced conditions: ' + Object.keys(n.force).join(', ') : '') + '</span>';
}

function buildClassButtons() {
  const box = $('#classButtons'); box.innerHTML = '';
  for (const h of HYP) {
    const b = document.createElement('button');
    b.dataset.h = h.id;
    const tax = h.id === 'HOSTILE_UAV' ? 'any hostile platform' : h.id === 'OWN_UAV' ? 'IFF / ATO deconfliction' :
      h.id === 'CIVILIAN_DRONE' ? 'DGCA-registered, legal' : h.id === 'BIRD' ? 'biological, no RF' : 'clutter / anomalous prop';
    b.innerHTML = h.label + '<small>' + tax + '</small>';
    b.onclick = () => chooseClass(h.id);
    box.appendChild(b);
  }
}

function buildEffectorButtons() {
  const box = $('#effectorButtons'); box.innerHTML = '';
  for (const e of S.pack.effectors) {
    const b = document.createElement('button');
    b.dataset.e = e.id; b.className = 'l' + e.level;
    b.innerHTML = '<span>' + e.label + '</span><span class="lv">L' + e.level + ' · ' + (e.range_m ? e.range_m + ' m' : '—') +
      (e.cost_inr ? ' · ' + fmtINR(e.cost_inr) : '') + '</span>';
    b.title = e.note || '';
    b.onclick = () => chooseEffector(e.id);
    box.appendChild(b);
  }
}

function buildMissionList() {
  const box = $('#missionList'); box.innerHTML = '';
  for (const m of S.missions) {
    const b = document.createElement('button');
    b.dataset.m = m.id;
    if (m.id === S.missionId) b.classList.add('on');
    b.innerHTML = '<b>' + m.id + ' · ' + m.name + '</b><span>' + m.brief + '</span>';
    b.onclick = () => { S.missionId = m.id; $$('#missionList button').forEach(x => x.classList.toggle('on', x === b)); };
    box.appendChild(b);
  }
}

function buildCustomPane() {
  const g = $('#customGrid'); g.innerHTML = '';
  const add = (key, label, items, idKey = 'id', labelKey = 'label') => {
    const l = document.createElement('label');
    l.innerHTML = label;
    const sel = document.createElement('select');
    for (const it of items) { const o = document.createElement('option'); o.value = it[idKey]; o.textContent = it[labelKey]; sel.appendChild(o); }
    sel.onchange = () => S.custom[key] = sel.value;
    S.custom[key] = items[0][idKey];
    l.appendChild(sel); g.appendChild(l);
  };
  add('terrainId', 'TERRAIN (Bhuvan/CartoDEM)', S.pack.terrain);
  add('lightId', 'LIGHT', S.pack.light);
  add('weatherId', 'WEATHER (IMD present-weather)', S.pack.weather);
  add('ewId', 'ELECTRONIC WARFARE', S.pack.ew_levels);
  add('zoneId', 'AIRSPACE ZONE (DGCA Digital Sky)', S.pack.airspace_zones.zones);
  const n1 = document.createElement('label'); n1.innerHTML = 'HOSTILE COUNT (swarm)';
  const i1 = document.createElement('input'); i1.type = 'number'; i1.min = 1; i1.max = 12; i1.value = 3;
  i1.onchange = () => S.custom.swarmSize = +i1.value; S.custom.swarmSize = 3;
  n1.appendChild(i1); g.appendChild(n1);
  const n2 = document.createElement('label'); n2.innerHTML = 'AMBIENT TRACKS (birds / civilian / own)';
  const i2 = document.createElement('input'); i2.type = 'number'; i2.min = 0; i2.max = 8; i2.value = 2;
  i2.onchange = () => S.custom.ambientCount = +i2.value; S.custom.ambientCount = 2;
  n2.appendChild(i2); g.appendChild(n2);
}

function bindUI() {
  $$('.tabs button').forEach(b => b.onclick = () => setView(b.dataset.view));
  $$('#modeSeg button').forEach(b => b.onclick = () => {
    S.mode = b.dataset.mode;
    $$('#modeSeg button').forEach(x => x.classList.toggle('on', x === b));
    $$('.pane').forEach(p => p.classList.remove('on'));
    $('#pane' + S.mode[0].toUpperCase() + S.mode.slice(1)).classList.add('on');
  });
  $('#btnStart').onclick = startSortie;
  $('#btnBench').onclick = showBench;
  $('#confSlider').oninput = (e) => { $('#confVal').textContent = e.target.value + '%'; };
  $('#opId').onchange = loadTrainee;
  $('#seatSel').onchange = (e) => { S.seat = e.target.value; applySeat(); toast('Seat: ' + e.target.value); };
  $('#disclaimer').querySelector('b').onclick = () => setView('prov');
  $$('.src').forEach(el => el.onclick = () => showSource(el.dataset.src));
  window.addEventListener('keydown', onKey);
  window.addEventListener('resize', resizeCanvases);
}

function setView(v) {
  $$('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.view === v));
  $$('.view').forEach(x => x.classList.toggle('on', x.id === 'view-' + v));
  if (v === 'unit') renderUnit();
  if (v === 'prov') renderProvenance();
}

function applySeat() {
  const r = $('.col.right');
  r.style.opacity = S.seat === 'C2' || S.seat === 'ENGAGE' ? '1' : '.42';
  $$('#effectorButtons button').forEach(b => b.disabled = !(S.seat === 'C2' || S.seat === 'ENGAGE'));
  $$('#classButtons button').forEach(b => b.disabled = !(S.seat === 'C2' || S.seat === 'SENSOR' || S.seat === 'EW'));
}

function onKey(e) {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  const keys = { '1': 'HOSTILE_UAV', '2': 'OWN_UAV', '3': 'CIVILIAN_DRONE', '4': 'BIRD', '5': 'NON_DRONE' };
  if (keys[e.key]) { chooseClass(keys[e.key]); return; }
  if (e.key === 'Tab') { e.preventDefault(); cycleTrack(); return; }
  const eff = { 'm': 'MONITOR', 'w': 'WARN', 'j': 'JAM', 'k': 'SPOOF', 'n': 'NET', 'g': 'GUN', 'l': 'LASER' };
  if (eff[e.key.toLowerCase()]) { chooseEffector(eff[e.key.toLowerCase()]); return; }
  if (e.key === ' ') { e.preventDefault(); S.speed = S.speed === 0 ? 1 : 0; toast(S.speed ? 'resumed' : 'paused'); }
}

// ================================================================= SORTIE
async function startSortie() {
  const body = { operatorId: S.operatorId, operatorName: S.operatorId, seat: S.seat, mode: S.mode };
  if (S.mode === 'scripted') { body.missionId = S.missionId; body.jitterSeed = 1 + Math.floor(Math.random() * 9999); }
  if (S.mode === 'custom') Object.assign(body, S.custom, { tier: 3, seed: (Math.random() * 0xffffffff) >>> 0 });
  if (S.mode === 'adaptive') body.seed = (Math.random() * 0xffffffff) >>> 0;

  $('#btnStart').disabled = true; $('#btnStart').textContent = 'BUILDING SORTIE…';
  try {
    const r = await api('/api/session', body);
    S.sessionId = r.sessionId; S.scenario = r.scenario; S.state = r.state; S.benchmarks = r.benchmarks;
    S.selected = null; S.result = null; S.rfHistory = []; S.lastLogLen = 0; S.pending = [];
    $('#setup').classList.add('hidden');
    setView('console'); applySeat();
    $('#missionLabel').textContent = describeScenario(r.scenario);
    toast('Sortie ' + r.scenario.fingerprintHash + (r.scenario.novel === false ? ' (REPEAT FINGERPRINT)' : ' · novel scenario'));
    startLoop();
  } catch (e) { toast('Failed: ' + e.message); }
  $('#btnStart').disabled = false; $('#btnStart').textContent = 'BEGIN SORTIE';
}

function describeScenario(sc) {
  return [sc.scripted || 'PROC', sc.terrain.label, sc.light.label, sc.weather.label, sc.ew.label, sc.zone.label + ' zone',
    'hostile×' + sc.swarmSize, 'ambient×' + sc.ambientCount, sc.populated ? 'POPULATED' : 'unpopulated',
    'seed ' + sc.seedHex, 'fp ' + sc.fingerprintHash].join(' · ');
}

let loopTimer = null;
function startLoop() {
  clearInterval(loopTimer);
  loopTimer = setInterval(tick, 250);
}
async function tick() {
  if (!S.sessionId || !S.state || S.state.finished || S.speed === 0) return;
  const inputs = S.pending.splice(0, S.pending.length);
  try {
    const r = await api('/api/tick', { sessionId: S.sessionId, inputs });
    S.state = r.state;
    render();
    if (S.state.finished) { clearInterval(loopTimer); await finishSortie(); }
  } catch (e) { /* keep the console alive on a dropped tick */ }
}

async function finishSortie() {
  const r = await api('/api/finish', { sessionId: S.sessionId });
  S.result = r.result; S.trainee = { model: null, next: r.result.nextSortie };
  renderAAR(r.result);
  renderUnit();
  toast('Sortie scored · net ' + r.result.net.toFixed(1) + '/100 · training gain ' +
    (r.result.trainingGain !== null ? Math.round(r.result.trainingGain * 100) + '%' : 'n/a'));
  setTimeout(() => setView('aar'), 700);
  $('#setup').classList.remove('hidden');
  if (r.result.nextSortie) {
    $('#directorRationale').innerHTML = '<b>AI Director.</b> ' + r.result.nextSortie.rationale;
  }
}

// ================================================================= ACTIONS
function chooseClass(h) {
  if (!S.selected) return toast('select a track first (Tab)');
  const conf = (+$('#confSlider').value) / 100;
  S.pending.push({ type: 'CLASSIFY', uid: S.selected, classification: h, confidence: conf });
  $$('#classButtons button').forEach(b => b.classList.toggle('sel', b.dataset.h === h));
  log('local', 'declare ' + h + ' @ ' + Math.round(conf * 100) + '% on ' + trackId(S.selected));
}

function chooseEffector(eid) {
  if (!S.selected) return toast('select a track first (Tab)');
  const eff = S.pack.effectors.find(e => e.id === eid);
  const trk = S.state.tracks.find(t => t.uid === S.selected);
  const conf = (+$('#confSlider').value) / 100;
  if (eff.level >= 3 && conf < S.pack.doctrine.confidence_threshold_engage) {
    if (!confirm('Declared confidence ' + Math.round(conf * 100) + '% is BELOW the doctrine engagement threshold of ' +
      Math.round(S.pack.doctrine.confidence_threshold_engage * 100) + '%.\n\nThis will be scored as a confidence-discipline failure. Engage anyway?')) return;
  }
  S.pending.push({ type: 'ENGAGE', uid: S.selected, effectorId: eid });
  $$('#effectorButtons button').forEach(b => b.classList.toggle('sel', b.dataset.e === eid));
  log('local', eff.label + ' → ' + trackId(S.selected) + ' (effect in ' + eff.effect_time_s + ' s)');
}

function cycleTrack() {
  const ts = S.state?.tracks || [];
  if (!ts.length) return;
  const i = ts.findIndex(t => t.uid === S.selected);
  S.selected = ts[(i + 1) % ts.length].uid;
  render();
}
const trackId = (uid) => (S.state?.tracks.find(t => t.uid === uid) || {}).id || uid;

function localLog(kind, text) {
  S.state.log.push({ t: S.state.t, kind, text });
  renderLog();
}
const log = localLog;

// ================================================================= RENDER
function render() {
  const st = S.state; if (!st) return;
  $('#clock').textContent = fmtT(st.t);
  $('#phaseLabel').textContent = st.finished ? 'sortie complete' : (S.speed === 0 ? 'held' : 'engaged');
  $('#trackCount').textContent = st.tracks.length;
  const breaches = (st.alive || []).filter(a => a.range_m <= (S.scenario?.defendedRadiusM || 400) && a.alive).length;
  const bEl = $('#breachCount'); bEl.textContent = breaches; bEl.className = breaches ? 'bad' : 'ok';
  const wl = st.workloadIndex || 0;
  $('#workloadVal').textContent = wl.toFixed(2);
  $('#workloadBar').style.width = Math.min(100, wl / 1.6 * 100) + '%';
  $('#workloadBar').style.background = wl > (S.pack.workload.w_max) ? 'var(--red)' : wl > 0.7 ? 'var(--amber)' : 'var(--cyan)';

  renderTracks(); renderBelief(); renderLedger(); renderLog();
  drawPPI(); drawRF(); drawEO();
  renderDoctrineHint();
  $('#rfMeta').textContent = 'sensitivity ' + S.pack.sensors.find(s => s.id === 'RF-1').params.sensitivity_dbm.value + ' dBm · fade margin applied';
  $('#radarMeta').textContent = 'Ku-band · Pd from the radar equation, not scripted';
}

function renderTracks() {
  const box = $('#trackTable');
  const st = S.state;
  if (!st.tracks.length) { box.innerHTML = '<div class="mini">no contacts. sensors are sweeping — detection emerges from the physics, it is never scripted.</div>'; $('#trackMeta').textContent = ''; return; }
  let h = '<table><thead><tr><th>TRK</th><th>CLASS</th><th>CONF</th><th>RNG</th><th>ALT</th><th>BELIEF</th><th>EFF</th></tr></thead><tbody>';
  for (const t of st.tracks) {
    const top = t.top || { hypothesis: 'NON_DRONE', value: 0 };
    const tag = HYP_TAG[top.hypothesis] || ['u', '?'];
    const alive = (st.alive || []).find(a => a.uid === t.uid);
    h += '<tr class="trk ' + (t.uid === S.selected ? 'sel ' : '') +
      (top.hypothesis === 'HOSTILE_UAV' ? 'hostile' : top.hypothesis === 'OWN_UAV' ? 'friendly' : 'unknown') +
      '" data-uid="' + t.uid + '">' +
      '<td>' + t.id + (alive && !alive.alive ? ' ✕' : '') + '</td>' +
      '<td><span class="tag ' + tag[0] + '">' + (t.label !== 'UNKNOWN' ? t.label.replace('_', ' ') : tag[1]) + '</span></td>' +
      '<td>' + (t.confidence ? Math.round(t.confidence * 100) + '%' : '—') + '</td>' +
      '<td>' + (t.range_m ? t.range_m.toFixed(0) + 'm' : '—') + '</td>' +
      '<td>' + (t.alt_m ? t.alt_m.toFixed(0) + 'm' : '—') + '</td>' +
      '<td>' + (top.value * 100).toFixed(0) + '% <span class="dim">H=' + (t.entropy ?? 0).toFixed(2) + '</span></td>' +
      '<td class="eng">' + (t.effector || '') + '</td></tr>';
  }
  box.innerHTML = h + '</tbody></table>';
  $$('#trackTable tr.trk').forEach(tr => tr.onclick = () => { S.selected = tr.dataset.uid; render(); });
  $('#trackMeta').textContent = st.tracks.length + ' tracks · Tab to cycle';
  if (!S.selected && st.tracks.length) S.selected = st.tracks[0].uid;
  $('#confSlider').disabled = !S.selected;
  if (!S.selected) $('#confVal').textContent = '—';
  else $('#confVal').textContent = $('#confSlider').value + '%';
}

function renderBelief() {
  const box = $('#beliefBars');
  const trk = (S.state?.tracks || []).find(t => t.uid === S.selected);
  if (!trk || !trk.belief) { box.innerHTML = ''; $('#ledger').innerHTML = '<div class="mini">select a track</div>'; return; }
  box.innerHTML = HYP.map(h => {
    const v = (trk.belief[h.id] || 0) * 100;
    return '<div class="bel ' + h.cls + '"><div class="k"><span>' + h.label + '</span><b>' + v.toFixed(0) + '%</b></div>' +
      '<div class="bar"><i style="width:' + v.toFixed(1) + '%"></i></div></div>';
  }).join('');
}

function renderLedger() {
  const box = $('#ledger');
  const trk = (S.state?.tracks || []).find(t => t.uid === S.selected);
  if (!trk) { box.innerHTML = ''; return; }
  // The full ledger lives in the AAR; live we show the most recent evidence.
  const entries = (trk.evidence || []).slice(-40).reverse();
  if (!entries.length) { box.innerHTML = '<div class="mini">no evidence logged yet on this track</div>'; return; }
  box.innerHTML = entries.map(e => {
    const d = e.delta?.HOSTILE_UAV;
    const dtxt = d === undefined ? '' : (d >= 0 ? '+' : '') + (d * 100).toFixed(0) + '% H';
    return '<div class="ev ' + (e.detected ? '' : 'neg') + '"><span class="t">' + fmtT(e.t) + '</span>' +
      '<span class="s">' + e.sensor + '</span><span class="d">' + e.text + ' <span class="delta ' + (d < 0 ? 'minus' : '') + '">' + dtxt + '</span></span></div>';
  }).join('');
}

function renderLog() {
  const box = $('#eventLog'); const lg = S.state?.log || [];
  if (lg.length === S.lastLogLen) return;
  S.lastLogLen = lg.length;
  box.innerHTML = lg.slice(-90).reverse().map(l =>
    '<div><span class="t">' + fmtT(l.t) + '</span><span class="k-' + l.kind + '">' + l.kind + '</span><span>' + l.text + '</span></div>').join('');
}

function renderDoctrineHint() {
  const box = $('#doctrineHint');
  const trk = (S.state?.tracks || []).find(t => t.uid === S.selected);
  if (!trk) { box.innerHTML = '<span class="dim">Select a track to see the doctrinal picture.</span>'; return; }
  const top = trk.top || { hypothesis: 'NON_DRONE', value: 0 };
  const eng = S.pack.doctrine.confidence_threshold_engage;
  const warn = S.pack.doctrine.confidence_threshold_warn;
  let advice;
  if (top.value < warn) advice = ['rc-info', 'BELOW WARN THRESHOLD', 'Evidence is not decisive. Keep sensors on the track; do not escalate. Declaring a class now will hurt your calibration score.'];
  else if (top.value < eng) advice = ['rc-info', 'WARN BAND', 'Enough to warn and cue, not enough to engage. Minimum sufficient force is a warning, or hold.'];
  else advice = ['rc-ok', 'ENGAGEMENT BAND', 'Belief clears the doctrine threshold. Now choose the MINIMUM SUFFICIENT effector — check the envelope, the corridor and the zone first.'];
  const sc = S.scenario;
  box.innerHTML = '<span class="rc ' + advice[0] + '">' + advice[1] + '</span> ' + advice[2] +
    '<br><span class="dim">zone <b>' + sc.zone.label + '</b>' + (sc.zone.engagement_authorised ? '' : ' — kinetic PROHIBITED') +
    ' · ground ' + (sc.populated ? '<b style="color:var(--red)">POPULATED</b> — AD gun prohibited' : 'unpopulated') + '</span>';
}

// ================================================================= CANVAS
function resizeCanvases() {
  for (const id of ['ppi', 'rfw', 'eo']) {
    const c = $('#' + id); if (!c) continue;
    const w = c.clientWidth; if (!w) continue;
    const ratio = c.height / c.width;
    c.width = Math.round(w * devicePixelRatio);
    c.height = Math.round(w * ratio * devicePixelRatio);
  }
  drawPPI(); drawRF(); drawEO();
}

function drawPPI() {
  const c = $('#ppi'); if (!c || !S.state) return;
  const g = c.getContext('2d'); const W = c.width, H = c.height, R = Math.min(W, H) / 2 - 6;
  g.clearRect(0, 0, W, H);
  g.fillStyle = '#070b10'; g.fillRect(0, 0, W, H);
  const cx = W / 2, cy = H / 2, maxR = 6000;

  g.strokeStyle = '#16202c'; g.lineWidth = 1;
  for (const r of [1000, 2000, 3000, 4000, 5000]) {
    g.beginPath(); g.arc(cx, cy, r / maxR * R, 0, 7); g.stroke();
    g.fillStyle = '#2b3a4a'; g.font = (9 * devicePixelRatio) + 'px monospace';
    g.fillText(r / 1000 + 'k', cx + 3, cy - r / maxR * R - 3);
  }
  for (let a = 0; a < 360; a += 30) {
    const rad = a * Math.PI / 180;
    g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.sin(rad) * R, cy - Math.cos(rad) * R); g.stroke();
  }
  // defended area
  const dr = (S.scenario?.defendedRadiusM || 400) / maxR * R;
  g.strokeStyle = '#3ddc8455'; g.setLineDash([4, 3]);
  g.beginPath(); g.arc(cx, cy, Math.max(dr, 4), 0, 7); g.stroke(); g.setLineDash([]);

  // sweep
  const sweep = (S.state.t * 1.6) % (Math.PI * 2);
  const grad = g.createConicGradient ? null : null;
  g.save(); g.translate(cx, cy); g.rotate(sweep);
  const lg = g.createLinearGradient(0, 0, R, 0);
  lg.addColorStop(0, 'rgba(57,194,215,0.22)'); lg.addColorStop(1, 'rgba(57,194,215,0)');
  g.fillStyle = lg; g.beginPath(); g.moveTo(0, 0); g.arc(0, 0, R, -0.35, 0); g.closePath(); g.fill();
  g.restore();

  // contacts - the operator sees TRACKS only, never raw ground truth
  for (const t of S.state.tracks) {
    if (t.range_m == null) continue;
    const rr = t.range_m / maxR * R;
    const x = cx + Math.sin(t.bearing) * rr, y = cy - Math.cos(t.bearing) * rr;
    const hostile = (t.top?.hypothesis === 'HOSTILE_UAV');
    const own = (t.top?.hypothesis === 'OWN_UAV');
    const alive = (S.state.alive || []).find(a => a.uid === t.uid);
    g.strokeStyle = !alive || !alive.alive ? '#4a5a6a' : hostile ? '#ff4d4f' : own ? '#39c2d7' : '#8b9bad';
    g.lineWidth = 1.6 * devicePixelRatio;
    g.beginPath(); g.arc(x, y, 5 * devicePixelRatio, 0, 7); g.stroke();
    if (t.uid === S.selected) { g.strokeStyle = '#f0a202'; g.strokeRect(x - 9 * devicePixelRatio, y - 9 * devicePixelRatio, 18 * devicePixelRatio, 18 * devicePixelRatio); }
    g.fillStyle = g.strokeStyle; g.font = (9 * devicePixelRatio) + 'px monospace';
    g.fillText(t.id, x + 8 * devicePixelRatio, y - 6 * devicePixelRatio);
  }
  g.fillStyle = '#39c2d7'; g.font = 'bold ' + (9 * devicePixelRatio) + 'px monospace';
  g.fillText('OWN POSITION', cx - 34 * devicePixelRatio, cy + 13 * devicePixelRatio);
}

function drawRF() {
  const c = $('#rfw'); if (!c || !S.state) return;
  const g = c.getContext('2d'); const W = c.width, H = c.height;
  // push one waterfall row per render
  const bands = 48;
  const row = new Array(bands).fill(0);
  for (const a of S.state.alive || []) {
    const trk = S.state.tracks.find(t => t.uid === a.uid);
    if (!trk) continue;
    // a band position derived from the track so the picture is stable
    let h = 0; for (const ch of a.uid) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const band = h % bands;
    const strength = Math.max(0, 1 - a.range_m / 3000);
    row[band] = Math.max(row[band], strength);
    row[Math.min(bands - 1, band + 1)] = Math.max(row[Math.min(bands - 1, band + 1)], strength * 0.5);
  }
  S.rfHistory.unshift(row); if (S.rfHistory.length > 46) S.rfHistory.pop();

  g.fillStyle = '#070b10'; g.fillRect(0, 0, W, H);
  const bh = H / 46, bw = W / bands;
  for (let y = 0; y < S.rfHistory.length; y++) {
    for (let x = 0; x < bands; x++) {
      const v = S.rfHistory[y][x]; if (v <= 0.02) continue;
      g.fillStyle = 'rgba(57,194,215,' + Math.min(1, v).toFixed(2) + ')';
      g.fillRect(x * bw, y * bh, bw - 1, bh - 0.5);
    }
  }
  g.fillStyle = '#2b3a4a'; g.font = (8 * devicePixelRatio) + 'px monospace';
  g.fillText('433 MHz', 3, H - 4); g.fillText('2.4 GHz', W * 0.4, H - 4); g.fillText('5.8 GHz', W * 0.78, H - 4);
  $('#rfLegend').innerHTML = 'A silent waterfall is <b style="color:var(--red)">not</b> an empty sky — a fibre-optic FPV emits nothing at all.';
}

function drawEO() {
  const c = $('#eo'); if (!c || !S.state) return;
  const g = c.getContext('2d'); const W = c.width, H = c.height;
  const trk = (S.state.tracks || []).find(t => t.uid === S.selected);
  const light = S.scenario?.light || { id: 'DAY', visible_contrast: 1, ir_contrast: .5 };
  const wx = S.scenario?.weather || { visibility_m: 20000 };

  // background: sky/ground split, hazed by the IMD visibility
  const haze = Math.min(0.85, 1 - Math.min(1, wx.visibility_m / 20000));
  const skyTop = light.id === 'NIGHT' ? '#05070c' : light.id === 'DUSK' ? '#2a1a20' : '#3d5a72';
  const grd = g.createLinearGradient(0, 0, 0, H);
  grd.addColorStop(0, skyTop); grd.addColorStop(0.62, light.id === 'NIGHT' ? '#0a0d13' : '#5d6a52'); grd.addColorStop(1, '#2b2f22');
  g.fillStyle = grd; g.fillRect(0, 0, W, H);
  g.fillStyle = 'rgba(180,190,200,' + (haze * 0.5).toFixed(2) + ')'; g.fillRect(0, 0, W, H);

  if (!trk) { g.fillStyle = '#6c7f92'; g.font = (11 * devicePixelRatio) + 'px monospace'; g.fillText('NO TARGET CUED', 12, H / 2); return; }

  // Apparent angular size straight from the geometry: pixels across the target
  // on the focal plane. The same number drives the Johnson-criteria Pd/Pcls/Pid
  // in the engine, so what the operator sees is what the physics computed.
  const p = S.pack.sensors.find(s => s.id === 'EO-1').params;
  const ifov = (p.sensor_width_mm.value / (p.focal_length_mm.value * p.px_horizontal.value)) * 1000; // mrad per pixel
  const rangeM = Math.max(trk.range_m || 1, 1);
  const pxAcross = trk.size_m ? (trk.size_m * 1000) / (ifov * rangeM) : 0;
  const tau = Math.exp(-(3.912 / Math.max(wx.visibility_m, 30)) * rangeM);
  const night = light.id === 'NIGHT';
  const contrast = light.crossover ? light.ir_contrast : (night ? light.ir_contrast : light.visible_contrast);
  const effPx = pxAcross * tau * Math.max(0.02, Math.min(1, contrast));

  // Target blob, scaled by the TRUE apparent pixel size, dimmed by transmission.
  const pxScale = (W / p.px_horizontal.value) * devicePixelRatio;
  const blobR = Math.max(1.2, effPx * pxScale * 0.5);
  const alpha = Math.min(0.95, 0.25 + effPx / 12);
  g.save();
  g.translate(W / 2, H / 2);
  g.fillStyle = night ? 'rgba(255,255,255,' + alpha.toFixed(2) + ')' : 'rgba(12,14,18,' + alpha.toFixed(2) + ')';
  if (trk.size_m && trk.size_m > 1.6) {           // fixed-wing silhouette
    g.fillRect(-blobR * 3, -blobR * 0.35, blobR * 6, blobR * 0.7);
    g.fillRect(-blobR * 0.4, -blobR * 1.6, blobR * 0.8, blobR * 3.2);
  } else {                                        // multirotor silhouette
    g.beginPath(); g.arc(0, 0, blobR, 0, 7); g.fill();
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI / 2 + Math.PI / 4;
      g.beginPath(); g.arc(Math.cos(a) * blobR * 2.1, Math.sin(a) * blobR * 2.1, blobR * 0.85, 0, 7); g.fill();
    }
  }
  g.restore();

  // reticle
  g.strokeStyle = 'rgba(240,162,2,.75)'; g.lineWidth = 1.2 * devicePixelRatio;
  g.beginPath(); g.arc(W / 2, H / 2, 34 * devicePixelRatio, 0, 7); g.stroke();
  g.beginPath(); g.moveTo(W / 2 - 46 * devicePixelRatio, H / 2); g.lineTo(W / 2 - 20 * devicePixelRatio, H / 2);
  g.moveTo(W / 2 + 20 * devicePixelRatio, H / 2); g.lineTo(W / 2 + 46 * devicePixelRatio, H / 2);
  g.moveTo(W / 2, H / 2 - 46 * devicePixelRatio); g.lineTo(W / 2, H / 2 - 20 * devicePixelRatio);
  g.moveTo(W / 2, H / 2 + 20 * devicePixelRatio); g.lineTo(W / 2, H / 2 + 46 * devicePixelRatio); g.stroke();

  g.fillStyle = '#dce6f0'; g.font = (10 * devicePixelRatio) + 'px monospace';
  g.fillText('TRK ' + trk.id + '  RNG ' + (trk.range_m || 0).toFixed(0) + ' m  ALT ' + (trk.alt_m || 0).toFixed(0) + ' m', 10, 16 * devicePixelRatio);
  g.fillText(wx.label.toUpperCase() + ' · vis ' + wx.visibility_m + ' m · ' + light.label.toUpperCase() +
    (light.crossover ? ' · THERMAL CROSSOVER' : ''), 10, 30 * devicePixelRatio);
  g.fillStyle = effPx >= p.px_required_id.value ? '#3ddc84' : effPx >= p.px_required_class.value ? '#f0a202' : '#ff4d4f';
  g.fillText('effective ' + effPx.toFixed(1) + ' px across  (τ=' + tau.toFixed(3) + ')', 10, 44 * devicePixelRatio);
  g.fillStyle = '#6c7f92';
  g.fillText(trk.hostile_rf ? 'RF link present on this track' : 'NO RF EMITTER on this track', 10, 58 * devicePixelRatio);
  $('#eoMeta').innerHTML = 'Johnson criteria — classify needs <b>' + p.px_required_class.value +
    '</b> px across the target, identify needs <b>' + p.px_required_id.value +
    '</b>. Transmission τ follows Koschmieder\'s law on the <b>IMD</b> visibility. ' +
    (effPx < p.px_required_class.value
      ? '<span style="color:var(--red)">Below the classification threshold — you cannot call a class off this sensor right now.</span>'
      : effPx < p.px_required_id.value
        ? '<span style="color:var(--amber)">Enough to classify, not enough to identify.</span>'
        : '<span style="color:var(--green)">Identification grade.</span>');
}

// ================================================================= AAR
function renderAAR(r) {
  $('#aarEmpty').classList.add('hidden');
  const body = $('#aarBody'); body.classList.remove('hidden');
  const comp = (c) => {
    const pct = c.score / c.max * 100;
    const cls = pct >= 75 ? '' : pct >= 45 ? 'mid' : 'low';
    return '<div class="comprow"><span class="n">' + c.label + '</span>' +
      '<div class="cbar"><i class="' + cls + '" style="width:' + pct.toFixed(1) + '%"></i></div>' +
      '<span class="val">' + c.score.toFixed(1) + ' / ' + c.max + '</span></div>' +
      '<div class="comprow" style="grid-template-columns:1fr"><span class="dim" style="font-size:9.5px">' + (c.detail || '') + '</span></div>';
  };
  const rcRows = Object.entries(r.rootCauses).sort((a, b) => b[1] - a[1]).map(([k, v]) =>
    '<tr><td><span class="pill ' + (k === 'CORRECT' ? 'ok' : 'no') + '">' + k + '</span></td><td>' + v + '</td><td class="dim">' +
    ({ UNDETECTED: 'Never detected — sensor posture / scan strategy', CLASSIFICATION: 'Detected, wrong class',
      IDENTIFICATION: 'Right class, wrong hostile/friendly call', DOCTRINE: 'Right picture, wrong effector or escalation',
      SITUATION: 'Airspace / deconfliction awareness', TIMING: 'Everything right, too late',
      NO_DECISION: 'No decision before the threat resolved', CORRECT: 'Doctrinally correct' }[k] || '') + '</td></tr>').join('');

  const evRows = r.events.map(e => {
    const rc = e.rootCause;
    return '<tr><td>' + e.uid + '</td><td>' + e.defLabel + '</td>' +
      '<td><span class="tag ' + (HYP_TAG[e.groundTruth.category] || ['u'])[0] + '">' + e.groundTruth.category.replace('_', ' ') + '</span></td>' +
      '<td>' + (e.detectedT === null ? '<span class="pill no">never</span>' : fmtT(e.detectedT)) + '</td>' +
      '<td>' + (e.actionableT === null ? '<span class="pill mid">no</span>' : fmtT(e.actionableT)) + '</td>' +
      '<td>' + (e.traineeClassification ? e.traineeClassification.replace('_', ' ') : '—') + '</td>' +
      '<td>' + (e.declaredConfidence === null ? '—' : Math.round(e.declaredConfidence * 100) + '%') + '</td>' +
      '<td>' + (e.action || '—') + '</td><td>' + (e.idealEffector || '—') + '</td>' +
      '<td><span class="pill ' + (rc === 'CORRECT' ? 'ok' : rc === 'TIMING' ? 'mid' : 'no') + '">' + rc + '</span></td>' +
      '<td>' + (e.neutralised ? '<span class="pill ok">neutralised</span>' : e.groundTruth.category === 'HOSTILE_UAV' ? '<span class="pill no">survived</span>' : '<span class="pill info">—</span>') + '</td></tr>';
  }).join('');

  const penRows = r.penalties.rows.length
    ? r.penalties.rows.map(p => '<tr><td><span class="pill no">' + p.type + '</span></td><td>−' + p.amount + '</td><td class="dim">' + p.detail + '</td></tr>').join('')
    : '<tr><td colspan="3" class="dim">No penalties. Clean sortie.</td></tr>';

  body.innerHTML = `
  <div class="cards">
    <div class="card ${r.net >= 70 ? 'good' : r.net >= 45 ? 'warn' : 'bad'}"><label>NET SCORE</label><div class="v">${r.net.toFixed(1)}</div><div class="s">gross ${r.gross.toFixed(1)} − penalties ${r.penalties.total}</div></div>
    <div class="card ${r.trainingGain >= .6 ? 'good' : r.trainingGain >= .3 ? 'warn' : 'bad'}"><label>TRAINING GAIN</label><div class="v">${r.trainingGain === null ? '—' : Math.round(r.trainingGain * 100) + '%'}</div><div class="s">normalised between the random-bot floor (${r.benchmarks?.random ?? '—'}) and the exemplar-bot ceiling (${r.benchmarks?.exemplar ?? '—'})</div></div>
    <div class="card ${r.escalation.eei >= .8 ? 'good' : 'warn'}"><label>ESCALATION ECONOMY</label><div class="v">${r.escalation.eei.toFixed(2)}</div><div class="s">minimum sufficient force ÷ force used. 1.00 = perfectly economical</div></div>
    <div class="card ${r.costOfExchange.ratio === null ? '' : r.costOfExchange.ratio <= 1 ? 'good' : 'bad'}"><label>COST OF EXCHANGE</label><div class="v">${r.costOfExchange.ratio === null ? '∞' : r.costOfExchange.ratio.toFixed(2)}</div><div class="s">${fmtINR(r.costOfExchange.spent)} expended against ${fmtINR(r.costOfExchange.threatValue)} of threat</div></div>
    <div class="card ${r.calibration.brier !== null && r.calibration.brier <= .15 ? 'good' : 'warn'}"><label>CALIBRATION</label><div class="v">${r.calibration.brier === null ? '—' : r.calibration.brier.toFixed(3)}</div><div class="s">Brier score. ${r.calibration.detail}</div></div>
    <div class="card"><label>PHYSICS FLOOR</label><div class="v">${r.meta.physicsFloorS.toFixed(1)}s</div><div class="s">earliest the sensors could have reached Pd 0.8 — computed, not guessed</div></div>
  </div>

  <div class="two">
    <div class="sect"><h3>SCORE VECTOR</h3><div class="body">${r.components.map(comp).join('')}</div></div>
    <div class="sect"><h3>ROOT-CAUSE ATTRIBUTION (dual-path scoring)</h3><div class="body">
      <table class="tbl"><thead><tr><th>CAUSE</th><th>N</th><th>WHAT IT MEANS</th></tr></thead><tbody>${rcRows}</tbody></table>
    </div></div>
  </div>

  <div class="two">
    <div class="sect"><h3>RELIABILITY DIAGRAM — declared confidence vs actual correctness</h3><div class="body">${reliabilitySVG(r.reliability)}</div></div>
    <div class="sect"><h3>PENALTY LEDGER</h3><div class="body">
      <table class="tbl"><thead><tr><th>EVENT</th><th>MARKS</th><th>DETAIL</th></tr></thead><tbody>${penRows}</tbody></table>
    </div></div>
  </div>

  <div class="sect"><h3>PER-TRACK ADJUDICATION — ground truth against what you reported</h3><div class="body" style="overflow:auto">
    <table class="tbl"><thead><tr><th>TRK</th><th>PLATFORM</th><th>TRUTH</th><th>ACQUIRED</th><th>ACTIONABLE</th>
    <th>YOU SAID</th><th>CONF</th><th>YOU DID</th><th>DOCTRINE</th><th>ROOT CAUSE</th><th>OUTCOME</th></tr></thead><tbody>${evRows}</tbody></table>
  </div></div>

  <div class="two">
    <div class="sect"><h3>WORKLOAD PROFILE (NASA-TLX grounded)</h3><div class="body">
      ${r.workload ? `peak ${r.workload.peak.toFixed(2)} · mean ${r.workload.mean.toFixed(2)} · overloaded ${r.workload.pctOverloaded.toFixed(0)}% of the sortie above the ${r.workload.threshold} threshold` : 'no samples'}
      <div class="dim" style="margin-top:6px">Axes captured after every sortie: ${r.workload ? r.workload.axes.join(' · ') : ''}</div>
    </div></div>
    <div class="sect"><h3>ANTI-ROTE CHECK</h3><div class="body">
      ${r.meta.rote?.suspected
        ? '<span class="pill no">ROTE SUSPECTED</span> ' + r.meta.rote.suspects.length + ' reaction(s) faster than the physics floor — the scenario will be mutated.'
        : '<span class="pill ok">CLEAR</span> No reaction faster than the physics floor. You were reading your sensors, not recalling the sortie.'}
    </div></div>
  </div>

  <div class="sect"><h3>SORTIE CERTIFICATE — tamper-evident</h3><div class="body cert">
    scenario seed <b>${r.meta.seedHex}</b> · fingerprint <b>${r.meta.fingerprintHash}</b>${r.meta.novel ? '' : ' <span class="pill no">REPEAT</span>'}<br>
    conditions ${r.meta.terrainId} / ${r.meta.lightId} / ${r.meta.weatherId} / ${r.meta.ewId} / ${r.meta.zoneId} · hostile×${r.meta.swarmSize} ambient×${r.meta.ambientCount} · ${r.meta.threatMix}<br>
    data pack <b>${S.pack.pack.version}</b> · engine <b>1.0.0</b> · issued ${new Date(r.certificate.issuedAt).toISOString()}<br>
    SHA-256 <b>${r.certificate.hash}</b>
  </div></div>
  `;
}

function reliabilitySVG(bins) {
  const W = 460, H = 190, P = 30;
  const sx = (i) => P + i * (W - P * 2) / bins.length;
  const sy = (v) => H - P - v * (H - P * 2);
  let bars = '';
  bins.forEach((b, i) => {
    if (!b.n) return;
    const x = sx(i), w = (W - P * 2) / bins.length - 3;
    bars += `<rect x="${x}" y="${sy(b.actual)}" width="${w}" height="${H - P - sy(b.actual)}" fill="#39c2d7" opacity=".75"/>`;
    bars += `<rect x="${x}" y="${sy(b.declared)}" width="${w}" height="2" fill="#f0a202"/>`;
  });
  return `<svg class="chart" viewBox="0 0 ${W} ${H}">
    <line x1="${P}" y1="${H - P}" x2="${W - P}" y2="${H - P}" stroke="#22303f"/>
    <line x1="${P}" y1="${P / 2}" x2="${P}" y2="${H - P}" stroke="#22303f"/>
    <line x1="${P}" y1="${H - P}" x2="${W - P}" y2="${P / 2}" stroke="#6c7f92" stroke-dasharray="4 4"/>
    ${bars}
    <text x="${W / 2}" y="${H - 6}" fill="#6c7f92" font-size="10" text-anchor="middle" font-family="monospace">declared confidence</text>
    <text x="10" y="${H / 2}" fill="#6c7f92" font-size="10" font-family="monospace" transform="rotate(-90 12 ${H / 2})">actual</text>
    <text x="${W - P}" y="${P / 2 - 4}" fill="#f0a202" font-size="9" text-anchor="end" font-family="monospace">amber = declared</text>
  </svg>`;
}

// ================================================================= UNIT
function renderUnit() {
  const box = $('#unitBody'); if (!box) return;
  const m = S.trainee?.model;
  if (!m) {
    box.innerHTML = '<div class="sect"><h3>UNIT READINESS</h3><div class="body">Enter an operator ID on the CONSOLE to open a trainee record.</div></div>';
    return;
  }
  const skills = Object.entries(m.skills).sort((a, b) => a[1].p - b[1].p);
  const rows = skills.map(([id, s]) => {
    const pct = s.p * 100;
    return '<div class="comprow"><span class="n">' + id.replace(/_/g, ' ').toLowerCase() + '</span>' +
      '<div class="cbar"><i class="' + (pct >= 75 ? '' : pct >= 45 ? 'mid' : 'low') + '" style="width:' + pct.toFixed(1) + '%"></i></div>' +
      '<span class="val">' + pct.toFixed(0) + '% <span class="dim">n=' + s.n + '</span></span></div>';
  }).join('');
  const sess = (m.sessions || []).slice(-12).map((s, i) =>
    '<tr><td>' + (i + 1) + '</td><td>' + (s.net ?? 0).toFixed(1) + '</td><td>' +
    (s.trainingGain === null || s.trainingGain === undefined ? '—' : Math.round(s.trainingGain * 100) + '%') + '</td><td>' +
    (s.seed ? '0x' + s.seed.toString(16).toUpperCase() : '—') + '</td><td class="dim">' +
    Object.entries(s.rootCauses || {}).filter(([k]) => k !== 'CORRECT').map(([k, v]) => k + '×' + v).join(', ') || 'clean' + '</td></tr>').join('');

  box.innerHTML = `
  <div class="cards">
    <div class="card"><label>OPERATOR</label><div class="v" style="font-size:15px">${m.id}</div><div class="s">${(m.sessions || []).length} sorties recorded</div></div>
    <div class="card"><label>MEAN MASTERY</label><div class="v">${(skills.reduce((s, [, v]) => s + v.p, 0) / skills.length * 100).toFixed(0)}%</div><div class="s">across ${skills.length} skill nodes</div></div>
    <div class="card ${S.trainee.next ? 'warn' : ''}"><label>DIRECTOR TARGET</label><div class="v" style="font-size:14px">${S.trainee.next ? S.trainee.next.targeting.label : '—'}</div><div class="s">${S.trainee.next ? 'tier ' + S.trainee.next.tier : ''}</div></div>
  </div>
  <div class="sect"><h3>SKILL MASTERY (Bayesian Knowledge Tracing) — weakest first</h3><div class="body">${rows}</div></div>
  <div class="sect"><h3>SESSION HISTORY</h3><div class="body"><table class="tbl"><thead><tr><th>#</th><th>NET</th><th>GAIN</th><th>SEED</th><th>NON-CORRECT ROOT CAUSES</th></tr></thead><tbody>${sess || '<tr><td colspan="5" class="dim">no sorties yet</td></tr>'}</tbody></table></div></div>
  <div class="sect"><h3>WHAT THE DIRECTOR WILL DO NEXT</h3><div class="body">${S.trainee.next ? S.trainee.next.rationale : '—'}</div></div>`;
}

// ================================================================= PROVENANCE
function renderProvenance() {
  const box = $('#provBody'); if (!box || !S.prov) return;
  const s = S.prov.summary;
  const rows = Object.entries(S.prov.sources).map(([id, v]) => {
    const gov = /^G/.test(id);
    return '<tr><td class="id">' + id + '</td>' +
      '<td><b>' + v.org + '</b><br><span class="dim">' + v.doc + '</span><br><a href="' + v.url + '" target="_blank" rel="noreferrer">' + v.url + '</a>' +
      (v.note ? '<br><span class="dim">' + v.note + '</span>' : '') +
      (v.reverify ? '<br><span class="pill mid">RE-VERIFY BEFORE SUBMISSION</span>' : '') + '</td>' +
      '<td><span class="cls ' + (gov ? 'gov' : 'open') + '">' + v.class + '</span></td>' +
      '<td class="dim">' + (S.prov.counts[id] || 0) + '</td></tr>';
  }).join('');
  box.innerHTML = `
  <div class="cards">
    <div class="card good"><label>GOVT OF INDIA SOURCES</label><div class="v">${s.govtSources}</div><div class="s">${s.govtParams} parameters</div></div>
    <div class="card"><label>OPEN RESEARCH SOURCES</label><div class="v">${s.openSources}</div><div class="s">${s.openParams} parameters</div></div>
    <div class="card bad"><label>TEAM ASSUMPTIONS</label><div class="v">${s.assumptions}</div><div class="s">flagged red wherever they appear</div></div>
    <div class="card"><label>DATA PACK</label><div class="v">v${S.pack.pack.version}</div><div class="s">${S.pack.pack.generated}</div></div>
  </div>
  <div class="sect"><h3>DATA SOURCE REGISTER — every parameter in the simulator resolves to one of these</h3>
    <div class="body"><table class="tbl srcTable"><thead><tr><th>ID</th><th>SOURCE</th><th>CLASS</th><th>PARAMS</th></tr></thead><tbody>${rows}</tbody></table></div>
  </div>
  <div class="sect"><h3>GOVERNANCE RULES</h3><div class="body" style="line-height:1.7">
    1. <b>Nothing classified.</b> Public, published material only — no operational ROE, no real effector parameters, no unit locations.<br>
    2. <b>Every number has a record.</b> id · param · value · unit · source · url · accessed date · confidence class · used-in list.<br>
    3. <b>Data is separate from code.</b> The pack is a versioned JSON bundle with a SHA-256 manifest. A Services-validated pack drops in with no code change.<br>
    4. <b>Assumptions are shown in red.</b> Anything the team assumed rather than sourced is visible as an assumption, never presented as fact.<br>
    5. <b>90-day refresh cycle.</b> Every sortie certificate records the pack version it ran against.<br>
    6. <b>Training-only boundary.</b> Abstract effectors, no weapon interface, no targeting solution, no integration with any physical system.
  </div></div>
  <div class="sect"><h3>WHERE THE AI IS — AND WHERE IT ISN'T</h3><div class="body">
    <table class="tbl"><thead><tr><th>LAYER</th><th>AI?</th><th>WHY</th></tr></thead><tbody>
    <tr><td>Sensor physics</td><td><span class="pill ok">NO — deterministic</span></td><td class="dim">Radar equation, RF link budget, Johnson criteria, Koschmieder transmission. Reproducible and auditable.</td></tr>
    <tr><td>Scenario content</td><td><span class="pill ok">NO — seeded</span></td><td class="dim">Forked seeded RNG plus government-derived distributions. No generative content.</td></tr>
    <tr><td>Threat library</td><td><span class="pill ok">NO — data-driven</span></td><td class="dim">DGCA / DRDO / BEL / MoD sources.</td></tr>
    <tr><td>AAR debrief text</td><td><span class="pill ok">NO — rule-based</span></td><td class="dim">Every sentence traces to a scored event. No LLM, so nothing can be hallucinated.</td></tr>
    <tr><td>Imagery</td><td><span class="pill ok">NO — procedural</span></td><td class="dim">Parametric silhouettes and shaders. No AI-generated images, no copyrighted photos.</td></tr>
    <tr><td>Adaptive difficulty</td><td><span class="pill info">YES</span></td><td class="dim">Bayesian Knowledge Tracing over 20 skill nodes picks the next sortie.</td></tr>
    <tr><td>Red-Force swarm</td><td><span class="pill info">YES</span></td><td class="dim">Saturation, wedge, decoy-screen, flanker roles; autonomous fallback under jamming.</td></tr>
    <tr><td>Skill-gap prediction</td><td><span class="pill info">YES</span></td><td class="dim">Confusion matrix and mastery trend predict the next likely failure mode.</td></tr>
    <tr><td>Human–AI teaming drill</td><td><span class="pill info">YES</span></td><td class="dim">An ATR aid proposes a class with a confidence; the trainee is scored on appropriate reliance.</td></tr>
    </tbody></table>
    <p style="margin:10px 0 0;font-size:12px"><b>AI-Enabled, AI-Honest:</b> AI decides <i>what you practise next</i>. It never decides <i>what is true</i>.</p>
  </div></div>`;
}

function showSource(id) {
  const v = S.prov?.sources?.[id];
  if (!v) return toast('no source record for ' + id);
  alert(id + ' — ' + v.org + '\n\n' + v.doc + '\n' + v.url + '\n\nclass: ' + v.class + '\naccessed: ' + v.accessed + '\n\n' + (v.note || ''));
}

async function showBench() {
  const out = $('#benchOut'); out.textContent = 'computing…';
  try {
    const c = await api('/api/calibration');
    let t = c.note + '\n\n' + 'THREAT'.padEnd(30) + 'RADAR'.padEnd(9) + 'RF'.padEnd(9) + 'EO/IR'.padEnd(9) + 'ACOUSTIC\n';
    for (const r of c.rows) {
      t += r.label.slice(0, 29).padEnd(30) +
        String(r.ranges['RADAR-1'] ?? 'none').padEnd(9) + String(r.ranges['RF-1'] ?? 'none').padEnd(9) +
        String(r.ranges['EO-1'] ?? 'none').padEnd(9) + String(r.ranges['ACO-1'] ?? 'none').padEnd(9) + '\n';
    }
    t += '\nMISSION BENCHMARKS (headless bots)\n';
    for (const m of c.missions) t += m.id.padEnd(5) + m.name.slice(0, 38).padEnd(40) + 'exemplar ' + String(m.exemplar).padStart(5) + '  random ' + String(m.random).padStart(5) + '\n';
    out.textContent = t;
  } catch (e) { out.textContent = 'failed: ' + e.message; }
}

boot().catch(e => { document.body.innerHTML = '<pre style="padding:20px;color:#ff8a8c">' + e.stack + '</pre>'; });
