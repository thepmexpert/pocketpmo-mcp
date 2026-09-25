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

  // Finding #3 residual, server entry path: a requested project whose own
  // file is malformed must surface the parse failure in-band (the agent
  // sees WHY the project is gone, not just "no matching").
  test('malformed requested file -> in-band error names the unreadable file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmo-mcp-corrupt-'));
    fs.writeFileSync(path.join(dir, 'alpha.json'), '{ torn');
    fs.writeFileSync(
      path.join(dir, 'beta.json'),
      JSON.stringify({ id: 2, name: 'Beta', activities: [] })
    );
    const prev = process.env.PMO_PROJECTS_DIR;
    process.env.PMO_PROJECTS_DIR = dir;
    try {
      const r = handleRequest(req(16, 'tools/call', { name: 'get_project', arguments: { project: 'alpha' } }));
      assert.equal(r.result.isError, true);
      const text = r.result.content[0].text;
      assert.ok(text.includes("no project matching 'alpha'"));
      assert.ok(text.includes('Available: 2'), 'available ids must survive in the error');
      assert.ok(text.includes('files skipped (invalid or unreadable)'));
      assert.ok(text.includes('failed to parse alpha.json'));
      assert.ok(!text.includes(dir), 'dir must not leak into the error');
    } finally {
      if (prev === undefined) delete process.env.PMO_PROJECTS_DIR;
      else process.env.PMO_PROJECTS_DIR = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
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

  test('backpressure: responses pace on write callbacks, stay ordered', async () => {
    // Fake stdout: buffer FULL — every write returns false and its
    // completion callback is HELD until the test releases it. Fails the old
    // fire-and-forget implementation (writes 2 and 3 appear immediately,
    // in-flight response 1 overtaken) AND any implementation that resolves
    // a chain link on write()'s boolean return: unflushed responses must
    // hold the chain and the drained signal.
    const written = [];
    let heldCallbacks = [];
    const fakeStdout = {
      write(chunk, cb) {
        written.push(chunk);
        heldCallbacks.push(cb);
        return false; // buffer always full
      },
      on() {} // server registers an stdout 'error' consumer
    };
    const { serve } = await import('../server.js');
    const { PassThrough } = await import('node:stream');
    const stdin = new PassThrough();
    const rl = serve({ stdin, stdout: fakeStdout });
    let drained = 0;
    rl.on('drained', () => { drained++; });
    stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) + '\n');
    stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }) + '\n');
    stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' }) + '\n');
    stdin.end();
    await new Promise((resolve) => stdin.on('end', resolve));
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
    // Backpressure active: only the first response may be written so far.
    assert.equal(written.length, 1, 'responses 2+3 must wait for response 1 to flush');
    assert.equal(JSON.parse(written[0]).id, 1);
    assert.equal(drained, 0, 'drained must not fire while a write is unflushed');
    const releaseOne = () => {
      // Remove-before-invoke: a callback that stays in the array would be
      // released twice, double-decrementing pending (cubic round 2).
      const cb = heldCallbacks.shift();
      if (cb) cb();
    };
    releaseOne(); // response 1 flushed → response 2 issued
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(written.length, 2, 'response 2 issued after response 1 flushed');
    assert.equal(drained, 0);
    releaseOne(); // response 2 flushed → response 3 issued
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(written.length, 3, 'all three responses written');
    assert.deepEqual(written.map((c) => JSON.parse(c).id), [1, 2, 3], 'responses must arrive in request order');
    assert.equal(drained, 0, 'still awaiting the final flush');
    releaseOne(); // final flush
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(drained, 1, 'drained fires only after every write completes');
  });

  test('overload cap: stdin pauses at MAX_PENDING, backlog stays bounded', async () => {
    // cubic round 2 verified the previous inline-overload design REORDERED
    // output: chained responses are issued from microtasks, so an inline
    // "overloaded" write overtakes responses to earlier requests. This
    // design pauses stdin instead — no special responses, no ordering
    // hazard, kernel-level backpressure bounds memory. Requests past the
    // cap get no response at all (a pipeliner has already violated
    // sequential-request semantics).
    const written = [];
    let heldCallbacks = [];
    const fakeStdout = {
      write(chunk, cb) {
        written.push(chunk);
        heldCallbacks.push(cb);
        return false;
      },
      on() {}
    };
    const { serve } = await import('../server.js');
    const { PassThrough } = await import('node:stream');
    // 1 MB high-water mark: all 1050 lines (~58 KB) arrive in ONE data
    // event, so readline emits every line synchronously and the admission
    // decision is deterministic (with the 16 KB default the tail lines sit
    // in the PassThrough buffer and trickle in AFTER resume, making the
    // answered-count nondeterministic).
    const stdin = new PassThrough({ highWaterMark: 1 << 20 });
    const rl = serve({ stdin, stdout: fakeStdout });
    const lines = [];
    for (let i = 1; i <= 1050; i++) lines.push(JSON.stringify({ jsonrpc: '2.0', id: i, method: 'ping' }));
    stdin.write(lines.join('\n') + '\n');
    stdin.end();
    await new Promise((resolve) => rl.on('close', resolve));
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
    const overloadCount = written.filter((c) => {
      try { return JSON.parse(c).error?.code === -32000; } catch { return false; }
    }).length;
    assert.equal(overloadCount, 0, 'no special overload responses exist to reorder the stream');
    assert.equal(written.length, 1, 'while callbacks are blocked only the chain head is written — memory stays bounded');
    // Unblock to fixpoint: each released callback issues the next link.
    while (heldCallbacks.length) {
      heldCallbacks.splice(0).forEach((cb) => cb());
      for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
    }
    // EXACT: exactly MAX_PENDING requests admitted, exactly 50 dropped. A
    // range here would let a regression that drops admission entirely
    // (answering all 1050, ascending) pass (cubic round 3).
    assert.equal(written.length, 1000, 'exactly MAX_PENDING requests admitted, excess dropped');
    assert.deepEqual(written.map((c) => JSON.parse(c).id), Array.from({ length: 1000 }, (_, i) => i + 1));
  });

  test('parse errors count against the cap', async () => {
    // OLD: writeResponse decremented `pending` for parse errors that were
    // never incremented — each garbage line DEFLATED the counter, so a
    // hostile client could send garbage to buy unlimited queue space for
    // pipelined full responses.
    const written = [];
    let heldCallbacks = [];
    const fakeStdout = {
      write(chunk, cb) {
        written.push(chunk);
        heldCallbacks.push(cb);
        return false;
      },
      on() {}
    };
    const { serve } = await import('../server.js');
    const { PassThrough } = await import('node:stream');
    const stdin = new PassThrough();
    const rl = serve({ stdin, stdout: fakeStdout });
    const lines = [JSON.stringify({ jsonrpc: '2.0', id: 'first', method: 'ping' })];
    for (let i = 0; i < 999; i++) lines.push('not-json');
    lines.push(JSON.stringify({ jsonrpc: '2.0', id: 'over', method: 'ping' }));
    stdin.write(lines.join('\n') + '\n');
    stdin.end();
    await new Promise((resolve) => rl.on('close', resolve));
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
    // Unblock to fixpoint, then count: the honest counter admits exactly
    // 1000 (1 valid + 999 parse-error responses); the request past the cap
    // is DROPPED — no response at all, no special error. The deflating old
    // implementation would have admitted it as response 1001.
    while (heldCallbacks.length) {
      heldCallbacks.splice(0).forEach((cb) => cb());
      for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
    }
    const overloadCount = written.filter((c) => {
      try { return JSON.parse(c).error?.code === -32000; } catch { return false; }
    }).length;
    assert.equal(overloadCount, 0, 'no special overload responses');
    assert.equal(written.length, 1000, 'the request past the cap got no response: parse errors held the counter honest');
  });

  test('write errors are consumed per-link and the chain continues', async () => {
    // Every write "fails" (callback receives EPIPE) yet returns true — the
    // old implementation attached no error handling to ok=true writes; the
    // new contract delivers the error TO the callback and keeps serving.
    // Real streams ALSO emit 'error' on the stream object after failing a
    // callback (verified with a failing _write). The fake is
    // EventEmitter-backed and emits UNCONDITIONALLY: if serve() ever stops
    // registering its stdout 'error' consumer, the emit here becomes an
    // unhandled 'error' event and this test FAILS — that is the crash
    // guard this suite actually pins (cubic round 3).
    const written = [];
    const { serve } = await import('../server.js');
    const { PassThrough } = await import('node:stream');
    const { EventEmitter } = await import('node:events');
    const fakeStdout = new class extends EventEmitter {
      write(chunk, cb) {
        written.push(chunk);
        setTimeout(() => {
          const err = new Error('EPIPE: client closed');
          err.code = 'EPIPE'; // real stream errors carry the code; the
          // stderr surface must stay quiet for EPIPE (client gone = expected)
          cb(err);              // callback contract: error delivered here
          this.emit('error', err); // ...and real streams emit the event too
        }, 1);
        return true;
      }
    }();
    const stdin = new PassThrough();
    const rl = serve({ stdin, stdout: fakeStdout });
    let drainedPromiseResolve;
    const drainedPromise = new Promise((resolve) => { drainedPromiseResolve = resolve; });
    rl.on('drained', () => { drainedPromiseResolve(); }); // register BEFORE writes: callbacks can fire within ~1ms
    stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) + '\n');
    stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }) + '\n');
    stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' }) + '\n');
    stdin.end();
    for (let i = 0; i < 100 && written.length < 3; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(written.length, 3, 'every response still attempts its write after per-link errors');
    assert.deepEqual(written.map((c) => JSON.parse(c).id), [1, 2, 3]);
    await drainedPromise;
  });

  test('non-EPIPE stdout errors surface on stderr, EPIPE stays quiet', async (t) => {
    // The stdout 'error' consumer prevents the uncaught-event crash, but the
    // fail-soft posture is "never crash", not "never tell anyone": EPIPE
    // (client gone) is expected and quiet; EIO/ENOSPC mean output is being
    // LOST and must be diagnosable.
    const { serve } = await import('../server.js');
    const { PassThrough } = await import('node:stream');
    const { EventEmitter } = await import('node:events');
    const makeStdout = (code, message, counters) =>
      new class extends EventEmitter {
        write(chunk, cb) {
          counters.writes++;
          setTimeout(() => {
            const err = new Error(message);
            err.code = code;
            cb(err);
            counters.emits++; // real streams emit the event after the callback
            this.emit('error', err);
          }, 1);
          return true;
        }
      }();

    // Phase 1 — EIO: must surface on stderr.
    const consoleError = t.mock.method(console, 'error', () => {});
    const eioCounters = { writes: 0, emits: 0 };
    const eioStdin = new PassThrough();
    serve({ stdin: eioStdin, stdout: makeStdout('EIO', 'EIO: redirected file gone', eioCounters) });
    eioStdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) + '\n');
    eioStdin.end();
    for (let i = 0; i < 100 && consoleError.mock.callCount() === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(eioCounters.writes, 1, 'the request reached the fake stdout (non-vacuity)');
    assert.equal(consoleError.mock.callCount(), 1, 'exactly one stderr diagnostic for the EIO failure');
    assert.match(consoleError.mock.calls[0].arguments[0], /EIO/);
    assert.match(consoleError.mock.calls[0].arguments[0], /stdout error/);
    consoleError.mock.restore();

    // Phase 2 — EPIPE: must stay quiet. FRESH serve() + stdin: phase 1's
    // stdin is already ended, and a second write to it is rejected with
    // ERR_STREAM_WRITE_AFTER_END before ever reaching the server — the
    // assertion below would pass vacuously (both bots, round 2). The
    // writes/emits counters prove the request actually exercised the path:
    // if serve() dropped its 'error' consumer, the unconditional emit here
    // becomes an unhandled 'error' event and this test FAILS.
    const epipeCounters = { writes: 0, emits: 0 };
    const epipeStdout = makeStdout('EPIPE', 'EPIPE: client closed', epipeCounters);
    const epipeStdin = new PassThrough();
    serve({ stdin: epipeStdin, stdout: epipeStdout });
    const consoleError2 = t.mock.method(console, 'error', () => {});
    epipeStdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }) + '\n');
    // Same 100-iteration bound as phase 1 — identical 1ms-delayed fake; a
    // tighter budget here is a spurious-flake invitation under CI load.
    for (let i = 0; i < 100 && epipeCounters.emits < 1; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(epipeCounters.writes, 1, 'the request reached the fake stdout (non-vacuity)');
    assert.equal(epipeCounters.emits, 1, "the stream 'error' event fired (the guard was exercised)");
    assert.equal(consoleError2.mock.callCount(), 0, 'EPIPE is expected and must not spam stderr');
  });
});

// ---------------------------------------------------------------------------
// External review batch (§1.3, §4.1, §4.2, §8.2)
// ---------------------------------------------------------------------------

// §1.3: MCP tool annotations — hosts read these instead of scraping responses.
test('review §1.3: tools expose read-only annotations', () => {
  const r = handleRequest(req(74, 'tools/list'));
  for (const t of r.result.tools) {
    assert.equal(t.annotations?.readOnlyHint, true, `${t.name} must be annotated read-only`);
    assert.equal(t.annotations?.destructiveHint, false, `${t.name} must not be destructive`);
    assert.equal(t.annotations?.idempotentHint, true, `${t.name} is a deterministic read`);
    assert.equal(t.annotations?.openWorldHint, false, `${t.name} touches only the projects dir`);
  }
});

// §4.1: non-string project args are rejected with a field+type error BEFORE
// any lookup — the old coercion turned {x:1} into a "[object Object]" lookup
// (inert, but sloppy: a project literally named "[object Object]" could match).
test('review §4.1: non-string project arg -> field+type error, no coercion', () => {
  for (const bad of [{ x: 1 }, 42, null, ['a']]) {
    const r = handleRequest(req(70, 'tools/call', { name: 'get_project', arguments: { project: bad } }));
    assert.equal(r.result.isError, true, `project ${JSON.stringify(bad)} must be rejected`);
    assert.match(
      r.result.content[0].text,
      /^invalid parameter 'project': expected a string, received /
    );
  }
});

// §8.2: unexpected internal errors are sanitized in-band (error.message can
// carry paths/library internals); full detail goes to stderr — the MCP log
// channel. Expected domain errors keep their operator-facing messages.
test('review §8.2: internal errors are sanitized in-band, detail to stderr', () => {
  const origError = console.error;
  const logged = [];
  console.error = (...a) => logged.push(a.join(' '));
  try {
    const r = handleRequest(req(71, 'tools/call', { name: 'boom', arguments: {} }), {
      boom() {
        throw new Error('ECONNREFUSED /tmp/secret/path');
      },
    });
    assert.equal(r.result.isError, true);
    assert.ok(!r.result.content[0].text.includes('secret'), 'internals must not leak in-band');
    assert.match(r.result.content[0].text, /internal tool error/);
    assert.ok(
      logged.some((l) => l.includes('/tmp/secret/path')),
      'full detail must reach stderr for the operator'
    );
  } finally {
    console.error = origError;
  }
  // Domain errors still pass through verbatim (project-not-found UX, #14).
  const miss = handleRequest(req(72, 'tools/call', { name: 'get_project', arguments: { project: 'nope' } }));
  assert.equal(miss.result.isError, true);
  assert.match(miss.result.content[0].text, /no project matching 'nope'/);
});

// §4.2: targets are clamped like iterations — an unbounded array would
// otherwise inflate both compute and response size from one argument.
test('review §4.2: targets are clamped to MAX_TARGETS', () => {
  const targets = Array.from({ length: 150 }, (_, i) => i + 1);
  const r = handleRequest(req(73, 'tools/call', {
    name: 'monte_carlo',
    arguments: { project: '101', iterations: 50, targets },
  }));
  const payload = JSON.parse(r.result.content[0].text);
  assert.equal(payload.probabilityByTarget.length, 100, 'first 100 targets only');
});

// §4.2: an oversized input line is rejected BEFORE JSON.parse with a
// predictable protocol error (id null — the line is deliberately not
// parsed), and the process keeps serving. The limit is read dynamically so
// the test drives it via env instead of shipping a multi-MB fixture.
test('review §4.2: oversized line -> -32600 id null, server keeps serving', async () => {
  const written = [];
  const fakeStdout = {
    write(chunk, cb) {
      written.push(chunk);
      cb();
      return true;
    },
    on() {},
  };
  const { serve } = await import('../server.js');
  const { PassThrough } = await import('node:stream');
  const stdin = new PassThrough();
  const rl = serve({ stdin, stdout: fakeStdout });
  let drained = 0;
  rl.on('drained', () => {
    drained++;
  });
  process.env.PMO_MAX_MESSAGE_BYTES = '64';
  try {
    stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', note: 'x'.repeat(100) }) + '\n');
    stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }) + '\n');
    stdin.end();
    await new Promise((resolve) => stdin.on('end', resolve));
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  } finally {
    delete process.env.PMO_MAX_MESSAGE_BYTES;
  }
  assert.equal(drained, 1, 'chain must settle cleanly after the rejection');
  assert.equal(written.length, 2);
  const first = JSON.parse(written[0]);
  assert.equal(first.error.code, -32600);
  assert.equal(first.id, null, 'oversized line is not parsed, so id is null');
  assert.match(first.error.message, /PMO_MAX_MESSAGE_BYTES/);
  assert.equal(JSON.parse(written[1]).id, 2, 'server must keep serving after the rejection');
});

// ---------------------------------------------------------------------------
// External review batch 2 (§2.2 cancellation/progress/limits)
// ---------------------------------------------------------------------------

// §2.2: monte_carlo through serve() is cancellable. Both frames arrive in
// one chunk, so readline processes them synchronously in order: the run
// dispatches, yields at its first setImmediate, the cancellation lands,
// and the run rejects BEFORE the response microtasks continue. Per the MCP
// cancellation contract the server sends NO response for the cancelled
// request — and keeps serving.
test('review §2.2: notifications/cancelled stops an in-flight monte carlo (no response, server alive)', async () => {
  const written = [];
  const fakeStdout = {
    write(chunk, cb) {
      written.push(chunk);
      cb();
      return true;
    },
    on() {},
  };
  const { serve } = await import('../server.js');
  const { PassThrough } = await import('node:stream');
  const stdin = new PassThrough();
  const rl = serve({ stdin, stdout: fakeStdout });
  let drained = 0;
  rl.on('drained', () => {
    drained++;
  });
  stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'monte_carlo', arguments: { project: '101', iterations: 5000 } } }) + '\n');
  stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 10 } }) + '\n');
  stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'ping' }) + '\n');
  stdin.end();
  await new Promise((resolve) => stdin.on('end', resolve));
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(drained, 1, 'write chain must settle');
  const parsed = written.map((c) => JSON.parse(c));
  assert.equal(
    parsed.some((p) => p.id === 10),
    false,
    'a cancelled request must get NO response (MCP cancellation contract)'
  );
  assert.ok(
    parsed.some((p) => p.id === 11 && p.result),
    'server must keep serving after a cancellation'
  );
});

// §2.2: progress notifications ride the same ordered write chain when the
// client supplies a progressToken.
test('review §2.2: monte carlo emits notifications/progress when a progressToken is present', async () => {
  const written = [];
  const fakeStdout = {
    write(chunk, cb) {
      written.push(chunk);
      cb();
      return true;
    },
    on() {},
  };
  const { serve } = await import('../server.js');
  const { PassThrough } = await import('node:stream');
  const stdin = new PassThrough();
  serve({ stdin, stdout: fakeStdout });
  stdin.write(JSON.stringify({
    jsonrpc: '2.0', id: 20, method: 'tools/call',
    params: { name: 'monte_carlo', _meta: { progressToken: 'tok-1' }, arguments: { project: '101', iterations: 50 } }
  }) + '\n');
  stdin.end();
  await new Promise((resolve) => stdin.on('end', resolve));
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  const parsed = written.map((c) => JSON.parse(c));
  const notes = parsed.filter((p) => p.method === 'notifications/progress');
  assert.ok(notes.length >= 1, `expected progress notifications, got ${notes.length}`);
  for (const n of notes) {
    assert.equal(n.params.progressToken, 'tok-1');
    assert.equal(n.params.total, 50);
    assert.equal(n.id, undefined, 'notifications carry no id');
  }
  const last = parsed[parsed.length - 1];
  assert.equal(last.id, 20, 'the final frame must be the response');
  assert.equal(last.result.isError, false);
});

// §2.2: concurrency cap — MC requests beyond the cap get a predictable
// in-band busy rejection. All three frames arrive in one chunk: lines 1-2
// dispatch (inflight full) synchronously before any async continuation,
// so line 3 is deterministically rejected.
test('review §2.2: monte carlo beyond PMO_MAX_CONCURRENT is rejected in-band', async () => {
  const written = [];
  const fakeStdout = {
    write(chunk, cb) {
      written.push(chunk);
      cb();
      return true;
    },
    on() {},
  };
  const { serve } = await import('../server.js');
  const { PassThrough } = await import('node:stream');
  const stdin = new PassThrough();
  serve({ stdin, stdout: fakeStdout });
  process.env.PMO_MAX_CONCURRENT = '2';
  try {
    for (const id of [30, 31, 32]) {
      stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'monte_carlo', arguments: { project: '101', iterations: 100 } } }) + '\n');
    }
    stdin.end();
    await new Promise((resolve) => stdin.on('end', resolve));
    for (let i = 0; i < 50; i++) await new Promise((resolve) => setImmediate(resolve));
  } finally {
    delete process.env.PMO_MAX_CONCURRENT;
  }
  const parsed = written.map((c) => JSON.parse(c));
  const byId = Object.fromEntries(parsed.filter((p) => p.id != null).map((p) => [p.id, p]));
  assert.ok(byId[30] && byId[31], 'first two runs must be admitted');
  assert.ok(byId[32].result.isError, 'third run must be rejected');
  assert.match(byId[32].result.content[0].text, /server busy/);
  assert.match(byId[32].result.content[0].text, /PMO_MAX_CONCURRENT/);
});

// §2.2: PMO_MAX_ACTIVITIES — absurd workloads are rejected predictably,
// naming the limit, instead of running the process hot for minutes.
test('review §2.2: monte carlo above PMO_MAX_ACTIVITIES is rejected with the limit named', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmo-cap-'));
  const acts = Array.from({ length: 51 }, (_, i) => ({
    id: `a${i}`,
    duration: 1,
    predecessors: i === 0 ? [] : [`a${i - 1}`],
  }));
  fs.writeFileSync(path.join(dir, 'big.json'), JSON.stringify({ id: 'big', name: 'Big', activities: acts }));
  const prevDir = process.env.PMO_PROJECTS_DIR;
  process.env.PMO_PROJECTS_DIR = dir;
  try {
    process.env.PMO_MAX_ACTIVITIES = '50';
    const r = handleRequest(req(81, 'tools/call', { name: 'monte_carlo', arguments: { project: 'big', iterations: 100 } }));
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, /51 activities/);
    assert.match(r.result.content[0].text, /capped at 50 \(PMO_MAX_ACTIVITIES\)/);
  } finally {
    if (prevDir === undefined) delete process.env.PMO_PROJECTS_DIR;
    else process.env.PMO_PROJECTS_DIR = prevDir;
    delete process.env.PMO_MAX_ACTIVITIES;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// §2.2: PMO_MAX_ITERATIONS is read dynamically — env tightens the clamp.
test('review §2.2: PMO_MAX_ITERATIONS dynamically clamps the requested count', async () => {
  process.env.PMO_MAX_ITERATIONS = '10';
  try {
    const r = handleRequest(req(80, 'tools/call', { name: 'monte_carlo', arguments: { project: '101', iterations: 1000 } }));
    const payload = JSON.parse(r.result.content[0].text);
    assert.equal(payload.iterations, 10, 'requested 1000 must clamp to the env limit 10');
  } finally {
    delete process.env.PMO_MAX_ITERATIONS;
  }
});
