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
 * overrides for staging tests. Never crashes on bad project data (the
 * pocketpmo-mcp convention): malformed projects and per-subscriber errors
 * are warnings; exit code is 0 with a JSON summary on stdout. Exit 1 is
 * reserved for "no run was possible" (roster unreadable / unexpected
 * top-level error) so cron observability catches a dead pipeline.
 *
 * Scheduler (CTO decision, recorded in docs/pulse.md): host launchd/cron
 * on the Mac Mini — the slack-bridge / trello-sync precedent. This is a
 * one-shot process; there is no resident scheduler to monitor.
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadAllProjects, projectsDir } from './lib/projects.js';
import { loadSubscriptions } from './lib/pulse/subscriptions.js';
import { buildDigestItems, MAX_ITEMS, MAX_CHASES } from './lib/pulse/needs.js';
import { renderDigest } from './lib/pulse/render.js';
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

/** Weekday guard: 0=Sun..6=Sat. Daily → Mon–Fri; weekly → Mon. */
export function cadenceDue(cadence, now) {
  const day = now.getUTCDay();
  if (cadence === 'weekly') return day === 1;
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

function buildContext(now) {
  return {
    now,
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
      subscriber,
      digest
    });
    return { action: 'dry-run', result };
  }
  const from = `${ctx.fromName} <${ctx.fromEmail}>`;
  const result = resolveProvider(process.env) === 'agentmail'
    ? await sendViaAgentmail({
        apiKey: process.env.AGENTMAIL_API_KEY,
        inboxId: process.env.AGENTMAIL_INBOX_ID,
        from,
        to: subscriber.email,
        subject: digest.subject,
        html: digest.html,
        text: digest.text
      })
    : await sendViaPostmark({
        token: process.env.POSTMARK_SERVER_TOKEN,
        from,
        to: subscriber.email,
        subject: digest.subject,
        html: digest.html,
        text: digest.text
      });
  return { action: 'send', result };
}

export async function runPulse(env = process.env) {
  // The shared loader (lib/projects.js) and the send gate read the live
  // process.env dynamically. Overlay the managed keys from the `env`
  // argument so the CLI's environment — and tests driving runPulse with a
  // plain object — configure the whole pipeline, not just this module.
  // SNAPSHOT + RESTORE in a finally: one run must never leak its config
  // into the next (back-to-back runPulse calls, e.g. in tests, would
  // otherwise inherit a previous run's PULSE_SEND/token — exactly the kind
  // of state bleed that turns a dry-run into a surprise send).
  const managedKeys = Object.keys(env).filter((key) => /^(PMO_|PULSE_|POSTMARK_|AGENTMAIL_)/.test(key));
  const snapshot = {};
  for (const key of managedKeys) {
    snapshot[key] = process.env[key];
    process.env[key] = env[key];
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
  const now = (() => {
    const override = env.PULSE_DATE ? new Date(env.PULSE_DATE) : new Date();
    return Number.isNaN(override.getTime()) ? new Date() : override;
  })();
  const ctx = buildContext(now);
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

  // Lazy + cached (CodeRabbit PR #20 R1): the portfolio is scanned once,
  // on the FIRST due subscriber. Skipped-only runs (weekend, weekly
  // cadence) never touch the projects directory. Per-subscriber fatal
  // handling is preserved: an unreadable projects dir records an error for
  // EVERY due subscriber rather than returning early, so the summary shows
  // exactly who was affected.
  let projects = null;
  let load = null;
  for (const subscriber of roster.subscribers) {
    let outcome;
    try {
      if (!env.PULSE_FORCE && !cadenceDue(subscriber.cadence, now)) {
        summary.skipped += 1;
        continue;
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
        // warnings inside load (never fatal) — fail-soft holds.
        throw new Error(load.fatal);
      }
      const { items, chases } = buildDigestItems({ subscriber, projects, now });
      const digest = renderDigest({
        subscriber,
        items,
        chases,
        now,
        fromName: ctx.fromName,
        fromEmail: ctx.fromEmail,
        unsubscribeUrl: ctx.unsubscribeUrl
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
