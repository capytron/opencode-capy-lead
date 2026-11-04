import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs"
import { join } from "node:path"

// End-to-end install coverage against the REAL opencode installer in an
// isolated XDG sandbox: the actual `opencode plugin add` flow (git clone +
// dependency preparation + config write). This is the layer that catches the
// install-breaking class the unit suite cannot see: runtime dependency trees
// (v0.6.0, 273 packages/186MB) and lifecycle-named scripts triggering npm
// inside the clone (v0.6.2).
//
// Known sandbox limitation (documented, upstream CLI behavior): `plugin
// list/check/update` resolve through the ELECTED background service and its
// config view, so XDG redirection cannot isolate them — update flows are
// verified on real machines instead, and the config-form quirk is asserted
// here only as its documented failure mode.
//
// Requires the `opencode` binary and network access to github.com; skips
// with a message otherwise. Never touches the machine's real config, data,
// or cache.

const SPEC = "capytron/opencode-capy-lead"
const root = join("/tmp/opencode", `e2e-${process.pid}`)
const env = {
  ...process.env,
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_DATA_HOME: join(root, "data"),
  XDG_CACHE_HOME: join(root, "cache"),
}
const proj = join(root, "proj")
const configFile = join(root, "config", "opencode", "opencode.json")

const run = (args) => spawnSync("opencode", args, {
  cwd: proj, env, encoding: "utf8", timeout: 300_000, maxBuffer: 32 * 1024 * 1024,
})

test("install flow: add installs lean, quirk documented, remove cleans", { timeout: 600_000 }, async t => {
  if (spawnSync("opencode", ["--version"], { encoding: "utf8" }).status !== 0) return t.skip("opencode CLI not available")
  mkdirSync(join(root, "config", "opencode"), { recursive: true })
  mkdirSync(proj, { recursive: true })
  try {
    // 1. The real installer flow from GitHub — this is the path that broke
    //    twice (heavy dependency tree, then lifecycle-script preparation).
    const add = run(["plugin", "add", SPEC])
    if (add.status !== 0) {
      const out = `${add.stdout}\n${add.stderr}`
      if (/ENOTFOUND|ETIMEDOUT|ECONNREFUSED|offline|network|dial tcp|getaddrinfo/i.test(out)) return t.skip(`no network: ${out.slice(0, 120)}`)
      assert.fail(`plugin add failed:\n${out.slice(0, 2000)}`)
    }
    const config = JSON.parse(readFileSync(configFile, "utf8"))
    assert.ok(config.plugins.includes(SPEC), "config holds the shorthand spec")

    // 2. Ship-gate invariants checked against BOTH the working tree and the
    //    copy the installer actually fetched (they can differ by revision).
    const checkInvariants = (pkg, label) => {
      assert.equal(pkg.dependencies, undefined, `${label}: no runtime dependencies`)
      assert.equal(pkg.workspaces, undefined, `${label}: workspaces trigger git-dep preparation`)
      for (const name of ["postinstall", "build", "preinstall", "install", "prepack", "prepare"]) {
        assert.equal(pkg.scripts?.[name], undefined, `${label}: scripts.${name} must not exist (git-dep preparation trigger)`)
      }
    }
    checkInvariants(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")), "working tree")
    const npmCache = join(root, "cache", "opencode", "npm")
    const staged = readdirSync(npmCache, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("git-opencode-capy-lead"))
      .flatMap((entry) => readdirSync(join(npmCache, entry.name), { withFileTypes: true })
        .filter((inner) => inner.isDirectory())
        .map((inner) => join(npmCache, entry.name, inner.name)))
    assert.ok(staged.length >= 1, "installer staged a copy of the plugin")
    for (const dir of staged) {
      // The staging root is the installer's own manifest (it declares the
      // plugin as a git dependency); the plugin itself lands in node_modules.
      const installed = join(dir, "node_modules", "opencode-capy-lead")
      assert.ok(existsSync(join(installed, "package.json")), `plugin installed at ${dir.slice(-24)}`)
      checkInvariants(JSON.parse(readFileSync(join(installed, "package.json"), "utf8")), `installed ${dir.slice(-24)}`)
      const tree = readdirSync(join(dir, "node_modules")).filter((name) => !name.startsWith("."))
      assert.deepEqual(tree, ["opencode-capy-lead"], `lean install: node_modules holds only the plugin, found [${tree.join(", ")}]`)
    }

    // 3. The documented config-form quirk: when the config holds a different
    //    form than the string passed to update, the CLI reports "Plugin is
    //    not configured". Teammates copy commands from the README, so this
    //    failure mode is locked here and the README troubleshoots it.
    writeFileSync(configFile, JSON.stringify({ plugins: [`github:${SPEC}`] }, null, 2))
    const mismatch = run(["plugin", "update", SPEC])
    assert.notEqual(mismatch.status, 0, "mismatched spec must fail (documents the CLI behavior the README troubleshoots)")
    assert.match(`${mismatch.stdout}\n${mismatch.stderr}`, /not configured/)

    // 4. Remove cleans the configured entry.
    const remove = run(["plugin", "remove", `github:${SPEC}`])
    assert.equal(remove.status, 0, `remove failed:\n${(remove.stdout + remove.stderr).slice(0, 500)}`)
    assert.deepEqual(JSON.parse(readFileSync(configFile, "utf8")).plugins, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
