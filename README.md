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

## Update

```sh
opencode plugin update capytron/opencode-capy-lead
```

Pin to a specific version by tag:

```sh
opencode plugin add capytron/opencode-capy-lead#v0.5.0
```

Available tags: `v0.3.0` · `v0.3.1` · `v0.4.0` · `v0.4.1` · `v0.5.0` — see [CHANGELOG.md](CHANGELOG.md) for what changed in each.

After updating, restart OpenCode (the plugin code swaps on server restart). Existing teams survive the update via versioned registry migration; `/capy-lead-init` re-runs onboarding if you want to reconfigure tracking.

Server: OpenCode 2.2+. TUI: 2.2.3+ / OpenTUI 0.8. Verification against every historical host release is not included.

## Usage

1. Run `/capy-lead-init [persona or request]` in the session that should become a lead. Other lead sessions in the same directory do not block it. Re-init preserves its positions and waits.
2. Ask the lead to organize suitable positions for the work. It creates sessions and explicitly registers each persistent position with `capy_lead add` and a meaningful role. Parentage alone never registers a worker.
3. Each position can use normal temporary subagents. Their results follow the host's ordinary subagent mechanism; they do not enter the team roster or idle gate.
4. The lead sees its team strip, sidebar and `/capy-team-view`. A registered worker sees only a worker badge. Unrelated sessions show no team UI.

One session belongs to at most one team and role. A human may promote a worker with `/capy-lead-init`; this removes its old membership and wait. Tools cannot silently take a session from another team.

## Human commands

| Command | Effect |
|---|---|
| `/capy-lead-init [text]` | Make this session a lead; preserve its existing team on re-init. |
| `/capy-set-persona <text>` | Update the calling lead's persona only. |
| `/capy-team-info` | Show this session's team, or all project teams when called outside a team. |
| `/capy-lead-detach [leadID\|all]` | Release coordination without deleting sessions. From an unrelated session, specify the target shown by team-info. |
| `/capy-lead-destroy [leadID\|all]` | Safe cleanup alias: release the target team and preserve all sessions. **No recursive session deletion.** |
| `/capy-team-view` | Lead-only interactive team panel. |

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
