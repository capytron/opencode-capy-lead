/** @jsxImportSource @opentui/solid */
/**
 * capy-lead TUI — team strip, team tree, and attention notifications.
 *
 * 1. Team strip (prompt.footer.status): `capy ▶ 2/3 ✓1 ✗0`
 * 2. Team tree:
 *    - `/capy-team` (or the command palette) opens an interactive panel:
 *        Lead       running   reviewing results
 *        ├─ backend     idle   succeeded · 1m ago
 *        └─ frontend   running
 *      up/down select a row, enter jumps to that session, escape closes.
 *    - The sidebar (below the session tree) shows the same tree compactly;
 *      clicking a row jumps to that session.
 * 3. Attention notifications, quiet by default: worker failure and pending
 *    team questions toast + notify (desktop + sound) when unfocused; normal
 *    completion is silent.
 *
 * All data is event-driven: roster + last outcomes come from the capyTeam
 * stamp the server plugin maintains on the lead session's metadata; busy
 * state is derived live from session status. The strip and tree render
 * nothing when the project has no team.
 */
import { Plugin } from "@opencode/plugin/tui"
import type { PanelInput } from "@opencode/plugin/tui/context"
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"

const ROUTE = "capy-lead.team"

const timeAgo = (time) => {
  if (!time) return ""
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}

export default Plugin.define({
  id: "capylead.tui",
  setup(context) {
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
        { kind: "lead", sessionID: current.lead.id, role: "Lead", running: leadStatus === "running", outcome: null, outcomeTime: null },
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
      render: () => <TeamStrip context={context} rows={rows} />,
    })

    // ---- 2a. interactive panel (/team) ------------------------------------
    const offPanel = context.ui.slot({
      append: "session.panel",
      render: (panel) => (
        <Show when={panel.name === ROUTE}>
          <TeamPanel context={context} panel={panel} rows={rows} jump={jump} tick={tick} />
        </Show>
      ),
    })

    // ---- 2b. compact sidebar tree ------------------------------------------
    const offSidebar = context.ui.slot({
      append: "sidebar.content",
      render: () => <TeamSidebar context={context} rows={rows} jump={jump} tick={tick} />,
    })

    // ---- 2c. /capy-team command (palette + slash) -------------------------------
    const offCommands = context.ui.slot({
      append: "app",
      render: () => (
        <TeamCommand
          context={context}
          rows={rows}
          onOpen={() => {
            const route = context.ui.router.current()
            const current = context.ui.panel.current()
            if (route.type === "session" && current?.sessionID === route.sessionID && current.name === ROUTE) {
              context.ui.panel.close()
              return
            }
            if (context.ui.panel.open(ROUTE)) return
            context.ui.toast.show({ title: "capy-lead", message: "Open a session first, then /capy-team", variant: "info" })
          }}
        />
      ),
    })

    return () => {
      offFailed()
      offForm()
      offStrip()
      offPanel()
      offSidebar()
      offCommands()
    }
  },
})

function TeamCommand(props: { context: Plugin.Context; rows: () => any[]; onOpen: () => void }) {
  props.context.keymap.layer(() => ({
    mode: "global",
    enabled: () => props.rows().length > 0,
    commands: [
      {
        id: "capylead.team.open",
        title: "Open the capy-lead team tree",
        slash: { name: "capy-team" },
        group: "capy-lead",
        palette: true,
        run: () => void props.onOpen(),
      },
    ],
  }))
  return null
}

function TeamStrip(props: { context: Plugin.Context; rows: () => any[] }) {
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
  return (
    <Show when={props.rows().length > 0}>
      <box flexDirection="row" flexShrink={0} minWidth={0}>
        <text fg={theme.text.muted} wrapMode="none" flexShrink={0}>
          {" · "}
        </text>
        <text fg={leadRunning() ? theme.text.feedback.success.base : theme.text.muted} wrapMode="none" flexShrink={0}>
          capy{leadRunning() ? " ▶" : ""}
        </text>
        <text fg={theme.text.muted} wrapMode="none" flexShrink={0}>
          {` ${counts().running}/${counts().total}`}
        </text>
        <Show when={counts().done > 0}>
          <text fg={theme.text.feedback.success.base} wrapMode="none" flexShrink={0}>
            {` ✓${counts().done}`}
          </text>
        </Show>
        <Show when={counts().failed > 0}>
          <text fg={theme.text.feedback.error.base} wrapMode="none" flexShrink={0}>
            {` ✗${counts().failed}`}
          </text>
        </Show>
      </box>
    </Show>
  )
}

function outcomeText(row, theme) {
  if (row.outcome === "succeeded") return { text: `✓ ${timeAgo(row.outcomeTime)}`.trim(), color: theme.text.feedback.success.base }
  if (row.outcome === "failed") return { text: `✗ ${timeAgo(row.outcomeTime)}`.trim(), color: theme.text.feedback.error.base }
  if (row.outcome) return { text: row.outcome, color: theme.text.muted }
  return { text: "", color: theme.text.muted }
}

function TeamPanel(props: {
  context: Plugin.Context
  panel: PanelInput
  rows: () => any[]
  jump: (sessionID: string) => void
  tick: () => number
}) {
  const theme = props.context.theme
  const [selected, setSelected] = createSignal(0)
  const count = createMemo(() => props.rows().length)
  const selectedRow = createMemo(() => props.rows()[Math.min(selected(), Math.max(0, count() - 1))])
  const focused = createMemo(() => props.panel.focused)

  props.context.keymap.layer(() => ({
    enabled: () => focused() && count() > 0,
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
          setSelected((index) => Math.min(count() - 1, index + 1))
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

  return (
    <box width="100%" height="100%" flexDirection="column" paddingTop={1} paddingLeft={1} paddingRight={1}>
      <text fg={theme.text.base} attributes={0} flexShrink={0} wrapMode="none">
        <b>CAPY TEAM</b>
        <span style={{ fg: theme.text.muted }}> · up/down move · enter open · esc close</span>
      </text>
      <box flexDirection="column" paddingTop={1}>
        <For each={props.rows()}>
          {(row, index) => {
            const isSelected = createMemo(() => index() === Math.min(selected(), count() - 1))
            const outcome = createMemo(() => {
              void props.tick()
              return outcomeText(row, theme)
            })
            return (
              <box
                flexDirection="row"
                gap={1}
                onMouseUp={() => {
                  setSelected(index())
                  props.jump(row.sessionID)
                  props.panel.close()
                }}
              >
                <text fg={isSelected() ? theme.text.base : theme.text.muted} wrapMode="none" flexShrink={0}>
                  {isSelected() ? "❯" : " "}
                </text>
                <text
                  fg={row.kind === "lead" ? theme.text.base : theme.text.muted}
                  wrapMode="none"
                  flexShrink={0}
                  truncate
                  minWidth={16}
                  maxWidth={24}
                >
                  {row.kind === "worker" ? (row.last ? "└─ " : "├─ ") : ""}
                  {row.role}
                </text>
                <text
                  fg={row.running ? theme.text.feedback.success.base : theme.text.muted}
                  wrapMode="none"
                  flexShrink={0}
                  minWidth={8}
                >
                  {row.running ? "running" : "idle"}
                </text>
                <text fg={outcome().color} wrapMode="none" truncate flexGrow={1} minWidth={0}>
                  {outcome().text}
                </text>
              </box>
            )
          }}
        </For>
      </box>
    </box>
  )
}

function TeamSidebar(props: { context: Plugin.Context; rows: () => any[]; jump: (sessionID: string) => void; tick: () => number }) {
  const theme = props.context.theme
  return (
    <Show when={props.rows().length > 0}>
      <box paddingTop={1}>
        <text fg={theme.text.base} wrapMode="none">
          <b>Capy Team</b>
        </text>
        <For each={props.rows()}>
          {(row) => {
            const outcome = createMemo(() => {
              void props.tick()
              return outcomeText(row, theme)
            })
            return (
              <box
                flexDirection="row"
                gap={1}
                onMouseUp={() => props.jump(row.sessionID)}
              >
                <text fg={theme.text.muted} wrapMode="none" truncate minWidth={14} maxWidth={20}>
                  {row.kind === "worker" ? (row.last ? "  └─ " : "  ├─ ") : ""}
                  {row.role}
                </text>
                <text fg={row.running ? theme.text.feedback.success.base : theme.text.muted} wrapMode="none">
                  {row.running ? "▶" : "·"}
                </text>
                <text fg={outcome().color} wrapMode="none" truncate flexGrow={1} minWidth={0}>
                  {outcome().text}
                </text>
              </box>
            )
          }}
        </For>
      </box>
    </Show>
  )
}
