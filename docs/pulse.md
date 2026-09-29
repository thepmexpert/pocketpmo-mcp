# Email pulse worker (`pulse.js`)

One daily weekday email per subscriber: **"N things need you"** — up to 3
ranked needs-you items plus a chases section — computed from the same
project JSON exports the MCP server reads. Outbound only; no in-app UI.
Approved plan: TPMAAAA-2372 (`#document-plan`), board directive 2026-09-29.

## Quickstart (dry-run — sends nothing)

```bash
PMO_PROJECTS_DIR=./data \
PULSE_SUBSCRIPTIONS=./subscriptions.sample.json \
PULSE_OUT_DIR=./pulse-out \
node pulse.js
```

Output: `pulse-out/<YYYY-MM-DD>/<email>.html` + `.txt` + `.json`, and one
JSON summary line on stdout:

```json
{"ok":true,"dryRun":true,"recipients":2,"sent":0,"written":3,"skipped":1,"errors":[],"warnings":[]}
```

Dry-run is the DEFAULT. Real sending requires `PULSE_SEND=1` **and** a
`POSTMARK_SERVER_TOKEN` in the environment (see `lib/pulse/provider.js`).

## Configuration (env)

| Variable | Default | Meaning |
|---|---|---|
| `PMO_PROJECTS_DIR` | `./data` | Project JSON exports (shared with the MCP server). |
| `PULSE_SUBSCRIPTIONS` | `./subscriptions.json` | Recipient roster (see `subscriptions.sample.json`). Keep production rosters **outside the repo** — recipient emails are personal data. |
| `PULSE_OUT_DIR` | `./pulse-out` | Dry-run output directory (gitignored). |
| `PULSE_FROM_NAME` | `PocketPMO Pulse` | Sender identity. |
| `PULSE_FROM_EMAIL` | `pulse@pocketpmo.com` | Sender address — must be SPF/DKIM-aligned on the sending domain. |
| `PULSE_UNSUBSCRIBE_URL` | _(none)_ | Optional https unsubscribe link; without it the footer asks for a `UNSUBSCRIBE` reply. |
| `PULSE_DATE` | now | Override "today" (ISO); used by tests and manual replays. |
| `PULSE_FORCE` | _(unset)_ | `1` bypasses the weekday/cadence guard (staging tests only). |
| `PULSE_SEND` | _(unset)_ | Must be exactly `1` to enable real sends. |
| `POSTMARK_SERVER_TOKEN` | _(none)_ | Postmark server token. **Secret**: issued via a Paperclip secret proposal; never committed to git, `.env` files, or docs. |

## Subscriptions file

```json
{ "subscribers": [
  { "email": "pm@example.com",
    "name": "D. Byrne",
    "projects": ["Northgate Platform Migration"],
    "cadence": "daily" }
] }
```

- `name` drives owner matching (see below); `projects` filters which
  exports feed the digest (empty/missing = all projects).
- `cadence`: `daily` (served Mon–Fri) or `weekly` (served Mondays).
  The worker enforces this itself — a cron misconfig cannot spam weekends.

## What counts as "needs you" (ranking rule)

Per subscriber, over their referenced projects:

| Item | Score |
|---|---|
| Overdue activity / milestone owned by the recipient (open, past due date) | `10000 + daysOverdue` |
| Pending decision owned by the recipient | `5000 + daysPending` |
| Open risk the recipient owns | `P × I × 100` |
| Top open P×I risk on a project they manage (even if unowned) | `P × I × 100` |

Highest score first, capped at **3** items. Chases (explicit `asks` arrays
plus overdue work owned by others on their projects) are listed separately,
most outstanding first, capped at **5**.

Field tolerance: exports are hand-editable JSON, so due dates
(`dueDate`/`due`/`endDate`/`finishDate`/`targetDate`/`finish`), owners
(`owner`/`assignee`/`responsible`), and titles are read through tolerant
getters. Owner matching is exact-lowercase, email, or a shared name token
of length ≥ 3 (`D. Byrne` matches `David Byrne`; role labels like `PM`
never match). Anything unparseable is skipped — a missing date can never
fabricate an "overdue" item, and malformed projects never crash the run.

## Scheduler (CTO decision)

**Host cron/launchd on the Mac Mini** — the slack-bridge / trello-sync
precedent. This is a one-shot process; there is no resident scheduler to
monitor, and logs go to the host's usual capture. Suggested crontab (06:30
Mon–Fri local):

```
30 6 * * 1-5  cd /path/to/pocketpmo-mcp && /usr/bin/env PMO_PROJECTS_DIR=/path/to/data PULSE_SUBSCRIPTIONS=/path/to/subscriptions.json PULSE_SEND=1 POSTMARK_SERVER_TOKEN="$PULSE_POSTMARK_TOKEN" node pulse.js >> /var/log/pocketpmo-pulse.log 2>&1
```

(Feed the token from a root-owned environment file or `launchd`
`EnvironmentVariables`, not from this repo.)

## Provider (CTO decision): Postmark over Resend

1. **Deliverability**: Postmark's network is transactional-only; shared
   pools carry no marketing mail — the right profile for an operational
   digest from a young domain.
2. **Zero-dep fit**: one endpoint, one header (`X-Postmark-Server-Token`)
   — a bare `fetch`, matching the repo's zero-dep rule.
3. **Free developer tier** (100/day) covers the MVP subscriber count.
   The provider is isolated in `lib/pulse/provider.js`; swapping to Resend
   is a one-module change if pricing/needs change.

Messages go out on Postmark's `broadcast` stream (permissioned, opt-out
digests — not password-reset-style transactional mail).

## Secret handling

`POSTMARK_SERVER_TOKEN` is a credential. It is provisioned through a
**Paperclip secret proposal** and injected into the worker's environment at
runtime. It must never appear in git history, `.env` files, issue comments,
or documentation. The repo's `subscriptions.sample.json` contains only
placeholder addresses.

## Tests

```bash
npm test -- test/pulse.test.js   # or the full suite: npm test
```

Coverage: subscriptions loading (invalid/duplicate/malformed), ranking and
selection, empty state, malformed-project fail-soft, HTML/text rendering
(escapes, unsubscribe line, sender identity), the dry-run/send gate, the
Postmark client against a fake fetch, cadence guard, and an end-to-end
`runPulse` dry run over `data/sample-project.json`.
