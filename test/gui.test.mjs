import { test } from "node:test"
import assert from "node:assert/strict"
import { createTeamSource, teamsIn, membership, teamRows } from "../src/gui/team.mjs"

const info = (id, stamp, directory = "/project") => ({ id, location: { directory }, metadata: stamp ? { capyTeam: stamp } : {} })
const stamp = { leadID: "lead", workers: [{ sessionID: "worker", role: "Builder", lastOutcome: "succeeded", waiting: "review" }] }

test("GUI ignores inherited stamps, unrelated sessions, duplicate positions and moved workers", () => {
  const sessions = [info("lead", { ...stamp, workers: [...stamp.workers, ...stamp.workers, { sessionID: "moved", role: "Moved" }] }), info("worker", stamp), info("other"), info("moved", undefined, "/elsewhere")]
  const teams = teamsIn(sessions, "/project")
  assert.equal(teams.length, 1)
  assert.equal(teams[0].workers.length, 1)
  assert.equal(membership(teams, "worker").role, "worker")
  assert.equal(membership(teams, "other"), undefined)
  assert.equal(membership(teams, "moved"), undefined)
  assert.equal(membership(teamsIn(sessions.slice(1), "/project"), "worker"), undefined)
})

test("GUI isolates multiple teams and computes live status without inferring child membership", () => {
  const teams = teamsIn([info("lead", stamp), info("worker"), info("b", { leadID: "b", workers: [] }), info("child")], "/project")
  assert.equal(membership(teams, "b").team.workers.length, 0)
  assert.equal(membership(teams, "child"), undefined)
  const rows = teamRows(membership(teams, "lead").team, id => id === "worker" ? "running" : "idle")
  assert.equal(rows[1].running, true)
  assert.equal(rows[1].waiting, "review")
})

test("GUI snapshot reads every page atomically", async () => {
  const calls = [], published = []
  const source = createTeamSource(() => ({ session: { list: async (input) => {
    calls.push(input)
    return input.cursor ? { data: [info("worker")], cursor: {} } : { data: [info("lead", stamp)], cursor: { next: "page2" } }
  } } }), "/project", value => published.push(value), assert.fail)
  await source.refresh()
  assert.equal(calls[1].cursor, "page2")
  assert.equal(published.length, 1)
  assert.equal(published[0].length, 2)
  source.dispose()
})

test("disposed GUI scopes never publish stale results or errors", async () => {
  let resolve
  const published = [], errors = []
  const source = createTeamSource(() => ({ session: { list: () => new Promise(done => { resolve = done }) } }), "/project", value => published.push(value), error => errors.push(error))
  const pending = source.refresh()
  source.dispose()
  resolve({ data: [info("lead", stamp)], cursor: {} })
  await pending
  assert.deepEqual(published, [])
  assert.deepEqual(errors, [])
})

test("snapshot failure is surfaced and cannot publish a partial roster", async () => {
  const published = [], errors = []
  const source = createTeamSource(() => ({ session: { list: async (input) => {
    if (input.cursor) throw new Error("offline")
    return { data: [info("lead", stamp)], cursor: { next: "page2" } }
  } } }), "/project", value => published.push(value), error => errors.push(error))
  await source.refresh()
  assert.deepEqual(published, [])
  assert.equal(errors.length, 1)
  source.dispose()
})

test("team naming uses the stamp name, stable fallbacks, and activity-first order", () => {
  const info = (id, title, stamp, time) => ({ id, title, location: { directory: "/project" }, ...(stamp ? { metadata: { capyTeam: stamp } } : {}), time })
  const teams = teamsIn([
    info("old", undefined, { leadID: "old", workers: [] }, { created: 1, updated: 100 }),
    info("named", "some tab title", { leadID: "named", name: "Atlas", workers: [] }, { created: 2, updated: 5 }),
    info("titled", "การตรวจสอบระบบหลังบ้าน", { leadID: "titled", workers: [] }, { created: 3, updated: 50 }),
    info("empty", undefined, { leadID: "empty", workers: [] }, { created: 4, updated: 10 }),
  ], "/project")
  assert.deepEqual(teams.map((team) => [team.lead.id, team.name]), [
    ["old", "Team 1"],
    ["titled", "การตรวจสอบระบ…"],
    ["empty", "Team 4"],
    ["named", "Atlas"],
  ], "most recently active first; fallback numbering follows creation order")
})
