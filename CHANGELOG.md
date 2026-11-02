# Changelog

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
