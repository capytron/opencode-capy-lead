import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { Command, MenuItem, Panel, Plugin, Slot, Style, type MountedSession, type PanelTab } from "@opencode/plugin/gui"
import type { SessionInfo } from "@opencode/client"
import { createTeamSource, membership, teamRows, teamsIn } from "./gui/team.mjs"
import css from "./gui/team.css?inline"

export default Plugin.define({
  setup(ctx) {
    // Key the scope by server and directory, not the currently selected lead.
    const [snapshot, setSnapshot] = createSignal<{ key: string; sessions: SessionInfo[]; error: boolean }>({ key: "", sessions: [], error: false })
    const scopeKey = (session: MountedSession) => `${session.server.id}\n${session.directory}`
    const sessionsFor = (session: MountedSession) => snapshot().key === scopeKey(session) ? snapshot().sessions : []
    const teamsFor = (session: MountedSession) => teamsIn(sessionsFor(session), session.directory)
    const memberFor = (session: MountedSession) => membership(teamsFor(session), session.id)
    const panelKey = `${ctx.id}:team`
    const open = () => {
      const session = ctx.sessions.current()
      if (session && memberFor(session)?.role === "lead") ctx.layout.toggle(panelKey, session)
    }
    const jump = (session: MountedSession, id: string) => {
      if (!session.server.connected || !sessionsFor(session).some((info) => info.id === id && info.location.directory === session.directory)) return
      ctx.tabs.open({ server: session.server.id, id }, { focus: true })
    }

    createEffect(() => {
      const session = ctx.sessions.current()
      if (!session) { setSnapshot({ key: "", sessions: [], error: false }); return }
      const server = session.server
      const key = scopeKey(session)
      const directory = session.directory
      const connected = server.connected
      // Track replacement clients/data on reconnect; callbacks read the live ref.
      const data = server.data
      const client = server.client
      void client
      setSnapshot({ key, sessions: [], error: false })
      if (!connected) return
      let dead = false
      const source = createTeamSource(() => server.client, directory,
        (sessions: SessionInfo[]) => { if (!dead) setSnapshot({ key, sessions, error: false }) },
        () => { if (!dead) setSnapshot({ key, sessions: [], error: true }) })
      let pending: ReturnType<typeof setTimeout> | undefined
      const refresh = () => {
        if (pending !== undefined) return
        pending = setTimeout(() => { pending = undefined; void source.refresh() }, 150)
      }
      const off = (["session.created", "session.metadata.updated", "session.deleted", "session.moved", "session.renamed"] as const).map((type) =>
        data.on(type, refresh))
      const toasts: ReturnType<typeof ctx.toast.show>[] = []
      const notify = (id: string, message: string, eventID: string, error = false) => {
        const currentMember = () => !dead && server.connected && snapshot().key === key &&
          membership(teamsIn(snapshot().sessions, directory), id)
        if (!currentMember()) return
        toasts.push(ctx.toast.show({ title: "capy-lead", description: message, variant: error ? "error" : "default",
          actions: [{ label: "Open session", run: () => {
            if (currentMember()) ctx.tabs.open({ server: server.id, id }, { focus: true })
          } }] }))
        if (toasts.length > 20) toasts.shift()?.dismiss()
        // Native notifications cannot revoke a session target after detach/move.
        // Keep native attention informational; toast actions revalidate membership.
        void ctx.attention.notify({ title: "capy-lead", message, variant: error ? "error" : "default",
          id: `${ctx.id}:${server.id}:${eventID}` })
      }
      off.push(data.on("session.execution.failed", (event) => {
        const member = membership(teamsIn(snapshot().key === key ? snapshot().sessions : [], directory), event.data.sessionID)
        if (member?.role === "worker") notify(event.data.sessionID, `Worker “${member.worker.role}” failed`, event.id, true)
      }))
      off.push(data.on("form.created", (event) => {
        const member = membership(teamsIn(snapshot().key === key ? snapshot().sessions : [], directory), event.data.form.sessionID)
        if (member) notify(event.data.form.sessionID, member.role === "lead" ? "The lead is waiting for your answer" : `Worker “${member.worker.role}” is waiting for your answer`, event.id)
      }))
      void source.refresh()
      // Reconcile missed updates after a disconnected event stream; never drive work.
      const timer = setInterval(refresh, 30_000)
      onCleanup(() => { dead = true; source.dispose(); off.forEach((stop) => stop()); toasts.forEach((toast) => toast.dismiss()); clearInterval(timer); clearTimeout(pending) })
    })

    ctx.add(Style, css)
    const tab: PanelTab = { id: "team", title: "Capy team", closable: "compact", fallback: true }
    ctx.add(Panel, {
      id: "team", region: "side",
      mobile: { title: "Capy team", order: 45, kind: "menu", icon: "file-tree" },
      list: (input) => memberFor(input.session)?.role === "lead" && input.open.includes("team") ? [tab] : [],
      render: (props) => {
        const member = createMemo(() => memberFor(props.session))
        const rows = createMemo(() => member()?.role === "lead" ? teamRows(member()!.team, (id: string) => props.session.server.data.session.status(id)) : [])
        return <section class="capy-team" aria-label="Capy team">
          <header><h2>Capy team</h2><p>{rows().filter((row) => row.running).length} running · {Math.max(0, rows().length - 1)} positions</p></header>
          <Show when={member()?.role === "lead"} fallback={<p role="status">This team is no longer active. Open a lead session to view its team.</p>}>
            <ul><For each={rows()}>{(row) => <li>
              <button type="button" onClick={() => jump(props.session, row.sessionID)} title={row.sessionID}>
                <span class="capy-team-dot" data-state={row.running ? "running" : row.outcome ?? "idle"} />
                <span class="capy-team-person"><strong>{row.role}</strong><small>{row.waiting || (row.sessionID === props.session.id ? "Current session" : sessionsFor(props.session).find((info) => info.id === row.sessionID)?.title || row.sessionID)}</small></span>
                <span class="capy-team-state">{row.running ? "Running" : row.waiting ? "Waiting" : row.outcome === "succeeded" ? "Done" : row.outcome === "failed" ? "Failed" : "Idle"}</span>
              </button>
            </li>}</For></ul>
            <Show when={rows().length === 1}><p>No positions yet. Ask the lead to register a persistent worker for a task.</p></Show>
          </Show>
        </section>
      },
    })
    ctx.add(Command, (): Command => ({ id: "team.open", title: "Open capy-lead team", group: "capy-lead", section: "session",
      slash: { name: "capy-team-view" }, enabled: !!ctx.sessions.current() && memberFor(ctx.sessions.current()!)?.role === "lead", run: open }))
    ctx.add(MenuItem, (): MenuItem | undefined => {
      const session = ctx.sessions.current()
      if (!session || memberFor(session)?.role !== "lead") return undefined
      return { menu: "session.panel", id: "team", title: "Capy team", icon: "file-tree", keybind: `${ctx.id}.team.open`,
        opened: ctx.layout.state(panelKey, session) !== "closed", run: open }
    })
    ctx.add(Slot, { at: "session.header", render: (input) => {
      const member = createMemo(() => memberFor(input.session))
      return <Show when={input.active && member()}><span class="capy-team-badge">
        <Show when={member()?.role === "lead"} fallback={`capy worker (${member()?.worker?.role ?? "worker"})`}>
          <button type="button" onClick={() => ctx.layout.toggle(panelKey, input.session)}>Capy team · {member()?.team.workers.length ?? 0}</button>
        </Show>
      </span></Show>
    } })
  },
})
