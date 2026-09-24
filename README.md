# pocketpmo-mcp

**Read-only MCP server exposing PocketPMO's computational core — PERT, CPM,
Monte Carlo, EVM, risk scoring — as typed tools over stdio.**

Agents ask, PocketPMO computes. Any MCP host (Hermes, Claude Desktop, the
waffle-os coordinator, agent packs) can now run forecast queries against
PocketPMO project data without a human driving the UI.

Part of the **PocketPMO × Waffle OS** bundle: PocketPMO is the workspace,
Waffle is the staff.

---

## Quickstart

```bash
git clone <this repo> && cd pocketpmo-mcp   # no dependencies to install
npm test                                     # 161 tests (needs Node ≥ 20 — see below)
node demo/demo.mjs                           # end-to-end demo transcript
```

> **Node version:** the server itself runs on Node ≥ 18 (zero-dep ESM, no
> test-runner involvement). The **test suite** uses `node:test`'s
> `describe`/`it` API, which exists from Node 18.6 (v16.17) but only left
> its experimental phase in Node 20 — run `npm test` on Node ≥ 20.

Serve over stdio (what MCP hosts launch):

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"ping"}' | PMO_PROJECTS_DIR=./data node server.js
```

## Project data

Projects are read from JSON export files in `PMO_PROJECTS_DIR`
(default `./data`). The schema is the PocketPMO project object — see
`data/sample-project.json` for a complete example (activities with
distributions, EVM milestones, risks, cost ledger). Malformed files are
skipped with a warning; the server never crashes on bad input.

## Tools (all read-only)

| Tool | Input | Returns |
|---|---|---|
| `list_projects` | — | projects with counts, dir, warnings |
| `get_project` | `project` | schedule/budget metadata + data-shape counts |
| `pert_estimate` | `project`, `targetDuration?` | per-activity expected/variance/stdDev, roll-up, P(completion ≤ target). Assumes independent activity durations — correlated durations (shared resources, common risks) make the true variance larger; treat roll-up as optimistic |
| `critical_path` | `project` | es/ef/ls/lf/float, critical set, project duration |
| `monte_carlo` | `project`, `iterations?`, `targets?`, `seed?` | p10/p50/p90 (R-7), mean/σ, P(≤ target), criticalActivityFrequency |
| `evm_metrics` | `project`, `statusDate?` | PV, EV, AC, CPI, SPI, EAC, VAC, timeline % (EAC/VAC null when CPI can't be computed, e.g. AC=0 or EV=0) |
| `risk_register` | `project` | risks scored P×I, ranked |

Design guarantees:

- **Deterministic** — seeded LCG RNG; identical calls return identical output.
- **Fail-soft** — any tool failure is an in-band `isError` result; the server
  keeps running. `issues[]` in responses flags suspect inputs (never silently
  fabricates statistics).
- **Read-only** — no tool writes to project data. Write-back is a future
  milestone gated on PocketPMO cloud persistence.
- **Faithful semantics** — the calculators are ports of the app's
  `pertCalculator`, `cpmCalculator`, `monteCarloEngine`, `evmCalculator`;
  each documents its source function in `lib/calculators.js`.

## Register with Hermes

```yaml
# ~/.hermes/config.yaml
mcp_servers:
  pocketpmo:
    command: "node"
    args: ["/absolute/path/to/pocketpmo-mcp/server.js"]
    env:
      PMO_PROJECTS_DIR: "/absolute/path/to/project-exports"
```

Restart Hermes; tools appear as `mcp_pocketpmo_list_projects`, etc.

## Register with Claude Desktop

```json
{
  "mcpServers": {
    "pocketpmo": {
      "command": "node",
      "args": ["/absolute/path/to/pocketpmo-mcp/server.js"],
      "env": { "PMO_PROJECTS_DIR": "/absolute/path/to/project-exports" }
    }
  }
}
```

## Waffle OS agent packs

The `pmo-analyst` pack declares all 7 tools in `tools/mcp.servers.json`
(`origin: "mcp:pocketpmo"`, `x-waffle.read_only: true`) and consumes them via
its `pocketpmo-forecast-query` skill. Other PM-domain packs
(portfolio-pmo-manager, project-controls-lead, senior-project-manager,
project-manager, program-manager) inherit by copying the same
`mcp.servers.json` block and adding the tools to their permissions.

Launch the server from a pack context by pointing `PMO_PROJECTS_DIR` at the
organisation's project export directory.

## Architecture

```
server.js           MCP framing (initialize/ping/tools/list/tools/call) + 7 handlers
lib/calculators.js  PERT · CPM · Monte Carlo · EVM (pure, documented ports)
lib/projects.js     JSON export-file store (tolerant loader)
data/               sample project fixture
demo/demo.mjs       real-subprocess E2E demo → markdown transcript
test/               161 tests (node:test, zero deps; run on Node ≥ 20)
```

## Roadmap

1. **v0.1 (this release)** — read-only over export files. ✅
2. **v0.2** — write tools (actuals capture, status returns) after PocketPMO's
   projectRepository → Supabase persistence ships; approval-gated in waffle.
3. **v0.3** — `pocketpmo-connector` pack as a first-class distributable;
   watcher integration (project change → waffle health review); scheduler
   jobs (Monday portfolio briefing with live CPI/SPI).

## License

MIT
