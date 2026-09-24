#!/usr/bin/env node
/**
 * E2E demo: spawns pocketpmo-mcp as a real subprocess, speaks MCP over
 * stdio, and produces a forecast briefing for the sample project.
 * Output is a formatted transcript suitable for docs.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { writeFileSync, mkdirSync } from 'node:fs';

const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.js');
// os.homedir(), not process.env.HOME — HOME is undefined on Windows, and
// path.join(undefined, ...) throws ERR_INVALID_ARG_TYPE (a crash), which
// argv[2] would otherwise mask as "the demo is broken".
const outPath = process.argv[2] || path.join(os.homedir(), 'data/outputs/2026-09-21-pmo-mcp-demo.md');

const proc = spawn('node', [serverPath], { stdio: ['pipe', 'pipe', 'pipe'] });
let buffer = '';
const pending = new Map();
let nextId = 1;

proc.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  let idx;
  while ((idx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

function request(method, params) {
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

async function call(tool, args) {
  const r = await request('tools/call', { name: tool, arguments: args });
  if (r.result?.isError) throw new Error(r.result.content[0].text);
  return JSON.parse(r.result.content[0].text);
}

const lines = [];
const log = (s = '') => lines.push(s);

try {
  const init = await request('initialize', {});
  log('# PocketPMO MCP — E2E Demo Transcript');
  log();
  log(`Date: ${new Date().toISOString().slice(0, 10)}`);
  log(`Server: ${init.result.serverInfo.name} v${init.result.serverInfo.version} (protocol ${init.result.protocolVersion})`);
  log(`Transport: stdio (newline-delimited MCP JSON-RPC), real subprocess`);
  log();

  const tools = await request('tools/list', {});
  log(`## 1. Tool discovery — ${tools.result.tools.length} tools`);
  log();
  for (const t of tools.result.tools) log(`- \`${t.name}\` — ${t.description}`);
  log();

  const listing = await call('list_projects', {});
  log(`## 2. list_projects → ${listing.projects.length} project(s) in ${listing.dir}`);
  log();
  for (const p of listing.projects) {
    log(`- **${p.name}** (id ${p.id}) — ${p.activityCount} activities, ${p.riskCount} risks, ${p.milestoneCount} milestones, budget ${p.budget}`);
  }
  log();

  const cp = await call('critical_path', { project: '101' });
  log(`## 3. critical_path — "${cp.project}"`);
  log();
  log(`- CPM project duration: **${cp.projectDuration} days**`);
  log(`- Critical chain: ${cp.criticalActivities.map((a) => `\`${a}\``).join(' → ')}`);
  log(`- Float elsewhere: ${cp.activities.filter((a) => !a.critical).map((a) => `${a.id} (${a.float}d)`).join(', ') || 'none'}`);
  log();

  const mc = await call('monte_carlo', {
    project: '101',
    iterations: 5000,
    targets: [75, 90, 110],
    seed: 42
  });
  log(`## 4. monte_carlo — 5000 iterations, seed 42`);
  log();
  log(`- Duration percentiles: p10 **${mc.percentiles.p10}d** · p50 **${mc.percentiles.p50}d** · p90 **${mc.percentiles.p90}d** (mean ${mc.mean}d, σ ${mc.stdDev}d)`);
  for (const t of mc.probabilityByTarget) {
    log(`- P(finish ≤ ${t.target}d): **${(t.probability * 100).toFixed(1)}%**`);
  }
  log(`- Critical-path frequency (top 5):`);
  for (const c of mc.criticalPathFrequency.slice(0, 5)) {
    log(`  - \`${c.id}\` on the critical path in ${(c.share * 100).toFixed(1)}% of runs`);
  }
  log();

  const evm = await call('evm_metrics', { project: '101', statusDate: '2026-09-21' });
  log(`## 5. evm_metrics — as of 2026-09-21`);
  log();
  log(`- BAC ${evm.budgetAtComplete} · PV ${evm.plannedValue} · EV ${evm.earnedValue} · AC ${evm.actualCost}`);
  log(`- CPI **${evm.cpi}** (${evm.cpi < 1 ? 'over cost' : 'under or on cost'} — earns ${(evm.cpi * 100).toFixed(0)}c of value per €1 spent)`);
  log(`- SPI **${evm.spi}** (${evm.spi < 1 ? 'behind' : 'ahead of or on'} schedule pace)`);
  log(`- EAC **${evm.eac}** (VAC ${evm.vac}) — ${evm.vac < 0 ? 'projected overrun' : 'projected underrun'}`);
  log(`- Timeline: ${evm.timeline.elapsedDays}/${evm.timeline.projectDurationDays} days elapsed (${(evm.timeline.actualTimePercentage * 100).toFixed(0)}%)`);
  log();

  const risks = await call('risk_register', { project: '101' });
  log(`## 6. risk_register — top risks by probability × impact`);
  log();
  for (const r of risks.risks.slice(0, 3)) {
    log(`- **${r.name}** — P${r.probability} × I${r.impact} = ${r.score} (${r.status}, owner: ${r.owner})`);
  }
  log();

  log('## What just happened');
  log();
  log('Every number above came from a real MCP `tools/call` against the same');
  log('calculator semantics that power app.pocketpmo.com — PERT, CPM, Monte');
  log('Carlo, EVM, risk scoring — served read-only over stdio. Any MCP host');
  log('(Hermes, Claude Desktop, waffle-os coordinator, agent packs) can run');
  log('this briefing. The pmo-analyst pack now declares these tools in');
  log('`tools/mcp.servers.json`, so its skills can cite them as evidence.');
} finally {
  proc.kill();
}

mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(outPath, lines.join('\n') + '\n');
console.log(lines.join('\n'));
console.error(`\nTranscript saved to ${outPath}`);
