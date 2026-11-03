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

test("built GUI renders scoped panel, navigation and worker badge; detach hides all controls", async () => {
  const dom = new JSDOM("<!doctype html><body><main></main></body>")
  const previous = {}
  for (const key of ["window", "document", "navigator", "Node", "Element", "HTMLElement"]) {
    previous[key] = Object.getOwnPropertyDescriptor(globalThis, key)
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] })
  }
  const tokens = Object.fromEntries(["Command", "MenuItem", "Panel", "Slot", "Style"].map(key => [key, key]))
  const contributions = new Map(), listeners = new Map(), jumps = [], layouts = [], toasts = [], notices = []
  const worker = { id: "worker", location: { directory: "/project" }, title: "Build GUI" }
  const lead = { id: "lead", location: { directory: "/project" }, metadata: { capyTeam: { leadID: "lead", workers: [{ sessionID: "worker", role: "Builder" }] } } }
  let records = [lead, worker]
  const server = { id: "sidecar", connected: true, client: { session: { list: async () => ({ data: records, cursor: {} }) } }, data: {
    session: { status: id => id === "worker" ? "running" : "idle" },
    on(type, handler) { listeners.set(type, handler); return () => listeners.delete(type) },
  } }
  const [current, setCurrent] = solid.createSignal({ id: "lead", server, directory: "/project" })
  const ctx = { id: "capylead", sessions: { current }, add(token, value) { contributions.set(token, value) },
    layout: { toggle: (...args) => layouts.push(args), state: () => "closed" }, tabs: { open: (...args) => jumps.push(args) },
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
    assert.equal(command().enabled, true)
    command().run()
    assert.equal(layouts[0][0], "capylead:team")
    const panel = contributions.get("Panel")
    assert.equal(panel.list({ session: current(), open: ["team"] }).length, 1)
    const main = document.querySelector("main")
    unmount = web.render(() => panel.render({ get session() { return current() } }), main)
    assert.match(main.textContent, /Builder/)
    assert.match(main.textContent, /Running/)
    main.querySelectorAll("button")[1].click()
    assert.equal(jumps[0][0].id, "worker")
    assert.equal(jumps[0][0].server, "sidecar")
    assert.equal(jumps[0][1].focus, true)
    setCurrent({ id: "worker", server, directory: "/project" })
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(command().enabled, false)
    const badge = document.createElement("div")
    const unbadge = web.render(() => contributions.get("Slot").render({ get session() { return current() }, active: true }), badge)
    assert.match(badge.textContent, /capy worker \(Builder\)/)
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
    assert.equal(badge.textContent, "")
    assert.equal(contributions.get("MenuItem")(), undefined)
    assert.equal(command().enabled, false)
    unbadge()
  } finally {
    unmount?.(); dispose?.(); dom.window.close()
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  }
  assert.equal(listeners.size, 0)
})
