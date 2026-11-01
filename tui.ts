/**
 * capy-lead TUI — team strip, team tree, and attention notifications.
 *
 * Rendering note: this file deliberately avoids JSX and any pragma-driven
 * JSX runtime. On hosts that load this plugin from an npm install, imports
 * injected by the TypeScript/JSX transpiler are not always intercepted by the
 * host's runtime-module rewriting (Bun may native-load node_modules ESM
 * without firing onResolve). Only import statements literally present in this
 * source are reliably rewritten to the host-provided modules, so every import
 * here — `solid-js` and `@opentui/solid/jsx-runtime` — is written out
 * explicitly and all elements are created through jsx()/jsxs() calls.
 *
 * 1. Team strip (prompt.footer.status): `capy ▶ 2/3 ✓1 ✗0`
 * 2. Team tree: `/capy-team` opens an interactive panel (up/down move,
 *    return opens the selected session, escape closes; click also opens);
 *    a compact tree is appended to the sidebar.
 * 3. Attention notifications, quiet by default: worker failure and pending
 *    team questions toast + notify (desktop + sound) when unfocused; normal
 *    completion is silent.
 *
 * All data is event-driven: roster + last outcomes come from the capyTeam
 * stamp the server plugin maintains on the lead session's metadata; busy
 * state is derived live from session status. The strip and tree render
 * nothing when the project has no team.
 */
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { jsx, jsxs } from "@opentui/solid/jsx-runtime"

const timeAgo = (time) => {
  if (!time) return ""
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}

export default {
  id: "capylead.tui",
  async setup(context) {
    // The lead is the session whose capyTeam stamp names itself; copies
    // inherited by children name a different id and are ignored.
    const team = createMemo(() => {
      for (const session of context.data.session.list()) {
        const stamp = session.metadata?.capyTeam
        if (stamp && stamp.leadID === session.id) return { lead: session, workers: stamp.workers ?? [] }
      }
      return undefined
    })

    // Same mechanism the built-in "Go to parent session" command uses.
    const jump = (sessionID) => {
      context.ui.router.navigate({ type: "session", sessionID })
    }

    const attention = (message, sessionID, variant, sound) => {
      context.ui.toast.show({ title: "capy-lead", message, sessionID, variant })
      void context.attention
        .notify({
          title: "capy-lead",
          message,
          notification: { when: "blurred" },
          sound: { name: sound, when: "blurred" },
        })
        .catch(() => undefined)
    }

    const offFailed = context.data.on("session.execution.failed", (event) => {
      const current = team()
      if (!current || event.data.sessionID === current.lead.id) return
      const worker = current.workers.find((item) => item.sessionID === event.data.sessionID)
      if (!worker) return
      attention(`Worker "${worker.role}" failed — the lead has been woken`, event.data.sessionID, "error", "error")
    })

    const offForm = context.data.on("form.created", (event) => {
      const current = team()
      if (!current) return
      const id = event.data.sessionID
      if (!id) return
      if (id === current.lead.id) {
        attention("The lead is waiting for your answer", id, "warning", "question")
        return
      }
      const worker = current.workers.find((item) => item.sessionID === id)
      if (worker) attention(`Worker "${worker.role}" is waiting for your answer`, id, "warning", "question")
    })

    // ---- shared tree rows -------------------------------------------------
    // Rows are ordered by the roster (registration order), never re-sorted on
    // updates, so the tree does not jump around while reading it.
    const rows = createMemo(() => {
      const current = team()
      if (!current) return []
      const leadStatus = context.data.session.status(current.lead.id)
      return [
        {
          kind: "lead",
          sessionID: current.lead.id,
          role: "Lead",
          running: leadStatus === "running",
          outcome: null,
          outcomeTime: null,
        },
        ...current.workers.map((worker, index) => ({
          kind: "worker",
          sessionID: worker.sessionID,
          role: worker.role,
          running: context.data.session.status(worker.sessionID) === "running",
          outcome: worker.lastOutcome ?? null,
          outcomeTime: worker.lastOutcomeTime ?? null,
          last: index === current.workers.length - 1,
        })),
      ]
    })

    // Refresh relative times ("1m ago") without waiting for other events.
    const [tick, setTick] = createSignal(0)
    const timer = setInterval(() => setTick(tick() + 1), 5000)
    onCleanup(() => clearInterval(timer))

    // ---- 1. strip ---------------------------------------------------------
    const offStrip = context.ui.slot({
      append: "prompt.footer.status",
      render: () => jsx(TeamStrip, { context, get rows() { return rows() } }),
    })

    // ---- 2a. interactive panel (/capy-team) --------------------------------
    const offPanel = context.ui.slot({
      append: "session.panel",
      render: (panel) =>
        jsx(Show, {
          get when() {
            return panel.name === "capy-lead.team"
          },
          get children() {
            return jsx(TeamPanel, { context, panel, get rows() { return rows() }, jump, get tick() { return tick() } })
          },
        }),
    })

    // ---- 2b. compact sidebar tree ------------------------------------------
    const offSidebar = context.ui.slot({
      append: "sidebar.content",
      render: () => jsx(TeamSidebar, { context, get rows() { return rows() }, jump, get tick() { return tick() } }),
    })

    // ---- 2c. /capy-team command (palette + slash) ---------------------------
    const openPanel = () => {
      const route = context.ui.router.current()
      const current = context.ui.panel.current()
      if (route.type === "session" && current?.sessionID === route.sessionID && current.name === "capy-lead.team") {
        context.ui.panel.close()
        return
      }
      if (context.ui.panel.open("capy-lead.team")) return
      context.ui.toast.show({ title: "capy-lead", message: "Open a session first, then /capy-team", variant: "info" })
    }
    context.keymap.layer(() => ({
      mode: "global",
      get enabled() {
        return rows().length > 0
      },
      commands: [
        {
          id: "capylead.team.open",
          title: "Open the capy-lead team tree",
          slash: { name: "capy-team" },
          group: "capy-lead",
          palette: true,
          run: () => {
            openPanel()
          },
        },
      ],
    }))
    const offCommandSlot = context.ui.slot({
      append: "app",
      render: () => null,
    })

    return () => {
      offFailed()
      offForm()
      offStrip()
      offPanel()
      offSidebar()
      offCommandSlot()
    }
  },
}

function outcomeText(row, theme) {
  if (row.outcome === "succeeded")
    return { text: `✓ ${timeAgo(row.outcomeTime)}`.trim(), color: theme.text.feedback.success.base }
  if (row.outcome === "failed")
    return { text: `✗ ${timeAgo(row.outcomeTime)}`.trim(), color: theme.text.feedback.error.base }
  if (row.outcome) return { text: row.outcome, color: theme.text.muted }
  return { text: "", color: theme.text.muted }
}

function TeamStrip(props) {
  const theme = props.context.theme
  const counts = createMemo(() => {
    const list = props.rows()
    const workers = list.filter((row) => row.kind === "worker")
    return {
      running: workers.filter((row) => row.running).length,
      done: workers.filter((row) => row.outcome === "succeeded").length,
      failed: workers.filter((row) => row.outcome === "failed").length,
      total: workers.length,
    }
  })
  const leadRunning = createMemo(() => props.rows().some((row) => row.kind === "lead" && row.running))
  return jsx(Show, {
    get when() {
      return props.rows().length > 0
    },
    get children() {
      return jsxs("box", {
        flexDirection: "row",
        flexShrink: 0,
        minWidth: 0,
        children: [
          jsx("text", { fg: theme.text.muted, wrapMode: "none", flexShrink: 0, children: " · " }),
          jsx("text", {
            get fg() {
              return leadRunning() ? theme.text.feedback.success.base : theme.text.muted
            },
            wrapMode: "none",
            flexShrink: 0,
            get children() {
              return leadRunning() ? "capy ▶" : "capy"
            },
          }),
          jsx("text", {
            fg: theme.text.muted,
            wrapMode: "none",
            flexShrink: 0,
            get children() {
              return ` ${counts().running}/${counts().total}`
            },
          }),
          jsx(Show, {
            get when() {
              return counts().done > 0
            },
            get children() {
              return jsx("text", {
                fg: theme.text.feedback.success.base,
                wrapMode: "none",
                flexShrink: 0,
                get children() {
                  return ` ✓${counts().done}`
                },
              })
            },
          }),
          jsx(Show, {
            get when() {
              return counts().failed > 0
            },
            get children() {
              return jsx("text", {
                fg: theme.text.feedback.error.base,
                wrapMode: "none",
                flexShrink: 0,
                get children() {
                  return ` ✗${counts().failed}`
                },
              })
            },
          }),
        ],
      })
    },
  })
}

function TeamPanel(props) {
  const theme = props.context.theme
  const [selected, setSelected] = createSignal(0)
  const count = createMemo(() => props.rows().length)
  const clamp = (index) => Math.min(index, Math.max(0, count() - 1))
  const selectedRow = createMemo(() => props.rows()[clamp(selected())])
  const focused = createMemo(() => props.panel.focused)

  props.context.keymap.layer(() => ({
    get enabled() {
      return focused() && count() > 0
    },
    commands: [
      {
        id: "capylead.team.up",
        title: "Move selection up",
        bind: "up",
        run: () => {
          setSelected((index) => Math.max(0, index - 1))
        },
      },
      {
        id: "capylead.team.down",
        title: "Move selection down",
        bind: "down",
        run: () => {
          setSelected((index) => clamp(index + 1))
        },
      },
      {
        id: "capylead.team.open",
        title: "Open the selected session",
        bind: "return",
        run: () => {
          const row = selectedRow()
          if (!row) return
          props.jump(row.sessionID)
          props.panel.close()
        },
      },
      {
        id: "capylead.team.close",
        title: "Close the team tree",
        bind: "escape",
        run: () => {
          props.panel.close()
        },
      },
    ],
  }))

  return jsxs("box", {
    width: "100%",
    height: "100%",
    flexDirection: "column",
    paddingTop: 1,
    paddingLeft: 1,
    paddingRight: 1,
    children: [
      jsxs("text", { fg: theme.text.base, flexShrink: 0, wrapMode: "none", children: [
        jsx("b", { children: "CAPY TEAM" }),
        jsx("span", { style: { fg: theme.text.muted }, children: " · up/down move · return open · esc close" }),
      ] }),
      jsx("box", {
        flexDirection: "column",
        paddingTop: 1,
        children: jsx(For, {
          get each() {
            return props.rows()
          },
          children: (row, index) => {
            const outcome = createMemo(() => {
              void props.tick()
              return outcomeText(row, theme)
            })
            return jsxs("box", {
              flexDirection: "row",
              gap: 1,
              onMouseUp: () => {
                setSelected(index())
                props.jump(row.sessionID)
                props.panel.close()
              },
              children: [
                jsx("text", {
                  get fg() {
                    return index() === clamp(selected()) ? theme.text.base : theme.text.muted
                  },
                  wrapMode: "none",
                  flexShrink: 0,
                  get children() {
                    return index() === clamp(selected()) ? "❯" : " "
                  },
                }),
                jsx("text", {
                  get fg() {
                    return row.kind === "lead" ? theme.text.base : theme.text.muted
                  },
                  wrapMode: "none",
                  flexShrink: 0,
                  truncate: true,
                  minWidth: 16,
                  maxWidth: 24,
                  get children() {
                    return (row.kind === "worker" ? (row.last ? "└─ " : "├─ ") : "") + row.role
                  },
                }),
                jsx("text", {
                  get fg() {
                    return row.running ? theme.text.feedback.success.base : theme.text.muted
                  },
                  wrapMode: "none",
                  flexShrink: 0,
                  minWidth: 8,
                  get children() {
                    return row.running ? "running" : "idle"
                  },
                }),
                jsx("text", {
                  get fg() {
                    return outcome().color
                  },
                  wrapMode: "none",
                  truncate: true,
                  flexGrow: 1,
                  minWidth: 0,
                  get children() {
                    return outcome().text
                  },
                }),
              ],
            })
          },
        }),
      }),
    ],
  })
}

function TeamSidebar(props) {
  const theme = props.context.theme
  return jsx(Show, {
    get when() {
      return props.rows().length > 0
    },
    get children() {
      return jsxs("box", {
        paddingTop: 1,
        children: [
          jsx("text", { fg: theme.text.base, wrapMode: "none", children: jsx("b", { children: "Capy Team" }) }),
          jsx(For, {
            get each() {
              return props.rows()
            },
            children: (row) => {
              const outcome = createMemo(() => {
                void props.tick()
                return outcomeText(row, theme)
              })
              return jsxs("box", {
                flexDirection: "row",
                gap: 1,
                onMouseUp: () => {
                  props.jump(row.sessionID)
                },
                children: [
                  jsx("text", {
                    fg: theme.text.muted,
                    wrapMode: "none",
                    truncate: true,
                    minWidth: 14,
                    maxWidth: 20,
                    get children() {
                      return (row.kind === "worker" ? (row.last ? "  └─ " : "  ├─ ") : "") + row.role
                    },
                  }),
                  jsx("text", {
                    get fg() {
                      return row.running ? theme.text.feedback.success.base : theme.text.muted
                    },
                    wrapMode: "none",
                    get children() {
                      return row.running ? "▶" : "·"
                    },
                  }),
                  jsx("text", {
                    get fg() {
                      return outcome().color
                    },
                    wrapMode: "none",
                    truncate: true,
                    flexGrow: 1,
                    minWidth: 0,
                    get children() {
                      return outcome().text
                    },
                  }),
                ],
              })
            },
          }),
        ],
      })
    },
  })
}
