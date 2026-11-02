# Changelog

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
