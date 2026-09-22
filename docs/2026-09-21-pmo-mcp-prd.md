# PocketPMO MCP Bridge — Product PRD

Version: 0.1 · Date: 2026-09-21 · Author: Wintermute · Sponsor: David
Status: Draft for implementation (read-only Phase 1)

---

## 1. Problem statement

Agent Waffle's PM agent packs (31 packs, ~2,500 skills) describe *what* a PMO
analyst does — collect returns, consolidate risk registers, detect milestone
slippage, reconcile forecasts — but have no computational engine behind them.
Every `tools/mcp.servers.json` across the pack estate is empty. When a pack
skill needs a schedule forecast or an earned-value figure today, the answer is
hand-computed or fabricated.

PocketPMO has the engine — PERT, CPM, Monte Carlo, EVM, risk scoring — proven
in production at app.pocketpmo.com, but it is an interactive workspace. It
cannot answer questions nobody typed into it, and agents can't call it.

**The gap is symmetric.** Waffle lacks math; PocketPMO lacks an API surface.

## 2. Product definition

**PocketPMO MCP Bridge** — a local MCP server that exposes PocketPMO's
computational core as typed, read-only tools over stdio, loadable by any MCP
host (Hermes, Claude Desktop, waffle-os coordinator, agent packs).

One sentence: **agents ask, PocketPMO computes.**

### Phase 1 (this PRD — scope)

Read-only tools against project export files (JSON). No auth surface, no
network, no writes. Runs on the user's machine.

### Phase 2 (out of scope, sequenced)

After the projectRepository → Supabase persistence ships: tools read and
write via the PocketPMO cloud API. `actuals-capture` becomes possible
(approval-gated per pack policies §5.7).

### Phase 3 (exploratory)

Watchers: PocketPMO project changes trigger waffle health reviews. Scheduler
jobs: Monday-morning portfolio briefing with live CPI/SPI. A dedicated
`pocketpmo-connector` pack distributed as a first-class pack.

## 3. Goals and success metrics

| Goal | Metric |
|---|---|
| Packs can compute | ≥7 tools callable end-to-end from an MCP host |
| Zero risk to app | No changes to rebel-projectpro-suite; bridge is standalone |
| Deterministic trust | Same input → byte-identical output (seeded RNG, pure functions) |
| Faithful semantics | Numbers match the app's calculators (ports, not re-inventions) |
| Demo sells the bundle | One transcript showing a forecast briefing no pack could produce before |

## 4. Users and jobs-to-be-done

1. **PMO analyst agent (primary).** "Is the rebaseline date safe at 80%
   confidence?" → calls `monte_carlo`, interprets with `variance-commentary`
   skill.
2. **Portfolio manager agent.** Monday roll-up across N project files →
   `evm_metrics` + `pert_estimate` per project, consolidated into the weekly
   report.
3. **David (dogfooder/GTM).** Runs his own four-product portfolio through the
   bridge; the demo transcript is marketing evidence for both products.

## 5. Functional requirements

### FR-1 Project source
- Projects load from JSON files in `PMO_PROJECTS_DIR` (default `./data`).
- Schema = PocketPMO project object (per `src/utils/blankProject.js`):
  `id`, `name`, `startDate`, `endDate`, `budget`, `activities[]`
  (`id`, `name`, `duration`, `predecessors[]`, optional `distribution{}`),
  `evmData.milestones[]` (`percentage`, `cost`, `progress` 0|0.1|1),
  `risks[]` (`probability` 1–5, `impact` 1–5), plus app-native nested stores
  (`pertData`, `cpmData`, `monteCarloData`) honoured when present.
- Malformed files are skipped with a warning, never crash the server.

### FR-2 Tool surface (all read-only)

| Tool | Input | Output |
|---|---|---|
| `list_projects` | — | [{id, name, activityCount, riskCount}] |
| `get_project` | {project} | metadata + data-shape summary |
| `pert_estimate` | {project, targetDuration?} | per-activity expected/variance/stdDev, roll-up, P(completion ≤ target) |
| `critical_path` | {project} | es/ef/ls/lf/float per activity, critical set, project duration |
| `monte_carlo` | {project, iterations?, targets?} | p10/p50/p90 (R-7 quantiles), mean, stdDev, P(≤ each target), criticalActivityFrequency |
| `evm_metrics` | {project, statusDate?} | PV, EV, AC, CPI, SPI, EAC, VAC (null when no actual cost), timeline % |
| `risk_register` | {project} | risks with probability × impact score, ranked |

- `iterations` clamped ≤ 20000 (default 2000).
- Every response includes `read_only: true` and an `issues[]` array — the
  server reports invalid inputs instead of silently fabricating statistics
  (mirrors the app's post-#78 Monte Carlo guard philosophy).

### FR-3 Protocol
- Newline-delimited MCP JSON-RPC over stdio; methods: `initialize`, `ping`,
  `tools/list`, `tools/call`; notifications silently absorbed; unknown methods
  → error −32601; handler exceptions → in-band `isError` results.
- Compatible with hosts speaking the same minimal framing as waffle-os
  `waffle mcp` and standard MCP clients.

### FR-4 Pack integration (pmo-analyst demo)
- Tools declared in `tools/mcp.servers.json` with `origin: "mcp:pocketpmo"`,
  `x-waffle: {read_only: true}` per pack spec §5.4.
- New skill `pocketpmo-forecast-query` consumes the tools; consuming skills
  list the tools they use in `tools_required` (no dead weight).
- Pack still validates with `validate_pack.py`.

## 6. Non-functional requirements

- **No dependencies.** Node ≥18 stdlib only. Installs by `git clone`.
- **Deterministic.** Seeded LCG RNG for Monte Carlo; pure functions elsewhere.
- **Fast.** 2000-iteration Monte Carlo on a 50-activity network < 500 ms.
- **Fail-soft.** Any tool failure is an in-band error result; process never
  exits on bad input.
- **Private.** No telemetry, no network calls, files never leave the machine.

## 7. Out of scope (Phase 1)

- Writes to project data (awaits Supabase persistence slice).
- Auth/multi-tenancy (local single-user).
- The pocketpmo-connector pack as a distributable artifact.
- Live sync with app.pocketpmo.com cloud backups.

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Port drifts from app semantics | Ports document their source functions; golden-case tests pin behaviour |
| Pack validator rejects tool entries | Validate immediately after edit (Task 8), before demo |
| Master red conflates with bridge | Bridge lives in its own repo; no shared CI |
| Export-file format changes | Loader tolerant, issues[] reporting, version-stamped fixture |

## 9. Milestones

1. M1: calculators ported + unit-tested (Tasks 2–5)
2. M2: server + loader + fixture (Tasks 6–7) — *tools callable*
3. M3: pmo-analyst pack wired + validated (Task 8) — *packs can compute*
4. M4: E2E demo transcript + README + tag v0.1.0 (Task 9) — *demo ready*

## 10. Open questions

1. Should `list_projects` also scan subdirectories? (default: no, keep flat)
2. Naming: `pocketpmo-mcp` vs `pocketpmo-bridge` (default: `pocketpmo-mcp`)
3. Which additional pack (portfolio-pmo-manager?) gets wired in M3+ — after
   David reviews the demo.
