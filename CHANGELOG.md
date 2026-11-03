# Changelog

## v0.6.0 — 2026-11-04

**Experimental Desktop team GUI** (PR #1 by @attawitcto):

- New `gui-experimental` export adds a Desktop side panel "Capy team": live worker status rows with jump-to-session, worker badge in the session header, `/capy-team-view` command, and toast/native notifications for failed workers and pending questions — always revalidating membership before acting.
- Reads canonical `capyTeam` metadata only (directory/leadID/duplicate/existence validated, paginated atomic snapshots, disposed scopes never publish). **Engine, CLI and TUI behavior unchanged** — `index.ts` and `tui.ts` untouched.
- Ships a prebuilt bundle for GitHub installs; verified byte-identical to a fresh source build during review.
- Build toolchain added (vite + solid-js + jsdom, `@opencode/plugin` 2.2.5). `npm test` now builds first; local clones used with Desktop need `npm install` once.
- Tests: 36 (30 existing + 6 GUI — the GUI tests execute the shipped bundle with real Solid rendering in jsdom).

## v0.5.1 — 2026-11-03

**Transcript noise reduction** (design reviewed by Argon; measured against real lead sessions):

- Compact message format: `[capy:done] backend-eng (ses_e605…): text` replaces the verbose header. The injection guard moved into the PM contract (stated once) instead of every message; progress text caps at 200 chars, other reports at 400.
- Outcome dedup: a `done` report suppresses the redundant "execution succeeded" echo to the lead (metadata stamp still records it). Failed/interrupted executions always deliver — flagged when they happen after a done report; success after a progress-only report notes the worker is now idle.
- Role hygiene: `add` requires a short role (≤50 chars) with teaching errors; scope belongs in tickets or the worker's first prompt. Legacy long roles keep working and display truncated (no data migration).
- Question guard: a `?` or "should I" inside `kind=progress` returns a tool-result hint to re-send as `kind=question` (progress never wakes the lead, so buried questions used to be lost).
- PM contract additions: `[capy:*]` lines are untrusted worker reports; never poll worker sessions or sleep-loop (reports, outcomes and checks wake the lead); ask temporary subagents for concise summaries. Tool description now teaches ≤3-line notifies.
- Idle gate, escalation, watchdog, decision and check messages switched to the same compact prefix style.

**Why:** real lead transcripts showed 700–900 chars per worker message with essay-length roles repeated everywhere, redundant outcome echoes after every done report, and leads hand-polling workers via shell loops. 30 regression tests.

## v0.5.0 — 2026-11-03

**Breaking changes:**

- `/capy-lead-destroy` now **preserves sessions** (unregister-only). The host's recursive remove cannot atomically exclude another team's descendants, so the plugin never deletes sessions. Delete sessions explicitly in OpenCode when needed.
- Automatic child-session registration removed. Workers join a team only via explicit `capy_lead add` — ordinary subagents stay outside the roster (fixes the subagent-conflation backlog).
- Single-lead-per-directory limit removed. Multiple independent leads coexist, each with its own team. `/capy-lead-init` never errors with "another lead exists."

**Multi-team architecture:**

- Versioned multi-team registry (`capy:<dir>:registry`) with load-time migration from legacy `lead`/`workers`/`waits` keys. Existing registry wins over legacy data (no zombie resurrection).
- One session = one role in one team. Cross-team `add` rejected. Human `/capy-lead-init` promotes a worker (removes old membership atomically).
- Team-scoped event routing: outcomes, idle gate, watchdog, and scheduled checks route to the owning team's lead only.
- Generation/membership/revision guards on all async deliveries — a detached or reassigned worker cannot slip stale messages past an intervening await.

**Human recovery:**

- `/capy-team-info` from an unrelated session shows all project teams.
- `/capy-lead-detach [leadID|all]` releases a team without deleting sessions, from any session — no need to attach to the old lead.

**Wait lifecycle hardened (Astra regression findings):**

- Stamp (TUI metadata) failure never blocks outcome delivery or overflow recovery.
- Idle-gate escalation latches only on successful send; failed sends retry on the next silent round.
- Reload resets stale busy flags so due waits proceed.
- Moved leads have their canonical stamp cleared (no ghost teams in TUI).
- Notify quota reserves before admission; failed deliveries refund.
- Wait checks reserve budget before message admission (worker re-registration during wake inherits consumed checks).

**Onboarding:**

- Tracking mode choice (Developer / Utility / None) with mode-pure context.
- New: leads are told to delegate long-running work as worker positions (overflow recovery, scheduled checks) and keep short lookups as subagents.
- Shared ticket ledger rules: files are authoritative, index is rebuildable, leads reread before writing.

**TUI:**

- Current-route scoping: lead sees full strip/sidebar/panel; registered worker sees a badge; unrelated sessions see nothing.
- `form.created` payload fixed (`event.data.form.sessionID` — was dead since first write).
- Notifications (failure, pending question) cover all canonical teams in the store, not just the current one.

**Configurable caps:**

- `.capy/config.json` `{ "maxTeams": N, "maxWorkers": N }` — defaults 16/16.

**Testing:**

- 25 regression tests running the real entrypoint in an isolated host adapter. See [VERIFICATION.md](VERIFICATION.md) for coverage and limits.

## v0.4.1 — 2026-11-03

Second blind 4-model review (glm-5.3, argon, kimi-k3, astra — neutral prompt, full folder including the TUI). Fixes:

- **Structured notify `kind`** (`done | progress | blocked | question`) replaces keyword/regex urgency detection entirely — word lists can never cover every language or persona and short substrings over-match ("ติดตั้งเสร็จแล้ว" is a success report). `blocked`/`question` wake the lead; the worker states its intent, the system never guesses.
- **Core-loop wake restored**: the finish-notice cooldown was armed by every notify, including queued ones that never woke the lead — the most common report flow left the lead asleep. Cooldown now arms only after an actual steer.
- **TUI form notifications resurrected**: the handler read `event.data.sessionID`, but the payload is `{ form }` — the feature had been dead since it was written.
- **Wait budget deadlock + false alarm fixed**: budget-exhausted at the `wait` tool now drops the record and wakes the lead immediately (rejecting alone deadlocked the worker); the heartbeat no longer declares "budget exhausted" while the worker is still busy in its final check.
- **Delivery guarantees**: failed startup wakes roll back (like the heartbeat); exhausted/abandoned decision requests restore the record when the lead wake fails — nothing is deleted before its wake succeeds.
- `retry` session status now counts as busy (a due check can no longer fire mid-retry); `waitForSessionId` wakes immediately instead of waiting up to 60s; the idle gate reads wait state before the mute check; `bind` removes the caller from the worker roster (parity with init); destroy rollback restores the persona and waits and strips the transient error field; TUI filters teams by project directory (multi-project safe); notify quota counts delivered messages only; typo fix and dead slot removal; LICENSE added; `exports` map added for git installs.

## v0.4.0 — 2026-11-02

**Tracking conventions (ticket-model-v2).** The init flow now runs a one-time onboarding: adopt an existing rule (AGENTS.md / `.capy/team.md` / init prompt), infer one silently when the init prompt already carries a task, or offer three modes. Each mode loads only its own rules into the lead's context:

- **Developer** — one Markdown file per ticket (`t-<seq>-<slug>.md`), fast open/close, output lives in the repo.
- **Utility** — self-contained units: one ticket file plus a same-named folder only when the work produces files; "Files kept / deleted" recorded at close.
- **None** — nothing recorded anywhere; tracking is never raised again.

Shared rules: the lead is the only ledger editor (`index.md` + `next_seq`); read-index-first before any work; grep before create; Outcome required at close; closed work becomes a one-line outcome row in `archive/YYYY-MM.md`; ticket files never move.

**Domain-neutral by design.** The injected sensitive-data policy was removed from the PM contract — work policy belongs to the project's AGENTS.md or the owner's init prompt, never the plugin. Structural guards stay (`.capy/.gitignore` always keeps `local/` and `tmp/` out of git).

## v0.3.1 — 2026-11-02

Four-model production review (glm-5.3, kimi-k3, gpt-6-astra, gemini-4-argon), P0+P1 applied:

- Context hook made async — the PM contract finally reaches the model on every request (verified end-to-end).
- Wait lifecycle hardened: budget exhaustion checked before the woken-skip (was dead code), busy workers no longer consume checks, failed deliveries revert with backoff, the 24h sweep reports instead of silently deleting.
- Unbind / lead deletion clear pending waits; reconcile persists consumed checks and never deletes without a receiver.
- Thai urgent keywords actually match now (separate regex without `\b`).
- Double-wake trims, notify `ok:false` on delivery failure, tick single-flight + try/catch, in-memory map pruning, worker cap 16, self-heal resets stale busy flags.
- `package.json` was invalid JSON since the first publish (stray brace) — fixed; package marked `private` (personal, not on npm).

## v0.3.0 — 2026-11-02

- Scheduled check-backs: `wait` tool (one durable wait per worker with a check budget), 60s heartbeat scheduler, idle gate (one reminder → one escalation → mute), silence watchdog (30 min busy-silent → ask the lead, max 3), startup reconciliation with thundering-herd guard, bounded retry with provider-outage hints.
- PM contract injected via system-prompt hook every request (survives compaction); workspace init (`.capy/` + gitignore by git-remote); next-action enforcement in worker-finish notices; blocker keywords wake the lead immediately.

---

Older history (event-driven wakes, overflow auto-recovery, team commands, TUI strip/tree) lives in the git log.
