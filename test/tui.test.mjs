import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import vm from "node:vm"

async function ui() {
  const slots = new Map()
  const layers = []
  const handlers = new Map()
  const jumps = []
  const canonical = (id, workers, name, title) => ({
    id, title,
    metadata: { capyTeam: { leadID: id, ...(name ? { name } : {}), workers } },
  })
  const sessions = [
    canonical("a", [{ sessionID: "w", role: "backend" }], "Atlas", "งานหลักกำลังคุมทีม"),
    canonical("b", [{ sessionID: "x", role: "research" }], "Beacon", "Astra รีวิว UX"),
    canonical("c", [], undefined, undefined),
    { id: "w", metadata: { capyTeam: { leadID: "a", workers: [{ sessionID: "w" }] } } },
  ]
  let current = "outside"
  let panelSession = "outside"
  const toasts = []
  const context = {
    theme: { text: { muted: "muted", base: "base", feedback: { success: { base: "green" }, error: { base: "red" } } } },
    data: { session: { list: () => sessions, status: () => "idle" }, on: (name, fn) => { handlers.set(name, fn); return () => {} } },
    ui: {
      router: { current: () => ({ type: "session", sessionID: current }), navigate: (route) => { jumps.push(route.sessionID) } },
      slot: (s) => { slots.set(s.append, s.render); return () => {} },
      panel: { current: () => undefined, open: () => true, close: () => {} },
      toast: { show: t => toasts.push(t) },
    },
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
  return {
    sessions, toasts, jumps,
    select: id => { current = id; panelSession = id },
    strip: () => slots.get("prompt.footer.status")(),
    sidebar: () => slots.get("sidebar.content")(),
    switcher: () => slots.get("session.panel")({ name: "capy-lead.teams", sessionID: panelSession, focused: false }),
    command: () => layers[0]().commands[0],
  }
}

test("unrelated sessions see the project total, no sidebar; the command works everywhere", async () => {
  const f = await ui()
  assert.match(f.strip().children, /teams · 3 in project/)
  assert.equal(f.sidebar(), null)
  const command = f.command()
  assert.equal(command.title, "Capy: Switch team")
})

test("empty projects show teams · 0 and an empty switcher that teaches the first step", async () => {
  const f = await ui()
  f.sessions.length = 0
  assert.match(f.strip().children, /teams · 0/)
  const text = JSON.stringify(f.switcher())
  assert.match(text, /No teams in this project yet/)
  assert.match(text, /\/capy-lead-init/)
})

test("worker badge names its team; inherited stamps and stale rosters fall back to the project total", async () => {
  const f = await ui()
  f.select("w")
  assert.match(f.strip().children, /↳ backend \(Atlas\)/)
  assert.equal(f.sidebar(), null)
  f.sessions[0].metadata.capyTeam.workers = []
  assert.match(f.strip().children, /teams · 3 in project/)
})

test("lead strip shows its own team name and counts; sidebar stays own-team only", async () => {
  const f = await ui()
  f.select("b")
  const strip = JSON.stringify(f.strip())
  assert.match(strip, /team · Beacon/)
  assert.match(strip, /0\/1/)
  const text = JSON.stringify(f.sidebar())
  assert.match(text, /research/)
  assert.doesNotMatch(text, /backend/)
})

test("switcher lists every team by name with title and a stable fallback name", async () => {
  const f = await ui()
  const text = JSON.stringify(f.switcher())
  assert.match(text, /Atlas — งานหลักกำลังคุมทีม/)
  assert.match(text, /Beacon — Astra รีวิว UX/)
  assert.match(text, /Team 3/)
  assert.doesNotMatch(text, /Current team/)
})

test("switcher marks the viewed session's team and opens that lead", async () => {
  const f = await ui()
  f.select("w")
  assert.match(JSON.stringify(f.switcher()), /Atlas.*\[Your team\]/)
  f.select("a")
  assert.match(JSON.stringify(f.switcher()), /\[Current team\]/)
})
