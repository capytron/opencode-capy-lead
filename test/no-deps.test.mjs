import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

// Policy: this plugin installs with ZERO runtime dependencies.
//
// opencode installs GitHub plugins through npm git-dependency preparation:
// every entry in `dependencies` gets installed on the user's machine at
// `opencode plugin update` time. v0.6.0 shipped `@opencode/plugin` there and
// pulled 273 packages (~186MB), failing on restricted networks with
// "NpmInstallFailedError: git dep preparation failed" (PR #1 follow-up).
//
// Nothing needs installing: the server entry imports node builtins only, the
// TUI entry's imports are rewritten to host-provided modules, and Desktop
// evaluates gui-experimental bundles with the app's own module instances
// (packages/app/src/runtime/plugin/module.ts in the opencode repo).
//
// These tests make adding a dependency a deliberate act that fails CI until
// the policy here is consciously revised.

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))

test("runtime dependencies stay empty — git installs must never pull third-party packages", () => {
  const deps = Object.keys(pkg.dependencies ?? {})
  assert.deepEqual(deps, [], `runtime dependencies are forbidden (host shares its own modules; see CHANGELOG v0.6.1). found: [${deps.join(", ")}]`)
})

test("scripts avoid install-lifecycle names that force git-dep preparation", () => {
  // pacote prepares GitHub-installed plugins by running npm inside the clone
  // when package.json declares workspaces or any of these scripts — even with
  // zero dependencies (v0.6.1 still failed until "build" was renamed, v0.6.2).
  // Keep script names outside this list forever.
  const triggers = ["postinstall", "build", "preinstall", "install", "prepack", "prepare"]
  const scripts = Object.keys(pkg.scripts ?? {})
  const hit = scripts.filter(name => triggers.includes(name))
  assert.deepEqual(hit, [], `scripts named ${JSON.stringify(triggers)} make opencode's installer run npm inside the clone. rename them (e.g. build:gui). found: [${hit.join(", ")}]`)
  assert.equal(pkg.workspaces, undefined, "workspaces would trigger git-dep preparation on install")
})

test("devDependencies are limited to the reviewed build toolchain", () => {
  const allowed = ["@opencode/plugin", "@types/node", "jsdom", "solid-js", "typescript", "vite", "vite-plugin-solid"]
  const extra = Object.keys(pkg.devDependencies ?? {}).filter(name => !allowed.includes(name))
  assert.deepEqual(extra, [], `new devDependencies need explicit review (they do not affect installs, but keep the toolchain deliberate). unexpected: [${extra.join(", ")}]`)
})

test("server and TUI entrypoints import no packages", () => {
  for (const file of ["index.ts", "tui.ts"]) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8")
    const imports = [...source.matchAll(/from\s+"([^"]+)"/g), ...source.matchAll(/import\(\s*"([^"]+)"\s*\)/g)].map(match => match[1])
    const external = imports.filter(name => !name.startsWith("node:") && !name.startsWith(".") && !name.startsWith("/"))
    // tui.ts deliberately names solid-js/@opentui literals: the host rewrites
    // those to its own instances (see the rendering note in tui.ts).
    const hostRewritten = new Set(["solid-js", "@opentui/solid/jsx-runtime"])
    const bad = external.filter(name => !hostRewritten.has(name))
    assert.deepEqual(bad, [], `${file} must not import external packages (node builtins and host-rewritten modules only). found: [${bad.join(", ")}]`)
  }
})

test("shipped GUI bundle only requires host-shared modules", () => {
  const shared = new Set([
    "effect", "@opencode/plugin/gui", "@opencode/plugin/gui/main", "@opencode/plugin/gui/file",
    "@opencode/plugin/gui/review", "@opencode/plugin/gui/browser", "@opencode/plugin/rpc",
    "@opencode/schema/rpc", "@opencode/client", "@opencode/client/effect", "@opencode/client/solid",
    "solid-js", "solid-js/web", "solid-js/store", "electron",
  ])
  const bundle = readFileSync(new URL("../dist/gui-experimental.cjs", import.meta.url), "utf8")
  const requires = [...bundle.matchAll(/require\("([^"]+)"\)/g)].map(match => match[1])
  const bad = [...new Set(requires.filter(name => !shared.has(name) && !name.startsWith("node:")))]
  assert.deepEqual(bad, [], `gui-experimental may only require modules the Desktop app shares (packages/app/src/runtime/plugin/module.ts) or node builtins. found: [${bad.join(", ")}]`)
})
