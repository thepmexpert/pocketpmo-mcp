/**
 * render-ritual.js — Monday/Friday ritual brief rendering (HTML + text).
 *
 * Same email-safe constraints as render.js: inline styles only, no
 * classes/<style>, every interpolated string entity-escaped, both formats
 * carry the sender identity and an unsubscribe line, and the empty state
 * still renders a short honest brief ("nothing slipped" / "no dated
 * changes") — it sends, it just says little.
 *
 * Status drafts are rendered as visually distinct paste-ready blocks: the
 * Friday ritual's whole point is that the PM walks into their status
 * meeting with the writing already done.
 */

import { escapeHtml, formatDate } from './render.js';

const KIND_LABELS = {
  'came-due': 'came due',
  'decision-raised': 'decision raised',
  updated: 'updated'
};

function changeDate(change) {
  const date = change.kind === 'came-due' ? change.dueDate : change.date;
  return formatDate(date) || 'date unknown';
}

function changeState(change) {
  if (change.kind === 'came-due') return change.open ? 'still open' : 'closed';
  return change.open ? 'open' : 'closed';
}

function textChange(change) {
  const label = KIND_LABELS[change.kind] || 'changed';
  const when = changeDate(change);
  const state = changeState(change);
  return `• "${change.title}" ${label} ${when} — ${state} (${change.projectName})`;
}

function textSlipped(item) {
  const owner = item.mine ? `${item.owner} (yours)` : item.owner;
  return `• "${item.title}" (${item.projectName}) — ${owner}, ${item.days} day${item.days === 1 ? '' : 's'} overdue`;
}

function textDecision(decision) {
  const since = decision.requestedOn ? ` since ${formatDate(decision.requestedOn)}` : '';
  const waiting = decision.days > 0 ? ` — ${decision.days} day${decision.days === 1 ? '' : 's'} waiting${since}` : '';
  return `• "${decision.title}" (${decision.projectName})${waiting}`;
}

function sectionText(title, lines, cap, total) {
  if (!total) return [];
  const shown = lines.slice(0, cap);
  const more = total > shown.length ? [`… and ${total - shown.length} more`] : [];
  return [`${title}:`, ...shown, ...more, ''];
}

/**
 * Render one ritual brief. `ctx`:
 *   brief    { kind: 'monday'|'friday', slipped, decisions, drafts, changes, changedTotal }
 *   subscriber { email, name }
 *   now, fromName, fromEmail, unsubscribeUrl — as renderDigest
 * Returns { subject, html, text }. Never throws on item-level oddities.
 */
export function renderRitualBrief(ctx) {
  const { subscriber, now, fromName, fromEmail, unsubscribeUrl } = ctx;
  // Fail-soft normalization (cubic PR #21 R1): the renderer is documented
  // as never throwing on item-level oddities, so filter non-object entries
  // ONCE here instead of trusting every downstream map dereference.
  const brief = {
    ...ctx.brief,
    slipped: Array.isArray(ctx.brief?.slipped) ? ctx.brief.slipped.filter((x) => x && typeof x === 'object') : [],
    decisions: Array.isArray(ctx.brief?.decisions) ? ctx.brief.decisions.filter((x) => x && typeof x === 'object') : [],
    drafts: Array.isArray(ctx.brief?.drafts) ? ctx.brief.drafts.filter((x) => x && typeof x === 'object') : [],
    changes: Array.isArray(ctx.brief?.changes) ? ctx.brief.changes.filter((x) => x && typeof x === 'object') : []
  };
  const { kind } = brief;
  const dateLabel = formatDate(now) || 'today';
  const greeting = subscriber.name ? `Hi ${subscriber.name},` : 'Hi,';
  const ritualLabel = kind === 'monday' ? 'Monday ritual' : 'Friday ritual';

  // Subject uses the pre-cap totals (same rule as the body's "… and N more"
  // line) so 12 slipped items never read "8 slipped" under the 8-item cap.
  const slippedTotal = brief.slippedTotal ?? brief.slipped.length;
  const decisionsTotal = brief.decisionsTotal ?? brief.decisions.length;
  const subject = kind === 'monday'
    ? (slippedTotal || decisionsTotal
        ? `PocketPMO Monday brief: ${slippedTotal} slipped, ${decisionsTotal} decision${decisionsTotal === 1 ? '' : 's'} you owe — ${dateLabel}`
        : `PocketPMO Monday brief: nothing slipped, nothing waiting — ${dateLabel}`)
    : `PocketPMO Friday brief: ${brief.drafts.length || 'no'} status draft${brief.drafts.length === 1 ? '' : 's'}, ${brief.changedTotal} change${brief.changedTotal === 1 ? '' : 's'} this week — ${dateLabel}`;

  // ---- plain text -----------------------------------------------------
  const textLines = [greeting, ''];
  if (kind === 'monday') {
    textLines.push(...sectionText(
      'What slipped',
      brief.slipped.map(textSlipped),
      brief.slipped.length,
      brief.slippedTotal ?? brief.slipped.length));
    textLines.push(...sectionText(
      'Decisions you owe',
      brief.decisions.map(textDecision),
      brief.decisions.length,
      brief.decisionsTotal ?? brief.decisions.length));
    if (!brief.slipped.length && !brief.decisions.length) {
      textLines.push('Nothing slipped, and no decisions are waiting on you. Clean slate.', '');
    }
  } else {
    if (brief.drafts.length) {
      textLines.push('Status drafts — paste-ready:', '');
      for (const draft of brief.drafts) {
        textLines.push(draft.text, '');
      }
    } else {
      textLines.push('No projects referenced — nothing to draft.', '');
    }
    textLines.push(...sectionText(
      "Changes since last week (7 days)",
      brief.changes.map(textChange),
      brief.changes.length,
      brief.changedTotal));
    if (!brief.changedTotal) {
      textLines.push('No dated changes in the project exports over the last 7 days.', '');
    }
  }
  textLines.push(
    `— ${fromName} <${fromEmail}>`,
    `${ritualLabel} brief, generated ${dateLabel} from your PocketPMO project data.`,
    unsubscribeUrl
      ? `Unsubscribe: ${unsubscribeUrl}`
      : "You receive this because you're subscribed to PocketPMO ritual briefs. Reply UNSUBSCRIBE to stop."
  );
  const text = textLines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';

  // ---- HTML -----------------------------------------------------------
  const slippedHtml = brief.slipped
    .map((item) => `        <li style="margin:0 0 8px 0;font-size:14px;color:#374151;">
          <span style="font-weight:600;color:#111827;">${escapeHtml(item.title)}</span>
          <span style="color:#6b7280;">(${escapeHtml(item.projectName)})</span> —
          ${escapeHtml(item.owner)}${item.mine ? ' <strong style="color:#b45309;">(yours)</strong>' : ''},
          <strong>${item.days} day${item.days === 1 ? '' : 's'} overdue</strong>
        </li>`)
    .join('\n');

  const decisionsHtml = brief.decisions
    .map((decision) => `        <li style="margin:0 0 8px 0;font-size:14px;color:#374151;">
          <span style="font-weight:600;color:#111827;">${escapeHtml(decision.title)}</span>
          <span style="color:#6b7280;">(${escapeHtml(decision.projectName)})</span>${decision.days > 0 ? ` — <strong>${decision.days} day${decision.days === 1 ? '' : 's'} waiting</strong>` : ''}${decision.requestedOn ? ` <span style="color:#9ca3af;">since ${escapeHtml(formatDate(decision.requestedOn) || '')}</span>` : ''}
        </li>`)
    .join('\n');

  const draftsHtml = brief.drafts
    .map((draft) => `      <div style="margin:0 0 14px 0;padding:12px 14px;background:#eef2ff;border-left:4px solid #4f46e5;border-radius:4px;font-size:14px;color:#1e1b4b;line-height:1.55;">${escapeHtml(draft.text)}</div>`)
    .join('\n');

  const changesHtml = brief.changes
    .map((change) => `        <li style="margin:0 0 6px 0;font-size:13px;color:#374151;">
          "${escapeHtml(change.title)}" ${escapeHtml(KIND_LABELS[change.kind] || 'changed')} ${escapeHtml(changeDate(change))} — ${escapeHtml(changeState(change))}
          <span style="color:#6b7280;">(${escapeHtml(change.projectName)})</span>
        </li>`)
    .join('\n');

  const overflowNote = (shown, total) =>
    total > shown
      ? `        <p style="font-size:12px;color:#6b7280;margin:0 0 18px;">… and ${total - shown} more.</p>\n`
      : '';

  const mondayBody = (brief.slipped.length || brief.decisions.length)
    ? `${brief.slipped.length ? `      <h2 style="font-size:14px;color:#92400e;margin:0 0 8px;">What slipped</h2>\n      <ul style="margin:0 0 18px;padding-left:20px;">\n${slippedHtml}\n      </ul>\n${overflowNote(brief.slipped.length, brief.slippedTotal ?? brief.slipped.length)}` : ''}${brief.decisions.length ? `      <h2 style="font-size:14px;color:#92400e;margin:0 0 8px;">Decisions you owe</h2>\n      <ul style="margin:0 0 18px;padding-left:20px;">\n${decisionsHtml}\n      </ul>\n${overflowNote(brief.decisions.length, brief.decisionsTotal ?? brief.decisions.length)}` : ''}`
    : `        <p style="font-size:14px;color:#6b7280;margin:0 0 18px;">Nothing slipped, and no decisions are waiting on you. Clean slate.</p>\n`;

  const fridayBody =
    (brief.drafts.length
      ? `      <h2 style="font-size:14px;color:#3730a3;margin:0 0 8px;">Status drafts — paste-ready</h2>\n${draftsHtml}\n`
      : `        <p style="font-size:14px;color:#6b7280;margin:0 0 18px;">No projects referenced — nothing to draft.</p>\n`) +
    (brief.changedTotal
      ? `      <h2 style="font-size:14px;color:#3730a3;margin:22px 0 8px;">Changes since last week (7 days)</h2>\n      <ul style="margin:0 0 18px;padding-left:20px;">\n${changesHtml}\n      </ul>\n` +
        (brief.changedTotal > brief.changes.length
          ? `        <p style="font-size:12px;color:#6b7280;margin:0 0 18px;">… and ${brief.changedTotal - brief.changes.length} more.</p>\n`
          : '')
      : `        <p style="font-size:14px;color:#6b7280;margin:22px 0 18px;">No dated changes in the project exports over the last 7 days.</p>\n`);

  const unsubscribeHtml = unsubscribeUrl
    ? `<a href="${escapeHtml(unsubscribeUrl)}" style="color:#6b7280;">Unsubscribe</a>`
    : "You receive this because you're subscribed to PocketPMO ritual briefs. Reply <strong>UNSUBSCRIBE</strong> to stop.";

  const html = `<!DOCTYPE html>
<html lang="en">
  <body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <div style="max-width:560px;margin:0 auto;padding:24px 16px;">
      <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;padding:24px;">
        <div style="font-size:12px;color:#9ca3af;margin-bottom:4px;">PocketPMO ${escapeHtml(ritualLabel)} — ${escapeHtml(dateLabel)}</div>
        <h1 style="font-size:20px;color:#111827;margin:0 0 14px;">${kind === 'monday' ? 'What slipped & what you owe' : 'Status drafts & the week\u2019s changes'}</h1>
        <p style="font-size:14px;color:#374151;margin:0 0 18px;">${escapeHtml(greeting)}</p>
${kind === 'monday' ? mondayBody : fridayBody}        <hr style="border:none;border-top:1px solid #e5e7eb;margin:22px 0 14px;" />
        <div style="font-size:12px;color:#6b7280;line-height:1.6;">
          — ${escapeHtml(fromName)} &lt;<a href="mailto:${escapeHtml(fromEmail)}" style="color:#6b7280;">${escapeHtml(fromEmail)}</a>&gt;<br/>
          ${escapeHtml(ritualLabel)} brief, generated ${escapeHtml(dateLabel)} from your PocketPMO project data.<br/>
          ${unsubscribeHtml}
        </div>
      </div>
    </div>
  </body>
</html>
`;

  return { subject, html, text };
}
