# opencode-capy-lead

An OpenCode plugin that turns one session per project into a **deputy-boss lead** (a PM secretary) coordinating up to 16 worker sessions. The lead is woken by real events, never polling; workers can register durable scheduled check-backs so no wait is ever forgotten; silent workers get exactly one reminder before the lead is told.

> Personal project — not published to npm. Install from this repository (or a local clone):

```sh
opencode plugin add capytron/opencode-capy-lead
```

For a local clone, use the path directly in the config:

```json
"plugins": ["/home/you/opencode-capy-lead"]
```

## Requirements

- OpenCode v2.2+ (TUI panel requires 2.2.3+ / OpenTUI 0.8).

## Install

Use the quick-install command above, or add the package to the configuration array:

```json
"plugins": ["capytron/opencode-capy-lead"]
```

## Getting started

1. Install the plugin using either method above.
2. Run `/capy-lead-init [persona]` in the session that should be the lead — this binds it, creates the `.capy/` workspace, and injects the PM contract.
3. Have the lead create worker sessions with `parentID` set to its session ID for automatic registration, or register existing project sessions through `capy_lead add`.
4. Open `/capy-team-view` to inspect the team and navigate to sessions. Use `/capy-team-info` to print the roster into the conversation.

## Commands

| Command | Purpose |
| --- | --- |
| `/capy-lead-init [persona]` | Bind the current session as this project's lead (one lead per project directory). |
| `/capy-set-persona <text>` | Set the lead's persona. |
| `/capy-team-info` | Print the roster, busy/idle status, and pending waits into the conversation. |
| `/capy-lead-destroy` | Interrupt and delete all workers, including orphans, clear the roster and waits, and unbind the lead. Partial failures keep the binding so the command can be rerun. |
| `/capy-team-view` | Open the interactive TUI team panel; also available in the command palette. |

All commands except `/capy-team-view` are server commands.

## Agent tool

Agents manage the team through the `capy_lead` tool.

| Action | Purpose and constraints |
| --- | --- |
| `bind` | Bind the calling session as lead; optionally set a persona. |
| `add` | Register a worker. Lead-only; the worker must be in the same project directory and cannot be the lead or any of its ancestors. The team is capped at 16 workers. |
| `remove` | Unregister a worker without deleting its session (its pending wait is cleared). Lead-only. |
| `unbind` | Unbind the lead; all scheduled waits are cleared with it. |
| `notify` | Send a worker's report to the lead with an explicit `kind`: `done` / `progress` queue for the lead's next wake; `blocked` / `question` wake the lead immediately. No keyword guessing — the worker states its intent (language-agnostic by design). 10 delivered messages/hour per worker (failed deliveries never consume quota), 600 characters each; sender identity comes from the calling session. A concluding report clears the sender's scheduled wait. |
| `wait` | Register a durable scheduled check-back (workers only): `reason` (what you wait for and how you will check it), `checkInMinutes` (1–1440), `maxChecks` (default 6, max 20), optional `waitForSessionId` (when that session's round ends, the check becomes due immediately — `checkInMinutes` stays the fallback). The plugin wakes the worker at check time with its own reason attached. One active wait per worker: re-registering overwrites, but the first budget stands — when it is spent, only the lead can continue the wait. |
| `list` | View the team, busy/idle status, latest results, and all pending waits. |

**The end-of-turn rule:** a worker never ends a turn while work is pending without calling `wait` (schedule a check) or `notify` (report/ask). The system enforces it — see the idle gate below.

## How it works

- **PM contract:** injected into the lead's system prompt on every model request via the context hook, so it survives compaction. It fixes the failure modes models actually hit: tiny status reports followed by stopping ("a report is not a stopping point"), acknowledging finished workers without a decision, vague progress filler. Reports to the owner use three lines — `Task [status] / Progress / Next` — with statuses `working | waiting | waiting-owner | done | stopped`.
- **Event-driven wake:** server events wake the lead when a registered worker succeeds, fails, or is interrupted (user-initiated interruptions do not notify). Finish notices steer the lead at most once per worker per minute; repeats ride the queue.
- **Scheduled check-backs:** a 60-second heartbeat wakes workers whose wait came due, with the reason they registered. Busy workers do not consume a check. A failed wake delivery is retried with backoff. When a wait's check budget is spent — or a wake goes unacted for 24h — the lead gets one decision request (workers cannot extend a budget alone).
- **Idle gate:** a worker round that ends with no wait and no notify gets exactly one reminder ping; a second silent round escalates to the lead once, then the worker is muted for 15 minutes.
- **Silence watchdog:** a worker busy with no activity for 30 minutes asks the lead to *check* (never to stop) — up to 3 wakes, resetting when the worker shows activity.
- **Startup reconciliation:** waits that came due while offline wake in a stagger; anything stale (6h+) or out of budget goes to the lead as one summary instead of a thundering herd.
- **Bounded retry:** two or more non-overflow execution failures per worker within 10 minutes escalate with a provider-outage hint when several workers fail together.
- **Per-project registry:** each project directory has one lead and one roster, persisted in plugin storage. Bindings for deleted sessions are pruned on load; stale busy flags are reset so the watchdog cannot false-positive after a restart.
- **Overflow auto-recovery:** context-window failures trigger compaction and a continue-the-work notice, capped at two recoveries per hour per session. When the `continuity` plugin is installed, capy-lead defers compaction to it; a compaction within the last five minutes is never repeated.
- **Workspace:** `/capy-lead-init` creates `.capy/` with `tickets/` and `tmp/` (ticket-less scratch); `.capy/local/` is kept out of git by `.capy/.gitignore`. Tracking is **ticket-model-v2**: one `t-<seq>-<slug>.md` file per ticket (never moves), an optional same-named folder only when the work produces files, a one-row-per-open-ticket `index.md` ledger maintained by the lead alone, and closed work summarized as one-line outcome rows in `archive/YYYY-MM.md` (old reports stay one row away). The mode chosen at init (Developer / Utility / None) loads only its own rules into the lead's context — None records nothing at all. The plugin stays domain-neutral on purpose: conventions, data-handling policy, and language belong to the project's AGENTS.md, the lead-maintained `.capy/team.md`, or the owner's init prompt — the engine stores no tracking state and never parses ticket files (a future `capynote` CLI can index them as-is).

## TUI

The footer strip shows team status:

```text
capy ▶ 2/3 ✓1 ✗0
```

- `▶`: the lead is running.
- `2/3`: running workers / total workers.
- `✓1` and `✗0`: counts of succeeded and failed last outcomes.

In `/capy-team-view`, **up/down** moves the selection, **return** opens the selected session, and **escape** closes the panel. Clicking a session opens it. A compact team tree also appears in the sidebar.

Worker failures and pending team questions produce toast notifications, with desktop notifications and sound when the terminal is unfocused. Successful rounds are silent.

## Limitations

- Slash commands are a local administration surface, not a security boundary.
- Event delivery is best-effort around plugin reloads; there is no durable outbox. Wait wakes, however, are durable: a missed or failed wake is retried or escalated to the lead.
- If the machine sleeps or the location is idle-evicted, the heartbeat pauses; overdue waits reconcile (staggered, herd-guarded) on the next load.
- Worker-supplied notice text is flattened and length-capped. This is structural mitigation only, not semantic prompt-injection protection.
- Recovery budgets and deduplication windows are in memory and reset on reload.
- A worker that alternates `notify` → fresh `wait` resets its check budget each cycle; the bound today is the notify rate limit (10/hour). A per-worker cumulative budget is planned.
