import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFile } from "node:fs/promises"

// The core entrypoints (index.ts, tui.ts) are untyped and excluded from the
// strict tsconfig gate — which twice let an undeclared identifier ship
// (readLead in the pre-rewrite incident, `rename` in v0.8.1: the VM test
// harness strips import lines and injects mocks, so missing bindings stay
// green until they crash on a real machine).
//
// This gate compiles the core with relaxed type rules so shape-inference
// noise cannot fail it, and fails ONLY on undeclared-name errors — the exact
// class that bit us. If the core ever gets fully typed and joins tsconfig,
// delete this test.

const UNDECLARED = /error TS(2304|2552|2553|2580):/ // Cannot find name / nonexistent property / etc.

test("core entrypoints have no undeclared identifiers (rename/readLead class)", () => {
  const tsc = spawnSync("npx", ["tsc", "--noEmit", "--strict", "false", "--noImplicitAny", "false",
    "--target", "ES2022", "--module", "ESNext", "--moduleResolution", "Bundler", "--skipLibCheck",
    "--types", "node", "index.ts", "tui.ts"], { cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 120_000 })
  const undeclared = tsc.stdout.split("\n").filter((line) => UNDECLARED.test(line))
  assert.deepEqual(undeclared, [], `the core references names that are not imported/declared — these crash at runtime:\n${undeclared.join("\n")}`)
}, { timeout: 180_000 })

test("the VM harness never injects a node builtin the source does not import", async () => {
  const source = await readFile(new URL("../index.ts", import.meta.url), "utf8")
  const imported = new Set()
  for (const match of source.matchAll(/^import\s+\{([^}]+)\}\s+from\s+"node:[^"]+"/gm)) {
    for (const name of match[1].split(",")) if (name.trim()) imported.add(name.trim())
  }
  // Every fs/path/crypto/os identifier the sandbox provides on the host side
  // of test/plugin.test.mjs must be covered by a real import here.
  const provided = ["readFile", "mkdir", "writeFile", "rename", "readdir", "rm", "homedir", "join", "randomUUID"]
  const missing = provided.filter((name) => !imported.has(name))
  assert.deepEqual(missing, [], `harness injects ${missing.join(", ")} but index.ts does not import them — the VM tests would mask a runtime ReferenceError`)
})
