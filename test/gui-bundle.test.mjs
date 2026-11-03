import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import vm from "node:vm"
import { JSDOM } from "jsdom"
import { createRequire } from "node:module"

// Execute the shipped CJS with the real Solid DOM renderer, not copied UI logic.
// Node's default Solid export is SSR; use the browser build just as Desktop does.
const require = createRequire(import.meta.url)
const solid = require("solid-js/dist/solid.cjs")
const webModule = { exports: {} }
vm.runInThisContext(`(function(require, module, exports) { ${readFileSync(require.resolve("solid-js/web/dist/web.cjs"), "utf8")}\n})`)(name => name === "solid-js" ? solid : require(name), webModule, webModule.exports)
const web = webModule.exports

test("built GUI renders scoped panel, badges and switcher; detach falls back to the project total", async () => {
  const dom = new JSDOM("<!doctype html><body><main></main></body>")
  const previous = {}
  for (const key of ["window", "document", "navigator", "Node", "Element", "HTMLElement"]) {
    previous[key] = Object.getOwnPropertyDescriptor(globalThis, key)
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] })
  }
  const tokens = Object.fromEntries(["Command", "MenuItem", "Panel", "Slot", "Style"].map(key => [key, key]))
  const contributions = new Map(), listeners = new Map(), jumps = [], layouts = [], toasts = [], notices = []
  const dialogRenders = [], dialogCloses = [], inserted = [], copied = []
  const worker = { id: "worker", location: { directory: "/project" }, title: "Build GUI" }
  const lead = { id: "lead", location: { directory: "/project" }, title: "โปรเจกต์หลัก", metadata: { capyTeam: { leadID: "lead", name: "Atlas", workers: [{ sessionID: "worker", role: "Builder" }] } } }
  let records = [lead, worker]
  const server = { id: "sidecar", connected: true, client: { session: { list: async () => ({ data: records, cursor: {} }) } }, data: {
    session: { status: id => id === "worker" ? "running" : "idle" },
    on(type, handler) { listeners.set(type, handler); return () => listeners.delete(type) },
  } }
  const [current, setCurrent] = solid.createSignal({ id: "lead", server, directory: "/project" })
  const ctx = { id: "capylead", sessions: { current }, add(token, value) { contributions.set(token, value) },
    layout: { toggle: (...args) => layouts.push(args), state: () => "closed" }, tabs: { open: (...args) => jumps.push(args) },
    dialogs: { open: render => { dialogRenders.push(render); return { close() {} } } },
    screen: { current: () => ({ composer: { insert: text => inserted.push(text) } }) },
    system: { copy: async text => copied.push(text) },
    toast: { show(options) { toasts.push(options); return { dismiss() {} } } }, attention: { notify: async options => { notices.push(options); return {} } } }
  const module = { exports: {} }
  const context = { module, exports: module.exports, require(name) {
    if (name === "solid-js") return solid
    if (name === "solid-js/web") return web
    if (name === "@opencode/plugin/gui") return { ...tokens, Plugin: { define: value => value } }
    throw new Error(`Unexpected runtime dependency: ${name}`)
  }, setInterval, clearInterval, setTimeout, clearTimeout, AbortController, console }
  vm.runInNewContext(readFileSync(new URL("../dist/gui-experimental.cjs", import.meta.url), "utf8"), context)
  let dispose, unmount
  try {
    solid.createRoot(stop => { dispose = stop; module.exports.default.setup(ctx) })
    await new Promise(resolve => setTimeout(resolve, 0))
    const command = () => contributions.get("Command")()
    assert.equal(command().title, "Capy: Switch team")
    assert.equal(command().enabled, true)
    // The switcher dialog lists every team, marks the current one, navigates on click.
    command().run()
    assert.equal(dialogRenders.length, 1)
    const dialogHost = document.createElement("div")
    document.body.appendChild(dialogHost)
    const unDialog = web.render(() => dialogRenders[0]({ close: () => dialogCloses.push("x") }), dialogHost)
    assert.match(dialogHost.textContent, /Teams in this project \(1\)/)
    assert.match(dialogHost.textContent, /Atlas — โปรเจกต์หลัก/)
    assert.match(dialogHost.textContent, /\[Current team\]/)
    assert.match(dialogHost.textContent, /● 1 running · 1 worker/)
    dialogHost.querySelectorAll("button")[1].click()
    assert.equal(jumps[0][0].id, "lead")
    assert.equal(dialogCloses.length, 1)
    // Own-team detail panel still scopes to the lead session.
    const panel = contributions.get("Panel")
    assert.equal(panel.list({ session: current(), open: ["team"] }).length, 1)
    const main = document.querySelector("main")
    unmount = web.render(() => panel.render({ get session() { return current() } }), main)
    assert.match(main.textContent, /Capy team · Atlas/)
    assert.match(main.textContent, /Builder/)
    main.querySelectorAll("button")[1].click()
    assert.equal(jumps[1][0].id, "worker")
    // Badges: lead names the team, worker names its team, non-member sees the project total.
    const badge = document.createElement("div")
    const unbadge = web.render(() => contributions.get("Slot").render({ get session() { return current() }, active: true }), badge)
    assert.match(badge.textContent, /Team lead · Atlas \(1\/1\)/)
    setCurrent({ id: "worker", server, directory: "/project" })
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(command().enabled, true)
    assert.match(badge.textContent, /Worker · Builder \(Atlas\)/)
    assert.equal(panel.list({ session: current(), open: ["team"] }).length, 0)
    listeners.get("session.execution.failed")({ id: "event-1", data: { sessionID: "worker" } })
    assert.equal(toasts.length, 1)
    assert.equal(notices[0].session, undefined)
    const jumpCount = jumps.length
    records = [{ ...lead, metadata: {} }, worker]
    listeners.get("session.metadata.updated")({})
    await new Promise(resolve => setTimeout(resolve, 180))
    toasts[0].actions[0].run()
    assert.equal(jumps.length, jumpCount, "stale notification action must not navigate after detach")
    assert.match(badge.textContent, /Teams · 0/)
    assert.equal(contributions.get("MenuItem")(), undefined)
    // The empty switcher teaches the first step and inserts the command into the composer.
    dialogRenders.length = 0
    command().run()
    assert.equal(dialogRenders.length, 1)
    const emptyHost = document.createElement("div")
    document.body.appendChild(emptyHost)
    const unEmpty = web.render(() => dialogRenders[0]({ close: () => dialogCloses.push("y") }), emptyHost)
    assert.match(emptyHost.textContent, /No teams in this project yet/)
    const buttons = [...emptyHost.querySelectorAll("button")]
    buttons.find(b => b.textContent.includes("/capy-lead-init")).click()
    assert.deepEqual(inserted, ["/capy-lead-init"])
    assert.equal(copied.length, 0)
    assert.equal(dialogCloses.length, 2)
    unEmpty()
    unDialog()
    unbadge()
  } finally {
    unmount?.()
    dispose?.()
    for (const key of Object.keys(previous)) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key])
      else delete globalThis[key]
    }
  }
})
