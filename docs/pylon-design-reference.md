# dispatch — Pylon design reference

Captured 2026-05-20. Pylon is the **structural** reference for the dispatch build.
Take the information architecture and the interaction patterns. **Ignore the
visuals** — Pylon is a light UI; dispatch is dark and emerald-accented per its
own palette (see `CONTEXT.md` and the Claude Design prompt).

Each entry below is titled (R0–R10) so a Claude Design prompt can reference it.
When uploading to Claude Design, attach the matching screenshot file and name it
to its title (e.g. `R1-pylon-issues-board.png`).

---

## R0 — Our v1 render (rejected)

The dark single-page render dispatch's first prompt produced. **For our
reference only — do not upload this one to Claude Design.** Every component in it
is correct (queue rows, status pills, per-engineer hours, Shared Issues,
reassignment cards). The mistake was information architecture: it stacked four
surfaces onto one page. The fix is four separate screens, not a tidier single
page.

## R1 — Pylon Issues board (kanban) → dispatch Issues board

The home screen. A kanban: columns are statuses (New / Waiting on You / Waiting
on Customer / On Hold), cards are tickets. Persistent left rail: nav (Accounts,
Issues, Broadcasts, Analytics, Integrations, Knowledge Base, Settings), saved
views under Issues (Unassigned, My Issues, By Customer, By Priority), and a
Connections list (Slack, Salesforce, HubSpot, etc.).

- **Take:** the kanban-by-status layout, compact card density, the persistent
  left rail with nav + saved views + connections.
- **Ignore:** Pylon's column names and field set. dispatch's status ladder is
  its own (New, On You, Waiting on Client, Follow-up Required, Follow-up 1 Sent,
  Closeout Follow-up Required).

## R2 — Pylon Triggers → dispatch Settings / Triggers surface

The automation config. "When a new issue is created → If [ARR > X and the
question is about Y] → Then [assign team / set a field]." A visual When / If /
Then rule builder, self-serve.

- **Take:** the whole pattern. This is how dispatch's routing, OOO coverage, and
  the 12h escalation get configured by Cody without code.

## R3 — Pylon issue detail → dispatch ticket detail

Drill into a card. Center: the client conversation, with a pinned "Account
Highlights" box and a tabbed top bar naming who you are talking to (Chat,
Internal thread, linked issues). Reply box at the bottom. Right: a panel
controlled by a vertical icon toolbar.

- **Take:** the three-zone layout, the tabbed top bar, the bottom reply box, and
  especially the right panel being toolbar-swappable.

## R4 — Pylon Account Highlights → dispatch, sourced from boolean-knowledge

The pinned highlights box, and the right-rail "Highlights" tab showing "Edited on
Feb 11 by Advith Chelikani."

- **Take:** the pinned-highlights pattern.
- **Key point:** it is a human-edited field, not AI. In dispatch this is a
  curated snippet from the client's boolean-knowledge file. Zero AI cost.

## R5 — Pylon internal-thread dropdown → dispatch internal thread

"+ Internal thread" opens a dropdown: Pylon / Slack / Email. dispatch uses the
Slack option.

## R6 — Pylon "Create internal thread in Slack" modal → dispatch

A searchable channel picker (type to filter any channel the app can post to),
an optional message, and a Slack-side preview. Private channels appear only once
the app is invited to them.

- **Take:** the searchable channel picker and the Slack-message preview.

## R7 — Pylon synced internal thread → dispatch

After the internal thread is created, replies posted in the Slack channel sync
back into the ticket, shown highlighted with a channel sticky (`#bugs-daily`).

- **Take:** the bidirectional sync, and the visual treatment — synced-in messages
  are visibly distinct and carry the channel name.

## R8 — Pylon account-info panel → dispatch client-info panel

The right-panel client view: revenue, seats, open issues count, avg response
time, days since last issue, churn risk.

- **Take:** the idea of a client-context panel in the swappable right rail.
- **For dispatch:** the content is sourced from boolean-knowledge, not a CRM, and
  the fields are dispatch's own (open tickets, client health, the §9.4 per-client
  economics) — not Pylon's SaaS metrics.

## R9 — Pylon Analytics (General) → dispatch Analytics surface

A section of dashboards reached from the left nav (General, CSAT, NPS, Workforce,
SLA). Headline counts plus charts.

- **Take:** Analytics is its own navigable section with multiple named
  dashboards, admin-gated.

## R10 — Pylon Workforce dashboard → dispatch admin dashboard

Per-assignee charts: median business-hours time to first response, median time
to resolution, issues by source by assignee.

- **Take:** this is the admin dashboard for Chris and Cody — response time,
  resolution time, issues handled, per engineer. Business-hours-aware, the same
  6am-5pm PST clock dispatch uses.
