# opencode-capy-lead

An OpenCode plugin for coordinating a lead session and worker sessions within a project. It maintains a persistent team registry, wakes the lead on worker outcomes through server events, and provides team controls in the conversation and TUI.

```sh
opencode plugin add capytron/opencode-capy-lead
```

## Requirements

- OpenCode v2.2+.

## Install

Use the quick-install command above, or add the package to the configuration array:

```json
"plugins": ["capytron/opencode-capy-lead"]
```

## Getting started

1. Install the plugin using either method above.
3. Have the lead create worker sessions with `parentID` set to its session ID for automatic registration, or register existing project sessions through `capy_lead add`.
4. Open `/capy-team` to inspect the team and navigate to sessions. Use `/capy-lead-team` to print the roster into the conversation.

## Commands

| Command | Purpose |
| --- | --- |
| `/capy-lead-init [persona]` | Bind the current session as this project's lead. |
| `/capy-lead-persona <text>` | Set the lead's persona. |
| `/capy-lead-team` | Print the roster into the conversation. |
| `/capy-lead-destroy` | Interrupt and delete all workers, including orphans, clear the roster, and unbind the lead. See destroy semantics below. |
| `/capy-team` | Open the interactive TUI team panel; also available in the command palette. |

All commands except `/capy-team` are server commands.

## Agent tool

Agents manage the team through the `capy_lead` tool.

| Action | Purpose and constraints |
| --- | --- |
| `bind` | Bind the calling session as lead; optionally set a persona. |
| `add` | Register a worker. Lead-only; the worker must be in the same project directory and cannot be the lead or any of its ancestors. |
| `remove` | Unregister a worker without deleting its session. Lead-only. |
| `unbind` | Unbind the lead. |
| `notify` | Send a registered worker's message to the lead, queued for the lead's next wake. Worker-to-lead only; limited to 10 messages/hour per worker and 600 characters per message. Sender identity comes from the calling session. |
| `list` | View the team, busy/idle status, and latest results. |

## How it works

- **Event-driven wake:** Server events wake the lead when a registered worker succeeds, fails, or is interrupted. There is no polling. User-initiated interruptions do not notify the lead.
- **Per-project registry:** Each project directory has one lead and one roster. Bindings persist across restarts in plugin storage; sessions confirmed deleted are pruned on load. Workers register automatically when created with `parentID` equal to the lead's session ID, or explicitly through `capy_lead add`.
- **Overflow auto-recovery:** Context-window failures trigger compaction and a notice to continue the work, capped at two recoveries per hour per session.
- **Continuity coordination:** When the `continuity` plugin is installed, capy-lead defers compaction to it and sends only the continuation notice. A compaction within the last five minutes is never repeated.
- **Destroy semantics:** `/capy-lead-destroy` interrupts and deletes every worker session, including orphans, then clears the roster and unbinds the lead. Partial failures retain the binding so the command can be rerun. The lead session and its ancestors are never deleted.

## TUI

The footer strip shows team status:

```text
capy ▶ 2/3 ✓1 ✗0
```

- `▶`: the lead is running.
- `2/3`: running workers / total workers.
- `✓1` and `✗0`: counts of succeeded and failed last outcomes.

In `/capy-team`, **up/down** moves the selection, **return** opens the selected session, and **escape** closes the panel. Clicking a session opens it. A compact team tree also appears in the sidebar.

Worker failures and pending team questions produce toast notifications, with desktop notifications and sound when the terminal is unfocused. Successful rounds are silent.



  ]
}

## Limitations

- Slash commands are a local administration surface, not a security boundary.
- Event delivery is best-effort around plugin reloads; there is no durable outbox.
- Worker-supplied notice text is flattened and length-capped. This is structural mitigation only, not semantic prompt-injection protection.
- Recovery budgets and deduplication windows are in memory and reset on reload.
