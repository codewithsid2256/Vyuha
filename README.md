# व्यूह · VYUHA

**AI-Enabled Drone & Counter-Drone Threat Simulation Trainer**

> *The Chakravyuha of the modern battlefield is a drone swarm. VYUHA trains those who break it.*

India's first **Evidence-Grounded** C-UAS trainer. Every number on screen comes from a published
Government of India source shown with its citation, and detection emerges from **solved sensor
physics** — not a script. Built for **Smart India Hackathon 2026 · SIH26247 · Ministry of Defence**.

---

## Why it is different

| Pillar | What it means |
|---|---|
| **Data Provenance Ledger** | Click any number → its source card (Drone Rules 2021, DGCA Digital Sky, BEL D4, IMD METAR, Bhuvan CartoDEM, PIB…). 29 params / 11 GoI sources, 10 / 4 open sources, 30 flagged assumptions. |
| **Physics-first sensors** | Radar equation + clutter SCR + Swerling-1; RF link budget with fade margin (fibre-optic FPV asserted `pd = 0`); EO/IR via Johnson pixels × atmospheric τ × contrast; acoustic BPF. |
| **Evidence Ledger + Calibrated Confidence** | 5-hypothesis Bayesian fusion, declared confidence, reliability diagram, ACTIONABLE-AWARENESS milestone. |
| **Graduated Response + Escalation Economy** | Decision tree → effector fit → EEI = `min(1, L_required / L_used)` → Cost-of-Exchange ₹/₹. |
| **NASA-TLX workload** | Applied to the human only, never to the simulation. |
| **Tamper-evident Sortie Certificate** | `SHA-256(scenario_seed ‖ engine_version ‖ pack_version ‖ operator_id ‖ score_vector)`. |

**AI-Enabled, AI-Honest:** *AI decides what you practise next — never what is true.*
Deterministic: sensor physics, scenario content, threat library, rule-based debrief.
AI: Bayesian skill tracking (BKT over 19 nodes), Red-Force swarm behaviour, skill-gap prediction, appropriate-reliance drill.

---

## Tech stack

Vanilla JS (ESM) + Canvas 2D front-end, **zero-dependency** Node 20 HTTP server, JSON data pack.
No build step, no CDN, runs fully offline. The engine runs **server-side**, so browser scoring is
byte-identical to what the test-suite exercises.

```
app/
├─ server.js            # zero-dep HTTP server + REST API
├─ data/data-pack.json  # every parameter = { value, source, note }
├─ src/engine/          # physics, evidence, doctrine, scoring, director, sim, bots
├─ public/              # console UI (Canvas-2D PPI, RF waterfall, EO, AAR)
├─ test/                # 109 engine + 38 server-integration assertions
└─ tools/calibrate.mjs  # winnability + coverage + provenance report
```

---

## Run it locally

Requires **Node 20+**. No `npm install` needed (zero dependencies).

```bash
npm start          # http://localhost:8080   (reads $PORT if set)
npm run dev        # http://localhost:8099   (fixed local port)
npm test           # 109 engine + 38 server tests + calibration gate
```

---

## Deploy free (Render)

The app already reads the injected `process.env.PORT` and binds `0.0.0.0`, so it drops straight
onto any Node PaaS. A [`render.yaml`](render.yaml) blueprint is included.

1. Push this repo to GitHub (see below).
2. On [render.com](https://render.com) → **New +** → **Blueprint** → select the repo.
   Render reads `render.yaml` and creates the free web service automatically.
3. When the build finishes you get a public URL like `https://vyuha-console.onrender.com`.

> **Free-tier note:** Render spins the service down after ~15 min idle; the first request then takes
> ~30–60 s to cold-start. Sessions are held in memory, so a restart clears in-progress sorties and
> the trainee learning model — fine for demos and judging.

---

## Verification

```
npm test  →  109 engine passed / 0 failed
             38 server-integration passed / 0 failed
             ALL 8 SCRIPTED MISSIONS WINNABLE (exemplar bot beats random floor)
             300/300 unique scenario fingerprints (100% novel)
```

---

*Training simulation only · no weapon control · no classified data.*
