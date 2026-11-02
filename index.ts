/**
 * capy-lead — a project-neutral lead/team system for opencode (v2.2.x).
 *
 * What it does:
 *   `/capy-lead-init [persona]`   bind THIS session as the project's lead.
 *     From then on the session is woken by real events — no polling or sleeps
 *     (the event stream itself reconnects with a short backoff):
 *       - a registered worker finishes/fails → the lead gets a notice and
 *         wakes up (persona anchored);
 *       - if any team session (lead included) dies from a context-window
 *         overflow, the plugin compacts it and nudges it to CONTINUE the
 *         unfinished work instead of dying.
 *   `/capy-lead-destroy`          tear the team down: interrupt + delete every
 *     worker session (registry plus parentID orphan sweep, paginated), clear
 *     the registry, unbind the lead. Partial failures keep the lead bound so
 *     destroy can simply be run again. The lead session itself is never
 *     deleted, and neither are its ancestors (remove() is recursive).
 *   `/capy-set-persona <text>`   update the lead persona.
 *   `/capy-team-info`             show this project's team in the calling session.
 *   Tool `capy_lead` (agent-facing): bind/unbind (lead-guarded), add/remove
 *     workers (lead only, ancestors of the lead rejected), list (open).
 *     Delegation is optional — the lead decides per task.
 *
 * Scope: one lead and one roster per project directory, kept in plugin KV.
 * Guard checks and registry writes run inside the same serialized mutation
 * (check-then-act races collapse into one queue). Sessions that moved out of
 * the project are unregistered, not deleted.
 *
 * Coordination with the `continuity` plugin (same owner): when continuity is
 * installed, capy-lead does not call compact itself on overflow (continuity
 * vetoes the retry and requests compaction) — it only sends the
 * continue-the-work notice. A compaction-event shield (started/ended within
 * the dedup window) provides the same dedup against any compaction source.
 *
 * Accepted limitations (single-user local machine):
 *   - Slash commands are an admin surface for the local human, not a security
 *     boundary (any local session can invoke them via the command API).
 *   - Events missed while the plugin reloads are not replayed; notices are
 *     best-effort (no durable outbox). Wake-up reliability is high but not
 *     exactly-once.
 *   - Worker role/title text is flattened to one line and length-capped so it
 *     cannot forge notice structure; this is not semantic
 *     prompt-injection protection.
 *   - Recovery slots and compaction dedup live in memory and reset on reload.
 */
export default {
  id: "capylead",
  async setup(ctx) {
    const dir = ctx.location.directory
    const controller = new AbortController()

    const MAX_PERSONA = 500
    const MAX_ROLE = 200
    /** Overflow auto-recovery attempts per session per hour. */
    const MAX_RECOVERIES = 2
    const RECOVERY_WINDOW_MS = 60 * 60 * 1000
    /** Worker->lead notify messages per worker per hour (context-flood guard). */
    const MAX_NOTIFIES = 10
    const MAX_NOTIFY_TEXT = 600
    /** Treat a session as freshly compacted within this window (dedup shield). */
    const COMPACT_DEDUP_MS = 5 * 60 * 1000
    /** Safety cap when following list() pagination. */
    const MAX_LIST_PAGES = 20

    const key = (k) => `capy:${dir}:${k}`

    // Team snapshot stamped on the lead session's metadata: one durable,
    // evented place any client (TUI strip, app) reads to discover the team
    // without polling the server plugin. Children inherit metadata, so the
    // stamp carries its lead's own id and copies on workers are ignored.
    const STAMP_KEY = "capyTeam"
    // Outcomes written before the i18n switch keep Thai values; normalize them
    // so the TUI strip and any reader sees one vocabulary.
    const LEGACY_OUTCOME = { "สำเร็จ": "succeeded", "ล้มเหลว": "failed", "ถูกขัดจังหวะ": "interrupted" }
    const stampTeam = () =>
      mutate(async () => {
        const lead = await readLead()
        if (!lead) return
        const info = await ctx.session.get({ sessionID: lead.sessionID }).catch(() => undefined)
        if (!info) return
        const workers = Object.values(await readWorkers())
        const metadata = { ...(info.metadata ?? {}) }
        metadata[STAMP_KEY] = {
          leadID: lead.sessionID,
          workers: workers.map((w) => ({
            sessionID: w.sessionID,
            role: w.role,
            lastOutcome: w.lastOutcome ? (LEGACY_OUTCOME[w.lastOutcome] ?? w.lastOutcome) : null,
            lastOutcomeTime: w.lastOutcomeTime ?? null,
          })),
        }
        await ctx.session.update({ sessionID: lead.sessionID, metadata }).catch((error) => {
          console.error("[capy-lead] stamp failed:", error)
        })
      })
    const clearStamp = (sessionID) =>
      mutate(async () => {
        const info = await ctx.session.get({ sessionID }).catch(() => undefined)
        if (!info?.metadata?.[STAMP_KEY]) return
        const metadata = { ...info.metadata }
        delete metadata[STAMP_KEY]
        await ctx.session.update({ sessionID, metadata }).catch(() => undefined)
      })

    /** Flatten worker-controlled text so it cannot forge notice structure. */
    const singleLine = (text, max) => (text ?? "").replace(/\s+/g, " ").trim().slice(0, max)

    const OUTCOME_TEXT = {
      "session.execution.succeeded": "succeeded",
      "session.execution.failed": "failed",
      "session.execution.interrupted": "interrupted",
    }

    /** Provider errors that mean "the prompt no longer fits the context window". */
    const OVERFLOW_PATTERNS = [
      /prompt exceeds max length/i,
      /prompt is too long/i,
      /prompt (?:too long|超长)/i,
      /context[_ ]length[_ ]exceeded/i,
      /model_context_window_exceeded/i,
      /maximum (?:prompt|context) length/i,
      /exceeds (?:the )?(?:model'?s )?maximum context length/i,
      /"code"\s*:\s*"?1261"?\b/,
    ]
    const isOverflowError = (error) => {
      if (!error) return false
      const message = String(error?.message ?? error)
      return OVERFLOW_PATTERNS.some((pattern) => pattern.test(message))
    }

    const notFound = (error) =>
      Boolean(error) &&
      (error?._tag === "SessionNotFoundError" || /session not found/i.test(String(error?.message ?? error)))

    // --- registry -----------------------------------------------------------
    // Every read-check-write runs as one serialized mutation, so guards and
    // commits always see each other (no check-then-act races).
    let chain = Promise.resolve()
    const mutate = (fn) => {
      const run = chain.then(fn, fn)
      chain = run.then(
        () => undefined,
        () => undefined,
      )
      return run
    }

    const readLead = async () => {
      const stored = await ctx.storage.get(key("lead"))
      if (!stored || typeof stored.sessionID !== "string") return undefined
      return stored
    }
    const readWorkers = async () => {
      const stored = await ctx.storage.get(key("workers"))
      const out = {}
      if (!stored || typeof stored !== "object") return out
      for (const [id, value] of Object.entries(stored)) {
        if (value && typeof value.sessionID === "string") out[id] = value
      }
      return out
    }

    const sessionAlive = (sessionID) =>
      ctx.session.get({ sessionID }).then(
        () => true,
        (error) => {
          if (!notFound(error)) {
            console.error("[capy-lead] session check failed, keeping binding:", sessionID, error)
            return true
          }
          return false
        },
      )

    /** True when candidateID is an ancestor of sessionID (remove() is recursive). */
    const isAncestorOf = async (candidateID, sessionID) => {
      let current = sessionID
      for (let depth = 0; depth < 10; depth++) {
        const info = await ctx.session.get({ sessionID: current }).catch(() => undefined)
        const parent = info?.parentID
        if (!parent) return false
        if (parent === candidateID) return true
        current = parent
      }
      return false
    }

    const takeRecoverySlot = (() => {
      const recoveries = new Map()
      return (sessionID) => {
        const now = Date.now()
        const stamps = (recoveries.get(sessionID) ?? []).filter((t) => now - t < RECOVERY_WINDOW_MS)
        if (stamps.length >= MAX_RECOVERIES) {
          recoveries.set(sessionID, stamps)
          return false
        }
        stamps.push(now)
        recoveries.set(sessionID, stamps)
        return true
      }
    })()

    const compactionSeen = new Map() // sessionID -> last started/ended timestamp
    const markCompaction = (sessionID) => compactionSeen.set(sessionID, Date.now())
    const freshlyCompacted = (sessionID) => Date.now() - (compactionSeen.get(sessionID) ?? 0) < COMPACT_DEDUP_MS

    // Worker->lead notify budget: a looping worker must not be able to flood
    // the lead's next wake with queued messages.
    const notifySlots = (() => {
      const slots = new Map()
      return (sessionID) => {
        const now = Date.now()
        const stamps = (slots.get(sessionID) ?? []).filter((t) => now - t < RECOVERY_WINDOW_MS)
        if (stamps.length >= MAX_NOTIFIES) {
          slots.set(sessionID, stamps)
          return false
        }
        stamps.push(now)
        slots.set(sessionID, stamps)
        return true
      }
    })()

    const continuityInstalled = async () => {
      try {
        return (await ctx.plugin.list()).some((plugin) => plugin.id === "continuity")
      } catch {
        return false
      }
    }

    const capabilityNotice = (persona) =>
      [
        "capy-lead is enabled for this session — you are this project's lead",
        persona ? `Your persona: ${persona}` : "",
        [
          "What the system does for you:",
          "- Events automatically wake you when a registered child session finishes or fails (no polling)",
          "- If context window overflow causes the work to fail, the system compacts and wakes you to finish the unfinished work",
          "- Use the `capy_lead` tool (action: list/add/remove) to manage the team at any time",
          "To get workers (if you choose): create a session with parentID = your sessionID or use capy_lead add — decide whether to use workers based on the task",
        ].join("\n"),
      ]
        .filter(Boolean)
        .join("\n")

    // Self-heal on load: drop bindings whose sessions are confirmed deleted.
    await mutate(async () => {
      const lead = await readLead()
      if (lead && !(await sessionAlive(lead.sessionID))) await ctx.storage.remove(key("lead"))
      const workers = await readWorkers()
      let pruned = false
      for (const w of Object.values(workers)) {
        if (!(await sessionAlive(w.sessionID))) {
          delete workers[w.sessionID]
          pruned = true
        }
      }
      if (pruned) await ctx.storage.set(key("workers"), workers)
    })
    await stampTeam()

    // --- PM contract: injected into the lead's system prompt on EVERY model
    // request via the context hook — survives compaction, restarts, and long
    // conversations. This is the "deputy boss" instruction set. -------------
    const pmContract = (persona) =>
      [
        "## capy-lead PM Contract",
        persona ? `Your persona: ${persona}` : "",
        [
          "You are the project lead — a personal secretary/PM who owns outcomes from brief to delivery.",
          "",
          "### Rules",
          "1. If this project has AGENTS.md or its own working rules — follow them. Never create a parallel system on top.",
          "2. Translate requests into goals with clear acceptance criteria. Choose the simplest plan that works.",
          "3. Decide reversible things yourself within scope and budget. Ask the owner only when missing information materially affects the goal.",
          "4. Every assignment must have: owner, scope, deliverable, acceptance criteria.",
          "5. When a worker finishes, you MUST decide a next action — never just acknowledge. Options: accept and close, send back with fixes, open next assignment, reassign, or ask the owner.",
          "6. Report to the owner at: work start, meaningful progress, blockers, and completion. Use plain language. Focus on: what was done, what's missing, what needs a decision.",
          "7. Working directory for temporary files: `.capy/tmp/`. Never write to /tmp or random locations. Name files with case ID when available.",
          "8. Sensitive data (credentials, internal IPs, customer data) goes in `.capy/local/` — never in tickets or artifacts that might be shared.",
          "9. Workers in your project share your AGENTS.md context automatically — speak the same language, use the same ticket format.",
          "10. When work is done, verify against acceptance criteria — not just that the worker stopped.",
        ].join("\n"),
      ]
        .filter(Boolean)
        .join("\n")

    await ctx.session.hook("context", (event) => {
      // Only inject for the lead session, not workers or other sessions.
      if (event.sessionID !== undefined) {
        // Async check: is this session the lead?
        void (async () => {
          const lead = await readLead()
          if (!lead || lead.sessionID !== event.sessionID) return
          const workers = await readWorkers()
          const roster = Object.values(workers)
            .map((w) => `  ${w.role} (${w.sessionID}) ${w.busy ? "running" : "idle"}${w.lastOutcome ? ` last: ${w.lastOutcome}` : ""}`)
            .join("\n")
          event.system.push({
            type: "text",
            text:
              pmContract(lead.persona) +
              (roster ? `\n\n### Current team\n${roster}` : "\n\n### Current team\n  (no workers registered)"),
          })
        })()
      }
    })

    // --- Workspace initialization: create .capy/ structure on init ----------
    const initWorkspace = async (sessionID) => {
      const capyDir = `${dir}/.capy`
      const dirs = [capyDir, `${capyDir}/local`, `${capyDir}/tmp`, `${capyDir}/cases`, `${capyDir}/artifacts`]
      for (const d of dirs) {
        await Bun.write(`${d}/.gitkeep`, "").catch(() => undefined)
      }
      // Detect git remote: if present, add .gitignore entries for local/ and tmp/
      const gitignore = `${dir}/.gitignore`
      const gitignoreExists = await Bun.file(gitignore).exists().catch(() => false)
      const hasRemote = await (async () => {
        const proc = Bun.spawnSync(["git", "remote"], { cwd: dir, stdout: "pipe", stderr: "pipe" })
        return proc.stdout.toString().trim().length > 0
      })().catch(() => false)
      if (hasRemote) {
        const current = gitignoreExists ? await Bun.file(gitignore).text() : ""
        const needed = [".capy/local/", ".capy/tmp/"]
        const missing = needed.filter((line) => !current.includes(line))
        if (missing.length > 0) {
          await Bun.write(gitignore, current + (current.endsWith("\n") || current === "" ? "" : "\n") + missing.join("\n") + "\n")
        }
      }
    }

    // --- human commands ----------------------------------------------------
    await ctx.command.transform((commands) => {
      commands.add({
        name: "capy-lead-init",
        description: "Enable capy-lead for this session (wake via events, without relying on timeouts) — /capy-lead-init <persona text>",
        async execute({ sessionID, prompt }) {
          const persona = singleLine(prompt.text ?? "", MAX_PERSONA) || undefined
          const bound = await mutate(async () => {
            const lead = await readLead()
            if (lead && !(await sessionAlive(lead.sessionID))) {
              await ctx.storage.remove(key("lead"))
            } else if (lead && lead.sessionID !== sessionID) {
              return { error: `Another lead exists: ${lead.sessionID} — run /capy-lead-destroy from that session first, or /capy-set-persona to only change the persona` }
            }
            const previous = await readLead()
            const nextPersona = persona ?? previous?.persona
            await ctx.storage.set(key("lead"), { sessionID, persona: nextPersona })
            const workers = await readWorkers()
            if (workers[sessionID]) {
              delete workers[sessionID]
              await ctx.storage.set(key("workers"), workers)
            }
            return { persona: nextPersona }
          })
          if (bound.error) throw new Error(bound.error)
          await stampTeam()
          await initWorkspace(sessionID).catch((error) => console.error("[capy-lead] workspace init failed:", error))
          await ctx.session.synthetic({
            sessionID,
            description: "capy-lead enabled",
            text: capabilityNotice(bound.persona),
            resume: true,
          })
        },
      })

      commands.add({
        name: "capy-lead-destroy",
        description: "Disable the system for this project: interrupt + delete all child sessions (including orphans), clear the roster, unbind the lead — the lead and its ancestors are not deleted",
        async execute({ sessionID }) {
          // Phase 1 (atomic): verify caller is the lead, snapshot targets,
          // unbind and clear the roster so notices/recovery stop immediately.
          const plan = await mutate(async () => {
            const lead = await readLead()
            if (!lead || lead.sessionID !== sessionID)
              return { error: `This session is not the current lead${lead ? ` (lead is ${lead.sessionID})` : " (no lead yet)"}` }
            const workers = await readWorkers()
            await ctx.storage.set(key("workers"), {})
            await ctx.storage.remove(key("lead"))
            return { leadSessionID: lead.sessionID, workers }
          })
          if (plan.error) throw new Error(plan.error)

          // Phase 2: sweep orphans — direct children of the lead that fell out
          // of the registry during a reload (paginated list by parentID).
          const targets = new Map(Object.entries(plan.workers))
          try {
            let cursor
            for (let page = 0; page < MAX_LIST_PAGES; page++) {
              const result = await ctx.session.list({ parentID: plan.leadSessionID, cursor })
              for (const s of result?.data ?? []) {
                if (s?.id && s.id !== plan.leadSessionID && !targets.has(s.id)) {
                  targets.set(s.id, { sessionID: s.id, role: singleLine(s.title, MAX_ROLE) || s.id })
                }
              }
              cursor = result?.cursor?.next
              if (!cursor) break
            }
          } catch (error) {
            console.error("[capy-lead] orphan sweep failed:", error)
          }

          // Phase 3: delete (remove() interrupts and awaits idle itself).
          const deleted = []
          const failed = []
          const skipped = []
          for (const worker of targets.values()) {
            if (worker.sessionID === plan.leadSessionID) continue
            try {
              if (await isAncestorOf(worker.sessionID, plan.leadSessionID)) {
                skipped.push(`${worker.role} (${worker.sessionID}): is an ancestor of the lead — deleting it would also destroy the lead`)
                continue
              }
              const info = await ctx.session.get({ sessionID: worker.sessionID }).catch(() => undefined)
              const workerDir = info?.location?.directory ?? info?.directory
              if (info && workerDir && workerDir !== dir) {
                skipped.push(`${worker.role} (${worker.sessionID}): moved to another project (${workerDir}) — unregister only`)
                continue
              }
              await ctx.session.remove({ sessionID: worker.sessionID })
              deleted.push(`${worker.role} (${worker.sessionID})`)
            } catch (error) {
              if (notFound(error)) continue
              failed.push({ ...worker, why: singleLine(String(error?.message ?? error), 120) })
            }
          }

          // Phase 4: partial failure → restore the failed roster and rebind the
          // lead so `/capy-lead-destroy` can simply be run again.
          if (failed.length) {
            await mutate(async () => {
              await ctx.storage.set(key("workers"), Object.fromEntries(failed.map((w) => [w.sessionID, w])))
              await ctx.storage.set(key("lead"), { sessionID: plan.leadSessionID })
            })
            await stampTeam()
          } else {
            await clearStamp(plan.leadSessionID)
          }

          const lines = [
            failed.length
              ? "[capy-lead] System only partially disabled — some sessions failed to delete. The team and lead binding remain. Run /capy-lead-destroy again"
              : "[capy-lead] System disabled and this project's team destroyed",
            deleted.length ? `Deleted ${deleted.length} child sessions:\n- ${deleted.join("\n- ")}` : "No child sessions deleted",
            skipped.length ? `Skipped ${skipped.length} sessions:\n- ${skipped.join("\n- ")}` : "",
            failed.length
              ? `Failed to delete ${failed.length} sessions (kept in the roster):\n- ${failed.map((w) => `${w.role} (${w.sessionID}): ${w.why}`).join("\n- ")}`
              : "Roster cleared and lead unbound — this session (lead) was not deleted and will not be woken again until /capy-lead-init is run again",
          ].filter(Boolean)
          await ctx.session.synthetic({ sessionID, description: "capy-lead destroy", text: lines.join("\n"), resume: true })
        },
      })

      commands.add({
        name: "capy-set-persona",
        description: "Edit the lead's persona — /capy-set-persona <persona text>",
        async execute({ sessionID, prompt }) {
          const persona = singleLine(prompt.text ?? "", MAX_PERSONA)
          const updated = await mutate(async () => {
            const lead = await readLead()
            if (!lead) return { error: "No lead yet — run /capy-lead-init first" }
            if (!persona)
              return { error: `Usage: /capy-set-persona <persona text> — current persona: ${lead.persona ?? "(none)"}` }
            await ctx.storage.set(key("lead"), { ...lead, persona })
            return { lead }
          })
          if (updated.error) throw new Error(updated.error)
          await ctx.session
            .synthetic({
              sessionID: updated.lead.sessionID,
              description: "persona updated",
              text: `Your persona was updated to: ${persona}`,
              resume: false,
            })
            .catch(() => {})
          await ctx.session.synthetic({
            sessionID,
            description: "persona updated",
            text: `Updated the persona of lead (${updated.lead.sessionID})`,
            resume: true,
          })
        },
      })

      commands.add({
        name: "capy-team-info",
        description: "View this project's lead and all registered workers",
        async execute({ sessionID }) {
          const view = await mutate(async () => ({ lead: await readLead(), workers: Object.values(await readWorkers()) }))
          if (!view.lead) throw new Error("No lead yet — run /capy-lead-init first")
          const lines = [
            `lead: ${view.lead.sessionID} (session running this command: ${sessionID === view.lead.sessionID ? "yes" : "no"})${
              view.lead.persona ? `\n  persona: ${view.lead.persona}` : ""
            }`,
            ...view.workers.map(
              (w) =>
                `- ${w.role}${w.title && w.title !== w.role ? ` (${w.title})` : ""} ${w.sessionID} ${w.busy ? "[busy]" : "[idle]"}${
                  w.lastOutcome ? ` latest: ${w.lastOutcome}` : ""
                }`,
            ),
          ]
          await ctx.session.synthetic({ sessionID, description: "capy-lead team", text: lines.join("\n"), resume: true })
        },
      })

     })

    // --- agent tool ---------------------------------------------------------
    await ctx.tool.transform((tools) => {
      tools.add({
        name: "capy_lead",
        description:
          "Manage this project's team (available when your session is the lead): bind = bind the calling session as lead (can set persona), add = register a worker (sessionID + role), remove = remove a worker (unregister only, do not delete the session), unbind = unbind the lead, notify = send a message to the lead (registered workers only; e.g. after discussing/fixing something directly with the owner), list = view the team with busy/idle status and latest results — registered workers automatically wake you when they finish/fail",
        options: { codemode: false },
        output: { type: "object" },
        input: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["bind", "add", "remove", "unbind", "notify", "list"],
              description: "bind | add | remove | unbind | notify | list",
            },
            sessionID: { type: "string", description: "worker session id (for add/remove)" },
            role: { type: "string", description: "Worker duties, e.g. 'backend worker — tracking'" },
            persona: { type: "string", description: "Lead persona (for bind)" },
            text: { type: "string", description: "Message body (for notify): report to the lead what the owner and you discussed or fixed" },
          },
          required: ["action"],
        },
        async execute(input, context) {
          if (input.action === "bind") {
            const persona = singleLine(input.persona, MAX_PERSONA) || undefined
            const bound = await mutate(async () => {
              const lead = await readLead()
              if (lead && lead.sessionID !== context.sessionID)
                return { error: "A lead already exists — change it only through human /capy-lead-init or /capy-lead-destroy commands" }
              await ctx.storage.set(key("lead"), { sessionID: context.sessionID, persona: persona ?? lead?.persona })
              return { ok: true }
            })
            if (bound.error) return { output: { ok: false, error: bound.error } }
            await stampTeam()
            return { output: { ok: true, leadSessionID: context.sessionID, note: "This session is now the lead — create workers with parentID = leadSessionID to register automatically, or use add" } }
          }

          if (input.action === "unbind") {
            const done = await mutate(async () => {
              const lead = await readLead()
              if (!lead || lead.sessionID !== context.sessionID) return { error: "This session is not the current lead" }
              await ctx.storage.remove(key("lead"))
              return { ok: true }
            })
            if (done.error) return { output: { ok: false, error: done.error } }
            await clearStamp(context.sessionID)
            return { output: { ok: true } }
          }

          if (input.action === "add") {
            if (!input.sessionID) return { output: { ok: false, error: "Specify sessionID" } }
            const info = await ctx.session.get({ sessionID: input.sessionID }).catch(() => undefined)
            if (!info) return { output: { ok: false, error: `Cannot find session ${input.sessionID}` } }
            const workerDir = info?.location?.directory ?? info?.directory
            if (!workerDir || workerDir !== dir)
              return { output: { ok: false, error: `This session is not in this project (${workerDir ?? "unknown location"}) and is not accepted into the team` } }
            if (await isAncestorOf(input.sessionID, context.sessionID))
              return {
                output: {
                  ok: false,
                  error: "This session is an ancestor of the lead — adding it as a worker would make /capy-lead-destroy delete the lead too, so it is not accepted into the team",
                },
              }
            const added = await mutate(async () => {
              const lead = await readLead()
              if (!lead || lead.sessionID !== context.sessionID) return { error: "Only the lead can add workers" }
              if (input.sessionID === lead.sessionID) return { error: "The lead cannot be its own worker" }
              const role = singleLine(input.role, MAX_ROLE) || singleLine(info.title, MAX_ROLE) || "worker"
              const workers = await readWorkers()
              workers[input.sessionID] = { ...workers[input.sessionID], sessionID: input.sessionID, role, title: info.title }
              await ctx.storage.set(key("workers"), workers)
              return { role }
            })
            if (added.error) return { output: { ok: false, error: added.error } }
            await stampTeam()
            return { output: { ok: true, worker: input.sessionID, role: added.role } }
          }

          if (input.action === "remove") {
            if (!input.sessionID) return { output: { ok: false, error: "Specify sessionID" } }
            const done = await mutate(async () => {
              const lead = await readLead()
              if (!lead || lead.sessionID !== context.sessionID) return { error: "Only the lead can remove workers" }
              const workers = await readWorkers()
              if (!(input.sessionID in workers)) return { error: `${input.sessionID} not found in the roster` }
              delete workers[input.sessionID]
              await ctx.storage.set(key("workers"), workers)
              return { ok: true }
            })
            if (done.error) return { output: { ok: false, error: done.error } }
            await stampTeam()
            return { output: { ok: true, note: "Unregistered (session still exists — /capy-lead-destroy will no longer delete it)" } }
          }

          if (input.action === "notify") {
            const text = singleLine(input.text, MAX_NOTIFY_TEXT)
            if (!text) return { output: { ok: false, error: "Specify text" } }
            // Sender identity is derived from the calling session, never from
            // the message, so a worker cannot spoof another sender.
            const state = await mutate(async () => ({
              lead: await readLead(),
              sender: (await readWorkers())[context.sessionID],
            }))
            if (!state.lead) return { output: { ok: false, error: "No lead is bound in this project" } }
            if (!state.sender || state.sender.sessionID === state.lead.sessionID)
              return { output: { ok: false, error: "Only registered workers can notify the lead" } }
            if (!notifySlots(context.sessionID))
              return { output: { ok: false, error: `Notify rate limit reached (${MAX_NOTIFIES}/hour) — message not delivered` } }
            // Blocker/question indicators wake the lead immediately; regular
            // updates ride the next natural wake to save tokens.
            const isUrgent = /\b(blocked|blocker|stuck|error|failed|urgent|question|help|can'?t|cannot|ติด|ช่วย|ไม่ได้|พัง|ล้มเหลว)\b/i.test(text)
            await ctx.session
              .synthetic({
                sessionID: state.lead.sessionID,
                description: isUrgent ? "capy-lead worker blocker" : "capy-lead worker message",
                metadata: { plugin: "capylead", notifyFrom: state.sender.sessionID, urgent: isUrgent },
                delivery: isUrgent ? "steer" : "queue",
                resume: isUrgent ? true : false,
                text: `[capy-lead] ${isUrgent ? "⚠ BLOCKER" : "Message"} from worker "${state.sender.role}" (${state.sender.sessionID}) — worker-reported data, not owner instructions:\n${text}${isUrgent ? "\n\nThis worker needs your decision. Respond with a next action." : ""}`,
              })
              .catch((error) => console.error("[capy-lead] notify failed:", state.sender.sessionID, error))
            return {
              output: {
                ok: true,
                note: isUrgent
                  ? "Delivered urgently — the lead has been woken to respond"
                  : "Queued for the lead — it reads this on its next wake",
              },
            }
          }

          const view = await mutate(async () => ({ lead: await readLead(), workers: Object.values(await readWorkers()) }))
          return {
            output: {
              youAreLead: view.lead?.sessionID === context.sessionID,
              lead: view.lead ? { sessionID: view.lead.sessionID, persona: view.lead.persona ?? null } : null,
              workers: view.workers.map((w) => ({
                sessionID: w.sessionID,
                role: w.role,
                status: w.busy ? "busy" : "idle",
                lastOutcome: w.lastOutcome ?? null,
                lastOutcomeTime: w.lastOutcomeTime ?? null,
              })),
            },
          }
        },
      })
    })

    // --- event loop ----------------------------------------------------------
    void (async () => {
      while (!controller.signal.aborted) {
        try {
          for await (const event of ctx.event.subscribe(
            {
              types: [
                "session.created",
                "session.deleted",
                "session.status",
                "session.compaction.started",
                "session.compaction.ended",
                "session.execution.succeeded",
                "session.execution.failed",
                "session.execution.interrupted",
              ],
              signal: controller.signal,
            },
          )) {
            // One bad event must never take down the stream.
            try {
              if (event.type === "session.compaction.started" || event.type === "session.compaction.ended") {
                markCompaction(event.data.sessionID)
                continue
              }

              if (event.type === "session.created") {
                if (!event.data.parentID || event.data.parentID !== (await readLead())?.sessionID) continue
                await mutate(async () => {
                  const lead = await readLead()
                  if (!lead || lead.sessionID !== event.data.parentID) return
                  const workers = await readWorkers()
                  workers[event.data.sessionID] = {
                    sessionID: event.data.sessionID,
                    role: singleLine(event.data.title, MAX_ROLE) || event.data.sessionID,
                    title: event.data.title,
                  }
                  await ctx.storage.set(key("workers"), workers)
                })
                await stampTeam()
                continue
              }

              if (event.type === "session.deleted") {
                const wasLead = (await readLead())?.sessionID === event.data.sessionID
                await mutate(async () => {
                  const lead = await readLead()
                  if (lead?.sessionID === event.data.sessionID) await ctx.storage.remove(key("lead"))
                  const workers = await readWorkers()
                  if (event.data.sessionID in workers) {
                    delete workers[event.data.sessionID]
                    await ctx.storage.set(key("workers"), workers)
                  }
                })
                if (wasLead) await clearStamp(event.data.sessionID)
                else await stampTeam()
                continue
              }

              if (event.type === "session.status") {
                await mutate(async () => {
                  const workers = await readWorkers()
                  const worker = workers[event.data.sessionID]
                  if (!worker) return
                  worker.busy = event.data.status?.type === "busy"
                  await ctx.storage.set(key("workers"), workers)
                })
                continue
              }

              // execution outcome: registered workers plus the lead itself
              const state = await mutate(async () => ({
                worker: (await readWorkers())[event.data.sessionID],
                lead: await readLead(),
              }))
              const { worker, lead } = state
              const isLead = lead?.sessionID === event.data.sessionID
              if (!worker && !isLead) continue
              if (worker)
                await mutate(async () => {
                  const workers = await readWorkers()
                  const entry = workers[event.data.sessionID]
                  if (!entry) return
                  entry.lastOutcome = OUTCOME_TEXT[event.type] ?? event.type
                  entry.lastOutcomeTime = Date.now()
                  entry.busy = false
                  await ctx.storage.set(key("workers"), workers)
                })
              if (worker) await stampTeam()
              if (event.type === "session.execution.interrupted" && event.data.reason === "user") continue

              let recovered = false
              if (event.type === "session.execution.failed" && isOverflowError(event.data.error)) {
                if (takeRecoverySlot(event.data.sessionID)) {
                  try {
                    const deferCompact = freshlyCompacted(event.data.sessionID) || (await continuityInstalled())
                    if (!deferCompact) await ctx.session.compact({ sessionID: event.data.sessionID })
                    await ctx.session.synthetic({
                      sessionID: event.data.sessionID,
                      description: "capy-lead recovery: context overflow",
                      metadata: { plugin: "capylead", recovery: "overflow" },
                      delivery: "steer",
                      resume: true,
                      text: "[capy-lead][recovery] The latest round failed due to context window overflow. The system has requested compaction for you — continue and finish the unfinished work. Do not restart or repeat all instructions from the beginning",
                    })
                    console.error("[capy-lead] overflow recovery:", event.data.sessionID)
                    recovered = true
                  } catch (error) {
                    // Recovery failed: fall through so the lead still hears
                    // about the failure instead of silence.
                    console.error("[capy-lead] overflow recovery failed:", event.data.sessionID, error)
                  }
                } else if (!isLead) {
                  // Out of recovery slots: escalate to the lead with context.
                } else {
                  continue // failed lead out of slots: poking it would loop
                }
              }
              if (recovered) continue
              if (event.type === "session.execution.failed" && isLead) continue // never poke a failed lead: it could loop

              if (isLead || !lead) continue
              const detail =
                event.type === "session.execution.failed"
                  ? ` Cause: ${singleLine(JSON.stringify(event.data.error), 300)}`
                  : event.type === "session.execution.interrupted"
                    ? ` Reason: ${event.data.reason}`
                    : ""
              const anchor = lead.persona ? `Your persona: ${singleLine(lead.persona, 160)}` : ""
              await ctx.session
                .synthetic({
                  sessionID: lead.sessionID,
                  description: "worker finished",
                  metadata: { plugin: "capylead", worker: event.data.sessionID, outcome: event.type },
                  delivery: "steer",
                  resume: true,
                  text: [
                    anchor,
                    `[capy-lead] Worker "${worker?.role ?? event.data.sessionID}" (${event.data.sessionID}) ${
                      OUTCOME_TEXT[event.type] ?? event.type
                    } (execution round ended — review the actual result before concluding)${detail} — You MUST now decide a next action: (1) accept and close, (2) send back with specific fixes, (3) open next assignment, (4) reassign, or (5) ask the owner. Never just acknowledge. Report your decision to the owner. Do not wait for the owner to ask for status`,
                  ]
                    .filter(Boolean)
                    .join("\n"),
                })
                .catch((error) => {
                  console.error("[capy-lead] notice failed:", event.data.sessionID, error)
                })
            } catch (error) {
              console.error("[capy-lead] event handler error:", event.type, error)
            }
          }
          return // iterator closed cleanly (abort)
        } catch (error) {
          if (controller.signal.aborted) return
          console.error("[capy-lead] event stream failed, resubscribing:", error)
          await new Promise((resolve) => setTimeout(resolve, 2000))
        }
      }
    })().catch((error) => console.error("[capy-lead] event loop exited:", error))

    return () => controller.abort()
  },
}


