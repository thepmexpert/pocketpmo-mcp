import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleRequest } from '../server.js';

const req = (id, method, params) => ({ jsonrpc: '2.0', id, method, params });

describe('protocol', () => {
  test('initialize returns protocol version and server info', () => {
    const r = handleRequest(req(1, 'initialize', {}));
    assert.equal(r.result.protocolVersion, '2025-06-18');
    assert.equal(r.result.serverInfo.name, 'pocketpmo-mcp');
  });

  test('ping returns empty result', () => {
    const r = handleRequest(req(2, 'ping'));
    assert.deepEqual(r.result, {});
  });

  test('notifications return null (no response)', () => {
    assert.equal(handleRequest({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  });

  test('unknown method -> -32601', () => {
    const r = handleRequest(req(3, 'resources/list'));
    assert.equal(r.error.code, -32601);
  });

  test('non-object request -> -32600', () => {
    const r = handleRequest('hello');
    assert.equal(r.error.code, -32600);
  });
});

describe('tools', () => {
  test('tools/list exposes 7 read-only tools', () => {
    const r = handleRequest(req(4, 'tools/list'));
    assert.equal(r.result.tools.length, 7);
    for (const t of r.result.tools) {
      assert.ok(t.name && t.description && t.inputSchema);
    }
  });

  test('unknown tool -> in-band error result, not crash', () => {
    const r = handleRequest(req(5, 'tools/call', { name: 'nope', arguments: {} }));
    assert.equal(r.result.isError, true);
  });

  // Regression (review batch 4): inherited Object.prototype properties must
  // not resolve as handlers. Plain `handlers[params.name]` lookup let a
  // client invoke 'constructor' (returned {}), 'hasOwnProperty' (raw
  // TypeError) or 'toString' instead of getting 'unknown tool'.
  test('prototype-pollution tool names -> unknown tool, never executed', () => {
    for (const name of ['constructor', '__proto__', 'hasOwnProperty', 'toString', 'valueOf']) {
      const r = handleRequest(req(50, 'tools/call', { name, arguments: {} }));
      assert.equal(r.result.isError, true, `${name} must be rejected in-band`);
      assert.match(r.result.content[0].text, /^unknown tool:/);
    }
    // non-string names too — the typeof gate rejects them before the lookup
    for (const name of [null, 42, { evil: true }, ['constructor']]) {
      const r = handleRequest(req(51, 'tools/call', { name, arguments: {} }));
      assert.equal(r.result.isError, true);
      assert.match(r.result.content[0].text, /^unknown tool:/);
    }
  });

  test('invalid params -> -32602', () => {
    const r = handleRequest(req(6, 'tools/call', 'oops'));
    assert.equal(r.error.code, -32602);
  });
});

describe('tool calls against bundled sample project', () => {
  test('list_projects finds the sample', () => {
    const r = handleRequest(req(7, 'tools/call', { name: 'list_projects', arguments: {} }));
    const payload = JSON.parse(r.result.content[0].text);
    assert.ok(payload.projects.some((p) => p.id === '101'));
  });

  test('pert_estimate with target returns completion probability', () => {
    const r = handleRequest(
      req(8, 'tools/call', { name: 'pert_estimate', arguments: { project: '101', targetDuration: 95 } })
    );
    const payload = JSON.parse(r.result.content[0].text);
    assert.equal(payload.rollup.expected > 0, true);
    assert.ok(payload.completionProbability.probability > 0 && payload.completionProbability.probability <= 1);
  });

  test('critical_path finds the long chain through integration build', () => {
    const r = handleRequest(req(9, 'tools/call', { name: 'critical_path', arguments: { project: '101' } }));
    const payload = JSON.parse(r.result.content[0].text);
    // a1 -> a2 -> a4 -> a5 -> a6 = 10+15+30+15+5 = 75 days
    assert.equal(payload.projectDuration, 75);
    assert.deepEqual(payload.criticalActivities, ['a1', 'a2', 'a4', 'a5', 'a6']);
  });

  test('monte_carlo is deterministic with the same seed', () => {
    const args = { project: '101', iterations: 300, targets: [100, 110] };
    const r1 = handleRequest(req(10, 'tools/call', { name: 'monte_carlo', arguments: args }));
    const r2 = handleRequest(req(11, 'tools/call', { name: 'monte_carlo', arguments: args }));
    assert.equal(r1.result.content[0].text, r2.result.content[0].text);
    const payload = JSON.parse(r1.result.content[0].text);
    assert.ok(payload.percentiles.p10 <= payload.percentiles.p50);
    assert.ok(payload.percentiles.p50 <= payload.percentiles.p90);
  });

  test('evm_metrics returns coherent metrics', () => {
    const r = handleRequest(
      req(12, 'tools/call', { name: 'evm_metrics', arguments: { project: '101', statusDate: '2026-09-21' } })
    );
    const m = JSON.parse(r.result.content[0].text);
    assert.equal(m.budgetAtComplete, 480000);
    // EV = 96000 (m1 complete) + 150000*0.5 + 140000*0.5 = 240000
    assert.equal(m.earnedValue, 240000);
    // AC = 96000 + 150000*0.5 + 140000*0.5 = 241000 (costs differ from %-weights)
    assert.equal(m.actualCost, 241000);
    assert.ok(m.timeline.actualTimePercentage > 0 && m.timeline.actualTimePercentage < 1);
  });

  test('risk_register ranks by probability x impact', () => {
    const r = handleRequest(req(13, 'tools/call', { name: 'risk_register', arguments: { project: '101' } }));
    const payload = JSON.parse(r.result.content[0].text);
    assert.equal(payload.risks[0].id, 'r1');
    assert.equal(payload.risks[0].score, 16);
  });

  test('bad project name -> in-band error with available ids', () => {
    const r = handleRequest(req(14, 'tools/call', { name: 'get_project', arguments: { project: 'ghost' } }));
    assert.equal(r.result.isError, true);
    assert.ok(r.result.content[0].text.includes('no project matching'));
  });

  test('critical_path surfaces duplicate-id issues from the project file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmo-mcp-dup-'));
    const dupProject = JSON.stringify({
      id: 'dup',
      name: 'Duplicate Ids',
      activities: [
        { id: 'a', duration: 3, predecessors: [] },
        { id: 'a', duration: 9, predecessors: [] },
        { id: 'b', duration: 2, predecessors: ['a'] }
      ]
    });
    fs.writeFileSync(path.join(dir, 'dup.json'), dupProject);
    const prev = process.env.PMO_PROJECTS_DIR;
    process.env.PMO_PROJECTS_DIR = dir;
    try {
      const r = handleRequest(req(15, 'tools/call', { name: 'critical_path', arguments: { project: 'dup' } }));
      const payload = JSON.parse(r.result.content[0].text);
      assert.ok(Array.isArray(payload.issues));
      assert.ok(
        payload.issues.some((i) => i.field === 'id' && /duplicate activity id 'a'/.test(i.message)),
        `expected duplicate-id issue, got: ${JSON.stringify(payload.issues)}`
      );
    } finally {
      if (prev === undefined) delete process.env.PMO_PROJECTS_DIR;
      else process.env.PMO_PROJECTS_DIR = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Review batch 5: seed-0 passthrough, schema-contract gate, backpressure
// ---------------------------------------------------------------------------

describe('review batch 5 hardening', () => {
  test('seed 0 is honored, not silently replaced by 42', () => {
    // OLD: Number(0) || 42 -> seed 42. NEW: seed 0 flows through to makeRng
    // (which maps LCG-zero state to 1). seed 0 must now be reproducible and
    // distinct from the seed-42 sequence.
    const base = { project: '101', iterations: 200 };
    const r0a = handleRequest(req(60, 'tools/call', { name: 'monte_carlo', arguments: { ...base, seed: 0 } }));
    const r0b = handleRequest(req(61, 'tools/call', { name: 'monte_carlo', arguments: { ...base, seed: 0 } }));
    const r42 = handleRequest(req(62, 'tools/call', { name: 'monte_carlo', arguments: { ...base, seed: 42 } }));
    assert.equal(r0a.result.content[0].text, r0b.result.content[0].text, 'seed 0 is reproducible');
    assert.notEqual(
      r0a.result.content[0].text,
      r42.result.content[0].text,
      'seed 0 must not produce the seed-42 sequence'
    );
  });

  test('missing required parameters are rejected with a schema-level error', () => {
    for (const name of ['get_project', 'pert_estimate', 'critical_path', 'monte_carlo', 'evm_metrics', 'risk_register']) {
      const r = handleRequest(req(63, 'tools/call', { name, arguments: {} }));
      assert.equal(r.result.isError, true, `${name} requires 'project'`);
      assert.match(r.result.content[0].text, /^missing required parameter\(s\): project$/);
    }
  });

  test('tools without required params still dispatch (list_projects)', () => {
    const r = handleRequest(req(64, 'tools/call', { name: 'list_projects', arguments: {} }));
    assert.equal(r.result.isError, false);
  });

  test('backpressure: responses stay ordered when stdout applies pressure', async () => {
    // Fake stdout: the FIRST write reports a full buffer (returns false) and
    // resolves on 'drain'; later writes succeed immediately. All three pings
    // are queued before the first drain fires — a naive async writeLine
    // would let response 2 overtake response 1.
    const written = [];
    let drainCallback = null;
    let firstWriteDone = false;
    const fakeStdout = {
      write(chunk) {
        written.push(chunk);
        if (!firstWriteDone) {
          firstWriteDone = true;
          setImmediate(() => {
            const cb = drainCallback;
            drainCallback = null;
            if (cb) cb();
          });
          return false;
        }
        return true;
      },
      once(event, cb) {
        assert.equal(event, 'drain');
        drainCallback = cb;
      }
    };
    const { serve } = await import('../server.js');
    const { PassThrough } = await import('node:stream');
    const stdin = new PassThrough();
    serve({ stdin, stdout: fakeStdout });
    stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) + '\n');
    stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }) + '\n');
    stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' }) + '\n');
    stdin.end();
    await new Promise((resolve) => stdin.on('end', resolve));
    // Allow the drain continuation and chained writes to flush
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(written.length, 3, 'all three responses written');
    const ids = written.map((c) => JSON.parse(c).id);
    assert.deepEqual(ids, [1, 2, 3], 'responses must arrive in request order');
  });
});
