/**
 * ritual.js — Monday/Friday ritual briefs (TPMAAAA-2370).
 *
 * "Be the thing that shows up at ritual time, not a place the PM visits."
 * A subscriber on the `ritual` cadence gets ONE brief per ritual day:
 *
 *   • Monday   — WHAT SLIPPED (every open, past-due activity/milestone on
 *     their projects, owner-attributed, theirs flagged) + DECISIONS YOU OWE
 *     (pending decisions waiting on the recipient, days pending).
 *   • Friday   — STATUS DRAFT (per project: a factual, copy-paste-ready
 *     status paragraph) + CHANGES SINCE LAST WEEK.
 *
 * Honesty constraint (the same one that governs needs.js): project exports
 * carry NO change history (no updatedAt in the wild today), so "changes" is
 * derived only from dates the exports actually contain — due dates inside
 * the 7-day window, decisions raised inside it, and updatedAt-style fields
 * (updatedAt/modifiedAt/lastUpdated) honored on activities, milestones, and
 * decisions when a future export grows them. A missing date never
 * fabricates a change; a quiet week says so.
 *
 * All extraction reuses needs.js's tolerant getters and calendar-day math,
 * and mirrors its fail-soft contract: malformed items are skipped, never
 * thrown; every extractor is total.
 */

import {
  pick, titleOf, parseDate, isClosed, calendarDays, ownerMatches,
  isReferencedProject, DUE_FIELDS
} from './needs.js';

export const MAX_SLIPPED = 8;
export const MAX_DECISIONS = 8;
export const MAX_CHANGES = 10;

const MODIFIED_FIELDS = ['updatedAt', 'modifiedAt', 'lastUpdated', 'updated'];
const DECISION_OWNER_FIELDS = ['owner', 'assignee', 'approver', 'decisionOwner', 'requestedBy'];

/**
 * Which brief does this run render? PULSE_BRIEF=monday|friday overrides
 * (staging/forced runs); an invalid value warns and falls through to the
 * weekday default — Monday→monday, Friday→friday, any other day→monday
 * (only reachable via PULSE_FORCE, documented in docs/pulse.md).
 */
export function resolveRitualBriefKind(env, now) {
  const raw = typeof env.PULSE_BRIEF === 'string' ? env.PULSE_BRIEF.trim().toLowerCase() : '';
  if (raw === 'monday' || raw === 'friday') return { kind: raw, warning: null };
  const warning = raw !== ''
    ? `invalid PULSE_BRIEF "${env.PULSE_BRIEF.trim()}" — using the weekday default`
    : null;
  const day = now instanceof Date && !Number.isNaN(now.getTime()) ? now.getUTCDay() : null;
  return { kind: day === 5 ? 'friday' : 'monday', warning };
}

function ownerLabel(value, subscriber) {
  const owner = pick(value, ['owner', 'assignee', 'responsible']);
  const name = owner === null || owner === undefined ? '' : String(owner).trim();
  if (!name) return null;
  return { name, mine: ownerMatches(name, subscriber) };
}

/** Open (not closed) dated item that is past due. `type` is 'activity' or
 * 'milestone' — only milestones carry the fraction-progress completion
 * rule (progress ≥ 1 = complete), matching needs.js. */
function slippedItem(entry, type, projectName, subscriber, now) {
  if (!entry || typeof entry !== 'object') return null;
  if (isClosed(pick(entry, ['status']))) return null;
  if (type === 'milestone') {
    const progress = Number(entry.progress);
    if (Number.isFinite(progress) && progress >= 1) return null;
  }
  const due = parseDate(pick(entry, DUE_FIELDS));
  if (!due) return null;
  const days = calendarDays(due, now);
  if (days <= 0) return null;
  const owner = ownerLabel(entry, subscriber);
  return {
    title: titleOf(entry, `Untitled ${type}`),
    projectName,
    owner: owner ? owner.name : 'unowned',
    mine: owner ? owner.mine : false,
    dueDate: due,
    days
  };
}

function collectSlipped(projects, subscriber, now) {
  const slipped = [];
  for (const project of projects) {
    if (!project || typeof project !== 'object') continue;
    if (!isReferencedProject(project, subscriber)) continue;
    const projectName = String(project.name || project.id);
    const activities = Array.isArray(project.activities) ? project.activities : [];
    for (const activity of activities) {
      const item = slippedItem(activity, 'activity', projectName, subscriber, now);
      if (item) slipped.push(item);
    }
    const evm = project.evmData && typeof project.evmData === 'object' ? project.evmData : {};
    const milestones = Array.isArray(evm.milestones) ? evm.milestones : [];
    for (const milestone of milestones) {
      const item = slippedItem(milestone, 'milestone', projectName, subscriber, now);
      if (item) slipped.push(item);
    }
  }
  slipped.sort((a, b) => b.days - a.days || a.projectName.localeCompare(b.projectName) || a.title.localeCompare(b.title));
  return slipped;
}

function collectDecisionsOwed(projects, subscriber, now) {
  const owed = [];
  for (const project of projects) {
    if (!project || typeof project !== 'object') continue;
    if (!isReferencedProject(project, subscriber)) continue;
    const projectName = String(project.name || project.id);
    const decisions = Array.isArray(project.decisions) ? project.decisions : [];
    for (const decision of decisions) {
      if (!decision || typeof decision !== 'object') continue;
      if (isClosed(pick(decision, ['status']))) continue;
      if (!ownerMatches(pick(decision, DECISION_OWNER_FIELDS), subscriber)) continue;
      const raised = parseDate(pick(decision, ['requestedOn', 'raisedOn', 'raised', 'date', 'createdAt']));
      const days = raised ? calendarDays(raised, now) : null;
      owed.push({
        title: titleOf(decision, 'Untitled decision'),
        projectName,
        requestedOn: raised,
        days: days !== null && days > 0 ? days : 0
      });
    }
  }
  owed.sort((a, b) => b.days - a.days || a.projectName.localeCompare(b.projectName) || a.title.localeCompare(b.title));
  return owed;
}

const CHANGE_KINDS = new Set(['came-due', 'decision-raised', 'updated']);

function changeDate(item) {
  return item.kind === 'decision-raised' ? item.date : item.dueDate ?? item.date;
}

function pushChange(list, seen, candidate) {
  if (!candidate || !CHANGE_KINDS.has(candidate.kind)) return;
  const key = `${candidate.kind}|${candidate.projectName}|${candidate.title}|${changeDate(candidate)?.toISOString?.() ?? ''}`;
  if (seen.has(key)) return;
  seen.add(key);
  list.push(candidate);
}

/** Open/closed for change tracking — the same completion rule slippedItem
 * and needs.js apply: a closed status, or for milestones only, fraction
 * progress ≥ 1, counts as complete regardless of the due date. */
function changeOpen(entry, type) {
  if (isClosed(pick(entry, ['status']))) return false;
  if (type === 'milestone') {
    const progress = Number(entry.progress);
    if (Number.isFinite(progress) && progress >= 1) return false;
  }
  return true;
}

/** The 7-calendar-day window ending "now" (daysAgo 0..6). */
function inWindow(date, now) {
  if (!date) return false;
  const daysAgo = calendarDays(date, now);
  return daysAgo >= 0 && daysAgo < 7;
}

function collectChanges(projects, subscriber, now) {
  const changes = [];
  const seen = new Set();
  for (const project of projects) {
    if (!project || typeof project !== 'object') continue;
    if (!isReferencedProject(project, subscriber)) continue;
    const projectName = String(project.name || project.id);
    const entries = [];
    for (const activity of Array.isArray(project.activities) ? project.activities : []) {
      entries.push({ entry: activity, type: 'activity' });
    }
    const evm = project.evmData && typeof project.evmData === 'object' ? project.evmData : {};
    for (const milestone of Array.isArray(evm.milestones) ? evm.milestones : []) {
      entries.push({ entry: milestone, type: 'milestone' });
    }
    for (const { entry, type } of entries) {
      if (!entry || typeof entry !== 'object') continue;
      const itemTitle = titleOf(entry, `Untitled ${type}`);
      const due = parseDate(pick(entry, DUE_FIELDS));
      if (inWindow(due, now)) {
        pushChange(changes, seen, {
          kind: 'came-due',
          title: itemTitle,
          projectName,
          dueDate: due,
          open: changeOpen(entry, type),
          type
        });
      }
      const modified = parseDate(pick(entry, MODIFIED_FIELDS));
      if (inWindow(modified, now)) {
        pushChange(changes, seen, {
          kind: 'updated',
          title: itemTitle,
          projectName,
          date: modified,
          open: changeOpen(entry, type),
          type
        });
      }
    }
    for (const decision of Array.isArray(project.decisions) ? project.decisions : []) {
      if (!decision || typeof decision !== 'object') continue;
      const decisionTitle = titleOf(decision, 'Untitled decision');
      const raised = parseDate(pick(decision, ['requestedOn', 'raisedOn', 'raised', 'date', 'createdAt']));
      if (inWindow(raised, now)) {
        pushChange(changes, seen, {
          kind: 'decision-raised',
          title: decisionTitle,
          projectName,
          date: raised,
          open: !isClosed(pick(decision, ['status']))
        });
      }
      const modified = parseDate(pick(decision, MODIFIED_FIELDS));
      if (inWindow(modified, now)) {
        pushChange(changes, seen, {
          kind: 'updated',
          title: decisionTitle,
          projectName,
          date: modified,
          open: !isClosed(pick(decision, ['status']))
        });
      }
    }
  }
  changes.sort((a, b) =>
    (changeDate(b)?.getTime() ?? 0) - (changeDate(a)?.getTime() ?? 0) ||
    a.projectName.localeCompare(b.projectName) ||
    a.title.localeCompare(b.title));
  return changes;
}

const OPEN_RISK_STATUSES = new Set(['open', 'monitoring', 'active', '']);

function topOpenRisk(project) {
  const risks = Array.isArray(project.risks) ? project.risks : [];
  let top = null;
  for (const risk of risks) {
    if (!risk || typeof risk !== 'object') continue;
    const rawStatus = pick(risk, ['status']);
    const status = rawStatus === null ? '' : String(rawStatus).trim().toLowerCase();
    if (!OPEN_RISK_STATUSES.has(status) || isClosed(status)) continue;
    const probability = Number(pick(risk, ['probability', 'likelihood']));
    const impact = Number(pick(risk, ['impact']));
    if (!Number.isFinite(probability) || !Number.isFinite(impact)) continue;
    const score = probability * impact;
    if (score <= 0) continue;
    if (!top || score > top.score) {
      top = {
        title: titleOf(risk, 'Untitled risk'),
        probability,
        impact,
        owner: (() => {
          const value = pick(risk, ['owner', 'assignee']);
          return value === null || value === undefined ? null : String(value).trim() || null;
        })(),
        score
      };
    }
  }
  return top;
}

/** Nearest future dated, still-open item — `type` selects the milestone
 * fraction-progress rule, matching needs.js. */
function nextDue(project, now) {
  let next = null;
  const consider = (entry, type) => {
    if (!entry || typeof entry !== 'object') return;
    if (isClosed(pick(entry, ['status']))) return;
    if (type === 'milestone') {
      const progress = Number(entry.progress);
      if (Number.isFinite(progress) && progress >= 1) return;
    }
    const due = parseDate(pick(entry, DUE_FIELDS));
    if (!due || due.getTime() < now.getTime()) return;
    if (!next || due.getTime() < next.dueDate.getTime()) {
      next = {
        title: titleOf(entry, `Untitled ${type}`),
        dueDate: due,
        owner: (() => {
          const value = pick(entry, ['owner', 'assignee', 'responsible']);
          return value === null || value === undefined ? null : String(value).trim() || null;
        })()
      };
    }
  };
  for (const activity of Array.isArray(project.activities) ? project.activities : []) consider(activity, 'activity');
  const evm = project.evmData && typeof project.evmData === 'object' ? project.evmData : {};
  for (const milestone of Array.isArray(evm.milestones) ? evm.milestones : []) consider(milestone, 'milestone');
  return next;
}

/** One factual, copy-paste-ready status paragraph per project. */
function buildStatusDraft(project, subscriber, now, slipped, decisionsOwed) {
  const projectName = String(project.name || project.id);
  const projectSlipped = slipped.filter((s) => s.projectName === projectName);
  const projectDecisions = decisionsOwed.filter((d) => d.projectName === projectName);
  const progressRaw = project.progress == null || String(project.progress).trim() === ''
    ? NaN
    : Number(project.progress);
  const progress = Number.isFinite(progressRaw) && progressRaw >= 0 && progressRaw <= 100
    ? Math.round(progressRaw)
    : null;
  const risk = topOpenRisk(project);
  const upcoming = nextDue(project, now);

  const sentences = [];
  sentences.push(progress !== null
    ? `${projectName} — ${progress}% complete.`
    : `${projectName} — progress not reported in the export.`);
  if (projectSlipped.length > 0) {
    const worst = projectSlipped[0];
    sentences.push(`${projectSlipped.length} item${projectSlipped.length === 1 ? '' : 's'} overdue; worst: "${worst.title}" (${worst.owner}, ${worst.days} day${worst.days === 1 ? '' : 's'}).`);
  } else {
    sentences.push('Nothing overdue.');
  }
  if (projectDecisions.length > 0) {
    sentences.push(`${projectDecisions.length} decision${projectDecisions.length === 1 ? '' : 's'} pending on you: "${projectDecisions[0].title}"${projectDecisions[0].days > 0 ? ` (${projectDecisions[0].days} day${projectDecisions[0].days === 1 ? '' : 's'} waiting)` : ''}.`);
  }
  if (risk) {
    sentences.push(`Top risk: "${risk.title}" (probability ${risk.probability} × impact ${risk.impact}${risk.owner ? `, owner ${risk.owner}` : ''}).`);
  }
  if (upcoming) {
    sentences.push(`Next due: "${upcoming.title}"${upcoming.owner ? ` (${upcoming.owner})` : ''} on ${upcoming.dueDate.toISOString().slice(0, 10)}.`);
  }
  return {
    projectName,
    progress,
    overdueCount: projectSlipped.length,
    decisionsPending: projectDecisions.length,
    text: sentences.join(' ')
  };
}

/**
 * Build one ritual brief. Returns
 * `{ kind, slipped, decisions, drafts, changes, changedTotal }` — the
 * slipped/decisions/changes arrays are capped (MAX_SLIPPED /
 * MAX_DECISIONS / MAX_CHANGES) so a huge export cannot produce an
 * unbounded email; drafts are one per referenced project (bounded by the
 * portfolio). Never throws on malformed input.
 */
export function buildRitualBrief({ subscriber, projects, now, kind }) {
  if (kind !== 'monday' && kind !== 'friday') {
    throw new Error(`buildRitualBrief: unknown brief kind "${kind}"`);
  }
  const safeProjects = Array.isArray(projects) ? projects : [];
  const slipped = collectSlipped(safeProjects, subscriber, now);
  const decisions = collectDecisionsOwed(safeProjects, subscriber, now);

  if (kind === 'monday') {
    return {
      kind,
      slipped: slipped.slice(0, MAX_SLIPPED),
      slippedTotal: slipped.length,
      decisions: decisions.slice(0, MAX_DECISIONS),
      decisionsTotal: decisions.length,
      drafts: [],
      changes: [],
      changedTotal: 0
    };
  }

  const drafts = [];
  for (const project of safeProjects) {
    if (!project || typeof project !== 'object') continue;
    if (!isReferencedProject(project, subscriber)) continue;
    drafts.push(buildStatusDraft(project, subscriber, now, slipped, decisions));
  }
  const changes = collectChanges(safeProjects, subscriber, now);
  return {
    kind,
    slipped,
    slippedTotal: slipped.length,
    decisions,
    decisionsTotal: decisions.length,
    drafts,
    changes: changes.slice(0, MAX_CHANGES),
    changedTotal: changes.length
  };
}
