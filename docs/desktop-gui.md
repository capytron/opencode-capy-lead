# Desktop GUI architecture

## Boundary

The existing `index.ts` owns team membership, persistence, wakeups and recovery.
The GUI only reads canonical `metadata.capyTeam` published by that server and
opens session tabs. No GUI action creates/deletes a session or changes membership.

`src/gui/team.mjs` validates canonical metadata, scopes teams to a directory,
filters duplicate/moved positions and loads all session-list pages atomically.
`src/gui/team.d.mts` describes its interface for the typed GUI entry.

`src/gui.tsx` scopes its subscriptions and pending reads to the current
server/directory. It uses the selected session's authenticated server reference,
not a hard-coded localhost URL or the Desktop sidecar for remote sessions.
Changing scope, reconnecting or unloading disposes the source and listeners.
Metadata events trigger a coalesced snapshot refresh. A 30-second read-only
refresh reconciles missed membership updates. Live running state comes from the
host's reactive session data, not the metadata's last recorded outcome.

## View rules

- Only a canonical lead sees the panel, launcher and team command.
- A registered worker sees a header badge only.
- Unrelated sessions and inherited metadata never produce team UI.
- Panel callbacks read reactive `props.session`; they do not capture the first
  session shown in a persistent panel render.
- Navigation is server-qualified and rechecks the current snapshot/directory.
- Errors discard the stale snapshot rather than showing stale membership; the
  next event or 30-second reconciliation retries the read.
- Team questions and worker failures use host attention APIs with event ids for
  native cross-window notification deduplication. Native notifications are
  informational (no stale session target); toast actions revalidate membership
  before opening a session and expire with their scope. Toasts remain per window.

## Build and distribution

The official GUI Vite preset externalizes the host's Solid and OpenCode modules
and emits one CommonJS bundle. The package exports it as `./gui-experimental`.
The bundle must be committed with its source for GitHub installs. There is no
install-time script and no automatic modification of user configuration.

The build is compiled against SDK 2.2.5. Experimental GUI APIs may change; a
passing build is not proof that every Desktop release is supported. See
`VERIFICATION.md` for the live-host acceptance checklist.
