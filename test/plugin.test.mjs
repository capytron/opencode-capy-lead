import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import vm from "node:vm"

async function fixture(seed = {}, options = {}) {
  const commands = new Map()
  const tools = new Map()
  const hooks = new Map()
  const data = new Map(Object.entries(seed))
  const sessions = new Map()
  const messages = []
  const events = []
  const intervals = []
  const errors = []
  let consumer
  const copy = (v) => v === undefined ? undefined : structuredClone(v)
  const context = vm.createContext({
    console: { ...console, error: (...args) => errors.push(args) }, AbortController, structuredClone, randomUUID: () => String(Math.random()),
    readFile: async (path) => { if (path.endsWith("config.json") && options.config) return JSON.stringify(options.config); throw Object.assign(new Error("not found"), { code: "ENOENT" }) },
    mkdir: async () => {}, writeFile: async () => {},
    setTimeout, clearTimeout,
    setInterval: (fn) => { intervals.push(fn); return fn }, clearInterval: () => {},
    Bun: { file: () => ({ json: async () => ({}), exists: async () => false, text: async () => "" }), write: async () => 0, spawnSync: () => ({ stdout: "" }) },
  })
  const plugin = vm.runInContext((await readFile(new URL("../index.ts", import.meta.url), "utf8")).replace(/^import .*\r?\n/gm, "").replace("export default", "globalThis.plugin ="), context)
  const ctx = {
    location: { directory: "/project" },
    storage: {
      get: async (key) => copy(data.get(key)),
      set: async (key, value) => { data.set(key, copy(value)) },
      remove: async (key) => { data.delete(key) },
    },
    session: {
      get: async ({ sessionID }) => {
        if (!sessions.has(sessionID)) throw Object.assign(new Error("session not found"), { _tag: "SessionNotFoundError" })
        return copy(sessions.get(sessionID))
      },
      update: async ({ sessionID, metadata }) => { if (options.beforeUpdate) await options.beforeUpdate(sessionID, metadata); sessions.get(sessionID).metadata = copy(metadata) },
      synthetic: async (input) => { if (options.reject?.(input)) throw new Error("admission failed"); messages.push(copy(input)); options.onAdmission?.(input) },
      list: async ({ parentID }) => ({ data: [...sessions.values()].filter(s => s.parentID === parentID) }),
      remove: async ({ sessionID }) => {
        if (options.removeReject) throw new Error("deletion failed")
        const remove = (id) => { for (const s of [...sessions.values()]) if (s.parentID === id) remove(s.id); sessions.delete(id) }
        remove(sessionID)
      },
      compact: async () => {},
      hook: async (name, fn) => { hooks.set(name, fn) },
    },
    command: { transform: async (fn) => fn({ add: (c) => commands.set(c.name, c) }) },
    tool: { transform: async (fn) => fn({ add: (t) => tools.set(t.name, t) }) },
    plugin: { list: async () => [] },
    event: { subscribe: async function* ({ signal }) {
      while (!signal.aborted) {
        if (events.length) { yield events.shift(); continue }
        await new Promise(resolve => { consumer = resolve; signal.addEventListener("abort", resolve, { once: true }) })
      }
    } },
  }
  const add = (id, parentID, directory = "/project") => sessions.set(id, { id, title: id, parentID, location: { directory }, metadata: {} })
  for (const id of ["a", "b", "w", "x", "outside"]) add(id)
  const stop = await plugin.setup(ctx)
  const call = async (id, input) => (await tools.get("capy_lead").execute(input, { sessionID: id })).output
  const command = (id, name, text = "") => commands.get(name).execute({ sessionID: id, prompt: { text } })
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)) }
  const emit = async (type, sessionID, extra = {}) => { events.push({ type, data: { sessionID, ...extra } }); consumer?.(); await settle() }
  return { call, command, stop, hooks, data, sessions, messages, add, emit, settle, intervals, options, errors }
}

test("context hooks work for ordinary sessions and two independent leads", { timeout: 1500 }, async () => {
  const f = await fixture()
  try {
    const ordinary = { sessionID: "outside", system: [] }
    await f.hooks.get("context")(ordinary)
    assert.equal(ordinary.system.length, 0)
    await f.command("a", "capy-lead-init", "persona A")
    await f.command("b", "capy-lead-init", "persona B")
    for (const id of ["a", "b"]) {
      const event = { sessionID: id, system: [] }
      await f.hooks.get("context")(event)
      assert.match(event.system[0].text, /PM Contract/)
      assert.match(event.system[0].text, id === "a" ? /persona A/ : /persona B/)
    }
  } finally { f.stop() }
})

test("explicit positions route reports to their own lead; temporary children stay unregistered", async () => {
  const f = await fixture()
  try {
    await f.command("a", "capy-lead-init")
    await f.command("b", "capy-lead-init")
    assert.equal((await f.call("a", { action: "add", sessionID: "w", role: "researcher" })).ok, true)
    assert.equal((await f.call("b", { action: "add", sessionID: "w", role: "hijack" })).ok, false)
    assert.equal((await f.call("b", { action: "add", sessionID: "a" })).ok, false)
    f.add("temporary", "a")
    await f.emit("session.created", "temporary", { id: "temporary", parentID: "a" })
    assert.equal((await f.call("a", { action: "list" })).workers.length, 1)
    f.messages.length = 0
    await f.call("w", { action: "notify", kind: "done", text: "finished" })
    await f.emit("session.execution.succeeded", "w")
    assert.ok(f.messages.some(m => m.sessionID === "a" && m.resume))
    assert.ok(!f.messages.some(m => m.sessionID === "b"))
  } finally { f.stop() }
})

test("migration survives reload without nested-mutation deadlock or zombie legacy keys", { timeout: 1500 }, async () => {
  const prefix = "capy:/project:"
  const f = await fixture({
    [prefix + "lead"]: { sessionID: "a", persona: "legacy" },
    [prefix + "workers"]: { w: { sessionID: "w", role: "researcher" } },
    [prefix + "waits"]: {},
  })
  try {
    assert.equal((await f.call("a", { action: "list" })).workers.length, 1)
    assert.equal(f.data.has(prefix + "lead"), false)
    assert.equal(f.sessions.get("a").metadata.capyTeam.workers.length, 1)
    const snapshot = Object.fromEntries(f.data)
    f.stop()
    const reloaded = await fixture(snapshot)
    try {
      assert.equal((await reloaded.call("a", { action: "list" })).workers.length, 1)
      assert.equal((await reloaded.call("a", { action: "list" })).lead.persona, "legacy")
      assert.equal(reloaded.sessions.get("a").metadata.capyTeam.workers[0].sessionID, "w")
    } finally { reloaded.stop() }
  } finally { f.stop() }
})

test("destroy protects a different team's nested descendants", async () => {
  const f = await fixture()
  try {
    f.add("w", "a")
    f.add("b", "w")
    await f.command("a", "capy-lead-init")
    await f.command("b", "capy-lead-init")
    await f.call("a", { action: "add", sessionID: "w", role: "position" })
    await f.command("a", "capy-lead-destroy")
    assert.ok(f.sessions.has("b"))
    assert.equal((await f.call("b", { action: "list" })).youAreLead, true)
  } finally { f.stop() }
})

test("a human can list and detach a lost team without attaching to its session", async () => {
  const f = await fixture()
  try {
    await f.command("a", "capy-lead-init")
    await f.command("outside", "capy-team-info")
    assert.match(f.messages.at(-1).text, /a/)
    await f.command("outside", "capy-lead-detach", "a")
    assert.ok(f.sessions.has("a"))
    assert.equal((await f.call("a", { action: "list" })).youAreLead, false)
  } finally { f.stop() }
})

test("re-init preserves a roster and human promotion removes old membership", async () => {
  const f = await fixture()
  try {
    await f.command("a", "capy-lead-init", "first")
    await f.call("a", { action: "add", sessionID: "w", role: "backend" })
    await f.command("a", "capy-lead-init", "second")
    assert.equal((await f.call("a", { action: "list" })).workers.length, 1)
    assert.equal((await f.call("w", { action: "bind" })).ok, false)
    await f.command("w", "capy-lead-init")
    assert.equal((await f.call("a", { action: "list" })).workers.length, 0)
    assert.equal((await f.call("w", { action: "list" })).youAreLead, true)
  } finally { f.stop() }
})

test("deleted lead releases the whole team; a worker cannot edit its persona", async () => {
  const f = await fixture()
  try {
    await f.command("a", "capy-lead-init", "original")
    await f.call("a", { action: "add", sessionID: "w", role: "backend" })
    await assert.rejects(f.command("w", "capy-set-persona", "changed"), /Only/)
    f.sessions.delete("a")
    await f.emit("session.deleted", "a")
    assert.equal((await f.call("w", { action: "notify", kind: "blocked", text: "help" })).ok, false)
    await f.command("b", "capy-lead-init")
    assert.equal((await f.call("b", { action: "add", sessionID: "w" })).ok, true)
  } finally { f.stop() }
})

test("failed notifications release reserved quota; over-quota messages are not delivered", async () => {
  const f = await fixture()
  try {
    await f.command("a", "capy-lead-init")
    await f.call("a", { action: "add", sessionID: "w" })
    f.options.reject = () => true
    for (let i = 0; i < 11; i++) assert.equal((await f.call("w", { action: "notify", text: "failed admission" })).ok, false)
    f.options.reject = undefined
    f.messages.length = 0
    for (let i = 0; i < 10; i++) assert.equal((await f.call("w", { action: "notify", text: "ติดตั้งสำเร็จ", kind: "progress" })).ok, true)
    assert.equal((await f.call("w", { action: "notify", text: "one too many", kind: "blocked" })).ok, false)
    assert.equal(f.messages.length, 10)
    assert.ok(f.messages.every(m => m.resume === false))
  } finally { f.stop() }
})

test("busy and retry workers do not consume due checks; failed wake stays durable", async () => {
  const f = await fixture()
  try {
    await f.command("a", "capy-lead-init")
    await f.call("a", { action: "add", sessionID: "w" })
    await f.call("w", { action: "wait", reason: "download", checkInMinutes: 1, maxChecks: 1 })
    const key = "capy:/project:registry"
    f.data.get(key).teams.a.waits.w.nextCheckAt = 0
    await f.emit("session.status", "w", { status: { type: "retry" } })
    f.intervals[0]()
    await f.settle()
    assert.equal(f.data.get(key).teams.a.waits.w.checkCount, 0)
    await f.emit("session.status", "w", { status: { type: "idle" } })
    f.data.get(key).teams.a.waits.w.nextCheckAt = Date.now() - 1
    f.options.reject = m => m.sessionID === "w"
    f.intervals[0]()
    await f.settle()
    assert.equal(f.data.get(key).teams.a.waits.w.status, "waiting")
    assert.equal(f.data.get(key).teams.a.waits.w.checkCount, 0)
    f.options.reject = undefined
    f.data.get(key).teams.a.waits.w.nextCheckAt = Date.now() - 1
    f.intervals[0]()
    await f.settle()
    assert.equal(f.data.get(key).teams.a.waits.w.checkCount, 1)
    await f.emit("session.status", "w", { status: { type: "busy" } })
    f.intervals[0]()
    await f.settle()
    assert.equal(f.data.get(key).teams.a.waits.w.status, "woken")
  } finally { f.stop() }
})

test("empty versioned registry wins over old legacy keys (no zombie migration)", async () => {
  const f = await fixture({ "capy:/project:registry": { version: 1, teams: {} }, "capy:/project:lead": { sessionID: "a" } })
  try { assert.equal((await f.call("a", { action: "list" })).youAreLead, false) }
  finally { f.stop() }
})

test("concurrent init preserves independent teams; configured caps can exceed sixteen", async () => {
  const f = await fixture({}, { config: { maxTeams: 100, maxWorkers: 100 } })
  try {
    const ids = Array.from({ length: 20 }, (_, i) => `lead-${i}`)
    for (const id of ids) f.add(id)
    await Promise.all(ids.map(id => f.command(id, "capy-lead-init")))
    assert.equal((await f.call("outside", { action: "list" })).teams.length, 20)
  } finally { f.stop() }
})

test("failed budget escalation retains its record and retries without granting a fresh budget", async () => {
  const f = await fixture()
  try {
    await f.command("a", "capy-lead-init")
    await f.call("a", { action: "add", sessionID: "w" })
    await f.call("w", { action: "wait", reason: "pending", checkInMinutes: 1, maxChecks: 1 })
    const waits = () => f.data.get("capy:/project:registry").teams.a.waits
    waits().w.checkCount = 1
    f.options.reject = m => m.sessionID === "a"
    f.intervals[0]()
    await f.settle()
    assert.equal(waits().w.status, "decision")
    assert.equal(waits().w.notified, false)
    assert.equal((await f.call("w", { action: "wait", reason: "new reason", checkInMinutes: 1 })).ok, false)
    await f.settle()
    f.options.reject = undefined
    f.messages.length = 0
    f.intervals[0]()
    await f.settle()
    assert.equal(waits().w.notified, true)
    assert.equal(f.messages.filter(m => m.sessionID === "a").length, 1)
    f.intervals[0]()
    await f.settle()
    assert.equal(f.messages.filter(m => m.sessionID === "a").length, 1)
  } finally { f.stop() }
})

test("safe destroy releases membership and waits without deleting any sessions", async () => {
  const f = await fixture({}, { removeReject: true })
  try {
    await f.command("a", "capy-lead-init", "keep persona")
    await f.call("a", { action: "add", sessionID: "w" })
    await f.call("w", { action: "wait", reason: "pending", checkInMinutes: 1 })
    await f.command("a", "capy-lead-destroy")
    const result = await f.call("a", { action: "list" })
    assert.equal(result.youAreLead, false)
    assert.ok(f.sessions.has("a"))
    assert.ok(f.sessions.has("w"))
    assert.equal(f.sessions.get("a").metadata.capyTeam, undefined)
  } finally { f.stop() }
})

test("unregistered children survive destroy; removed worker is not swept back into targets", async () => {
  const f = await fixture()
  try {
    f.add("w", "a")
    await f.command("a", "capy-lead-init")
    await f.call("a", { action: "add", sessionID: "w" })
    await f.call("a", { action: "remove", sessionID: "w" })
    await f.command("a", "capy-lead-destroy")
    assert.ok(f.sessions.has("w"))
    assert.equal((await f.call("a", { action: "list" })).youAreLead, false)
  } finally { f.stop() }
})

test("moved lead and workers are never woken by their previous project", async () => {
  const f = await fixture()
  try {
    await f.command("a", "capy-lead-init")
    await f.call("a", { action: "add", sessionID: "w" })
    f.sessions.get("w").location.directory = "/elsewhere"
    f.messages.length = 0
    await f.emit("session.execution.succeeded", "w")
    assert.equal(f.messages.length, 0)
    f.sessions.get("a").location.directory = "/elsewhere"
    const event = { sessionID: "a", system: [] }
    await f.hooks.get("context")(event)
    assert.equal(event.system.length, 0)
  } finally { f.stop() }
})

test("interrupted old destroy state is recoverable with non-destructive detach", async () => {
  const f = await fixture({ "capy:/project:registry": { version: 1, teams: { a: { sessionID: "a", generation: "old", status: "destroying", workers: {}, waits: {} } } } })
  try {
    await f.command("outside", "capy-lead-detach", "a")
    assert.ok(f.sessions.has("a"))
    assert.equal((await f.call("a", { action: "list" })).youAreLead, false)
  } finally { f.stop() }
})

test("a quickly re-registering worker inherits its admitted check count", async () => {
  const f = await fixture()
  try {
    await f.command("a", "capy-lead-init")
    await f.call("a", { action: "add", sessionID: "w" })
    await f.call("w", { action: "wait", reason: "download", checkInMinutes: 1 })
    f.data.get("capy:/project:registry").teams.a.waits.w.nextCheckAt = Date.now() - 1
    let registration
    f.options.onAdmission = m => { if (m.sessionID === "w") registration = f.call("w", { action: "wait", reason: "still downloading", checkInMinutes: 5 }) }
    f.intervals[0]()
    await f.settle()
    await registration
    assert.equal(f.data.get("capy:/project:registry").teams.a.waits.w.checkCount, 1)
    assert.equal(f.data.get("capy:/project:registry").teams.a.waits.w.reason, "still downloading")
  } finally { f.stop() }
})

test("an old stamp cannot finish after detach and resurrect a canonical team", async () => {
  const f = await fixture()
  try {
    await f.command("a", "capy-lead-init")
    let release
    let entered
    const ready = new Promise(resolve => { entered = resolve })
    f.options.beforeUpdate = async () => { f.options.beforeUpdate = undefined; entered(); await new Promise(resolve => { release = resolve }) }
    const adding = f.call("a", { action: "add", sessionID: "w" })
    await ready
    const detaching = f.command("outside", "capy-lead-detach", "a")
    release()
    await Promise.all([adding, detaching])
    assert.equal(f.sessions.get("a").metadata.capyTeam, undefined)
    assert.equal((await f.call("a", { action: "list" })).youAreLead, false)
  } finally { f.stop() }
})

test("stamp failure does not block outcome delivery to the lead", async () => {
  const f = await fixture()
  try {
    await f.command("a", "capy-lead-init")
    await f.call("a", { action: "add", sessionID: "w" })
    // Worker reports first so the round is "reported" and the outcome
    // notification (not the idle gate) fires on completion.
    await f.call("w", { action: "notify", kind: "done", text: "finished" })
    f.messages.length = 0
    f.options.beforeUpdate = async () => { throw new Error("metadata temporarily unavailable") }
    await f.emit("session.execution.succeeded", "w")
    assert.ok(f.messages.some(m => m.sessionID === "a" && m.resume === true), "lead must receive outcome even when stamp fails")
  } finally { f.stop() }
})

test("idle gate escalation retries when send fails; latch only on success", async () => {
  const f = await fixture()
  try {
    await f.command("a", "capy-lead-init")
    await f.call("a", { action: "add", sessionID: "w" })
    // Round 1: silent -> gets ping
    await f.emit("session.execution.succeeded", "w")
    assert.ok(f.messages.some(m => m.sessionID === "w" && m.text.includes("notify")))
    // Round 2: silent again, but send to lead FAILS
    f.messages.length = 0
    f.options.reject = m => m.sessionID === "a"
    await f.emit("session.execution.succeeded", "w")
    assert.equal(f.messages.filter(m => m.sessionID === "a").length, 0, "send should fail")
    // Round 3: send works again -> escalation must retry
    f.options.reject = undefined
    f.messages.length = 0
    await f.emit("session.execution.succeeded", "w")
    assert.ok(f.messages.some(m => m.sessionID === "a" && m.text.includes("reminder")),
      "escalation must retry after failed send")
  } finally { f.stop() }
})

test("reload resets stale busy flag so due waits can proceed", async () => {
  const f = await fixture()
  try {
    await f.command("a", "capy-lead-init")
    await f.call("a", { action: "add", sessionID: "w" })
    await f.call("w", { action: "wait", reason: "download", checkInMinutes: 1 })
    // Simulate: worker was busy when plugin process died
    const reg = f.data.get("capy:/project:registry")
    reg.teams.a.workers.w.busy = true
    reg.teams.a.waits.w.nextCheckAt = Date.now() - 1
    f.stop()
    // Reload with same storage
    const reloaded = await fixture(Object.fromEntries(f.data))
    try {
      reloaded.intervals[0]()
      await reloaded.settle()
      const after = reloaded.data.get("capy:/project:registry")
      assert.equal(after.teams.a.workers.w.busy, false, "stale busy must reset on reload")
      assert.ok(after.teams.a.waits.w.checkCount >= 1 || after.teams.a.waits.w.status !== "waiting",
        "due wait must proceed after busy reset")
    } finally { reloaded.stop() }
  } finally { f.stop() }
})

test("moved lead's canonical stamp is cleared on reconcile", async () => {
  const f = await fixture()
  try {
    await f.command("a", "capy-lead-init")
    await f.call("a", { action: "add", sessionID: "w" })
    assert.ok(f.sessions.get("a").metadata.capyTeam, "stamp exists before move")
    // Move lead to another directory
    f.sessions.get("a").location.directory = "/elsewhere"
    f.intervals[0]() // trigger heal via tick
    await f.settle()
    const reg = f.data.get("capy:/project:registry")
    assert.equal(reg.teams.a, undefined, "team must be removed from registry")
    assert.equal(f.sessions.get("a").metadata.capyTeam, undefined, "stamp must be cleared even for moved session")
  } finally { f.stop() }
})
