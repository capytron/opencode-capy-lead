# opencode-capy-lead

Multi-team lead/worker coordination for OpenCode. Independent lead sessions in the same project, each with its own persistent positions. Long-running work gets overflow recovery and scheduled check-backs; short lookups stay as ordinary subagents.

> Personal project — not published to npm (`private: true`).

## Install

From GitHub:

```sh
opencode plugin add capytron/opencode-capy-lead
```

From a local clone (put the path in your config):

```json
"plugins": ["/home/you/opencode-capy-lead"]
```

## Desktop GUI (experimental)

The package now includes a separate Desktop GUI alongside the existing server and TUI.
It targets the OpenCode **2.2.5 GUI SDK**; the API is experimental. A Windows
Desktop 2.2.5 smoke test confirmed panel opening and visibility of a registered
worker that completed a greeting. Broader live-host acceptance remains pending.

- In an active **lead** session, run `/capy-team-view`, click the **Capy team**
  header badge, or choose **Capy team** from the side panel's **+** menu.
- The side panel shows the lead and explicitly registered positions, live running
  state, last outcome and scheduled-wait reason. Click a row to open its session.
- Registered workers get only a header badge. Unrelated or detached sessions show the muted
  project total (`Teams · N in project`) and can open the switcher, but no team detail UI.
  Multiple teams stay scoped to the selected session and server.
- Worker failures and team questions use Desktop toast/attention APIs. System
  notifications respect the user's settings and are deduplicated across windows.
- This is a **side panel/tab**, not an insertion into Desktop's left session-list
  sidebar. The GUI SDK has no equivalent to TUI `sidebar.content`.
- Reads refresh on metadata/membership events and reconcile every 30 seconds;
  UI refreshes never create workers, prompts or collection work.

For development (Node 20.19+ or 22.12+):

```sh
npm ci
npm run check
```

Ship the single `dist/gui-experimental.cjs` bundle in Git so GitHub installs have
an entry ready to load without relying on install scripts. Rebuild it whenever
GUI source changes. Keep a development clone separate from the live plugin.
To try a finished build, replace the existing package entry with this clone's
absolute path in **global** `opencode.json(c)`; do not load both copies. No live
config change is performed by the tests. See `VERIFICATION.md` for limitations.

## Global AGENTS.md

On startup the plugin maintains one marked section in your global `~/.config/opencode/AGENTS.md` — "Autonomy — work until done": keep working (ask only for unauthorized hard-to-reverse actions, missing access, or owner-only decisions — a clear instruction that already covers the action never needs asking again), self-reliance (install lightweight scoped tooling or write a small script yourself; never cloud servers, paid services or system-wide changes; clean up after yourself; never weaken a check), finish-before-summarize (verify criteria; gaps your own review finds are work you fix before finalizing; asking never blocks while independent work remains), and scope discipline.

opencode loads this file **additively** with every project's own `AGENTS.md` — project rules always apply too, and **solo sessions get the full behavior without a team**.

- Existing file content is preserved; the marked section is managed idempotently. As a migration, unmarked Markdown blocks that are near-verbatim copies (≥80% identical lines) of the legacy autonomy text — the raw pre-plugin file or the retired continuity block — are also removed; user-rewritten rules with their own wording always survive. Timestamped backups (newest 3) sit next to the file.
- Opt out by replacing the section with `<!-- capy-lead:autonomy:disabled -->`, or set `CAPY_LEAD_SKIP_AGENTS=1`.

## Tests

`npm test` runs five layers:

1. **Engine unit tests** — the real `index.ts` in a VM fixture with an isolated host adapter (registry lifecycle, waits, idle gate, recovery, AGENTS.md management).
2. **TUI tests** — strip states, switcher, scoping.
3. **GUI tests** — the shipped Desktop bundle executed with real Solid rendering in jsdom.
4. **Dependency-policy guards** — zero runtime deps, devDep allowlist, lifecycle-free script names, host-shared bundle requires only.
5. **Install-flow E2E** — the real `opencode plugin add` from GitHub in an isolated XDG sandbox; catches install-breaking repo changes (dependency trees, lifecycle scripts) and documents the CLI's config-form quirk (`plugin update` must receive the exact string your config holds). Skips when the `opencode` binary or network is unavailable.

## Troubleshooting

**`opencode plugin update` says "Plugin is not configured: …"** — the CLI matches the *exact* string stored in your config. Check what your machine has (`cat ~/.config/opencode/opencode.json`, the `plugins` array), then either pass that exact string to `update`, or reinstall cleanly:

```sh
opencode plugin remove "<exact string from your config>"
opencode plugin add capytron/opencode-capy-lead
```

## Update

```sh
opencode plugin update capytron/opencode-capy-lead
```

Pin to a specific version by tag:

```sh
opencode plugin add capytron/opencode-capy-lead#v0.10.0
```

Available tags: `v0.3.0` · `v0.3.1` · `v0.4.0` · `v0.4.1` · `v0.5.0` · `v0.5.1` · `v0.6.0` · `v0.6.1` · `v0.6.2` — see [CHANGELOG.md](CHANGELOG.md) for what changed in each.

After updating, restart OpenCode (the plugin code swaps on server restart). Existing teams survive the update via versioned registry migration; `/capy-lead-init` re-runs onboarding if you want to reconfigure tracking.

Server: OpenCode 2.2+. TUI: 2.2.3+ / OpenTUI 0.8. Verification against every historical host release is not included.

## Usage

1. Run `/capy-lead-init [persona or request]` in the session that should become a lead. Other lead sessions in the same directory do not block it. Re-init preserves its positions and waits.
2. Ask the lead to organize suitable positions for the work. It creates sessions and explicitly registers each persistent position with `capy_lead add` and a meaningful role. Parentage alone never registers a worker.
3. Each position can use normal temporary subagents. Their results follow the host's ordinary subagent mechanism; they do not enter the team roster or idle gate.
4. The lead sees its team strip, sidebar and team panel. A registered worker sees `Worker · <role> (<team name>)`. Every other session still shows the project total (`teams · 3 in project`) so nobody forgets teams exist — and `/capy-team-view` opens a **team switcher** from any session (Desktop: click the badge): every team by name, most recently active first, `[Current team]`/`[Your team]` markers, one action to open that team's lead. Projects with no teams get an empty switcher that explains how to start one.
5. Leads name their team at init (`capy_lead rename`, e.g. `Atlas`); humans can rename anytime with `/capy-team-name <name>`. Teams without a name fall back to a stable `Team N`.

One session belongs to at most one team and role. A human may promote a worker with `/capy-lead-init`; this removes its old membership and wait. Tools cannot silently take a session from another team.

## Human commands

| Command | Effect |
|---|---|
| `/capy-lead-init [text]` | Make this session a lead; preserve its existing team on re-init. |
| `/capy-set-persona <text>` | Update the calling lead's persona only. |
| `/capy-team-info` | Text overview: your team, or every team in the project when called outside a team. |
| `/capy-team-name` | Rename the calling lead's team: `<name>`. |
| `/capy-lead-detach [leadID\|all]` | Release coordination without deleting sessions. From an unrelated session, specify the target shown by team-info. |
| `/capy-lead-destroy [leadID\|all]` | Safe cleanup alias: release the target team and preserve all sessions. **No recursive session deletion.** |
| `/capy-team-view` | Team switcher from any session (most recently active first; opens the team lead). |
| `/capy-workspace-init` | Scaffold the **utility-workspace framework** into this directory: an agent-operating constitution (AGENTS rules), knowledge homes (FLEET/inventory/kb/howto/PLANS), ticket tracking (`.capy/`), and a deferred SOPS+age vault template. Existing files are never touched; reruns are no-ops; the pre-commit vault hook installs automatically when the directory is a git repository. Provenance is recorded in `.capy/workspace.json`. The vault itself stays deferred until the first real secret (the scaffolded `HOWTO-secrets §1a` bootstrap). |

Closing a client/tab is not deleting a session. To release an old team you cannot find, use team-info and detach from a new session; attaching to the old lead is unnecessary. Deleting sessions, when desired, is an explicit host UI operation.

### Why destroy now preserves sessions

The host's remove operation recursively deletes descendants without an atomic subtree precondition. Another team or temporary subagent may be underneath a position, including a child created after inspection. The plugin cannot promise safe selective recursive deletion, so cleanup unregisters instead. This intentionally changes the old destructive command behavior.

## Agent tool

`capy_lead` actions:

- `bind`: make the caller a lead or update its persona. Human init is required to promote an existing worker.
- `add`: lead registers a persistent position using `sessionID` and `role`. Target must belong to this project and not another team.
- `remove`: unregister a position and clear its wait; session is preserved.
- `unbind`: detach the caller's own team.
- `list`: own roster/waits; unrelated callers get project lead IDs.
- `notify`: worker report with `text` and `kind: done | progress | blocked | question`. Blocked/question wake its own lead immediately. Done/progress queue; execution completion normally wakes the lead. Only explicit kinds determine urgency, never text regex. Ten accepted reports per worker/hour; failed admission refunds the reserved slot. Progress preserves an existing wait; concluding reports clear it.
- `wait`: worker schedules a check with `reason`, `checkInMinutes` (1–1440), optional `maxChecks` (default 6, at most 20), optional `waitForSessionId` in the same project. Dependencies can be in another team; delivery always returns to the wait owner's team.

## Lifecycle

- A directory-wide mutation queue owns a versioned multi-team registry in plugin KV. Legacy lead/workers/waits keys migrate before handlers start; existing new-format registry wins over legacy data, including when empty.
- Context hooks inject each active lead's PM contract and its own roster. Ordinary sessions receive nothing. Contracts encourage initiative and verification; model compliance is not guaranteed by prompts.
- Successful worker execution with an explicit pending wait does not wake the lead unnecessarily. Otherwise a missing report gets one reminder, then one escalation. Routine notification cooldowns reduce repeated steering.
- Wait checks reserve budget before message admission. Failed admissions preserve a retryable wait without consuming a check. An admitted check that receives no follow-up is escalated, not repeatedly executed automatically.
- Exhausted/stale waits keep a decision record. Failed decision admission retries; successful admission latches the notification. The lead can ask for a concluding report, or deliberately remove/re-add the position to authorize a new budget.
- A 60-second heartbeat reconciles work. Confirmed deleted or moved leads release their whole team; deleted/moved workers are removed, not adopted by another lead. Transient lookup failures do not prove deletion.
- The watchdog requests a health check after 30 minutes busy without an observed status change, at most three requests until activity. This is a coarse status signal, not proof of tool/output progress. Provider retry counts as busy.
- Context overflow recovery requests compaction and continuation, at most twice/hour/session. With the continuity plugin installed, compaction is delegated to it. Recovery failure falls through to the owning lead's outcome notice.
- Metadata publishes canonical team snapshots on lead sessions. Inherited child stamps are not membership proof. Failure/question notifications currently cover canonical teams visible in the TUI store, even while another team is selected.

Defaults are 16 leads per project and 16 positions per lead. Override with project-local `.capy/config.json`:

```json
{ "maxTeams": 100, "maxWorkers": 32 }
```

These are ceilings, not recruitment targets. Leads choose useful positions for actual work. Config is read when the plugin instance loads.

## Tracking and workspace

Init adopts explicit existing tracking rules from the request, AGENTS.md or `.capy/team.md`. Without them it offers/infer Developer, Utility or None. Tracking is a model-maintained convention, not parsed/enforced by the engine. None means no new tracking records/instructions; previously existing files are not deleted.

Developer uses one ticket Markdown file, linked to normal repo outputs. Utility uses one ticket file plus an optional same-named folder for reports/evidence. Closed files never move; summaries go to monthly archive rows. Search proceeds index/archive rows → matching tickets → relevant artifacts. Only selected rules belong in team.md; the one-time onboarding message describes the choices, so it is not literal context isolation.

Multiple leads share project history. Ticket files are authoritative and the Markdown index is rebuildable. Leads must reread before writing, identify ticket ownership and reconcile collisions. This is **not** a transactional concurrent ledger. Future capynote migration depends on its eventual schema/importer; drop-in compatibility is not promised.

Init creates `.capy/tmp/` and `.capy/local/`, and merges ignore rules for them into `.capy/.gitignore`. Tracking files are created by the lead only when applicable. Gitignore does not untrack already committed files; project data policy belongs to AGENTS.md or the owner.

## Verification and limitations

```sh
npm test
```

Node tests execute the actual server entrypoint in an isolated host adapter and exercise the TUI membership/render gates without a real terminal renderer. They are not live end-to-end or visual tests.

- No edits to user config are required for development tests. Do not enable a partially edited plugin in a live server.
- No exactly-once guarantee: process death between durable state and admission can require reconciliation; missed execution events are not replayed.
- Automation pauses while the process/location is unloaded. Confirmed session deletion differs from closing a tab.
- Scratch cleanup is model-managed; there is no automatic artifact deletion.
- Report/recovery budgets are process-local; reload resets them. Prompt flattening is not semantic injection protection.
- Temporary subagents already registered by an old version remain registered after migration until explicitly removed.
- The serialized admission path can delay other team operations if a host API call hangs; there is no distributed lock across independent server processes.
