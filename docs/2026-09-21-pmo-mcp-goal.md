# PocketPMO MCP Bridge — Structured Goal

Date: 2026-09-21 · Owner: David · Status: APPROVED-FOR-IMPLEMENTATION (Wintermute recommendation)

```
OUTCOME:     A read-only MCP server ("pocketpmo-mcp") that exposes PocketPMO's
             computational core (PERT, CPM, Monte Carlo, EVM) as typed tools
             over stdio, verified end-to-end, and wired into the pmo-analyst
             agent pack so its skills can call real numbers for the first time.
             Done = all tools pass unit tests, the pack validates with
             validate_pack.py, and a scripted E2E demo shows
             initialize → tools/list → tools/call returning real forecast data
             from a project export file.

SOURCES:     ~/repos/rebel-projectpro-suite (calculator semantics: src/utils/
             pertCalculator.js, cpmCalculator.js, monteCarloEngine.js,
             evmCalculator.js; project schema: src/utils/blankProject.js)
             ~/repos/waffle-os/docs/how-to-create-a-waffle-os-agent-pack.md
             (§5.4 tools/mcp.servers.json format)
             ~/repos/waffle-os/src/waffle_os/cowork/adapter.py (McpStdioServer
             protocol pattern: initialize / ping / tools/list / tools/call)

CONSTRAINTS: - READ-ONLY. No tool writes to any project data. Write path is a
               post-Supabase-persistence milestone.
             - Zero impact on rebel-projectpro-suite master (currently red from
               owner WIP). Standalone package in ~/repos/pocketpmo-mcp.
             - No new heavyweight dependencies. Node 22 stdlib only.
             - Pack changes limited to pmo-analyst (the demo pack); other packs
               inherit later by copying the mcp.servers.json block.
             - Pack tool declarations must follow §5.4: origin "mcp:pocketpmo",
               x-waffle.read_only, every tool listed in a skill's tools_required.
             - Calculator implementations are faithful ports of the app's
               semantics (documented in the PRD), not re-inventions.

DELIVERABLE: ~/repos/pocketpmo-mcp/  (server + tests + sample project + demo)
             docs/: goal (this file), implementation plan, product PRD
             pmo-analyst pack updated: tools/mcp.servers.json + skill wiring
             E2E demo transcript: ~/data/outputs/2026-09-21-pmo-mcp-demo.md
             Git: initial commit + tag v0.1.0 on completion
```

## Strategic rationale (why this is the keystone)

- PocketPMO = math + data without judgment. Waffle packs = judgment without
  numbers (every pack `tools/mcp.servers.json` is currently empty).
- One MCP server gives all 31 packs computational teeth; six PM-domain packs
  inherit it directly via the same tool declarations.
- MCP is deliberately loose coupling: neither product's positioning depends on
  the other, but the bundle ("PocketPMO is the workspace, Waffle is the staff")
  is worth more than the sum.
- Sequencing guard: deep write-back integration requires the
  projectRepository → Supabase persistence slice. This read-only bridge is
  valuable immediately and de-risks the tool-schema design first.
