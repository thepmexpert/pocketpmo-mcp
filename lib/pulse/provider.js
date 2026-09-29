/**
 * provider.js — transactional email delivery (AgentMail | Postmark) +
 * dry-run writer.
 *
 * PROVIDER DECISION (CTO, recorded for the PR): provider is selectable via
 * `PULSE_PROVIDER` (`agentmail` | `postmark`, default `postmark`).
 *   • agentmail — board directive 2026-09-29: AgentMail is the company's
 *     credentialed email channel TODAY, so P2 staging sends run through it.
 *     Sends originate from a dedicated AgentMail inbox (envelope-from is
 *     the inbox address; `PULSE_FROM_EMAIL` is passed as Reply-To).
 *     pocketpmo.com alignment (SPF/DKIM on the digest's From:) stays a
 *     board-owned DNS decision and is NOT required for staging.
 *   • postmark — production candidate (transactional-only network,
 *     free 100/month tier, custom-domain alignment) pending board account
 *     setup + DNS. Original decision record: Postmark over Resend for
 *     deliverability and zero-dep fit; Resend stays a one-module swap.
 * Misconfiguration fails toward dry-run: an unknown PULSE_PROVIDER value
 * resolves to the explicit invalid state, which keeps the send gate closed
 * even if a postmark token is present (PR #20 R2) — a typo can never turn
 * a dry-run into a real send.
 *
 * SAFETY MODEL (pulse plan, hard requirement): dry-run is the DEFAULT.
 * Real sending requires BOTH `PULSE_SEND=1` AND the selected provider's
 * credentials in the environment (postmark: `POSTMARK_SERVER_TOKEN`;
 * agentmail: `AGENTMAIL_API_KEY` + `AGENTMAIL_INBOX_ID`). Secrets are
 * issued through Paperclip secret proposals / the system keychain and
 * never committed (no git, no .env files, no docs). Tests inject a fake
 * fetch; the real module never smuggles network I/O into import time.
 */

import fs from 'node:fs';
import path from 'node:path';

export const POSTMARK_URL = 'https://api.postmarkapp.com/email';
export const AGENTMAIL_URL = 'https://api.agentmail.to/v0';

// Hard bound on one provider send (PR #20 R2). Without it a provider that
// never completes the request hangs the whole cron run and starves every
// later recipient. 15s comfortably covers transactional-send latency.
export const SEND_TIMEOUT_MS = 15000;

function isTimeoutAbort(err) {
  // AbortSignal.timeout rejects with `TimeoutError`; a pre-aborted or
  // externally aborted signal surfaces as `AbortError`. Both mean "the
  // bounded send window elapsed", never "the send failed at the provider".
  return Boolean(err) && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

export const PROVIDER_INVALID = 'invalid';

/**
 * Resolve the delivery provider from the environment. Default postmark;
 * only the exact string 'agentmail' selects AgentMail. Any OTHER explicit
 * value — typo, wrong case, garbage — resolves to `PROVIDER_INVALID`
 * instead of silently falling back to postmark (PR #20 R2): with a
 * POSTMARK_SERVER_TOKEN present that fallback let a misconfiguration
 * perform a real send. Invalid keeps the gate closed (dry-run).
 */
export function resolveProvider(env = process.env) {
  const raw = env.PULSE_PROVIDER;
  if (raw === undefined || raw === '') return 'postmark';
  if (raw === 'agentmail') return 'agentmail';
  if (raw === 'postmark') return 'postmark';
  return PROVIDER_INVALID;
}

/**
 * Send gate. True only when the explicit flag AND the selected provider's
 * credentials are present. Anything other than exactly '1' for PULSE_SEND
 * means dry-run — the flag must be unambiguous, not truthy. An invalid
 * PULSE_PROVIDER keeps the gate closed regardless of credentials.
 */
export function isSendEnabled(env = process.env) {
  if (env.PULSE_SEND !== '1') return false;
  const provider = resolveProvider(env);
  if (provider === PROVIDER_INVALID) return false;
  if (provider === 'agentmail') {
    return Boolean(env.AGENTMAIL_API_KEY) && Boolean(env.AGENTMAIL_INBOX_ID);
  }
  return Boolean(env.POSTMARK_SERVER_TOKEN);
}

/**
 * Send one email via Postmark. `fetchImpl` is injectable for tests.
 * Returns `{ ok: true, messageId }` or `{ ok: false, error }` — never
 * throws (network errors become results; the pulse loop must survive one
 * recipient failing).
 */
export async function sendViaPostmark({
  fetchImpl = fetch,
  token,
  from,
  to,
  subject,
  html,
  text,
  messageStream = 'broadcast',
  timeoutMs = SEND_TIMEOUT_MS
}) {
  if (!token) return { ok: false, error: 'POSTMARK_SERVER_TOKEN is not set' };
  let response;
  try {
    response = await fetchImpl(POSTMARK_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Postmark-Server-Token': token
      },
      body: JSON.stringify({
        From: from,
        To: to,
        Subject: subject,
        HtmlBody: html,
        TextBody: text,
        MessageStream: messageStream
      })
    });
  } catch (err) {
    if (isTimeoutAbort(err)) return { ok: false, error: `send timed out after ${timeoutMs}ms` };
    return { ok: false, error: `network error: ${err.message}` };
  }
  let body = null;
  try {
    body = await response.json();
  } catch {
    // Non-JSON error bodies happen on proxy-layer failures; fall through to status.
  }
  if (!response.ok) {
    const detail = body && body.Message ? body.Message : `HTTP ${response.status}`;
    return { ok: false, error: `postmark error: ${detail}` };
  }
  return { ok: true, messageId: body && body.MessageID };
}

/**
 * Send one email via AgentMail. Messages originate FROM the given inbox
 * (AgentMail has no per-message envelope-from); `from` is passed as the
 * Reply-To so replies still route to the configured pulse address.
 * `fetchImpl` is injectable for tests. Returns `{ ok: true, messageId }`
 * or `{ ok: false, error }` — never throws (the pulse loop must survive
 * one recipient failing).
 */
export async function sendViaAgentmail({
  fetchImpl = fetch,
  apiKey,
  inboxId,
  from,
  to,
  subject,
  html,
  text,
  timeoutMs = SEND_TIMEOUT_MS
}) {
  if (!apiKey) return { ok: false, error: 'AGENTMAIL_API_KEY is not set' };
  if (!inboxId) return { ok: false, error: 'AGENTMAIL_INBOX_ID is not set' };
  let response;
  try {
    response = await fetchImpl(`${AGENTMAIL_URL}/inboxes/${encodeURIComponent(inboxId)}/messages/send`, {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        to: [to],
        reply_to: from ? [from] : undefined,
        subject,
        text,
        html
      })
    });
  } catch (err) {
    if (isTimeoutAbort(err)) return { ok: false, error: `send timed out after ${timeoutMs}ms` };
    return { ok: false, error: `network error: ${err.message}` };
  }
  let body = null;
  try {
    body = await response.json();
  } catch {
    // Non-JSON error bodies happen on proxy-layer failures; fall through to status.
  }
  if (!response.ok) {
    const detail = body && (body.message || body.Message) ? (body.message || body.Message) : `HTTP ${response.status}`;
    return { ok: false, error: `agentmail error: ${detail}` };
  }
  return { ok: true, messageId: body && body.message_id };
}

/**
 * Dry-run writer: persists one rendered digest to `<outDir>/<date>/<slug>`
 * as `.html` + `.txt` + `.json` (subject/meta). `now` is the run's
 * calendar-anchored date (lib/pulse/calendar.js) so the folder label
 * matches the subject/overdue-day calendar; `generatedAt` is the real
 * generation instant and defaults to `now`. Returns the written paths.
 * Never throws — a filesystem failure degrades to a returned error.
 */
export function writeDryRun({ outDir, now, generatedAt = now, subscriber, digest, fsImpl = fs, pathImpl = path }) {
  const dateDir = (() => {
    try {
      return now.toISOString().slice(0, 10);
    } catch {
      return 'unknown-date';
    }
  })();
  const slug = asSafeSlug(subscriber.email);
  const dir = pathImpl.join(outDir, dateDir);
  const base = pathImpl.join(dir, slug);
  const written = [];
  try {
    fsImpl.mkdirSync(dir, { recursive: true });
    for (const [suffix, content] of [
      ['.html', digest.html],
      ['.txt', digest.text],
      ['.json', JSON.stringify({ email: subscriber.email, subject: digest.subject, generatedAt: generatedAt.toISOString() }, null, 2)]
    ]) {
      fsImpl.writeFileSync(base + suffix, content);
      written.push(base + suffix);
    }
    return { ok: true, written };
  } catch (err) {
    return { ok: false, error: err.message, written };
  }
}

function asSafeSlug(email) {
  // Identity-preserving: encodeURIComponent keeps every distinct normalized
  // address distinct (user+tag@ vs user_tag@ used to fold into the same
  // slug and overwrite each other's dry-run files — CodeRabbit PR #20 R1).
  // encodeURIComponent leaves the RFC 3986 sub-delims ! ' ( ) * unescaped
  // (`*` is illegal in Windows filenames), so clamp those to %XX. The
  // result draws only from [A-Za-z0-9-._~] — filesystem-safe on
  // macOS/Linux/Windows.
  const slug = encodeURIComponent(String(email).toLowerCase()).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return slug || 'unknown-recipient';
}
