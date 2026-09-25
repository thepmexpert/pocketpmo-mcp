#!/usr/bin/env node
/**
 * pocketpmo-mcp — read-only MCP server exposing PocketPMO's forecast tools.
 *
 * Speaks newline-delimited MCP JSON-RPC over stdio (the same minimal framing
 * as waffle-os's McpStdioServer): initialize / ping / tools/list / tools/call.
 * Handler errors are reported in-band (isError: true); the process never dies
 * on bad input. Strictly read-only: no tool writes to any project data.
 */

import { createInterface } from 'node:readline';
import {
  pertStats,
  pertRollup,
  pertCompletionProbability,
  cpmNetwork,
  runMonteCarlo,
  runMonteCarloAsync,
  MonteCarloCancelledError,
  makeRng,
  evmMetrics,
  validateActivities,
  validDuration,
  validPertOrdering,
  round2
} from './lib/calculators.js';
import { listProjects, getProject, projectsDir } from './lib/projects.js';

const SERVER_INFO = { name: 'pocketpmo-mcp', version: '0.1.0' };
const PROTOCOL_VERSION = '2025-06-18';
// Tighter than the lib-level hard ceiling in lib/calculators.js (1,000,000):
// the server clamps agent-supplied iteration counts here BEFORE the lib sees
// them (garbage gets the default workload, not the maximum).
export const MAX_ITERATIONS = 20000;
// §4.2: targets are clamped like iterations — an unbounded array would
// otherwise inflate both compute and response size from a single argument.
export const MAX_TARGETS = 100;
// §2.2 defaults. All three are read DYNAMICALLY (env can tune them per
// request; same discipline as the cache caps) so tests and operators drive
// them without module-reload gymnastics.
const DEFAULT_MAX_ACTIVITIES = 5000;
const DEFAULT_MAX_CONCURRENT = 2;

const maxIterations = () => {
  const raw = Number(process.env.PMO_MAX_ITERATIONS);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : MAX_ITERATIONS;
};
const maxActivities = () => {
  const raw = Number(process.env.PMO_MAX_ACTIVITIES);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_MAX_ACTIVITIES;
};
const maxConcurrent = () => {
  const raw = Number(process.env.PMO_MAX_CONCURRENT);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_MAX_CONCURRENT;
};
const maxTargets = () => {
  const raw = Number(process.env.PMO_MAX_TARGETS);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : MAX_TARGETS;
};

// §1.3: MCP tool annotations. All tools are pure reads over the projects
// directory (deterministic: monte_carlo is seeded by default), so every
// tool carries the same read-only/idempotent hints — hosts read these
// instead of scraping `read_only` out of every response payload.
const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
};

// ---------------------------------------------------------------------------
// Tool surface
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'list_projects',
    description:
      'List PocketPMO projects available to the server (from export files).',
    annotations: READ_ONLY_ANNOTATIONS,
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'get_project',
    description: 'Get a project summary: schedule, budget, and data-shape counts.',
    annotations: READ_ONLY_ANNOTATIONS,
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string', description: 'Project id or name' } },
      required: ['project']
    }
  },
  {
    name: 'pert_estimate',
    description:
      'PERT three-point estimates per activity plus roll-up and completion probability against an optional target duration (days). ASSUMPTION: the variance roll-up assumes activity durations are independent — correlated durations (shared resources, common risks) make the true project variance larger, so treat the roll-up and completion probability as optimistic in that case.',
    annotations: READ_ONLY_ANNOTATIONS,
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        targetDuration: { type: 'number', description: 'Target duration in days' }
      },
      required: ['project']
    }
  },
  {
    name: 'critical_path',
    description:
      'CPM analysis: early/late start-finish, float, critical activities, project duration.',
    annotations: READ_ONLY_ANNOTATIONS,
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string' } },
      required: ['project']
    }
  },
  {
    name: 'monte_carlo',
    description:
      'Monte Carlo schedule simulation: duration percentiles, mean, stdDev, probability of finishing by target dates, and criticality — criticalActivityFrequency is the per-activity probability of sitting on the critical path in a simulation run (criticalPathFrequency is a deprecated alias with the same per-activity shares; whole-path frequencies are not reported because simulated path identity is unstable). Deterministic (seeded). Targets beyond the first 100 are ignored.',
    annotations: READ_ONLY_ANNOTATIONS,
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        iterations: { type: 'number', description: 'Default 2000, max 20000 (PMO_MAX_ITERATIONS)' },
        targets: {
          type: 'array',
          items: { type: 'number' },
          description: 'Target durations (days) for completion probability. Beyond the cap (default 100; PMO_MAX_TARGETS) targets are ignored.'
        },
        seed: { type: 'number', description: 'RNG seed for reproducible runs (default 42)' }
      },
      required: ['project']
    }
  },
  {
    name: 'evm_metrics',
    description:
      'Earned value metrics: PV, EV, AC, CPI, SPI, EAC, VAC and timeline percentage. SEMANTICS: AC is DERIVED (milestone cost x progress under the PocketPMO export model), not ledger-recorded spend; costData.expenses are not incorporated.',
    annotations: READ_ONLY_ANNOTATIONS,
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        statusDate: { type: 'string', description: 'ISO date, defaults to today' }
      },
      required: ['project']
    }
  },
  {
    name: 'risk_register',
    description:
      'Project risks scored by probability x impact, ranked highest first.',
    annotations: READ_ONLY_ANNOTATIONS,
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string' } },
      required: ['project']
    }
  }
];

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

// §8.2: expected domain failures (project not found, empty projects dir,
// no activities) throw this marker so the dispatch catch-all can pass their
// SAFE, operator-facing messages through verbatim. Anything ELSE reaching
// the catch-all is an internal bug whose message may carry filesystem paths
// or library internals — that gets logged to stderr (the MCP log channel)
// and a generic message in-band.
class DomainError extends Error {}

function loadOrFail(idOrName) {
  // §4.1: reject non-string project args with a field+type error BEFORE any
  // lookup. The old coercion turned {x:1} into a "[object Object]" lookup —
  // inert, but a project literally named "[object Object]" could match, and
  // the error named neither the field nor the expected type.
  if (typeof idOrName !== 'string') {
    throw new DomainError(
      `invalid parameter 'project': expected a string, received ${idOrName === null ? 'null' : typeof idOrName}`
    );
  }
  const { project, error } = getProject(idOrName);
  if (error) throw new DomainError(error);
  return project;
}

const HANDLERS = {
  list_projects() {
    const { projects, warnings } = listProjects();
    // `dir` stays server-side: it is the operator's configured location and
    // must not leak into MCP client responses (same rationale as #3).
    return { projects, warnings, read_only: true };
  },

  get_project(args) {
    const p = loadOrFail(args.project);
    return {
      id: p.id,
      name: p.name,
      status: p.status ?? null,
      startDate: p.startDate ?? null,
      endDate: p.endDate ?? null,
      budget: p.budget ?? null,
      spent: p.spent ?? null,
      manager: p.manager ?? null,
      counts: {
        activities: Array.isArray(p.activities) ? p.activities.length : 0,
        risks: Array.isArray(p.risks) ? p.risks.length : 0,
        milestones: Array.isArray(p.evmData?.milestones) ? p.evmData.milestones.length : 0,
        expenses: Array.isArray(p.costData?.expenses) ? p.costData.expenses.length : 0
      },
      read_only: true
    };
  },

  pert_estimate(args) {
    const p = loadOrFail(args.project);
    const acts = Array.isArray(p.activities) ? p.activities : [];
    const issues = [];
    if (!acts.length) throw new DomainError(`project '${args.project}' has no activities`);
    const detailed = acts.map((a) => {
      const o = a.distribution?.optimistic ?? (a.duration ?? NaN) * 0.7;
      const m = a.distribution?.mostLikely ?? a.duration ?? NaN;
      const pe = a.distribution?.pessimistic ?? (a.duration ?? NaN) * 1.5;
      if (
        !validDuration(a.duration) &&
        !(a.distribution && typeof a.distribution.mostLikely === 'number')
      ) {
        issues.push({ activityId: a.id ?? null, field: 'duration', message: 'no usable duration; pert stats will be NaN', received: a.duration ?? null });
      }
      // Raw distribution triples bypass the app's edit-mode validation, so
      // ordering/positivity violations surface here as issues — checked on
      // the EFFECTIVE values (after duration-derived fallbacks), via the
      // same shared predicate pertStats uses.
      if (!validPertOrdering(o, m, pe)) {
        issues.push({
          activityId: a.id ?? null,
          field: 'distribution',
          message: `estimates violate optimistic <= mostLikely <= pessimistic with all values finite >= 0; pert stats will be NaN`,
          received: { optimistic: o, mostLikely: m, pessimistic: pe }
        });
      }
      const stats = pertStats(o, m, pe);
      // Full precision flows into the rollup (which rounds once at its own
      // boundary); per-activity display values are rounded here.
      return {
        id: a.id,
        name: a.name ?? a.id,
        ...stats
      };
    });
    const rollup = pertRollup(detailed);
    for (const id of rollup.skipped) {
      issues.push({
        activityId: id,
        field: 'statistics',
        message: `activity excluded from roll-up: expected/variance are not finite (invalid or missing estimates)`
      });
    }
    const { skipped: _skipped, ...rollupStats } = rollup;
    // Rollup has consumed the raw per-activity stats; round the activity
    // display values now, at the response boundary.
    const detailedDisplay = detailed.map((s) => ({
      ...s,
      expected: round2(s.expected),
      variance: round2(s.variance),
      stdDev: round2(s.stdDev)
    }));
    const result = {
      project: p.name,
      activities: detailedDisplay,
      rollup: rollupStats,
      read_only: true,
      issues
    };
    if (args.targetDuration !== undefined) {
      result.completionProbability = {
        targetDuration: Number(args.targetDuration),
        probability: pertCompletionProbability(rollup.expected, rollup.stdDev, Number(args.targetDuration))
      };
    }
    return result;
  },

  critical_path(args) {
    const p = loadOrFail(args.project);
    const acts = Array.isArray(p.activities) ? p.activities : [];
    if (!acts.length) throw new DomainError(`project '${args.project}' has no activities`);
    const issues = validateActivities(acts);
    const net = cpmNetwork(structuredClone(acts));
    return {
      project: p.name,
      ...(issues.length ? { issues } : {}),
      ...net,
      criticalActivities: net.activities.filter((a) => a.critical).map((a) => a.id),
      read_only: true
    };
  },

  monte_carlo(args, context) {
    const p = loadOrFail(args.project);
    const acts = Array.isArray(p.activities) ? p.activities : [];
    if (!acts.length) throw new DomainError(`project '${args.project}' has no activities`);
    // §2.2: reject absurd workloads PREDICTABLY instead of running the
    // process hot for minutes — the limit names itself so the caller can
    // raise it consciously (env) or split the network.
    const activityCap = maxActivities();
    if (acts.length > activityCap) {
      throw new DomainError(
        `project '${args.project}' has ${acts.length} activities; monte carlo is capped at ${activityCap} (PMO_MAX_ACTIVITIES) — split the network or raise the limit`
      );
    }
    // Coerce → default, floor fractional, clamp to [1, maxIterations()].
    // runMonteCarlo throws on non-integers, so floor before it sees the value.
    // Default (2000) only for non-finite input — a floored finite value like
    // 0.5 → 0 must clamp to 1, not silently become the full default.
    const requested = Number(args.iterations);
    const floored = Number.isFinite(requested) ? Math.floor(requested) : 2000;
    const iterations = Math.min(Math.max(floored, 1), maxIterations());
    // ?? not ||: seed 0 is a legitimate seed — `Number(0) || 42` silently
    // replaced it with 42. makeRng itself guards the LCG-zero edge
    // (state 0 produces an all-zero sequence, so 0 maps to state 1 there).
    const seedArg = args.seed === undefined || args.seed === null ? undefined : Number(args.seed);
    const seed =
      seedArg !== undefined && Number.isFinite(seedArg)
        ? seedArg
        : 42;
    const runArgs = {
      activities: structuredClone(acts),
      iterations,
      rng: makeRng(seed),
      // §4.2: clamped like iterations (documented in the tool description —
      // "first 100 used"); items are still coerced/reported downstream.
      targets: Array.isArray(args.targets) ? args.targets.slice(0, maxTargets()) : []
    };
    // §2.2: with a request context (serve() provides one for every
    // monte_carlo call), the run is cancellable and yields to the event
    // loop; progress rides the MCP progress notification when the client
    // supplied a progressToken. Direct handleRequest calls without a
    // context keep the synchronous path (identical results).
    if (context && context.signal) {
      return runMonteCarloAsync({
        ...runArgs,
        signal: context.signal,
        onProgress:
          context.progressToken !== undefined && context.progressToken !== null
            ? (progress, total) => context.emitProgress(progress, total)
            : undefined
      }).then((result) => ({ project: p.name, ...result, read_only: true }));
    }
    const result = runMonteCarlo(runArgs);
    return { project: p.name, ...result, read_only: true };
  },

  evm_metrics(args) {
    const p = loadOrFail(args.project);
    const result = evmMetrics({
      budget: p.evmData?.projectBudget ?? p.budget,
      milestones: p.evmData?.milestones ?? [],
      inProgressValue: p.evmData?.inProgressValue ?? 50,
      startDate: p.startDate,
      endDate: p.endDate,
      statusDate: args.statusDate ?? new Date().toISOString().slice(0, 10)
    });
    return { project: p.name, ...result, read_only: true };
  },

  risk_register(args) {
    const p = loadOrFail(args.project);
    const risks = (Array.isArray(p.risks) ? p.risks : [])
      .map((r) => ({
        id: r.id ?? null,
        name: r.name ?? r.title ?? 'unnamed risk',
        probability: r.probability ?? null,
        impact: r.impact ?? null,
        score:
          typeof r.probability === 'number' && typeof r.impact === 'number'
            ? r.probability * r.impact
            : null,
        status: r.status ?? null,
        owner: r.owner ?? null,
        mitigation: r.mitigation ?? null
      }))
      .sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
    return { project: p.name, risks, read_only: true };
  }
};

// ---------------------------------------------------------------------------
// JSON-RPC framing
// ---------------------------------------------------------------------------

function textResult(payload) {
  // §4.2: machine-readable payloads ship COMPACT — pretty-printing was
  // pure response bloat for JSON consumers (every MCP client parses this
  // text as JSON; indentation helps no one).
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false };
}

function errorResult(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

export function handleRequest(request, handlers = HANDLERS, context = null) {
  if (!request || typeof request !== 'object') {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request: expected an object' } };
  }
  const method = request.method ?? '';
  const id = request.id;
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO
      }
    };
  }
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (typeof method === 'string' && method.startsWith('notifications/')) return null;
  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  }
  if (method === 'tools/call') {
    const params = request.params ?? {};
    if (!params || typeof params !== 'object') {
      return { jsonrpc: '2.0', id, error: { code: -32602, message: 'invalid params: expected an object' } };
    }
    // Object.hasOwn rejects inherited properties ('constructor',
    // 'toString', 'hasOwnProperty', '__proto__'), which a plain lookup
    // would resolve off Object.prototype — a malicious client could
    // invoke inherited functions instead of getting 'unknown tool'.
    if (typeof params.name !== 'string' || !Object.hasOwn(handlers, params.name)) {
      return { jsonrpc: '2.0', id, result: errorResult(`unknown tool: ${params.name}`) };
    }
    // Enforce the declared inputSchema contract (required params only —
    // the handlers own type coercion and clamping). MCP clients rely on
    // the schema for validation; without this gate the contract is
    // one-sided and a missing required param fails deep inside a handler
    // with a less helpful error.
    const tool = TOOLS.find((t) => t.name === params.name);
    const args = params.arguments ?? {};
    const missing = ((tool && tool.inputSchema.required) || []).filter(
      (k) => args[k] === undefined
    );
    if (missing.length) {
      return {
        jsonrpc: '2.0',
        id,
        result: errorResult(`missing required parameter(s): ${missing.join(', ')}`)
      };
    }
    const handler = handlers[params.name];
    try {
      const value = handler(args, context);
      // §2.2: monte_carlo with a request context returns a PROMISE (the
      // cancellable, yielding run). Same response envelope, settled async —
      // serve() tracks the promise so notifications/cancelled can reach it.
      if (value && typeof value.then === 'function') {
        return value.then(
          (payload) => ({ jsonrpc: '2.0', id, result: textResult(payload) }),
          (error) => {
            // Cancellation propagates: serve() owns the "no response" side
            // of the MCP cancellation contract.
            if (error instanceof MonteCarloCancelledError) throw error;
            if (error instanceof DomainError) {
              return { jsonrpc: '2.0', id, result: errorResult(error.message) };
            }
            console.error(`pocketpmo-mcp: internal error in tool '${params.name}':`, error);
            return { jsonrpc: '2.0', id, result: errorResult('internal tool error; see server logs') };
          }
        );
      }
      return { jsonrpc: '2.0', id, result: textResult(value) };
    } catch (error) {
      // §8.2: expected domain errors keep their safe operator-facing
      // messages; anything else is an internal bug — full detail to stderr
      // (the MCP log channel, never the protocol channel), generic message
      // in-band so paths/internals cannot leak to clients.
      if (error instanceof DomainError) {
        return { jsonrpc: '2.0', id, result: errorResult(error.message) };
      }
      console.error(`pocketpmo-mcp: internal error in tool '${params.name}':`, error);
      return { jsonrpc: '2.0', id, result: errorResult('internal tool error; see server logs') };
    }
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } };
}

export function serve({ stdin = process.stdin, stdout = process.stdout } = {}) {
  const rl = createInterface({ input: stdin, terminal: false });
  // Backpressure (review batch 5): when stdout's kernel buffer is full,
  // Response writes are chained so responses stay IN ORDER: the next
  // response is issued only after the previous write's COMPLETION CALLBACK
  // runs. Links resolve on the callback, never on write()'s boolean return
  // — on macOS, pipes are async and `true` does not mean flushed, so a
  // link resolved on the return value would let direct-run process.exit(0)
  // truncate buffered output. Write errors (EPIPE when the client closes
  // the pipe) are delivered TO the callback, consumed there, and the chain
  // continues with later responses; a destroyed stream settles its pending
  // callbacks, so the chain cannot wedge.
  let tail = Promise.resolve();
  let pending = 0; // admitted responses not yet fully written
  const MAX_PENDING = 1000;
  const writeResponse = (payload) =>
    new Promise((resolve) => {
      try {
        stdout.write(JSON.stringify(payload) + '\n', () => {
          pending--;
          if (pending < MAX_PENDING && !inputClosed) rl.resume(); // unblock paused input
          resolve();
        });
      } catch {
        pending--; // synchronous write error: fail-soft, keep serving
        if (pending < MAX_PENDING && !inputClosed) rl.resume();
        resolve();
      }
    });
  // A failed async write fires the completion callback AND emits 'error' on
  // the stream (verified: a Writable whose _write fails asynchronously does
  // both). Without a listener, an async EPIPE (client closed the pipe) is
  // an uncaught 'error' event that kills the process. The chain already
  // settles per-link via callbacks — consuming the event here is what keeps
  // the process alive to reach its clean exit. Minimal write-only sinks
  // (only .write — the previous documented contract) have no .on; they
  // forgo the crash guard by construction.
  if (typeof stdout.on === 'function') {
    stdout.on('error', (err) => {
      // stderr is the MCP log channel, never the protocol channel — safe
      // even when stdout is fully broken. EPIPE (client gone) is expected
      // and quiet; anything else (EIO, ENOSPC on a redirected file) means
      // output is being LOST and must be diagnosable, not swallowed — the
      // fail-soft posture is "never crash", not "never tell anyone".
      if (err && err.code !== 'EPIPE') {
        console.error(`pocketpmo-mcp: stdout error: ${err.code ?? ''} ${err.message ?? err}`.trimEnd());
      }
    });
  }
  // Admission control: past MAX_PENDING, PAUSE reading stdin. Backpressure
  // then propagates at the kernel level — the client's pipe buffer fills
  // and ITS writes block — so server memory stays bounded no matter how
  // fast the client pipelines. Requests past the cap are dropped without a
  // response: a pipeliner has already violated the sequential-request
  // convention MCP hosts follow, and a sequential client never reaches
  // this path. Writing a special "overloaded" error inline instead would
  // jump the queue — chained responses are issued from microtasks, so an
  // inline stdout.write overtakes responses to requests the server
  // received EARLIER (cubic round 2 verified this against the real
  // serve()). Reading resumes when the backlog drains below the cap.
  const respond = (id, payload) => {
    if (pending >= MAX_PENDING) {
      rl.pause();
      return;
    }
    pending++;
    tail = tail.then(() => writeResponse(payload));
  };
  // §4.2: input-line cap, read dynamically (env-tunable per use — the same
  // discipline as the cache caps). readline has already buffered the line
  // by the time this fires, but the cap keeps parse + dispatch from EVER
  // seeing oversized input: the expensive part (JSON.parse of an arbitrary
  // blob) is what gets refused.
  const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024;
  const maxMessageBytes = () => {
    const raw = Number(process.env.PMO_MAX_MESSAGE_BYTES);
    return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_MAX_MESSAGE_BYTES;
  };
  // §2.2: in-flight cancellable calculations, keyed by request id.
  // notifications/cancelled aborts the matching entry; the concurrency cap
  // bounds how many Monte Carlo runs can be live at once (a pipelining
  // client stacking dozens of 20k-iteration runs would otherwise queue
  // minutes of work with no bound).
  const inflight = new Map();
  const entryFor = (id) => (id !== undefined && id !== null ? inflight.get(id) : null);

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const limit = maxMessageBytes();
    // Measure the UNTRIMMED line (bot sweep round 1, both reviewers): trim()
    // strips unbounded whitespace, so a whitespace-padded oversized line
    // would sail past the cap and still reach JSON.parse.
    if (Buffer.byteLength(line) > limit) {
      // id null: the line is deliberately not parsed, so the request id is
      // unknowable (JSON-RPC allows id null for undetectable ids).
      respond(null, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: `invalid request: line exceeds ${limit} bytes (PMO_MAX_MESSAGE_BYTES)` }
      });
      return;
    }
    let request;
    try {
      request = JSON.parse(trimmed);
    } catch (error) {
      respond(null, { jsonrpc: '2.0', id: null, error: { code: -32700, message: `parse error: ${error.message}` } });
      return;
    }
    // §2.2: cancellation rides a NOTIFICATION, so it must be intercepted
    // before the generic notifications/ suppression in handleRequest.
    if (
      request &&
      typeof request === 'object' &&
      request.method === 'notifications/cancelled'
    ) {
      const rid = request.params?.requestId;
      const entry = entryFor(rid);
      if (entry && !entry.settled) entry.controller.abort();
      return;
    }
    // §2.2: concurrency cap — a monte_carlo call beyond the cap gets a
    // PREDICTABLE in-band rejection instead of silently queueing minutes
    // of work behind the runs already live.
    const isMonteCarlo =
      request.method === 'tools/call' &&
      request.params?.name === 'monte_carlo';
    if (isMonteCarlo && inflight.size >= maxConcurrent()) {
      respond(request.id, {
        jsonrpc: '2.0',
        id: request.id,
        result: errorResult(
          `server busy: ${inflight.size} monte carlo calculation(s) in flight (PMO_MAX_CONCURRENT=${maxConcurrent()}); retry when they complete or cancel one`
        )
      });
      return;
    }
    // §2.2: per-request context for monte_carlo — abort signal (wired to
    // notifications/cancelled via the inflight map) and the progress
    // notification emitter. Progress notifications join the SAME ordered
    // write chain as responses (an inline stdout.write would overtake
    // earlier responses — batch-6 round-sweep lesson) and are DROPPED
    // under admission pressure: they are expendable, responses are not.
    let context = null;
    if (isMonteCarlo && request.id !== undefined && request.id !== null) {
      const controller = new AbortController();
      const progressToken = request.params?._meta?.progressToken;
      context = {
        signal: controller.signal,
        progressToken,
        emitProgress: (progress, total) => {
          if (pending >= MAX_PENDING) return;
          pending++;
          tail = tail.then(() =>
            writeResponse({
              jsonrpc: '2.0',
              method: 'notifications/progress',
              params: { progressToken, progress, total }
            })
          );
        }
      };
      inflight.set(request.id, { controller, settled: false });
    }
    const response = handleRequest(request, HANDLERS, context);
    if (response && typeof response.then === 'function') {
      const rid = request.id;
      response.then(
        (res) => {
          const entry = entryFor(rid);
          if (entry) {
            entry.settled = true;
            inflight.delete(rid);
          }
          respond(rid, res);
        },
        (error) => {
          const entry = entryFor(rid);
          if (entry) {
            entry.settled = true;
            inflight.delete(rid);
          }
          // MCP cancellation contract: the receiver SHOULD NOT send a
          // response for a cancelled request — the client asked to stop.
          if (error instanceof MonteCarloCancelledError) return;
          console.error(`pocketpmo-mcp: internal error in tool '${request.params?.name}':`, error);
          respond(rid, {
            jsonrpc: '2.0',
            id: rid,
            result: errorResult('internal tool error; see server logs')
          });
        }
      );
      return;
    }
    if (response === null) return;
    respond(response.id, response);
  });
  // HandleRequest is synchronous, but responses queue in the chain while
  // stdout applies backpressure — the direct-run exit path must await it.
  // inputClosed gates rl.resume(): resume() on a closed Interface throws
  // ERR_USE_AFTER_CLOSE (a capped-then-closed client fires write callbacks
  // after close), which would crash via the very callbacks meant to keep
  // the process alive.
  let inputClosed = false;
  rl.on('close', () => {
    inputClosed = true;
    tail.catch(() => {}).then(() => rl.emit('drained'));
  });
  return rl;
}

const isDirectRun =
  process.argv[1] && (process.argv[1].endsWith('server.js') || process.argv[1].endsWith('pocketpmo-mcp'));

if (isDirectRun) {
  const rl = serve();
  // Keep the process alive on stdio; exit only after every queued response
  // has actually been written (process.exit here would truncate whatever is
  // still waiting for drain — 10k pings into an unread pipe lost ~83% of
  // responses before this await).
  process.stdin.on('end', () => {
    rl.on('drained', () => process.exit(0));
  });
}
