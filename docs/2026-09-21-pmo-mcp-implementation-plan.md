# PocketPMO MCP Server — Implementation Plan

> **For Hermes:** Use subagent-driven-development to implement this plan
> task-by-task, or execute directly. Each task is small and independently
> verifiable.

**Goal:** A read-only MCP stdio server exposing PocketPMO's calculators, wired
into the pmo-analyst pack as a working demo.

**Architecture:** Standalone Node 22 package (`~/repos/pocketpmo-mcp`). The
server (`server.js`) speaks newline-delimited MCP JSON-RPC over stdio — the
same minimal framing waffle-os uses in `cowork/adapter.py`. Calculation logic
lives in `lib/calculators.js`, a dependency-free port of the app's four
calculator utilities (semantics documented in the PRD). Project data loads
from JSON export files in a configurable directory (`PMO_PROJECTS_DIR`, default
`./data`), parsed by `lib/projects.js`.

**Tech Stack:** Node ≥18 (stdlib only: `fs`, `path`, `readline`). Tests with
`node --test`. No npm dependencies.

---

## Task 1: Scaffold the package

**Files:**
- Create: `~/repos/pocketpmo-mcp/package.json`
- Create: `~/repos/pocketpmo-mcp/.gitignore`

`package.json`:
```json
{
  "name": "pocketpmo-mcp",
  "version": "0.1.0",
  "description": "Read-only MCP server exposing PocketPMO forecast tools (PERT, CPM, Monte Carlo, EVM)",
  "type": "module",
  "main": "server.js",
  "bin": { "pocketpmo-mcp": "./server.js" },
  "scripts": {
    "start": "node server.js",
    "test": "node --test test/"
  },
  "engines": { "node": ">=18" },
  "license": "MIT"
}
```

**Verify:** `node --test test/` reports 0 tests, exit 0 (empty dir tolerated
with `--test` on a missing dir fails — create `test/` in Task 2 first).

## Task 2: Port the PERT calculator (TDD)

**Files:**
- Create: `lib/calculators.js`
- Test: `test/calculators.test.js`

**Semantics (faithful to `src/utils/pertCalculator.js`):**
- `pertStats(o, m, p)`: expected = (o + 4m + p) / 6; variance = ((p−o)/6)²;
  stdDev = √variance; round all to 2dp; non-finite input → all NaN.
- `pertCompletionProbability(totalExpected, totalStdDev, target)`: normal
  approximation; z = (target − expected)/stdDev; clamp z to [−3, 3];
  probability via erf-based Φ; invalid → 0.5.

**Step 1:** Write failing tests (golden cases: o=3,m=5,p=9 → expected 5.33,
stdDev 1.0; symmetric case o=m=p → stdDev 0; probability(z=0)=0.5;
target far below → ~1.0).
**Step 2:** `npm test` → FAIL.
**Step 3:** Implement the two functions.
**Step 4:** `npm test` → PASS. **Commit:** `feat: port PERT calculator`.

## Task 3: Port the CPM calculator (TDD)

**Semantics (faithful to `src/utils/cpmCalculator.js` `calculateCpmNetwork`):**
Iterative forward pass (handles non-topological order): activities with no
predecessors get es=0, ef=duration; others wait until all predecessors
processed, es=max(pred.ef), ef=es+duration. Backward pass from max EF:
lf=projectDuration (max EF) for activities nothing depends on (NOT the
activity's own ef — that would wrongly zero their float and mark parallel
terminals critical); lf=min(succ.ls); ls=lf−duration;
float=ls−es. Critical = float 0. Unreachable activities (cycles) stay
unprocessed and are reported.

**Tests:** linear chain A→B→C; two parallel branches (shorter branch has
float); diamond dependency. **Commit:** `feat: port CPM calculator`.

## Task 4: Port the Monte Carlo engine (TDD)

**Semantics (faithful to `src/utils/monteCarloEngine.js`):**
- `buildDistributions(activities)`: per activity with id; explicit
  `distribution` object honoured (fields min/optimistic, mode/mostLikely,
  max/pessimistic, mean, stdDev); default triangular (o=0.7·d, m=d, p=1.5·d,
  mean=(o+m+p)/3 ≈ 1.0667·d — the actual sampled mean, stdDev=0.2·d).
  Invalid durations fall back to 1 — reported, not silent.
- Triangular sampling: `o + rng()·(m−o) + rng()·(p−m)` resampled while rng() <
  (m−o)/(p−o) — matches the app's rejection shape; normal sampling via
  Box-Muller with seeded LCG (seeded ⇒ deterministic tests).
- `runMonteCarlo({activities, distributions, iterations, rng})`: simulate
  project duration per iteration as **CPM-based**: duration = max ef over
  activities after forward pass with sampled durations (this matches
  `calculateProjectDuration` semantics: longest path end, not naive max of
  sampled durations). Collect percentiles p10/p50/p90 (R-7 quantiles,
  matching the app's simple-statistics quantileSorted), mean, stdDev,
  probability of finishing by each requested target date (empirical share
  of simulated durations ≤ target), criticalActivityFrequency (share of
  iterations where the activity sat on the critical path).
- Input validation mirrors `validateMonteCarloActivities`: report issues, never
  fabricate silent stats.

**Tests:** seeded rng reproducibility (two runs identical); triangular(5,5,5)
degenerates to deterministic 5·chain; percentiles monotonic; a definitely-long
activity dominates p90. **Commit:** `feat: port Monte Carlo engine`.

## Task 5: Port the EVM calculator (TDD)

**Semantics (faithful to `src/utils/evmCalculator.js`):**
- Milestones: `{percentage, cost, progress}` with progress enum
  {NOT_STARTED:0, IN_PROGRESS:0.1, COMPLETE:1}.
- EV = Σ (budget·percentage/100) · (1 if complete, inProgressFraction if
  in-progress). AC = Σ cost · same multipliers. PV = budget ·
  actualTimePercentage where actualTimePercentage = elapsedDays/totalDays
  clamped [0,1]. CPI = EV/AC; SPI = EV/PV; EAC = BAC/CPI; VAC = BAC−EAC. Dates: strict YYYY-MM-DD inputs use UTC calendar-day math, timestamps use instant arithmetic; impossible calendar dates ('2026-02-30') and unparseable values are reported in issues[]. EAC/VAC = null whenever CPI <= 0 (AC = 0 or EV = 0; matches calculateEvmAdvancedMetrics).
- Invalid budget → 0s throughout, flagged in response `issues`.

**Tests:** all-complete milestones → EV=BAC; halfway in-progress → fraction;
over-budget AC → CPI<1; missing dates → timeline zeros + issue flag.
**Commit:** `feat: port EVM calculator`.

## Task 6: Project store loader

**Files:** `lib/projects.js`, `test/projects.test.js`

Read `PMO_PROJECTS_DIR` (default `./data`), list `*.json` files, parse each as
a PocketPMO project (schema per `src/utils/blankProject.js`: id, name,
activities, risks, evmData.milestones, pertData/cpmData/monteCarloData, costData…).
`listProjects()` → minimal metadata; `getProject(idOrName)` → full object.
Graceful errors: malformed file → skipped with warning (never crashes server).

**Fixture:** `data/sample-project.json` — a realistic 6-activity project with
one dependency chain, distributions on each activity, 3 EVM milestones, 2
risks. This doubles as the demo dataset.
**Commit:** `feat: project store loader + sample project`.

## Task 7: MCP server

**Files:** `server.js`, `test/server.test.js`

Newline-delimited JSON-RPC over stdio (pattern identical to waffle's
`McpStdioServer`). Methods: `initialize` (protocolVersion "2025-06-18",
serverInfo {name:"pocketpmo-mcp", version}), `ping`, `notifications/*` (no
response), `tools/list`, `tools/call`. Unknown method → −32601. Handler error
→ in-band `isError:true` result (server never dies).

**Tools (all read-only, listed in tools/list):**
1. `list_projects()` → [{id, name, activityCount, riskCount, path}]
2. `get_project({project})` → core fields + nested data counts
3. `pert_estimate({project, targetDuration?})` → per-activity expected/variance/
   stdDev + roll-up + completion probability vs target
4. `critical_path({project})` → CPM network: es/ef/ls/lf/float, critical flag,
   project duration
5. `monte_carlo({project, iterations?, targets?})` → duration percentiles,
   mean/stdDev, P(finish by target), criticalActivityFrequency table (per-activity criticality; criticalPathFrequency kept as deprecated alias)
   (iterations clamped ≤ 20000)
6. `evm_metrics({project, statusDate?})` → PV/EV/AC/CPI/SPI/EAC/VAC + timeline
7. `risk_register({project})` → risks with probability-impact score

Dispatch table maps tool name → handler; each handler loads the project file
fresh (no stale cache within a process lifetime of >60s; simple mtime check).

**Tests:** initialize/tools/list/tools/call round-trips via injected
stdin/stdout streams; error paths (bad tool, bad project). **Commit:**
`feat: MCP stdio server`.

## Task 8: Wire the pmo-analyst pack

**Files:** edit
`/Volumes/2TB_Drive/wintermute/agent-packs/working-extracted/pmo-analyst-0.1.0/pmo-analyst/tools/mcp.servers.json`
+ `skills/forecast-actual-reconciliation/SKILL.md` (+ `tools_required`) + new
skill `skills/pocketpmo-forecast-query/SKILL.md`.

- Declare the 7 tools with `origin: "mcp:pocketpmo"`, `x-waffle.read_only:
  true`, automation_level `auto_if_low_risk`, risk `low`.
- Add `pocketpmo-forecast-query` skill (queries the server for schedule/cost
  confidence; `tools_required` lists the tools it uses).
- Append the new tool names to `tools_required` of the skills that consume
  numbers (forecast-actual-reconciliation, milestone-slippage-detection,
  weekly-portfolio-report — only where the pack already lists tools, per §5.4
  "no dead weight").
- Validate with David's `validate_pack.py` (PyYAML lives in
  `~/waffle-os-mcp/.venv/bin/python`).
- Re-zip: `pocketpmo-connector` distribution is a later decision — for now
  patch the extracted pack in place and note the provenance in the pack README.

**Verify:** validator passes; no duplicate tool names across local/mcp files.
**Commit (agent-packs is not a git repo — note the change in the triage
report directory):** write
`/Volumes/2TB_Drive/wintermute/agent-packs/CHANGELOG-pmo-mcp.md`.

## Task 9: E2E demo + docs

- Script `demo/demo.mjs`: spawns the server, speaks MCP over stdio, runs
  initialize → tools/list → pert_estimate → critical_path → monte_carlo →
  evm_metrics against `data/sample-project.json`, prints a formatted transcript.
- Run it, save output to `~/data/outputs/2026-09-21-pmo-mcp-demo.md`.
- README.md: what it is, quickstart, tool reference, Hermes `config.yaml`
  registration snippet (`mcp_servers: pocketpmo:` command node …), pack wiring
  summary, roadmap (write-back after Supabase persistence).
- **Commit:** `feat: E2E demo + README`, tag `v0.1.0`.

## Verification checklist (definition of done)

- [ ] `npm test` green in ~/repos/pocketpmo-mcp (calculators, loader, server)
- [ ] `demo/demo.mjs` produces a real transcript with plausible numbers
- [ ] Server runs standalone: `echo '{"jsonrpc":"2.0","id":1,"method":"ping"}' | node server.js`
- [ ] validate_pack.py passes on patched pmo-analyst pack
- [ ] No changes to rebel-projectpro-suite working tree
- [ ] Demo transcript + docs written; tag v0.1.0 pushed
