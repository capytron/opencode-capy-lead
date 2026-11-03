import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import vm from "node:vm"

async function ui() {
  const slots = new Map()
  const layers = []
  const handlers = new Map()
  const canonical = (id, workers) => ({ id, metadata: { capyTeam: { leadID: id, workers } } })
  const sessions = [canonical("a", [{ sessionID: "w", role: "backend" }]), canonical("b", [{ sessionID: "x", role: "research" }]), { id: "w", metadata: { capyTeam: { leadID: "a", workers: [{ sessionID: "w" }] } } }]
  let current = "outside"
  let panelSession = "outside"
  const toasts = []
  const context = {
    theme: { text: { muted: "muted", base: "base", feedback: { success: { base: "green" }, error: { base: "red" } } } },
    data: { session: { list: () => sessions, status: () => "idle" }, on: (name, fn) => { handlers.set(name, fn); return () => {} } },
    ui: { router: { current: () => ({ type: "session", sessionID: current }), navigate: () => {} }, slot: (s) => { slots.set(s.append, s.render); return () => {} }, panel: { current: () => undefined, open: () => true }, toast: { show: t => toasts.push(t) } },
    keymap: { layer: fn => layers.push(fn) }, attention: { notify: async () => {} },
  }
  const jsx = (type, props) => typeof type === "function" ? type(props) : { type, ...props }
  const sandbox = vm.createContext({
    createMemo: fn => fn, createSignal: value => [() => value, v => { value = v }], onCleanup: () => {},
    Show: p => p.when ? p.children : (p.fallback ?? null), For: p => p.each.map((row, i) => p.children(row, () => i)),
    jsx, jsxs: jsx, setInterval: () => 0, clearInterval: () => {},
  })
  const plugin = vm.runInContext((await readFile(new URL("../tui.ts", import.meta.url), "utf8")).replace(/^import .*\r?\n/gm, "").replace("export default", "globalThis.plugin ="), sandbox)
  await plugin.setup(context)
  return { sessions, toasts, handlers, select: id => { current = id; panelSession = id },
    strip: () => slots.get("prompt.footer.status")(), sidebar: () => slots.get("sidebar.content")(),
    panel: () => slots.get("session.panel")({ name: "capy-lead.team", sessionID: panelSession, focused: false }),
    commandEnabled: () => layers[0]().enabled,
  }
}

test("unrelated sessions render no strip, sidebar, panel or team command", async () => {
  const f = await ui()
  assert.equal(f.strip(), null)
  assert.equal(f.sidebar(), null)
  assert.equal(f.panel(), null)
  assert.equal(f.commandEnabled(), false)
})

test("worker sees only a badge; removed worker's inherited stamp is ignored", async () => {
  const f = await ui()
  f.select("w")
  assert.match(f.strip().children, /worker.*backend/)
  assert.equal(f.sidebar(), null)
  assert.equal(f.panel(), null)
  assert.equal(f.commandEnabled(), false)
  f.sessions[0].metadata.capyTeam.workers = []
  assert.equal(f.strip(), null)
})

test("each lead sees only its own positions, independent of session order", async () => {
  const f = await ui()
  f.select("b")
  assert.equal(f.commandEnabled(), true)
  const text = JSON.stringify(f.sidebar())
  assert.match(text, /research/)
  assert.doesNotMatch(text, /backend/)
})
