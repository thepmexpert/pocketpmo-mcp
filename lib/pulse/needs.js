/**
 * needs.js — the pulse computational core.
 *
 * Turns (subscriber, projects, now) into a ranked "needs you" list (≤3) and
 * a chases list ("who owes what, days outstanding"). Shares the project
 * loader with the MCP server (lib/projects.js — loadAllProjects is already
 * fail-soft: malformed files are skipped with warnings, never fatal).
 *
 * Field tolerance is a DESIGN CONSTRAINT, not defensive padding: project
 * exports are hand-editable JSON produced by a client-only SPA (schema
 * mirrors rebel-projectpro-suite's blankProject), so the same logical field
 * appears under several spellings across real exports (dueDate/due/endDate,
 * owner/assignee, title/name). Every getter picks the first present
 * candidate and degrades to "not computable" — an item without a parseable
 * date simply is not "overdue"; it is never a crash.
 *
 * Ranking rule (documented in docs/pulse.md, covered by tests):
 *   overdue activity/milestone : 10000 + daysOverdue
 *   pending decision           :  5000 + daysPending
 *   risk (P×I, open)           :   P×I × 100
 * Sort desc, tie-break title asc (deterministic), cap at 3.
 *
 * Day math is CALENDAR-based (Y/M/D diff), not millisecond-based: 24h-day
 * arithmetic drifts across DST (the docket.ie DI-027 class of bug) and a
 * pulse that says "6 days overdue" on a 7-calendar-day debt is a defect.
 */

// ---------------------------------------------------------------------------
// tolerant getters
// ---------------------------------------------------------------------------

/** First defined, non-empty (after String()) candidate value. */
function pick(obj, names) {
  if (!obj || typeof obj !== 'object') return null;
  for (const name of names) {
    const value = obj[name];
    if (value !== undefined && value !== null && asString(value).trim() !== '') {
      return value;
    }
  }
  return null;
}

function asString(value) {
  try {
    return String(value);
  } catch {
    return ''; // {"toString":null} is valid JSON; never let it throw
  }
}

/** Parse a date-ish value; null when not a real date. Accepts Date, ISO /
 * 'YYYY-MM-DD' strings — exactly what hand-edited exports contain — and
 * epoch-ms numbers. Strings and numbers are accepted ONLY within 2000–2100:
 * a bare small number (42) or an epoch-default string
 * ("1970-01-01T00:00:00.000Z") would otherwise parse as 1970 and fabricate
 * a ~20,000-day overdue item. */
export function parseDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') {
    if (value < 946684800000 || value > 4102444800000) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  if (date.getTime() < 946684800000 || date.getTime() > 4102444800000) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split('-').map(Number);
    if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) {
      return null;
    }
  }
  return date;
}

const CLOSED_WORDS = new Set([
  'done', 'complete', 'completed', 'cancelled', 'canceled', 'closed',
  'approved', 'rejected', 'declined', 'resolved', 'withdrawn'
]);

/** Anything explicitly closed is done; a missing/unknown status is NOT —
 * hand-edited exports omit status on live work far more often than they
 * omit it on finished work (fail-open toward surfacing, which is the safe
 * direction for a needs-you digest). */
export function isClosed(status) {
  return CLOSED_WORDS.has(asString(status).trim().toLowerCase());
}

/** Calendar-day difference (now − date), DST-safe via UTC Y/M/D. */
export function calendarDays(from, to) {
  const a = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  const b = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  return Math.round((a - b) / 86400000);
}

const DUE_FIELDS = ['dueDate', 'due', 'endDate', 'finishDate', 'targetDate', 'finish'];

/** Owner/assignee matching: exact lowercase, or any shared whole token of
 * length ≥ 3 ('D. Byrne' matches 'David Byrne' via 'byrne'; 'PM' never
 * matches — two-letter tokens are role labels, not names). Emails compare
 * case-insensitively and never token-match (local parts are not names). */
export function ownerMatches(ownerValue, subscriber) {
  const owner = asString(ownerValue).trim().toLowerCase();
  if (!owner) return false;
  if (subscriber.email && owner === subscriber.email.toLowerCase()) return true;
  const name = asString(subscriber.name).trim().toLowerCase();
  if (!name) return false;
  if (owner === name) return true;
  if (owner.includes('@') || name.includes('@')) return false;
  const ownerTokens = owner.split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
  const nameTokens = name.split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
  return ownerTokens.some((t) => nameTokens.includes(t));
}

function titleOf(obj, fallback) {
  return asString(pick(obj, ['title', 'name', 'summary', 'what'])).trim() || fallback;
}

// ---------------------------------------------------------------------------
// per-project extraction — every extractor is total (never throws)
// ---------------------------------------------------------------------------

function* overdueActivities(project, subscriber, now) {
  const activities = Array.isArray(project.activities) ? project.activities : [];
  for (const activity of activities) {
    if (!activity || typeof activity !== 'object') continue;
    if (isClosed(pick(activity, ['status']))) continue;
    if (!ownerMatches(pick(activity, ['owner', 'assignee', 'responsible']), subscriber)) continue;
    const due = parseDate(pick(activity, DUE_FIELDS));
    if (!due) continue;
    const daysOverdue = calendarDays(due, now);
    if (daysOverdue <= 0) continue;
    yield {
      kind: 'overdue-activity',
      title: titleOf(activity, 'Untitled activity'),
      dueDate: due,
      days: daysOverdue,
      score: 10000 + daysOverdue
    };
  }
}

function* overdueMilestones(project, subscriber, now) {
  const evm = project.evmData && typeof project.evmData === 'object' ? project.evmData : {};
  const milestones = Array.isArray(evm.milestones) ? evm.milestones : [];
  for (const milestone of milestones) {
    if (!milestone || typeof milestone !== 'object') continue;
    const progress = Number(milestone.progress);
    if (Number.isFinite(progress) && progress >= 1) continue;
    if (isClosed(pick(milestone, ['status']))) continue;
    if (!ownerMatches(pick(milestone, ['owner', 'assignee', 'responsible']), subscriber)) continue;
    const due = parseDate(pick(milestone, DUE_FIELDS));
    if (!due) continue;
    const daysOverdue = calendarDays(due, now);
    if (daysOverdue <= 0) continue;
    yield {
      kind: 'overdue-milestone',
      title: titleOf(milestone, 'Untitled milestone'),
      dueDate: due,
      days: daysOverdue,
      score: 10000 + daysOverdue
    };
  }
}

/** Decisions: closed statuses are exhaustive (done/approved/rejected/...);
 * everything else — including a MISSING status — is pending. */
function* pendingDecisions(project, subscriber, now) {
  const decisions = Array.isArray(project.decisions) ? project.decisions : [];
  for (const decision of decisions) {
    if (!decision || typeof decision !== 'object') continue;
    if (isClosed(pick(decision, ['status']))) continue;
    if (!ownerMatches(pick(decision, ['owner', 'assignee', 'approver', 'decisionOwner', 'requestedBy']), subscriber)) continue;
    const raised = parseDate(pick(decision, ['requestedOn', 'raisedOn', 'raised', 'date', 'createdAt']));
    const daysPending = raised ? calendarDays(raised, now) : null;
    yield {
      kind: 'decision',
      title: titleOf(decision, 'Untitled decision'),
      requestedOn: raised,
      days: daysPending !== null && daysPending > 0 ? daysPending : 0,
      score: 5000 + (daysPending !== null ? Math.max(0, daysPending) : 0)
    };
  }
}

const OPEN_RISK_STATUSES = new Set(['open', 'monitoring', 'active', '']);

function* topRisks(project, subscriber, now) {
  const risks = Array.isArray(project.risks) ? project.risks : [];
  const isManager = ownerMatches(pick(project, ['manager', 'projectManager', 'owner']), subscriber);
  const own = [];
  let topUnowned = null;
  for (const risk of risks) {
    if (!risk || typeof risk !== 'object') continue;
    const rawStatus = pick(risk, ['status']);
    const status = rawStatus === null ? '' : asString(rawStatus).trim().toLowerCase();
    if (!OPEN_RISK_STATUSES.has(status) || isClosed(status)) continue;
    const probabilityValue = pick(risk, ['probability', 'likelihood']);
    const impactValue = pick(risk, ['impact']);
    if (probabilityValue === null || impactValue === null) continue;
    const probability = Number(probabilityValue);
    const impact = Number(impactValue);
    if (!Number.isFinite(probability) || !Number.isFinite(impact)) continue;
    if (ownerMatches(pick(risk, ['owner', 'assignee']), subscriber)) {
      own.push({ kind: 'risk', title: titleOf(risk, 'Untitled risk'), probability, impact, days: null, score: probability * impact * 100 });
      continue;
    }
    // A manager also sees the single highest P×I risk nobody-owns on their
    // project (awareness of the project's worst case) — decided AFTER the
    // scan, by score, so first-seen order can't win.
    if (isManager && probability * impact > 0) {
      const candidate = { kind: 'risk', title: titleOf(risk, 'Untitled risk'), probability, impact, days: null, score: probability * impact * 100 };
      if (!topUnowned || candidate.score > topUnowned.score ||
          (candidate.score === topUnowned.score && candidate.title.localeCompare(topUnowned.title) < 0)) {
        topUnowned = candidate;
      }
    }
  }
  own.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  if (topUnowned) yield topUnowned;
  for (const risk of own) yield risk;
}

/** Chases — who owes the recipient what. Two sources, merged:
 * 1. Explicit `asks`/`chases`/`followUps` arrays:
 *    { from, what, requestedOn, to?, status? } — `from` owes `to` (default:
 *    the project manager). Included when `to` matches the subscriber and
 *    `from` does not, and the ask is not closed.
 * 2. Derived: overdue items (activities/milestones) owned by SOMEONE ELSE on
 *    the subscriber's projects — the digest tells the recipient who to poke,
 *    with days outstanding. */
function collectChases(project, subscriber, now) {
  const chases = [];
  const isManager = ownerMatches(pick(project, ['manager', 'projectManager', 'owner']), subscriber);
  const arrays = ['asks', 'chases', 'followUps'];
  for (const key of arrays) {
    const list = Array.isArray(project[key]) ? project[key] : [];
    for (const ask of list) {
      if (!ask || typeof ask !== 'object') continue;
      if (isClosed(pick(ask, ['status']))) continue;
      const from = asString(pick(ask, ['from', 'owner', 'who'])).trim();
      const to = asString(pick(ask, ['to', 'requester', 'for']));
      const owedTo = to || (isManager ? subscriber.name || subscriber.email : '');
      if (!from || !owedTo || !ownerMatches(owedTo, subscriber)) continue;
      if (ownerMatches(from, subscriber)) continue; // you don't chase yourself
      const requested = parseDate(pick(ask, ['requestedOn', 'requested', 'date', 'createdAt']));
      const days = requested ? calendarDays(requested, now) : null;
      chases.push({
        who: from,
        what: titleOf(ask, 'Unspecified ask'),
        projectName: asString(project.name || project.id),
        days: days !== null && days > 0 ? days : 0
      });
    }
  }
  const activities = Array.isArray(project.activities) ? project.activities : [];
  for (const activity of activities) {
    if (!activity || typeof activity !== 'object') continue;
    if (isClosed(pick(activity, ['status']))) continue;
    const owner = asString(pick(activity, ['owner', 'assignee', 'responsible'])).trim();
    if (!owner || ownerMatches(owner, subscriber)) continue;
    const due = parseDate(pick(activity, DUE_FIELDS));
    if (!due) continue;
    const daysOverdue = calendarDays(due, now);
    if (daysOverdue <= 0) continue;
    chases.push({
      who: owner,
      what: titleOf(activity, 'Untitled activity'),
      projectName: asString(project.name || project.id),
      days: daysOverdue
    });
  }
  const evm = project.evmData && typeof project.evmData === 'object' ? project.evmData : {};
  const milestones = Array.isArray(evm.milestones) ? evm.milestones : [];
  for (const milestone of milestones) {
    if (!milestone || typeof milestone !== 'object') continue;
    const progress = Number(milestone.progress);
    if (Number.isFinite(progress) && progress >= 1) continue;
    if (isClosed(pick(milestone, ['status']))) continue;
    const owner = asString(pick(milestone, ['owner', 'assignee', 'responsible'])).trim();
    if (!owner || ownerMatches(owner, subscriber)) continue;
    const due = parseDate(pick(milestone, DUE_FIELDS));
    if (!due) continue;
    const daysOverdue = calendarDays(due, now);
    if (daysOverdue <= 0) continue;
    chases.push({
      who: owner,
      what: titleOf(milestone, 'Untitled milestone'),
      projectName: asString(project.name || project.id),
      days: daysOverdue
    });
  }
  return chases;
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

export const MAX_ITEMS = 3;
export const MAX_CHASES = 5;

/**
 * Build the digest payload for one subscriber.
 * `projects` is an array of already-parsed project objects (the caller
 * streams them through lib/projects.js's fail-soft loader). Returns
 * `{ items, chases }` — `items` ranked and capped at 3, `chases` sorted by
 * days outstanding desc and capped at 5. Never throws on malformed input.
 */
export function buildDigestItems({ subscriber, projects, now }) {
  const items = [];
  const chases = [];
  for (const project of projects) {
    if (!project || typeof project !== 'object') continue;
    const projectName = asString(project.name || project.id);
    const referenced =
      !Array.isArray(subscriber.projects) || subscriber.projects.length === 0
        ? true
        : subscriber.projects.some(
            (ref) => asString(ref).trim().toLowerCase() === projectName.toLowerCase() ||
                     asString(ref).trim().toLowerCase() === asString(project.id).trim().toLowerCase()
          );
    if (!referenced) continue;
    const push = (raw) => items.push({ ...raw, projectName });
    for (const item of overdueActivities(project, subscriber, now)) push(item);
    for (const item of overdueMilestones(project, subscriber, now)) push(item);
    for (const item of pendingDecisions(project, subscriber, now)) push(item);
    for (const item of topRisks(project, subscriber, now)) push(item);
    chases.push(...collectChases(project, subscriber, now));
  }
  items.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  chases.sort((a, b) => b.days - a.days || a.who.localeCompare(b.who));
  return { items: items.slice(0, MAX_ITEMS), chases: chases.slice(0, MAX_CHASES) };
}
