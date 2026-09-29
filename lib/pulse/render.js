/**
 * render.js — digest rendering (HTML + plain text).
 *
 * Email-safe HTML: inline styles only (no CSS files, no classes — Gmail
 * strips <style> in some contexts), tables avoided in favor of simple
 * block layout, every interpolated string entity-escaped (titles come from
 * hand-editable project JSON — unescaped interpolation would be an HTML
 * injection into recipients' mail clients).
 *
 * Required by the pulse plan: BOTH formats carry the sender identity and
 * an unsubscribe line; the empty state ("nothing needs you") renders a
 * short digest in both formats — it still sends, it just says little.
 */

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatDate(date) {
  if (!date) return null;
  try {
    return date.toISOString().slice(0, 10);
  } catch {
    return null;
  }
}

const KIND_LABELS = {
  'overdue-activity': 'Overdue activity',
  'overdue-milestone': 'Overdue milestone',
  decision: 'Decision waiting on you',
  risk: 'Top risk on your project'
};

/** One rendered item line for the text format. */
function textItem(item) {
  const label = KIND_LABELS[item.kind] || 'Item';
  const daysLabel = item.kind === 'decision' ? 'waiting' : 'overdue';
  const when = item.days !== null && item.days !== undefined && item.days > 0
    ? `${item.days} day${item.days === 1 ? '' : 's'} ${daysLabel}`
    : item.dueDate
      ? `due ${formatDate(item.dueDate)}`
      : '';
  const parts = [`• [${label}] ${item.title} — ${item.projectName}`];
  if (when) parts.push(`  (${when})`);
  if (item.kind === 'risk') {
    parts.push(`  (probability ${item.probability} × impact ${item.impact})`);
  }
  return parts.join('\n');
}

function textChase(chase) {
  const days = chase.days > 0
    ? `${chase.days} day${chase.days === 1 ? '' : 's'} outstanding`
    : 'due today';
  return `• ${chase.who} owes: ${chase.what} (${chase.projectName}) — ${days}`;
}

/**
 * Render one digest. `ctx`:
 *   subscriber  { email, name }
 *   items       ranked needs-you items (from buildDigestItems)
 *   chases      chases list (from buildDigestItems)
 *   now         Date the digest is generated for
 *   fromName    sender identity, e.g. "PocketPMO Pulse" (required)
 *   fromEmail   sender address, e.g. pulse@pocketpmo.com (required)
 *   unsubscribeUrl  optional https unsubscribe link
 * Returns { subject, html, text }. Never throws on item-level oddities.
 */
export function renderDigest(ctx) {
  const { subscriber, items = [], chases = [], now, fromName, fromEmail, unsubscribeUrl } = ctx;
  const dateLabel = formatDate(now) || 'today';
  const greeting = subscriber.name ? `Hi ${subscriber.name},` : 'Hi,';
  const hasItems = items.length > 0;

  const subject = hasItems
    ? `PocketPMO: ${items.length} thing${items.length === 1 ? '' : 's'} need you — ${dateLabel}`
    : `PocketPMO: nothing needs you today (${dateLabel})`;

  // ---- plain text -----------------------------------------------------
  const textLines = [
    greeting,
    hasItems
      ? ''
      : 'Nothing needs you today — no overdue work, pending decisions, or top risks on your projects.',
    ...items.map(textItem),
    items.length ? '' : '',
    chases.length ? 'Chases — who owes what:' : '',
    ...chases.map(textChase),
    chases.length ? '' : '',
    `— ${fromName} <${fromEmail}>`,
    `Generated ${dateLabel} from your PocketPMO project data.`,
    unsubscribeUrl
      ? `Unsubscribe: ${unsubscribeUrl}`
      : "You receive this because you're subscribed to PocketPMO pulse digests. Reply UNSUBSCRIBE to stop."
  ];
  const text = textLines.filter((line) => line !== null && line !== undefined).join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';

  // ---- HTML -----------------------------------------------------------
  const itemsHtml = items
    .map((item) => {
      const label = KIND_LABELS[item.kind] || 'Item';
      let meta = '';
      const daysLabel = item.kind === 'decision' ? 'waiting' : 'overdue';
      if (item.days > 0) {
        meta = `${item.days} day${item.days === 1 ? '' : 's'} ${daysLabel}`;
      } else if (item.dueDate) {
        meta = `due ${formatDate(item.dueDate)}`;
      } else if (item.kind === 'risk') {
        meta = `probability ${item.probability} × impact ${item.impact}`;
      }
      return `      <div style="margin:0 0 14px 0;padding:12px 14px;border-left:4px solid #b45309;background:#fffbeb;border-radius:4px;">
        <div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#92400e;">${escapeHtml(label)}</div>
        <div style="font-size:15px;font-weight:600;color:#111827;margin:4px 0 2px;">${escapeHtml(item.title)}</div>
        <div style="font-size:13px;color:#4b5563;">${escapeHtml(item.projectName)}${meta ? ` — <strong>${escapeHtml(meta)}</strong>` : ''}</div>
      </div>`;
    })
    .join('\n');

  const chasesHtml = chases.length
    ? `      <h2 style="font-size:14px;color:#374151;margin:26px 0 8px;">Chases — who owes what</h2>\n` +
      chases
        .map((chase) => {
          const days = chase.days > 0
            ? `${chase.days} day${chase.days === 1 ? '' : 's'} outstanding`
            : 'due today';
          return `      <div style="font-size:13px;color:#374151;margin:0 0 6px 0;">${escapeHtml(chase.who)} owes: <strong>${escapeHtml(chase.what)}</strong> <span style="color:#6b7280;">(${escapeHtml(chase.projectName)} — ${escapeHtml(days)})</span></div>`;
        })
        .join('\n')
    : '';

  const unsubscribeHtml = unsubscribeUrl
    ? `<a href="${escapeHtml(unsubscribeUrl)}" style="color:#6b7280;">Unsubscribe</a>`
    : "You receive this because you're subscribed to PocketPMO pulse digests. Reply <strong>UNSUBSCRIBE</strong> to stop.";

  const html = `<!DOCTYPE html>
<html lang="en">
  <body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <div style="max-width:560px;margin:0 auto;padding:24px 16px;">
      <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;padding:24px;">
        <div style="font-size:12px;color:#9ca3af;margin-bottom:4px;">PocketPMO pulse — ${escapeHtml(dateLabel)}</div>
        <h1 style="font-size:20px;color:#111827;margin:0 0 14px;">${hasItems ? `${items.length} thing${items.length === 1 ? '' : 's'} need you` : 'Nothing needs you today'}</h1>
        <p style="font-size:14px;color:#374151;margin:0 0 18px;">${escapeHtml(greeting)}</p>
        ${hasItems ? '' : `        <p style="font-size:14px;color:#6b7280;margin:0 0 18px;">No overdue work, pending decisions, or top risks on your projects today.</p>\n`}
${hasItems ? itemsHtml + '\n' : ''}${chasesHtml ? chasesHtml + '\n' : ''}
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:22px 0 14px;" />
        <div style="font-size:12px;color:#6b7280;line-height:1.6;">
          — ${escapeHtml(fromName)} &lt;<a href="mailto:${escapeHtml(fromEmail)}" style="color:#6b7280;">${escapeHtml(fromEmail)}</a>&gt;<br/>
          Generated ${escapeHtml(dateLabel)} from your PocketPMO project data.<br/>
          ${unsubscribeHtml}
        </div>
      </div>
    </div>
  </body>
</html>
`;

  return { subject, html, text };
}
