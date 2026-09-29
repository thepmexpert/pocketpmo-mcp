/**
 * provider.js — transactional email delivery (Postmark) + dry-run writer.
 *
 * PROVIDER DECISION (CTO, recorded for the PR): Postmark over Resend.
 *   1. Deliverability: Postmark's network is transactional-only — shared
 *      pools carry no marketing mail, which is exactly the profile an
 *      operational digest needs to land on day one of a new domain.
 *   2. Zero-dep fit: one endpoint, one auth header — a bare fetch with
 *      `X-Postmark-Server-Token`, no SDK, matching the repo's zero-dep rule.
 *   3. Free developer tier (100/day) covers the MVP subscriber count.
 *      (Resend's API is equally simple and is the natural fallback if
 *      pricing changes; the client is isolated in this file so swapping
 *      providers is one module.)
 *
 * SAFETY MODEL (pulse plan, hard requirement): dry-run is the DEFAULT.
 * Real sending requires BOTH `PULSE_SEND=1` AND a `POSTMARK_SERVER_TOKEN`
 * in the environment — the token itself is issued through a Paperclip
 * secret proposal and never committed (no git, no .env files, no docs).
 * Tests inject a fake fetch; the real module never smuggles network I/O
 * into import time.
 */

import fs from 'node:fs';
import path from 'node:path';

export const POSTMARK_URL = 'https://api.postmarkapp.com/email';

/**
 * Send gate. True only when the explicit flag AND the token are present.
 * Anything other than exactly '1' for PULSE_SEND means dry-run — the flag
 * must be unambiguous, not truthy.
 */
export function isSendEnabled(env = process.env) {
  return env.PULSE_SEND === '1' && Boolean(env.POSTMARK_SERVER_TOKEN);
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
  messageStream = 'broadcast'
}) {
  if (!token) return { ok: false, error: 'POSTMARK_SERVER_TOKEN is not set' };
  let response;
  try {
    response = await fetchImpl(POSTMARK_URL, {
      method: 'POST',
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
 * Dry-run writer: persists one rendered digest to `<outDir>/<date>/<slug>`
 * as `.html` + `.txt` + `.json` (subject/meta). Returns the written paths.
 * Never throws — a filesystem failure degrades to a returned error.
 */
export function writeDryRun({ outDir, now, subscriber, digest, fsImpl = fs, pathImpl = path }) {
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
      ['.json', JSON.stringify({ email: subscriber.email, subject: digest.subject, generatedAt: now.toISOString() }, null, 2)]
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
  // Percent-encoding yields only [A-Za-z0-9-._~] — filesystem-safe on
  // macOS/Linux/Windows.
  const slug = encodeURIComponent(String(email).toLowerCase());
  return slug || 'unknown-recipient';
}

function asString(v) {
  try {
    return String(v);
  } catch {
    return '';
  }
}
