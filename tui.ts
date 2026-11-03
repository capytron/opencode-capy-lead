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
 * Scoping: the UI renders ONLY for the session being viewed —
 *   - the lead session gets the full team (strip + sidebar + /capy-team-view);
 *   - a registered worker session gets a small "capy · worker (role)" badge;
 *   - any other session renders nothing.
 * Attention notifications (failure, pending question) are NOT scoped to the
 * viewed session: they fire for every team visible in this TUI, so a worker
 * failing in team B still notifies while the user reads team A.
 *
 * All data is event-driven: rosters + last outcomes come from the capyTeam
 * stamps the server plugin maintains on each lead session's metadata (a
 * stamp is canonical only when stamp.leadID === session.id — copies that
 * children inherit name a different id and are ignored); busy state is
 * derived live from session status.
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
    // Every team whose canonical stamp exists in this TUI's session store.
    // One project directory can host multiple leads, each with its own team.
    const firstWords = (text, max = 14) => {
      const one = String(text ?? "").replace(/\s+/g, " ").trim()
      return one.length > max ? one.slice(0, max - 1) + "…" : one
    }
    const allTeams = createMemo(() => {
      const teams = []
      for (const session of context.data.session.list()) {
        const stamp = session.metadata?.capyTeam
        if (!stamp || stamp.leadID !== session.id) continue
        const workers = stamp.workers ?? []
        const lastOutcome = Math.max(0, ...workers.map((item) => item.lastOutcomeTime ?? 0), 0)
        teams.push({
          lead: session,
          workers,
          name: stamp.name || firstWords(session.title) || "",
          activity: Math.max(session.time?.updated ?? 0, lastOutcome),
          created: session.time?.created ?? 0,
        })
      }
      // Stable fallback numbering for teams with no name and no usable title.
      const numbered = new Map([...teams].sort((a, b) => a.created - b.created).map((team, index) => [team, index + 1]))
      for (const team of teams) if (!team.name) team.name = `Team ${numbered.get(team)}`
      // Most recently active first: the team someone forgot about sits on top.
      return [...teams].sort((a, b) => b.activity - a.activity)
    })

    // Membership of the session the user is currently viewing.
    const currentSessionID = createMemo(() => {
      const route = context.ui.router.current()
      return route?.type === "session" ? route.sessionID : undefined
    })
    const activeTeam = createMemo(() => {
      const activeID = currentSessionID()
      if (!activeID) return undefined
      const asLead = allTeams().find((team) => team.lead.id === activeID)
      if (asLead) return { team: asLead, role: "lead", worker: undefined }
      for (const team of allTeams()) {
        const worker = team.workers.find((item) => item.sessionID === activeID)
        if (worker) return { team, role: "worker", worker }
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
      for (const team of allTeams()) {
        if (event.data.sessionID === team.lead.id) continue
        const worker = team.workers.find((item) => item.sessionID === event.data.sessionID)
        if (worker) {
          attention(`Worker "${worker.role}" failed — the lead has been woken`, event.data.sessionID, "error", "error")
          return
        }
      }
    })

    const offForm = context.data.on("form.created", (event) => {
      if (allTeams().length === 0) return
      // The payload is { form: Info } — sessionID lives on the form object.
      const id = event.data.form?.sessionID
      if (!id) return
      for (const team of allTeams()) {
        if (id === team.lead.id) {
          attention("The lead is waiting for your answer", id, "warning", "question")
          return
        }
        const worker = team.workers.find((item) => item.sessionID === id)
        if (worker) {
          attention(`Worker "${worker.role}" is waiting for your answer`, id, "warning", "question")
          return
        }
      }
    })

    // ---- shared tree rows (lead view only) ---------------------------------
    // Rows are ordered by the roster (registration order), never re-sorted on
    // updates, so the tree does not jump around while reading it.
    const rows = createMemo(() => {
      const active = activeTeam()
      if (!active || active.role !== "lead") return []
      const leadStatus = context.data.session.status(active.team.lead.id)
      return [
        {
          kind: "lead",
          sessionID: active.team.lead.id,
          role: "Lead",
          running: leadStatus === "running",
          outcome: null,
          outcomeTime: null,
        },
        ...active.team.workers.map((worker, index) => ({
          kind: "worker",
          sessionID: worker.sessionID,
          role: worker.role,
          running: context.data.session.status(worker.sessionID) === "running",
          outcome: worker.lastOutcome ?? null,
          outcomeTime: worker.lastOutcomeTime ?? null,
          last: index === active.team.workers.length - 1,
        })),
      ]
    })

    // Refresh relative times ("1m ago") without waiting for other events.
    const [tick, setTick] = createSignal(0)
    const timer = setInterval(() => setTick(tick() + 1), 5000)
    onCleanup(() => clearInterval(timer))

    // ---- 1. strip: membership answers itself; the project total is the ----
    // ---- workspace memory that survives closed tabs -----------------------
    const offStrip = context.ui.slot({
      append: "prompt.footer.status",
      render: () => {
        const active = activeTeam()
        if (!active) {
          const count = allTeams().length
          return jsx("text", {
            fg: context.theme.text.muted, wrapMode: "none", flexShrink: 0,
            get children() { return ` · teams · ${count > 0 ? `${count} in project` : "0"}` },
          })
        }
        if (active.role === "worker") {
          return jsx("text", {
            fg: context.theme.text.muted, wrapMode: "none", flexShrink: 0,
            get children() { return ` · ↳ ${active.worker?.role ?? "worker"} (${active.team.name})` },
          })
        }
        return jsx(TeamStrip, { context, rows, teamName: () => active.team.name })
      },
    })

    // ---- 2a. team switcher (/capy-team-view, every session) ---------------
    const offPanel = context.ui.slot({
      append: "session.panel",
      render: (panel) =>
        jsx(Show, {
          get when() {
            return panel.name === "capy-lead.teams" && panel.sessionID === currentSessionID()
          },
          get children() {
            return jsx(SwitcherPanel, { context, panel, allTeams, activeTeam, currentSessionID, jump, tick })
          },
        }),
    })

    // ---- 2b. compact sidebar tree (lead only) ------------------------------
    const offSidebar = context.ui.slot({
      append: "sidebar.content",
      render: () =>
        jsx(Show, {
          get when() {
            return activeTeam()?.role === "lead"
          },
          get children() {
            return jsx(TeamSidebar, { context, rows, jump, tick })
          },
        }),
    })

    // ---- 2c. /capy-team-view command (palette + slash, every session) -----
    const openPanel = () => {
      const route = context.ui.router.current()
      const current = context.ui.panel.current()
      if (route.type === "session" && current?.sessionID === route.sessionID && current.name === "capy-lead.teams") {
        context.ui.panel.close()
        return
      }
      if (context.ui.panel.open("capy-lead.teams")) return
      context.ui.toast.show({ title: "capy-lead", message: "Open a session first, then /capy-team-view", variant: "info" })
    }
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "capylead.team.open",
          title: "Capy: Switch team",
          slash: { name: "capy-team-view" },
          group: "capy-lead",
          palette: true,
          run: () => {
            openPanel()
          },
        },
      ],
    }))

    return () => {
      offFailed()
      offForm()
      offStrip()
      offPanel()
      offSidebar()
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
              return leadRunning() ? theme.text.feedback.success.base : theme.text.base
            },
            wrapMode: "none", flexShrink: 0,
            get children() {
              return `team ${leadRunning() ? "▶" : "·"} ${props.teamName()}`
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
                wrapMode: "none", flexShrink: 0,
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
                wrapMode: "none", flexShrink: 0,
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

function SwitcherPanel(props) {
  const theme = props.context.theme
  const [selected, setSelected] = createSignal(0)
  const teams = createMemo(() => props.allTeams())
  const count = createMemo(() => teams().length)
  const clamp = (index) => Math.min(index, Math.max(0, count() - 1))
  const selectedTeam = createMemo(() => teams()[clamp(selected())])
  const focused = createMemo(() => props.panel.focused)

  // The marker answers "which team is this session in?" at a glance.
  const marker = (team) => {
    const active = props.activeTeam()
    if (!active) return ""
    if (active.team.lead.id === team.lead.id) return active.role === "lead" ? "Current team" : "Your team"
    return ""
  }
  const secondary = (team) => {
    void props.tick()
    const running = team.workers.filter((item) => props.context.data.session.status(item.sessionID) === "running").length
    if (running > 0) return `● ${running} running · ${team.workers.length} ${team.workers.length === 1 ? "worker" : "workers"}`
    if (team.activity > 0) return `Active ${timeAgo(team.activity)}`
    return team.workers.length > 0 ? `${team.workers.length} ${team.workers.length === 1 ? "worker" : "workers"}` : "No workers yet"
  }

  props.context.keymap.layer(() => ({
    get enabled() {
      return focused() && count() > 0
    },
    commands: [
      {
        id: "capylead.teams.up",
        title: "Move selection up",
        bind: "up",
        run: () => {
          setSelected((index) => Math.max(0, index - 1))
        },
      },
      {
        id: "capylead.teams.down",
        title: "Move selection down",
        bind: "down",
        run: () => {
          setSelected((index) => clamp(index + 1))
        },
      },
      {
        id: "capylead.teams.open",
        title: "Open the team lead session",
        bind: "return",
        run: () => {
          const team = selectedTeam()
          if (!team) return
          props.jump(team.lead.id)
          props.panel.close()
        },
      },
      {
        id: "capylead.teams.close",
        title: "Close the team switcher",
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
        jsx("b", { children: "TEAMS IN THIS PROJECT" }),
        jsx("span", { style: { fg: theme.text.muted }, children: ` (${count()})` }),
      ] }),
      jsx(Show, {
        get when() {
          return count() > 0
        },
        get fallback() {
          return jsxs("box", { flexDirection: "column", paddingTop: 1, children: [
            jsx("text", { fg: theme.text.base, wrapMode: "none", children: "No teams in this project yet" }),
            jsx("text", { fg: theme.text.muted, wrapMode: "none", children: "Start a team to delegate tasks to helpers." }),
            jsx("text", { fg: theme.text.muted, wrapMode: "none", children: "Type /capy-lead-init in chat to make this session a team lead." }),
          ] })
        },
        get children() {
          return jsx("box", {
            flexDirection: "column",
            paddingTop: 1,
            children: jsx(For, {
              get each() {
                return teams()
              },
              children: (team, index) => {
                const title = String(team.lead.title ?? "").replace(/\s+/g, " ").trim()
                return jsxs("box", {
                  flexDirection: "row",
                  gap: 1,
                  onMouseUp: () => {
                    setSelected(index())
                    props.jump(team.lead.id)
                    props.panel.close()
                  },
                  children: [
                    jsx("text", {
                      get fg() {
                        return index() === clamp(selected()) ? theme.text.base : theme.text.muted
                      },
                      wrapMode: "none", flexShrink: 0,
                      get children() {
                        return index() === clamp(selected()) ? "❯" : " "
                      },
                    }),
                    jsx("text", {
                      get fg() {
                        return marker(team) ? theme.text.base : theme.text.muted
                      },
                      wrapMode: "none", truncate: true, flexGrow: 1, minWidth: 0,
                      get children() {
                        const mark = marker(team)
                        return `${team.name}${title && title !== team.name ? ` — ${title}` : ""}${mark ? ` [${mark}]` : ""}`
                      },
                    }),
                    jsx("text", {
                      get fg() {
                        return team.workers.some((item) => props.context.data.session.status(item.sessionID) === "running")
                          ? theme.text.feedback.success.base
                          : theme.text.muted
                      },
                      wrapMode: "none", flexShrink: 0, truncate: true, maxWidth: 34,
                      get children() {
                        return secondary(team)
                      },
                    }),
                  ],
                })
              },
            }),
          })
        },
      }),
      jsx("text", { fg: theme.text.muted, flexShrink: 0, wrapMode: "none", children: "↵ Open team lead · Esc Close" }),
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
