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
{"ok":true,"dryRun":true,"recipients":3,"sent":0,"written":9,"skipped":0,"errors":[],"warnings":[]}
```

(recipients/written counts reflect the sample roster on a Monday: one
`daily`, one `weekly`, one `ritual` subscriber — all three due.)

Dry-run is the DEFAULT. Real sending requires `PULSE_SEND=1` **and** the
selected provider's credentials (`PULSE_PROVIDER`: `agentmail` | `postmark`,
default `postmark` — see `lib/pulse/provider.js`).

## Configuration (env)

| Variable | Default | Meaning |
|---|---|---|
| `PMO_PROJECTS_DIR` | `./data` | Project JSON exports (shared with the MCP server). |
| `PULSE_SUBSCRIPTIONS` | `./subscriptions.json` | Recipient roster (see `subscriptions.sample.json`). Keep production rosters **outside the repo** — recipient emails are personal data. |
| `PULSE_OUT_DIR` | `./pulse-out` | Dry-run output directory (gitignored). |
| `PULSE_FROM_NAME` | `PocketPMO Pulse` | Sender identity. |
| `PULSE_FROM_EMAIL` | `pulse@pocketpmo.com` | Sender address — with AgentMail it rides as Reply-To (envelope-from is the inbox); with Postmark it is the envelope From and must be SPF/DKIM-aligned. |
| `PULSE_UNSUBSCRIBE_URL` | _(none)_ | Optional https unsubscribe link; without it the footer asks for a `UNSUBSCRIBE` reply. |
| `PULSE_DATE` | now | Override "today" (ISO); used by tests and manual replays. |
| `PULSE_TZ` | host local | IANA zone for the run's calendar day — the cadence guard, date labels, dry-run folders, and overdue-day math all read THIS calendar (not UTC), because the crontab fires in host-local time. Pin it (e.g. `Europe/Dublin`) so behavior survives host tz changes; an invalid value warns and falls back to host local. |
| `PULSE_FORCE` | _(unset)_ | Must be exactly `1` to bypass the weekday/cadence guard (staging tests only); e.g. `0` does NOT bypass. |
| `PULSE_SEND` | _(unset)_ | Must be exactly `1` to enable real sends. |
| `PULSE_PROVIDER` | `postmark` | `agentmail` or `postmark`. Any other explicit value is invalid: it keeps the send gate closed (dry-run) even if a postmark token is present — misconfiguration fails toward dry-run. |
| `AGENTMAIL_API_KEY` | _(none)_ | AgentMail API key (used when `PULSE_PROVIDER=agentmail`). **Secret**: system keychain / Paperclip secret proposal; never committed. |
| `AGENTMAIL_INBOX_ID` | _(none)_ | Sending AgentMail inbox id, e.g. `pocketpmo-pulse@agentmail.to`. **Secret-adjacent config**; provisioned with the key. |
| `POSTMARK_SERVER_TOKEN` | _(none)_ | Postmark server token (default provider). **Secret**: issued via a Paperclip secret proposal; never committed to git, `.env` files, or docs. |

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
- `cadence`: `daily` (served Mon–Fri), `weekly` (served Mondays), or
  `ritual` (served Mondays + Fridays with the Monday/Friday ritual
  briefs — see below).
  The worker enforces this itself — a cron misconfig cannot spam weekends.
  The weekday guard reads the `PULSE_TZ` (default host-local) calendar
  day, matching the crontab's clock — see `lib/pulse/calendar.js`.

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

## Ritual briefs (`cadence: "ritual"` — TPMAAAA-2370)

Beyond the daily digest, a subscriber on `cadence: "ritual"` gets ONE
brief per PM ritual day, rendered by `lib/pulse/ritual.js` +
`lib/pulse/render-ritual.js`. Served Mondays and Fridays only (the
worker enforces this like every cadence — a cron misconfig cannot send a
ritual brief on a Wednesday):

- **Monday — what slipped + decisions you owe.** Every open, past-due
  activity/milestone on the subscriber's projects (owner-attributed, the
  recipient's own items flagged "yours"), worst first, capped at 8 with an
  overflow note; plus pending decisions waiting on the recipient, days
  waiting, capped at 8. Nothing slipped → a short clean-slate brief.
- **Friday — status draft + changes since last week.** Per referenced
  project, a factual, copy-paste-ready status paragraph (progress,
  overdue count + worst item, decisions pending on you, top open P×I
  risk, next due date — only the fields the export actually contains, no
  invented RAG ratings); plus every derivable change inside the last 7
  calendar days (items that came due — still open or closed —, decisions
  raised, and `updatedAt`/`modifiedAt`/`lastUpdated` timestamps when a
  future export grows them), capped at 10.

**Honesty constraint:** project exports carry no change history (no
`updatedAt` in the wild today). "Changes since last week" is therefore
derived ONLY from dates the exports contain; a quiet week renders an
explicit "no dated changes in the project exports over the last 7 days"
line. A missing date never fabricates a change.

**`PULSE_BRIEF`** (`monday`|`friday`): overrides the weekday-derived
brief for `PULSE_FORCE` staging runs on other days; an invalid value
warns and falls back to the weekday default (Mon→monday, Fri→friday,
any other forced day→monday).

## Scheduler (CTO decision)

**Host cron/launchd on the Mac Mini** — the slack-bridge / trello-sync
precedent. This is a one-shot process; there is no resident scheduler to
monitor, and logs go to the host's usual capture. Suggested crontab (06:30
Mon–Fri local):

```
30 6 * * 1-5  cd /path/to/pocketpmo-mcp && /usr/bin/env PMO_PROJECTS_DIR=/path/to/data PULSE_SUBSCRIPTIONS=/path/to/subscriptions.json PULSE_SEND=1 PULSE_PROVIDER=agentmail PULSE_TZ=Europe/Dublin AGENTMAIL_API_KEY="$PULSE_AGENTMAIL_KEY" AGENTMAIL_INBOX_ID="pocketpmo-pulse@agentmail.to" node pulse.js >> /var/log/pocketpmo-pulse.log 2>&1
```

(Feed the credentials from a root-owned environment file or `launchd`
`EnvironmentVariables`, not from this repo. Pin `PULSE_TZ` to the zone the
cron schedule actually means — the guard and all date labels follow it.)

## Provider (CTO decision): selectable — AgentMail (staging) / Postmark (prod candidate)

`PULSE_PROVIDER` selects the delivery client; both live in
`lib/pulse/provider.js` as zero-dep `fetch` wrappers with the same
`{ok, messageId|error}` result contract.

**AgentMail** (board directive 2026-09-29 — the company's credentialed
channel today, used for P2 staging):

1. **No DNS prerequisites**: sends originate from a dedicated AgentMail
   inbox (e.g. `pocketpmo-pulse@agentmail.to`), so staging can start
   without the board-owned pocketpmo.com DNS changes.
2. **Verifiable delivery**: the internal test mailbox is an AgentMail
   inbox too, so delivery is confirmed by reading the recipient inbox via
   the API — no human "did it arrive?" loop.
3. **Envelope-from is the inbox address**; `PULSE_FROM_EMAIL`
   (`pulse@pocketpmo.com`) is passed as Reply-To. SPF/DKIM alignment of
   the visible From: on pocketpmo.com remains a board DNS decision for
   production (AgentMail custom domains, exact records on request).

**Postmark** (production candidate, default provider — original decision
record: Postmark over Resend):

1. **Deliverability**: Postmark's network is transactional-only; shared
   pools carry no marketing mail — the right profile for an operational
   digest from a young domain.
2. **Zero-dep fit**: one endpoint, one header (`X-Postmark-Server-Token`)
   — a bare `fetch`, matching the repo's zero-dep rule.
3. **Free developer tier** (100/month) covers the MVP subscriber count.
   Resend stays a one-module swap if pricing/needs change.

Messages go out on Postmark's `broadcast` stream (permissioned, opt-out
digests — not password-reset-style transactional mail).

## Secret handling

`AGENTMAIL_API_KEY` and `POSTMARK_SERVER_TOKEN` are credentials. They are
provisioned through a **Paperclip secret proposal** (or the macOS system
keychain) and injected into the worker's environment at runtime. They must
never appear in git history, `.env` files, issue comments, or
documentation. The repo's `subscriptions.sample.json` contains only
placeholder addresses.

## Tests

```bash
node --test test/pulse.test.js   # or the full suite: npm test
```

Coverage: subscriptions loading (invalid/duplicate/malformed), ranking and
selection, empty state, malformed-project fail-soft, HTML/text rendering
(escapes, unsubscribe line, sender identity), the provider-aware dry-run/
send gate, the Postmark and AgentMail clients against a fake fetch, cadence
guard, the `PULSE_TZ` calendar anchoring (guard/labels/folders/overdue math
on one calendar), an end-to-end `runPulse` dry run over
`data/sample-project.json`, and the ritual briefs (`test/ritual.test.js`:
Monday slipped/decisions extraction + caps, Friday status drafts, the
7-day change window incl. updatedAt tolerance and the honest empty state,
brief-kind resolution incl. `PULSE_BRIEF` override/warning, ritual
cadence guard, and an end-to-end ritual dry run).
