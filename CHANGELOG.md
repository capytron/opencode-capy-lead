# Changelog

## v0.10.1 — 2026-11-07

**Prompt-sharpening round (Astra-reviewed plan; text-only, no logic/state changes)** — committed without a version tag by owner policy (tags mark curated stable points only):

- Tool description now teaches evidence-based done reports: state the observed result against the assigned acceptance criteria plus verification limits — never a bare "finished" (merges the A1+A2 proposal; no rigid vocabulary).
- `[capy:decision]` no longer tells the LEAD to "conclude via notify" — an action only registered workers have. It now says: decide the next action and have the worker report its outcome.
- The L2 contract acknowledges existing tracking rules (".capy/team.md") without gating on a scaffold marker.
- "[capy:*] messages" split into engine coordination notices vs untrusted worker reports (watchdog/decision/check were mislabeled as worker reports).
- Quota error reworded to close the relabeling loophole (progress → blocked to dodge the cap).
- Long-text teaching error points to an assigned report/scratch file instead of "ticket" (workers must not write tracking files — lead-only in the workspace framework).
- Tracking-choice "None" no longer contradicts the ticket assumption; L2 "give each position its ticket" softened to "assignment; link its ticket if any".
- B1 (ticket pointer on add) and B2 (wait end-condition field) remain deferred pending production evidence.


## v0.10.0 — 2026-11-07

**Workspace mode — the utility-workspace framework now ships inside the plugin** (85 tests):

- New command `/capy-workspace-init`: scaffolds the owner's workspace framework into any directory — rules-only AGENTS.md constitution, one-home knowledge topology (FLEET / inventory / kb / howto / PLANS / project), `.capy` utility-mode ticket tracking, and a deferred SOPS+age vault template (OS-neutral: no keychain dependency, runtime consumption via `sops exec-env`, first-secret bootstrap with a one-time key-backup RECOMMENDATION — never a gate).
- Non-destructive by design: existing files are never touched, reruns are no-ops, and the pre-commit staged-vault hook (rename-aware) installs automatically in git repositories. Provenance recorded in `.capy/workspace.json` (template + plugin version, file list).
- The framework content carries everything hardened through three review rounds: empirically verified failure-path recipes (backup lifecycle deletes plaintext sources; file-only consumers keep real exit statuses), the session-start crash sweep, proportional-strictness rules (one grep per scope, single-write transcript honesty, no double-asking the owner).
- Machine-generic template: host manuals, inventory records and FLEET facts are per-machine and intentionally absent — they are created at onboarding.


## v0.9.2 — 2026-11-05

**Astra's three follow-up hypotheses closed** (82 tests):

- A stale notify completing after a remove+add no longer marks the fresh membership as reported — the activity write now happens only when the post-send bookkeeping still owns the same membership, so a genuinely silent first round still gets the idle-gate reminder.
- Registering a wait on a dependency that is already an idle registered worker starts with an immediate check instead of waiting out the full interval for something already finished.
- The boot reconciliation tick is delayed ~8s so live session.status events can re-mark genuinely busy workers before a due check is delivered into a running execution (busy was blind-reset at boot).


## v0.9.1 — 2026-11-05

**Astra "what else is broken" round — all seven confirmed findings fixed** (80 tests):

- **Malformed-registry tolerance now covers every engine path**: `load()` normalizes a missing `teams` map, `heal()` normalizes `workers`/`waits` and drops null teams, and `role()` plus the tick/detach/handler/stamp paths survive null teams and missing maps — a corrupted record no longer kills the heartbeat or a healthy team's outcome delivery (reproduced via a probe: `Cannot read properties of null`).
- **The progress quota no longer blocks urgent reports**: blocked/question/done always get through; only `progress` counts toward the 10/hour budget (a worker hitting a real blocker after ten updates still wakes its lead).
- **Overflow escalation latches only on successful delivery** — the last remaining latch-before-send instance.
- **A failed outcome send no longer spends the 60s wake cooldown**: the cooldown is set only when a wake actually landed, so a failed first delivery never silences the next failure.
- **Boot heal now stamps removed leads**: a lead that moved away while the plugin was down loses its ghost `capyTeam` metadata on reload, not just on the next heartbeat.
- **Question/blocked stay visible**: `lastOutcome` records the ask, a succeeded execution right after it no longer flips the team view to "Done" (TUI shows ❓/⚠, Desktop "Asked"/"Blocked"); `done`/`progress` correctly end the ask.
- **Stale notify after a re-add can no longer mark the new membership as reported** (post-send bookkeeping now checks full ownership, not just team generation), and a schema self-check test locks the tolerant input shape itself.


## v0.9.0 — 2026-11-05

**Fixes from the dc-infra field report** (screenshot session where `list` failed repeatedly and `add` was rejected):

- **Schema tolerance**: the tool's input schema no longer carries enum/range constraints (only `action` stays an enum). A model passing junk fields alongside an action (e.g. a bad `kind` with `action:"list"`) used to be rejected by host-side validation before the code ran — surfacing as a mysterious ×. Values are validated in code with teaching errors exactly where they matter.
- **Subagents cannot bind themselves into ghost leads**: `bind` from a spawned session (has a parentID) is rejected with a teaching error; the human `/capy-lead-init` can still promote any session. This was the likely source of "Session already belongs to another team or is a lead" — a subagent reading "bind yourself" self-promoted, then the real lead's `add` correctly bounced off the one-session-one-team guard.
- **Conflict errors are actionable now**: they name the holding team and the exact release command (`/capy-lead-detach <leadID>`).
- **Malformed registry records no longer crash every action**: `role()`, the roster context hook, `summary`, stamping and heal tolerate a missing `workers`/`waits` map (reproduced: `Cannot read properties of undefined` from `team.workers[id]` broke `list`, `notify` and every other action in the directory). 73 tests.


## v0.8.3 — 2026-11-04

**Hotfix: shipping bug both raw reviews caught independently + binding gate** (Astra & Argon open review):

- **Fixed `rename is not defined`** (P0): the atomic AGENTS.md write used `rename` without importing it — shipped broken in v0.8.1/v0.8.2. The VM test harness masked it by injecting mocks after stripping imports, the same blind spot as the historical `readLead` incident. Also imports `readdir`/`rm` for the new backup retention.
- **New binding gate** (`test/binding.test.mjs`): relaxed tsc over `index.ts`/`tui.ts` fails only on undeclared-identifier errors (the readLead/rename class), plus a harness rule that the VM sandbox may never inject a builtin the source does not import. Verified it turns red on the exact bug.
- **Backup retention**: keep the newest 3 `AGENTS.md.bak-*` files instead of growing forever; temp files carry a random suffix so concurrent same-process setups cannot collide.
- **TUI truth fix**: workers with a scheduled wait now show ⏳ and are no longer counted as done (✓) after a succeeded outcome — matching the Desktop GUI.
- **E2E now verifies the actual install**, not just the working tree: invariants are checked against the fetched copy and `node_modules` must contain exactly the plugin (lean-install proof).
- README sync: unrelated-session behavior, the unmarked near-verbatim migration rule, and backup policy now documented as implemented. Full typing of the core (129 relaxed-check errors of shape noise) is the follow-up. 69 tests.


## v0.8.2 — 2026-11-04

**Install-flow E2E test + test guide** (after a teammate hit `plugin update` → "Plugin is not configured"):

- New `test/install-flow.test.mjs`: runs the real `opencode plugin add` from GitHub in an isolated XDG sandbox — the layer that catches install-breaking repo changes (runtime dependency trees, lifecycle-named scripts) before they ship — and locks the CLI's config-form quirk as its documented behavior.
- README now documents the five test layers and the update troubleshooting (pass the exact string your config holds, or remove + add).
- Known sandbox limitation documented: `plugin list/check/update` resolve through the elected background service, so XDG redirection cannot isolate them; update flows are verified on real machines. 67 tests.


## v0.8.1 — 2026-11-04

**AGENTS.md migration hardening** (Argon review round):

- **Fixed a self-blocking bug**: the section footer mentions the `disabled` marker inline, and the opt-out check ran before stripping our own section — after the first install, no future section update could ever land. The check now runs on the file *without* our managed blocks, anchored to a full-line match.
- **Atomic write with backup**: content goes to a temp file then renames into place; the previous file is backed up first. A crash or concurrent writer can no longer corrupt the file every session loads.
- **Half-present markers refuse to edit** (begin without end or vice versa) instead of silently appending a duplicate section; CRLF line endings handled.
- **Deterministic legacy-duplicate stripper**: unmarked Markdown blocks that are near-verbatim copies (≥80% identical lines) of the legacy autonomy text — the raw hand-written file and the continuity plugin's old block — are removed; user-rewritten rules with their own wording survive. No LLM involved, immune to prompt injection, works headless.
- The `opencode run` semantic-dedup idea stays deferred: with deterministic stripping the remaining cases do not justify a model call at startup (recursion, auth and cost risks documented in the review). 66 tests.

## v0.8.0 — 2026-11-04

**Autonomy baseline for every session + slim team contract** (design reviewed by Astra, Argon and Kimi):

- The plugin now manages one marked section in the global `~/.config/opencode/AGENTS.md` ("Autonomy — work until done", per machine): keep working (ask only for unauthorized hard-to-reverse actions, missing access, or owner-only decisions — a clear instruction already covers the action), self-reliance (install lightweight scoped tooling or write a small script; no cloud/paid/system-wide; cleanup; never weaken checks), finish-before-summarize (verify criteria; gaps you find are work you fix before finalizing; asking never blocks while independent work remains; report blockers when nothing remains), and scope discipline. Solo sessions get the full behavior without a team. Existing content is preserved; disable with `<!-- capy-lead:autonomy:disabled -->` or `CAPY_LEAD_SKIP_AGENTS=1`.
- The lead PM contract slimmed to team mechanics only (ownership, workers as a concurrency limit, gap-fixing, untrusted reports, no polling, status reporting) and defers autonomy/permissions/completion to AGENTS.md — removing the contradiction where the contract asked before dependency changes while the autonomy rules say to install what the task needs.
- Verified live: the running server reloaded the plugin, wrote the section, and the instruction watcher injected it into open sessions immediately. 61 tests.


## v0.7.1 — 2026-11-04

**Engine bug round two** (dual audit by Argon and Kimi; every fix below is reproduced or statically confirmed with a regression test):

- **Wake-loop fixes**: a `woken` wait is owned by its 5-minute admission timer only — the exhausted-check comparison no longer re-fires `[capy:decision]` on every unrelated event, and a woken worker ending silently is no longer gate-pinged on top of it (double wake). Gate pings latch only after a successful send, so a failed ping retries instead of escalating to the lead. Wait retries against an exhausted budget never re-alert the lead.
- **Token-drain fixes**: question/blocked reports (which already wake the lead) no longer get a redundant "execution succeeded" echo; overflow recovery never enters the lead loop and, after two failed recoveries in an hour, escalates once to the lead instead of resuming the worker forever; deleting a dependency session immediately releases its waiters (was up to a full interval); a tick arriving mid-flight is remembered and re-run instead of dropped.
- **Re-add actually authorizes a fresh budget** (as the decision message always claimed): membership rotates, stale waits and idle-gate state are cleared, and the notify quota resets with them.
- **Polish**: question-hint ignores URLs with query strings; compactions tracking limited to members; `purge` clears the notify budget; team fallback names snapshot once at stamp time (no flicker as titles mutate) with prefix-deduped display and deterministic `Team N` ordering; GUI guards on malformed `form.created` payloads. 57 tests.


## v0.7.0 — 2026-11-04

**Multi-team visibility, team naming, and a long-content channel** (design reviewed with Astra and Argon against novice/non-dev scenarios):

- **Team switcher everywhere**: `/capy-team-view` now works from any session (Desktop: click the header badge) and opens a flat switcher — every team in the directory by name, most recently active first (a forgotten team resurfaces on top), `[Current team]`/`[Your team]` markers, `● N running · M workers` / `Active 2h ago`, one action opens that team's lead session. Navigate-only: joining and membership stay engine-driven.
- **Workspace memory in every session**: unrelated sessions now show `teams · 3 in project` (muted) instead of nothing — answers "did I already start a team?" even with every tab closed. Worker badges name their team: `Worker · Reviewer (Atlas)`. Lead strips show the team name.
- **Team naming**: leads name their team at init (`capy_lead rename`, taught in onboarding); humans override with `/capy-team-name`. Names flow into the metadata stamp, `/capy-team-info`, strips, badges and the switcher; unnamed teams fall back to a stable `Team N` by creation order, then to a shortened session title.
- **Empty switcher teaches the first step**: "No teams in this project yet — Start a team to delegate tasks to helpers", with a button that inserts `/capy-lead-init` into the composer (copy fallback).
- **Long-content channel (novice + anti-overflow)**: notify text is now hard-capped (400 chars, 200 for progress) and **rejected with a teaching error** instead of silently truncated — long plans, research and consultations must go through files (tickets, `.capy/tmp`) with a short summary plus the path; contract lines now tell leads and workers to move long content through files and to have temporary subagents summarize long input.
- Stale teams are shown honestly (`Active 2d ago` from lead session + worker outcome timestamps) without claiming abandonment. 48 tests.

## v0.6.2 — 2026-11-04

**Fix `opencode plugin add/update` failing with "git dep preparation failed"** (still broken in v0.6.1):

- Root cause: pacote (opencode's installer) runs `npm install` inside a cloned plugin repo whenever package.json declares workspaces or a script named `postinstall` / `build` / `preinstall` / `install` / `prepack` / `prepare`. Our `"build": "vite build"` script triggered it, so every branch-tracking install (clone route) tried to install the full dev toolchain on the endpoint and failed.
- Renamed the script to `build:gui` — preparation no longer triggers and installs never run npm inside the clone.
- Guard tests now enforce the whole policy: zero runtime dependencies, a reviewed devDependencies allowlist, lifecycle-free script names, no workspaces, entrypoint imports, and bundle `require()` targets limited to host-shared modules. 41 tests.
- Note: installing with an explicit `#tag` follows the GitHub tarball route, which hides this failure mode — only the branch-tracking route exercises preparation. Verified both routes.

## v0.6.1 — 2026-11-04

**Fix plugin update/install from GitHub** (broke in v0.6.0):

- v0.6.0 declared `@opencode/plugin` as a runtime dependency; npm's git-dependency preparation then installed its entire tree — **273 packages / ~186 MB** — which fails on restricted or slow networks (`NpmInstallFailedError: git dep preparation failed`).
- The Desktop host already shares `@opencode/plugin/gui*` and `solid-js` module instances with `gui-experimental` bundles (they resolve to the app's own modules), so the plugin needs **zero runtime dependencies**. `@opencode/plugin` moved to devDependencies (build-time types and vite plugin only).
- Git installs now pull nothing beyond the plugin itself.

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
