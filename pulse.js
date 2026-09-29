#!/usr/bin/env node
/**
 * pulse.js — pocketpmo email pulse worker (one-shot).
 *
 * Loads projects (PMO_PROJECTS_DIR, shared with the MCP server's fail-soft
 * loader) plus a subscriptions roster (PULSE_SUBSCRIPTIONS, default
 * ./subscriptions.json), computes each subscriber's ranked "needs you"
 * digest + chases, then either:
 *   • dry-run (DEFAULT): writes rendered HTML/text to PULSE_OUT_DIR —
 *     sends nothing; or
 *   • real send: only when PULSE_SEND=1 AND the selected provider's
 *     credentials are set (PULSE_PROVIDER=agentmail → AGENTMAIL_API_KEY +
 *     AGENTMAIL_INBOX_ID; default postmark → POSTMARK_SERVER_TOKEN; see
 *     lib/pulse/provider.js isSendEnabled). Credentials arrive via a
 *     Paperclip secret proposal / the system keychain — never git, never
 *     .env files, never docs.
 *
 * Cadence guard (defense in depth for cron misconfig): "daily" subscribers
 * are served Mon–Fri only, "weekly" subscribers on Mondays. PULSE_FORCE=1
 * overrides for staging tests. The guard — and every date label, the
 * dry-run folder, and overdue-day math — reads ONE calendar day: the
 * PULSE_TZ day when set (IANA name), else the host's local day, because
 * the documented crontab fires in host-local time (lib/pulse/calendar.js
 * re-keys `now` onto that calendar; cubic PR #20 R2). Never crashes on
 * bad project data (the pocketpmo-mcp convention): malformed projects and
 * per-subscriber errors are warnings; exit code is 0 with a JSON summary
 * on stdout. Exit 1 is reserved for "no run was possible" (roster
 * unreadable / unexpected top-level error) so cron observability catches
 * a dead pipeline.
 *
 * Scheduler (CTO decision, recorded in docs/pulse.md): host launchd/cron
 * on the Mac Mini — the slack-bridge / trello-sync precedent. This is a
 * one-shot process; there is no resident scheduler to monitor.
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadAllProjects, projectsDir } from './lib/projects.js';
import { loadSubscriptions } from './lib/pulse/subscriptions.js';
import { resolvePulseTimeZone, calendarAnchor } from './lib/pulse/calendar.js';
import { buildDigestItems, MAX_ITEMS, MAX_CHASES } from './lib/pulse/needs.js';
import { renderDigest } from './lib/pulse/render.js';
import { buildRitualBrief, resolveRitualBriefKind } from './lib/pulse/ritual.js';
import { renderRitualBrief } from './lib/pulse/render-ritual.js';
import { isSendEnabled, resolveProvider, sendViaPostmark, sendViaAgentmail, writeDryRun } from './lib/pulse/provider.js';

function envDefault(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function log(message) {
  try {
    process.stderr.write(`pulse: ${message}\n`);
  } catch {}
}

/** Weekday guard: 0=Sun..6=Sat. Daily → Mon–Fri; weekly → Mon;
 * ritual → Mon + Fri (the two PM ritual days, TPMAAAA-2370). */
export function cadenceDue(cadence, now) {
  const day = now.getUTCDay();
  if (cadence === 'weekly') return day === 1;
  if (cadence === 'ritual') return day === 1 || day === 5;
  return day >= 1 && day <= 5;
}

function collectProjects() {
  const projects = [];
  const load = loadAllProjects((project) => {
    // Bounded retention for a ONE-SHOT process: only fields the pulse core
    // reads are copied, so a 10 MB export with a huge cost ledger cannot
    // inflate the pulse's footprint. Everything else is garbage-collected
    // with the scan.
    projects.push({
      id: project.id,
      name: project.name,
      status: project.status,
      manager: project.manager,
      projectManager: project.projectManager,
      owner: project.owner,
      // Retain only primitive numeric/string progress (cubic PR #21 R1 P2):
      // buildStatusDraft does String(progress), so a malformed object with a
      // hostile toString would throw inside the brief build and drop this
      // subscriber's Friday ritual instead of failing soft.
      progress: typeof project.progress === 'number' || typeof project.progress === 'string'
        ? project.progress
        : undefined,
      activities: project.activities,
      evmData: project.evmData,
      risks: project.risks,
      decisions: project.decisions,
      asks: project.asks,
      chases: project.chases,
      followUps: project.followUps
    });
  });
  return { projects, load };
}

function buildContext(now, generatedAt) {
  return {
    now,
    // The REAL generation instant (dry-run .json meta) — distinct from the
    // calendar-anchored `now` the labels and day math read.
    generatedAt,
    fromName: envDefault('PULSE_FROM_NAME', 'PocketPMO Pulse'),
    fromEmail: envDefault('PULSE_FROM_EMAIL', 'pulse@pocketpmo.com'),
    unsubscribeUrl: envDefault('PULSE_UNSUBSCRIBE_URL', ''),
    outDir: path.resolve(envDefault('PULSE_OUT_DIR', 'pulse-out')),
    sendEnabled: isSendEnabled(process.env)
  };
}

async function deliver(ctx, subscriber, digest) {
  if (!ctx.sendEnabled) {
    const result = writeDryRun({
      outDir: ctx.outDir,
      now: ctx.now,
      generatedAt: ctx.generatedAt,
      subscriber,
      digest
    });
    return { action: 'dry-run', result };
  }
  const from = `${ctx.fromName} <${ctx.fromEmail}>`;
  const provider = resolveProvider(process.env);
  const result = provider === 'agentmail'
    ? await sendViaAgentmail({
        apiKey: process.env.AGENTMAIL_API_KEY,
        inboxId: process.env.AGENTMAIL_INBOX_ID,
        from,
        to: subscriber.email,
        subject: digest.subject,
        html: digest.html,
        text: digest.text
      })
    : provider === 'postmark'
      ? await sendViaPostmark({
          token: process.env.POSTMARK_SERVER_TOKEN,
          from,
          to: subscriber.email,
          subject: digest.subject,
          html: digest.html,
          text: digest.text
        })
      : { ok: false, error: 'invalid PULSE_PROVIDER: unknown value keeps the gate closed' };
  return { action: 'send', result };
}

export async function runPulse(env = process.env) {
  // The shared loader (lib/projects.js) and the send gate read the live
  // process.env dynamically. Overlay the MANAGED keys — the union of the
  // managed namespace present in the `env` argument AND in the live
  // process.env — so the CLI's environment and tests driving runPulse with
  // a plain object configure the whole pipeline, not just this module.
  // R4 (P1): the union matters for the reverse direction too. Keying the
  // overlay on `env` alone left ambient PULSE_SEND/POSTMARK_SERVER_TOKEN
  // live whenever the supplied env OMITTED the send settings, so a test or
  // embedded caller inherited a real-send configuration from its shell.
  // Keys absent (or undefined) in `env` are CLEARED for the duration of the
  // run — delete, not `= undefined`, which Node coerces to the string
  // "undefined". SNAPSHOT + RESTORE in a finally: one run must never leak
  // its config into the next (back-to-back runPulse calls, e.g. in tests,
  // would otherwise inherit a previous run's PULSE_SEND/token — exactly
  // the kind of state bleed that turns a dry-run into a surprise send).
  const MANAGED_KEY = /^(PMO_|PULSE_|POSTMARK_|AGENTMAIL_)/;
  const managedKeys = [...new Set([...Object.keys(env), ...Object.keys(process.env)])].filter((key) => MANAGED_KEY.test(key));
  const snapshot = {};
  for (const key of managedKeys) {
    snapshot[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  try {
    return await pulseBody(env);
  } finally {
    for (const key of managedKeys) {
      if (snapshot[key] === undefined) delete process.env[key];
      else process.env[key] = snapshot[key];
    }
  }
}

async function pulseBody(env) {
  const tz = resolvePulseTimeZone(env);
  if (tz.warning) log(tz.warning);
  const nowReal = (() => {
    const override = env.PULSE_DATE ? new Date(env.PULSE_DATE) : new Date();
    return Number.isNaN(override.getTime()) ? new Date() : override;
  })();
  // ONE calendar day for the whole run (cubic PR #20 R2): the documented
  // crontab fires host-local, so the cadence guard, date labels, dry-run
  // folder, and overdue-day math must all read the PULSE_TZ (default
  // host-local) calendar — not UTC. calendarAnchor re-keys `now` onto that
  // calendar; calendarWeekday/labels/day-math downstream then agree.
  const now = calendarAnchor(nowReal, tz.timeZone);
  const ctx = buildContext(now, nowReal);
  const subscriptionsPath = path.resolve(
    env.PULSE_SUBSCRIPTIONS || 'subscriptions.json'
  );

  const roster = loadSubscriptions(subscriptionsPath);
  for (const warning of roster.warnings) log(warning);
  if (roster.error) {
    log(roster.error);
    return {
      ok: false,
      error: roster.error,
      sent: 0,
      written: 0,
      skipped: 0,
      warnings: roster.warnings
    };
  }

  const summary = {
    ok: true,
    dryRun: !ctx.sendEnabled,
    recipients: roster.subscribers.length,
    sent: 0,
    written: 0,
    skipped: 0,
    errors: [],
    warnings: [...roster.warnings]
  };
  if (tz.warning) summary.warnings.push(tz.warning);

  // Lazy + cached (CodeRabbit PR #20 R1): the portfolio is scanned once,
  // on the FIRST due subscriber. Skipped-only runs (weekend, weekly
  // cadence) never touch the projects directory. Per-subscriber fatal
  // handling is preserved: an unreadable projects dir records an error for
  // EVERY due subscriber rather than returning early, so the summary shows
  // exactly who was affected.
  let projects = null;
  let load = null;
  // The ritual brief kind (monday/friday) is resolved ONCE per run so a
  // PULSE_BRIEF typo warns once, not once per subscriber.
  let ritualBrief = null;
  for (const subscriber of roster.subscribers) {
    let outcome;
    try {
      // R2 (P1): require the EXACT value '1' — a truthy check let a
      // misconfigured PULSE_FORCE=0 weekend production run send digests.
      if (env.PULSE_FORCE !== '1' && !cadenceDue(subscriber.cadence, now)) {
        summary.skipped += 1;
        continue;
      }
      if (subscriber.cadence === 'ritual' && ritualBrief === null) {
        // PULSE_BRIEF is a staging/forced-run override (cubic PR #21 R1 P1):
        // an ambient value must not turn a production Monday into a Friday
        // brief, so only runs forced with exact '1' may read it.
        ritualBrief = resolveRitualBriefKind(env.PULSE_FORCE === '1' ? env : {}, now);
        if (ritualBrief.warning) summary.warnings.push(ritualBrief.warning);
      }
      if (load === null) {
        ({ projects, load } = collectProjects());
        if (!load.fatal) {
          for (const warning of load.warnings) {
            const line = `skipped project file: ${warning}`;
            if (!summary.warnings.includes(line)) summary.warnings.push(line);
          }
        }
      }
      if (load.fatal) {
        // An unreadable projects directory is a portfolio-level failure:
        // every digest would be silently empty, which is worse than a
        // recorded error. Per-file malformed projects still degrade to
        // warnings inside load (never fatal) — fail-soft holds. R2 (P1):
        // mark the summary failed before throwing so the run is observable
        // (ok=false + exit 1) for cron even though the per-subscriber
        // catch keeps recording errors for every due subscriber.
        summary.ok = false;
        throw new Error(load.fatal);
      }
      const renderArgs = {
        subscriber,
        now,
        fromName: ctx.fromName,
        fromEmail: ctx.fromEmail,
        unsubscribeUrl: ctx.unsubscribeUrl
      };
      const digest = subscriber.cadence === 'ritual'
        ? renderRitualBrief({
            ...renderArgs,
            brief: buildRitualBrief({
              subscriber,
              projects,
              now,
              kind: ritualBrief.kind
            })
          })
        : renderDigest({
            ...renderArgs,
            ...buildDigestItems({ subscriber, projects, now })
          });
      outcome = await deliver(ctx, subscriber, digest);
    } catch (err) {
      summary.errors.push(`${subscriber.email}: ${err.message}`);
      log(`error for ${subscriber.email}: ${err.message}`);
      continue;
    }
    if (outcome.result.ok) {
      if (outcome.action === 'send') summary.sent += 1;
      else summary.written += outcome.result.written.length;
    } else {
      summary.errors.push(`${subscriber.email}: ${outcome.result.error}`);
      log(`delivery failed for ${subscriber.email}: ${outcome.result.error}`);
    }
  }

  return summary;
}

async function main() {
  let summary;
  try {
    summary = await runPulse(process.env);
  } catch (err) {
    // The loop above never throws by construction; a throw here means the
    // process itself is unhealthy (e.g. env exploded before the loop).
    log(`fatal: ${err.message}`);
    process.exitCode = 1;
    return;
  }
  try {
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } catch {}
  if (!summary.ok) process.exitCode = 1;
}

// Import guard: tests import runPulse/cadenceDue directly; the CLI path
// only runs when executed as the entry module.
const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main().catch((err) => {
    log(`fatal: ${err.message}`);
    process.exitCode = 1;
  });
}
