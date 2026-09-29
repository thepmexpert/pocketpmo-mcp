/**
 * subscriptions.js — load and validate pulse subscription configs.
 *
 * Subscriptions are a config file (`subscriptions.json`), not a database:
 * MVP per the approved pulse plan. Schema:
 *
 *   { "subscribers": [
 *     { "email": "pm@example.com",
 *       "name": "D. Byrne",              // optional, used for owner matching
 *       "projects": ["Northgate"],       // optional: project id-or-name refs;
 *                                        //   if PRESENT it must be an array of
 *                                        //   non-empty strings — anything else
 *                                        //   skips the subscriber with a warning
 *       "cadence": "daily" } ] }         // "daily" | "weekly", default "daily"
 *
 * A top-level bare array of subscribers is accepted too (hand-edited files
 * drift). Fail-soft per the pocketpmo-mcp convention: one malformed
 * subscriber is skipped with a warning and never prevents the others from
 * loading; an unreadable/invalid FILE yields `{ subscribers: [], error }`
 * and the caller decides what an empty roster means.
 *
 * This module is deliberately separate from lib/projects.js so the pulse
 * can point subscriptions at any path (the production roster lives OUTSIDE
 * the repo — it contains recipient emails, which are personal data; only
 * `subscriptions.sample.json` is committed).
 */

import fs from 'node:fs';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CADENCES = new Set(['daily', 'weekly']);

function asString(value) {
  if (value === null || value === undefined) return '';
  try {
    return String(value);
  } catch {
    return ''; // unconvertible ({"toString":null} is valid JSON) — treat as absent
  }
}

function normalizeSubscriber(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { skip: 'missing or invalid email' };
  const email = asString(raw.email).trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return { skip: 'missing or invalid email' };
  const name = asString(raw.name).trim();
  const cadenceRaw = asString(raw.cadence).trim().toLowerCase();
  const cadence = CADENCES.has(cadenceRaw) ? cadenceRaw : 'daily';
  // A PRESENT projects filter must be an array of non-empty strings, else the
  // subscriber is rejected (fail closed): coercing a malformed filter to []
  // would widen it to ALL projects downstream (buildDigestItems treats an
  // empty filter as "no restriction") and leak other projects' details.
  // `[]` itself stays legal as an intentionally empty filter.
  const projects = raw.projects === undefined
    ? []
    : Array.isArray(raw.projects) && raw.projects.every((p) => typeof p === 'string' && p.trim() !== '')
      ? raw.projects.map((p) => p.trim())
      : null;
  if (projects === null) {
    return { skip: 'invalid projects filter (must be an array of non-empty project id-or-name strings)' };
  }
  return { subscriber: { email, name, cadence, projects } };
}

/**
 * Load a subscriptions file. Returns
 * `{ subscribers, warnings, error }` where `error` is non-null only when the
 * file itself cannot be read or parsed (missing roster = caller's call) and
 * `warnings` carries per-subscriber skips. Never throws on bad input.
 */
export function loadSubscriptions(filePath) {
  const result = { subscribers: [], warnings: [], error: null };
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    result.error = `cannot read subscriptions file: ${err.message}`;
    return result;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    result.error = `subscriptions file is not valid JSON: ${err.message}`;
    return result;
  }
  const list = Array.isArray(parsed) ? parsed : parsed && parsed.subscribers;
  if (!Array.isArray(list)) {
    result.error = 'subscriptions file must be {"subscribers":[...]} or a top-level array';
    return result;
  }
  const seen = new Set();
  list.forEach((rawSub, i) => {
    const norm = normalizeSubscriber(rawSub);
    if (norm.skip) {
      result.warnings.push(`subscriber #${i + 1} skipped: ${norm.skip}`);
      return;
    }
    const sub = norm.subscriber;
    if (seen.has(sub.email)) {
      result.warnings.push(`subscriber ${sub.email} duplicated — keeping first entry`);
      return;
    }
    seen.add(sub.email);
    result.subscribers.push(sub);
  });
  return result;
}
