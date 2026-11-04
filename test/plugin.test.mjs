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
  const files = new Map(Object.entries(options.files ?? {}))
  let consumer
  const copy = (v) => v === undefined ? undefined : structuredClone(v)
  const context = vm.createContext({
    console: { ...console, error: (...args) => errors.push(args) }, AbortController, structuredClone, randomUUID: () => String(Math.random()),
    process: { env: { ...(options.env ?? {}) } },
    homedir: () => "/home/tester",
    join: (...parts) => parts.join("/").replace(/\/{2,}/g, "/"),
    readFile: async (path) => {
      if (files.has(path)) return files.get(path)
      if (path.endsWith("config.json") && options.config) return JSON.stringify(options.config)
      throw Object.assign(new Error("not found"), { code: "ENOENT" })
    },
    mkdir: async () => {}, writeFile: async (path, content) => { files.set(path, content) },
    rename: async (from, to) => { files.set(to, files.get(from) ?? ""); files.delete(from) },
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
  return { call, command, stop, hooks, data, sessions, messages, add, emit, settle, intervals, options, errors, files }
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
    assert.ok(f.messages.some(m => m.sessionID === "a"))
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
    assert.equal((await f.call("b", { action: "add", sessionID: "w", role: "w1" })).ok, true)
  } finally { f.stop() }
})

test("failed notifications release reserved quota; over-quota messages are not delivered", async () => {
  const f = await fixture()
  try {
    await f.command("a", "capy-lead-init")
    await f.call("a", { action: "add", sessionID: "w", role: "w1" })
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
    await f.call("a", { action: "add", sessionID: "w", role: "w1" })
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
    await f.call("a", { action: "add", sessionID: "w", role: "w1" })
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
    await f.call("a", { action: "add", sessionID: "w", role: "w1" })
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
    await f.call("a", { action: "add", sessionID: "w", role: "w1" })
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
    await f.call("a", { action: "add", sessionID: "w", role: "w1" })
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
    await f.call("a", { action: "add", sessionID: "w", role: "w1" })
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
    const adding = f.call("a", { action: "add", sessionID: "w", role: "w1" })
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
    await f.call("a", { action: "add", sessionID: "w", role: "w1" })
    // Worker reports progress (not done) so the outcome notification
    // (not the idle gate) fires on completion even while stamp fails.
    await f.call("w", { action: "notify", kind: "progress", text: "halfway done" })
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
    await f.call("a", { action: "add", sessionID: "w", role: "w1" })
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
    await f.call("a", { action: "add", sessionID: "w", role: "w1" })
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
    await f.call("a", { action: "add", sessionID: "w", role: "w1" })
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

test("done report suppresses the redundant outcome echo", async () => {
  const f = await fixture()
  try {
    await f.command("a", "capy-lead-init")
    await f.call("a", { action: "add", sessionID: "w", role: "w1" })
    await f.call("w", { action: "notify", kind: "done", text: "shipped" })
    f.messages.length = 0
    await f.emit("session.execution.succeeded", "w")
    await f.settle()
    assert.ok(f.messages.every(m => m.sessionID !== "a"), "no outcome echo to the lead after a done report")
    const reg = f.data.get("capy:/project:registry")
    assert.equal(reg.teams.a.workers.w.lastOutcome, "succeeded", "stamp still records the outcome")
  } finally { f.stop() }
})

test("failed execution always reaches the lead, even after a done report", async () => {
  const f = await fixture()
  try {
    await f.command("a", "capy-lead-init")
    await f.call("a", { action: "add", sessionID: "w", role: "w1" })
    await f.call("w", { action: "notify", kind: "done", text: "shipped" })
    f.messages.length = 0
    await f.emit("session.execution.failed", "w", { error: { message: "boom" } })
    assert.ok(f.messages.some(m => m.sessionID === "a" && m.text.includes("AFTER a done report")),
      "failure after done must be delivered and flagged")
  } finally { f.stop() }
})

test("add enforces short teaching roles", async () => {
  const f = await fixture()
  try {
    await f.command("a", "capy-lead-init")
    const long = await f.call("a", { action: "add", sessionID: "w", role: "x".repeat(60) })
    assert.equal(long.ok, false)
    assert.match(long.error, /Role too long/)
    f.add("w2", "a")
    const missing = await f.call("a", { action: "add", sessionID: "w2", role: "   " })
    assert.equal(missing.ok, false)
    assert.match(missing.error, /short role/)
    const ok = await f.call("a", { action: "add", sessionID: "w", role: "backend-eng" })
    assert.equal(ok.ok, true)
    assert.equal(ok.ok, true)
  } finally { f.stop() }
})

test("legacy essay roles display truncated, never break the team", async () => {
  const f = await fixture()
  try {
    await f.command("a", "capy-lead-init")
    const reg = f.data.get("capy:/project:registry")
    reg.teams.a.workers.w = { membershipID: "m1", sessionID: "w", role: "t-0005 ORIGINAL #263 scope only; #227 integration NOT authorized by owner; mapping replay tests read-only", lastActivityAt: Date.now() }
    f.messages.length = 0
    await f.command("a", "capy-team-info")
    const info = f.messages.find(m => m.sessionID === "a")
    assert.ok(info.text.includes("…"), "long role truncated for display")
    assert.ok(!info.text.includes("#227"), "essay tail not shown")
    assert.equal(reg.teams.a.workers.w.role.length > 50, true, "stored role untouched")
  } finally { f.stop() }
})

test("question buried in progress gets a hint, not silence", async () => {
  const f = await fixture()
  try {
    await f.command("a", "capy-lead-init")
    await f.call("a", { action: "add", sessionID: "w", role: "w1" })
    const res = await f.call("w", { action: "notify", kind: "progress", text: "Found 2 edge cases. Patch now or log only?" })
    assert.equal(res.ok, true)
    assert.match(res.hint, /kind=question/)
    assert.ok(f.messages.some(m => m.sessionID === "a" && m.text.startsWith("[capy:progress]")), "progress still delivered compactly")
  } finally { f.stop() }
})

test("team naming: lead renames itself; owner command overrides; stamp and info carry the name", async () => {
  const f = await fixture()
  try {
    await f.command("a", "capy-lead-init")
    await f.call("a", { action: "add", sessionID: "w", role: "w1" })
    const tooLong = await f.call("a", { action: "rename", name: "x".repeat(30) })
    assert.equal(tooLong.ok, false)
    assert.match(tooLong.error, /24/)
    const named = await f.call("a", { action: "rename", name: "Atlas" })
    assert.equal(named.ok, true)
    assert.equal(f.sessions.get("a").metadata.capyTeam.name, "Atlas")
    const worker = await f.call("w", { action: "rename", name: "Hijack" })
    assert.equal(worker.ok, false)
    await f.command("a", "capy-team-name", "Beacon")
    assert.equal(f.sessions.get("a").metadata.capyTeam.name, "Beacon")
    f.messages.length = 0
    await f.command("a", "capy-team-info")
    assert.ok(f.messages.some(m => m.sessionID === "a" && m.text.includes("Beacon — Lead a")), "team info leads with the team name")
  } finally { f.stop() }
})

test("onboarding teaches the lead to name its team", async () => {
  const f = await fixture()
  try {
    const messages = await f.command("a", "capy-lead-init")
    assert.ok(f.messages.some(m => m.sessionID === "a" && m.text.includes("capy_lead rename")), "naming instruction present")
  } finally { f.stop() }
})

test("notify rejects over-long text with a teaching error instead of silent truncation", async () => {
  const f = await fixture()
  try {
    await f.command("a", "capy-lead-init")
    await f.call("a", { action: "add", sessionID: "w", role: "w1" })
    const longDone = await f.call("w", { action: "notify", kind: "done", text: "y".repeat(401) })
    assert.equal(longDone.ok, false)
    assert.match(longDone.error, /401\/400/)
    assert.match(longDone.error, /file/)
    const longProgress = await f.call("w", { action: "notify", kind: "progress", text: "p".repeat(201) })
    assert.equal(longProgress.ok, false)
    assert.match(longProgress.error, /201\/200/)
    const ok = await f.call("w", { action: "notify", kind: "done", text: "shipped; details in .capy/tickets/t-1.md" })
    assert.equal(ok.ok, true)
  } finally { f.stop() }
})

test("a woken wait is owned by its timer: no premature decision, no gate ping", async () => {
  const f = await fixture()
  try {
    await f.command("a", "capy-lead-init")
    await f.call("a", { action: "add", sessionID: "w", role: "w1" })
    // Budget fully spent, worker just woken by the last check.
    const reg = f.data.get("capy:/project:registry")
    reg.teams.a.waits.w = { sessionID: "w", role: "w1", reason: "download", nextCheckAt: Date.now() + 60000, revision: "r1", maxChecks: 1, checkCount: 1, status: "woken", admittedAt: Date.now() }
    f.messages.length = 0
    await f.emit("session.execution.succeeded", "b")
    assert.ok(!f.messages.some(m => m.sessionID === "a" && m.text.includes("[capy:decision]")), "no premature decision while woken")
    f.messages.length = 0
    // The woken worker ending silently must not be gate-pinged either.
    await f.emit("session.execution.succeeded", "w")
    assert.ok(!f.messages.some(m => m.sessionID === "w"), "no gate ping while the wait owns the worker")
    assert.ok(!f.messages.some(m => m.sessionID === "a" && m.text.includes("[capy:decision]")), "decision still waits for the timer")
  } finally { f.stop() }
})

test("failed gate ping retries instead of escalating to the lead", async () => {
  const f = await fixture()
  try {
    await f.command("a", "capy-lead-init")
    await f.call("a", { action: "add", sessionID: "w", role: "w1" })
    f.options.reject = m => m.sessionID === "w"
    await f.emit("session.execution.succeeded", "w")
    assert.equal(f.messages.filter(m => m.sessionID === "w").length, 0, "ping send failed")
    f.options.reject = undefined
    f.messages.length = 0
    await f.emit("session.execution.succeeded", "w")
    assert.ok(f.messages.some(m => m.sessionID === "w" && m.text.includes("[capy:gate]")), "ping must retry on the next silent round")
    assert.ok(!f.messages.some(m => m.sessionID === "a" && m.text.includes("[capy:escalate]")), "must not skip to escalation")
  } finally { f.stop() }
})

test("wait retries against an exhausted budget never re-alert the lead", async () => {
  const f = await fixture()
  try {
    await f.command("a", "capy-lead-init")
    await f.call("a", { action: "add", sessionID: "w", role: "w1" })
    const reg = f.data.get("capy:/project:registry")
    reg.teams.a.waits.w = { sessionID: "w", role: "w1", reason: "job", nextCheckAt: Date.now(), revision: "r1", maxChecks: 1, checkCount: 1, status: "waiting", notified: true }
    f.intervals[0]()
    await f.settle()
    const decisions = () => f.messages.filter(m => m.sessionID === "a" && m.text.includes("[capy:decision]")).length
    f.messages.length = 0
    await f.call("w", { action: "wait", reason: "retry", checkInMinutes: 5 })
    await f.call("w", { action: "wait", reason: "retry again", checkInMinutes: 5 })
    await f.call("w", { action: "wait", reason: "retry three", checkInMinutes: 5 })
    assert.equal(decisions(), 1, "lead alerted exactly once for the exhausted budget")
  } finally { f.stop() }
})

test("question and blocked reports suppress the outcome echo", async () => {
  const f = await fixture()
  try {
    await f.command("a", "capy-lead-init")
    await f.call("a", { action: "add", sessionID: "w", role: "w1" })
    await f.call("w", { action: "notify", kind: "question", text: "patch now or log only?" })
    f.messages.length = 0
    await f.emit("session.execution.succeeded", "w")
    assert.ok(f.messages.every(m => !m.text.includes("execution succeeded")), "no outcome echo after a question")
    assert.ok(f.messages.every(m => !m.text.includes("[capy:outcome]")), "no outcome message at all")
  } finally { f.stop() }
})

test("re-adding a position authorizes a fresh check budget as documented", async () => {
  const f = await fixture()
  try {
    await f.command("a", "capy-lead-init")
    await f.call("a", { action: "add", sessionID: "w", role: "w1" })
    const reg = f.data.get("capy:/project:registry")
    reg.teams.a.waits.w = { sessionID: "w", role: "w1", reason: "job", nextCheckAt: Date.now(), revision: "r1", maxChecks: 1, checkCount: 1, status: "decision", notified: true }
    const blocked = await f.call("w", { action: "wait", reason: "again", checkInMinutes: 5 })
    assert.equal(blocked.ok, false)
    assert.match(blocked.error, /Budget exhausted/)
    assert.equal((await f.call("a", { action: "add", sessionID: "w", role: "w1" })).ok, true)
    const fresh = await f.call("w", { action: "wait", reason: "fresh budget", checkInMinutes: 5 })
    assert.equal(fresh.ok, true, "re-add resets the wait budget")
    const after = f.data.get("capy:/project:registry")
    assert.notEqual(after.teams.a.workers.w.membershipID, "m-old", "membership id rotates on re-add")
  } finally { f.stop() }
})

test("overflow recovery: leads are excluded; a crash-looping worker escalates to the lead once", async () => {
  const f = await fixture()
  try {
    await f.command("a", "capy-lead-init")
    await f.call("a", { action: "add", sessionID: "w", role: "w1" })
    const overflow = { error: { message: "context window exceeded" } }
    f.messages.length = 0
    await f.emit("session.execution.failed", "a", overflow)
    assert.equal(f.messages.length, 0, "leads never enter the recovery loop")
    await f.emit("session.execution.failed", "w", overflow)
    await f.emit("session.execution.failed", "w", overflow)
    assert.equal(f.messages.filter(m => m.sessionID === "w" && m.text.includes("[capy:recovery]")).length, 2, "two worker recoveries")
    f.messages.length = 0
    await f.emit("session.execution.failed", "w", overflow)
    assert.equal(f.messages.filter(m => m.sessionID === "a" && m.text.includes("keeps overflowing")).length, 1, "lead alerted once about the crash-loop")
    await f.emit("session.execution.failed", "w", overflow)
    assert.equal(f.messages.filter(m => m.sessionID === "a" && m.text.includes("keeps overflowing")).length, 1, "no repeat alerts within the hour")
    assert.equal(f.messages.filter(m => m.sessionID === "w").length, 0, "no more direct resumes")
  } finally { f.stop() }
})

test("deleting a dependency releases its waiters immediately", async () => {
  const f = await fixture()
  try {
    await f.command("a", "capy-lead-init")
    await f.call("a", { action: "add", sessionID: "w", role: "w1" })
    f.add("dep")
    await f.call("w", { action: "wait", reason: "waiting on dep", checkInMinutes: 60, waitForSessionId: "dep" })
    await f.emit("session.deleted", "dep")
    const wait = f.data.get("capy:/project:registry").teams.a.waits.w
    assert.ok(wait.nextCheckAt <= Date.now(), "waiter released for the next tick")
  } finally { f.stop() }
})

test("URLs with query strings do not trigger the question hint", async () => {
  const f = await fixture()
  try {
    await f.command("a", "capy-lead-init")
    await f.call("a", { action: "add", sessionID: "w", role: "w1" })
    const res = await f.call("w", { action: "notify", kind: "progress", text: "Checked https://example.com/api?page=1 — 200 OK" })
    assert.equal(res.ok, true)
    assert.equal(res.hint, undefined, "URL question mark is not a question")
  } finally { f.stop() }
})

test("notify quota is refreshed when a position is removed and re-added", async () => {
  const f = await fixture()
  try {
    await f.command("a", "capy-lead-init")
    await f.call("a", { action: "add", sessionID: "w", role: "w1" })
    for (let i = 0; i < 10; i++) await f.call("w", { action: "notify", kind: "progress", text: `update ${i}` })
    const over = await f.call("w", { action: "notify", kind: "progress", text: "one too many" })
    assert.equal(over.ok, false)
    assert.match(over.error, /limit/i)
    assert.equal((await f.call("a", { action: "remove", sessionID: "w" })).ok, true)
    await f.call("a", { action: "add", sessionID: "w", role: "w1" })
    const fresh = await f.call("w", { action: "notify", kind: "progress", text: "back with a fresh quota" })
    assert.equal(fresh.ok, true)
  } finally { f.stop() }
})

test("the plugin installs its autonomy section into the global AGENTS.md", async () => {
  const f = await fixture()
  try {
    const written = f.files.get("/home/tester/.config/opencode/AGENTS.md")
    assert.ok(written, "global file written")
    assert.match(written, /capy-lead:autonomy v1/)
    assert.match(written, /reporting a finding is never a valid final action/)
    assert.match(written, /No cloud servers, paid services/)
    assert.equal(f.errors.length, 0)
  } finally { f.stop() }
})

test("an existing global AGENTS.md keeps its own content untouched", async () => {
  const f = await fixture({}, { files: { "/home/tester/.config/opencode/AGENTS.md": "# My own rules\n\nAlways use pnpm.\n" } })
  try {
    const written = f.files.get("/home/tester/.config/opencode/AGENTS.md")
    assert.ok(written.startsWith("# My own rules"), "user content preserved first")
    assert.match(written, /Always use pnpm\./)
    assert.match(written, /capy-lead:autonomy v1/)
  } finally { f.stop() }
})

test("the disabled marker stops management; re-runs never duplicate the section", async () => {
  const f = await fixture({}, { files: { "/home/tester/.config/opencode/AGENTS.md": "# Mine\n\n<!-- capy-lead:autonomy:disabled -->\n" } })
  try {
    assert.equal(f.files.get("/home/tester/.config/opencode/AGENTS.md"), "# Mine\n\n<!-- capy-lead:autonomy:disabled -->\n", "no rewrite when disabled")
  } finally { f.stop() }
  const once = await fixture()
  try {
    const content = once.files.get("/home/tester/.config/opencode/AGENTS.md")
    const again = await fixture({}, { files: { "/home/tester/.config/opencode/AGENTS.md": content } })
    try {
      assert.equal(again.files.get("/home/tester/.config/opencode/AGENTS.md"), content, "idempotent: unchanged content is not rewritten")
    } finally { again.stop() }
  } finally { once.stop() }
})

test("contract v2 defers autonomy to AGENTS.md and keeps team mechanics", async () => {
  const f = await fixture()
  try {
    await f.command("a", "capy-lead-init")
    const event = { sessionID: "a", system: [] }
    await f.hooks.get("context")(event)
    assert.match(event.system[0].text, /Follow the autonomy, scope, permission, and completion rules in AGENTS\.md/)
    assert.match(event.system[0].text, /Gaps you or your workers find .* are unfinished work/)
    assert.match(event.system[0].text, /not promises to begin/)
    assert.doesNotMatch(event.system[0].text, /Ask before dependency/, "the ask-bar lives in AGENTS.md only")
  } finally { f.stop() }
})

test("install migrates away the legacy continuity autonomy block", async () => {
  const legacy = "# Autonomy — work until done\n\nRaw user text from before.\n\n<!-- opencode-plugin-continuity:autonomy begin (managed block — reinstall/update via install.sh) -->\n# Autonomy — work until done\n\nDuplicate from the old plugin.\n<!-- opencode-plugin-continuity:autonomy end -->\n"
  const f = await fixture({}, { files: { "/home/tester/.config/opencode/AGENTS.md": legacy } })
  try {
    const written = f.files.get("/home/tester/.config/opencode/AGENTS.md")
    assert.ok(written.includes("Raw user text from before."), "user content preserved")
    assert.ok(!written.includes("opencode-plugin-continuity"), "legacy block removed")
    assert.ok(!written.includes("Duplicate from the old plugin."), "old duplicate gone")
    assert.equal((written.match(/^<!-- capy-lead:autonomy/gm) || []).length, 1, "exactly one managed section")
    assert.equal(f.errors.length, 0)
  } finally { f.stop() }
})

test("the disabled check ignores its own inline mention; a tampered section still updates", async () => {
  const once = await fixture()
  try {
    const written = once.files.get("/home/tester/.config/opencode/AGENTS.md")
    assert.ok(written.includes("capy-lead:autonomy:disabled"), "footer mentions the marker inline")
    const tampered = written.replace("## Scope discipline", "## Scope discipline\n- TAMPERED STALE LINE")
    const again = await fixture({}, { files: { "/home/tester/.config/opencode/AGENTS.md": tampered } })
    try {
      const fixed = again.files.get("/home/tester/.config/opencode/AGENTS.md")
      assert.ok(fixed, "rewritten despite the inline disabled mention")
      assert.ok(!fixed.includes("TAMPERED STALE LINE"), "stale line inside the section is replaced away")
    } finally { again.stop() }
  } finally { once.stop() }
})

test("half-present managed markers refuse to edit", async () => {
  const f = await fixture({}, { files: { "/home/tester/.config/opencode/AGENTS.md": "# Mine\n\n<!-- capy-lead:autonomy v1 -->\norphan begin only\n" } })
  try {
    assert.equal(f.files.get("/home/tester/.config/opencode/AGENTS.md"), "# Mine\n\n<!-- capy-lead:autonomy v1 -->\norphan begin only\n", "file untouched")
    assert.ok(f.errors.some(args => args.map(String).join(" ").includes("unbalanced")), "error logged")
  } finally { f.stop() }
})

test("CRLF files migrate cleanly", async () => {
  const legacy = "# My rules\r\n\r\n<!-- opencode-plugin-continuity:autonomy begin (managed block — reinstall/update via install.sh) -->\r\nold text\r\n<!-- opencode-plugin-continuity:autonomy end -->\r\n"
  const f = await fixture({}, { files: { "/home/tester/.config/opencode/AGENTS.md": legacy } })
  try {
    const written = f.files.get("/home/tester/.config/opencode/AGENTS.md")
    assert.ok(!written.includes("opencode-plugin-continuity"), "legacy block removed despite CRLF")
    assert.ok(written.includes("# My rules"), "user content kept")
    assert.equal((written.match(/^<!-- capy-lead:autonomy/gm) || []).length, 1)
  } finally { f.stop() }
})

test("near-verbatim legacy autonomy text is stripped; rewritten user rules survive", async () => {
  const legacyCopy = `# Autonomy — work until done

You are a continuous coding agent. Default to finishing: work each task end-to-end without stopping to report, ask, or wait, unless genuinely blocked.

## Keep working
- Do not stop mid-task to ask questions about anything that can be undone. When something is unclear, choose the most reasonable reading, state your assumption in one line, and keep going. The user will redirect you if needed.
- Ask first only before a true one-way door: destructive or hard-to-reverse actions (deleting data, force-pushing, publishing/releasing), or when a required credential is missing. Keep that bar high.
- A permission prompt raised by the harness is a legitimate pause; continue immediately once it resolves.
- After finishing one step, move directly to the next step of the task. Do not write a progress report and wait for an approval that was never requested.
- Ending your reply without a tool call ends your turn. Before ending a turn, check: is any success criterion still unverified, any remaining step you could do right now? If yes, keep working instead of stopping.
- Keep the user informed with brief statements of what you just did and what you are doing next — as part of working, not instead of working.

## Finish before you summarize
- A task is done only when its success criteria are met AND verified: run the checks, confirm real output. Never report assumed results as verified.
- When the main task finishes, put yourself in the user's shoes: what would they ask next? Fix what your change broke, tie off loose ends you created, and finish obvious same-scope follow-ups before stopping.
- Give the full report once, when the work is finished — following the project's own reporting rules if it defines any.

## Scope discipline
- Complete the task fully — don't gold-plate, but don't leave it half-done.
- Do not expand scope beyond what was asked. Collect follow-up ideas and mention them in the final summary instead of doing them.`
  const userRules = "## My own autonomy rules\n- Always ask me before merging to main; I like reviewing diffs myself.\n- Deploy only from the release branch after checks pass.\n"
  const f = await fixture({}, { files: { "/home/tester/.config/opencode/AGENTS.md": legacyCopy + "\n\n" + userRules } })
  try {
    const written = f.files.get("/home/tester/.config/opencode/AGENTS.md")
    assert.ok(!written.includes("continuous coding agent"), "verbatim legacy copy removed")
    assert.ok(!written.includes("true one-way door"), "legacy bullets removed")
    assert.ok(written.includes("## My own autonomy rules"), "rewritten user rules survive")
    assert.ok(written.includes("Always ask me before merging"), "user's own wording kept")
    assert.equal((written.match(/^<!-- capy-lead:autonomy/gm) || []).length, 1)
    assert.equal(f.errors.length, 0)
  } finally { f.stop() }
})
