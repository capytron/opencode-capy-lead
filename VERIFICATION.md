# Desktop GUI verification

The GUI is compiled against `@opencode/plugin` 2.2.5. Run `npm ci` and
`npm run check` (on Windows, use `npm.cmd` if PowerShell blocks `npm.ps1`).
The suite builds the shipped CommonJS bundle before testing it.

Added tests cover canonical membership, multiple teams, moved/deleted workers,
pagination, atomic reads, disposed scope results, and failed reads. A separate
bundle test executes the actual generated CJS with the real Solid browser DOM
renderer in jsdom and a mocked Desktop host: panel rendering, session navigation,
lead command gating, worker badge, detach and event subscription cleanup.

The automated suite is **not a live Electron/OpenCode Desktop test**. A separate
owner-observed smoke test on Windows Desktop 2.2.5 (2026-11-03) confirmed that the
local plugin loaded, the team panel opened, and a registered worker appeared and
completed a greeting. No screenshot was retained. Native notifications,
multi-window deduplication, host reload timing, responsive appearance and the
remaining manual checklist still need live-host verification.
The existing server and TUI entrypoints are unchanged; their test import stripping
now accepts Windows CRLF. Build/test dependencies are pinned in package-lock.json.
`npm audit` currently reports 24 moderate transitive advisories from the 2.2.5
SDK dependency tree, with no high/critical advisories; no forced dependency
upgrades or overrides were applied. The GUI bundle externalizes host-provided
SDK/Solid modules rather than shipping that SDK dependency tree into the GUI.

Manual acceptance on a separate test location/configuration:

1. Load exactly one copy of the built plugin in global configuration.
2. Init two independent lead sessions; register one worker for each.
3. On each lead, open `/capy-team-view` and check only its own positions appear.
4. Open a worker by row; check only its worker badge appears. Open an unrelated
   session and check no team UI appears.
5. Change worker running/outcome/wait state and verify the lead's panel updates.
6. Detach the team; check its command, menu, panel and badge disappear.
7. Switch directory/server, disconnect/reconnect, reload GUI and open a second
   window; verify no stale membership, duplicate listeners or notifications.
8. Check keyboard focus and light/dark/narrow layouts. No session is deleted by
   any GUI action.

# Multi-lead verification

## Incident

An incomplete in-place refactor removed `readLead` while old context-hook call
sites still used it. The live plugin hot-reloaded the intermediate file and
failed before model requests. Syntax checking did not detect this runtime error.
Another intermediate migration called `stampTeam` from inside its own serialized
mutation queue, causing a startup deadlock. Both failures were reproduced by
executing the server entrypoint in an isolated adapter before replacement.

The user removed the plugin from live configuration. This work does not edit
that configuration or enable the plugin.

## Reproducible checks

Run from this plugin directory:

```sh
npm test
git diff --check
```

The suite currently has 48 tests (engine, TUI, GUI bundle in jsdom, and dependency-policy guards). It runs the real entrypoint source, not copied
business logic. Host storage, session admission, filesystem, timers and events
are isolated adapters; user sessions and plugin KV are untouched.

Covered behavior:

- Ordinary-session context hooks; independent lead contracts in one directory.
- Concurrent initialization, configurable limits above sixteen, idempotent re-init.
- Explicit worker registration; temporary child sessions excluded; cross-team
  membership rejected; human promotion removes previous membership.
- Report routing to the correct lead and a real wake after normal notify/completion.
- Reserved notification quota; failure refunds; over-quota reports not admitted.
- Legacy migration, actual second setup from persisted registry, canonical stamps,
  and an empty versioned registry preventing old-team resurrection.
- Deleted/moved session boundaries, persona permission, fresh-session team recovery.
- Cleanup preserves sessions, including nested other-team and unregistered children.
- Recovery of interrupted old destroying state.
- Due waits while busy/retrying; failed delivery retains work; retryable/latching
  budget escalation; re-registration during wake inherits consumed check budget.
- A deferred old metadata publication cannot resurrect a detached team.
- TUI gates: unrelated session has no strip/sidebar/panel/command, workers only a
  badge, removed inherited worker metadata ignored, each lead sees its own team.

Server native ESM import and syntax parsing of both entrypoints are checked
separately. No old single-team helper calls remain.

## Review

Astra reviewed the replacement twice, read-only. The first review found lifecycle
and await races despite passing immediate-adapter tests. Fixes include serialized
admission/stamp publication, pre-admission check reservation, recoverable cleanup,
and preserving all sessions instead of relying on unsafe recursive deletion.
The second review found membership guards and stale initialization/publication
paths, which were subsequently corrected.

## Limits of the evidence

These checks do **not** prove absence of all bugs. They are not live OpenCode
server/TUI integration, a real Solid/OpenTUI renderer, cross-version compatibility,
or a provider/model execution test. No Bun executable was available. Real reactive
layout and host unload/reload timing still require isolated host verification
before treating this as a fully validated release. Do not re-enable a partially
edited working copy in a live service.

No automatic push, tag, publish, config modification, live database edit, or
re-enabling is part of these verification commands.
