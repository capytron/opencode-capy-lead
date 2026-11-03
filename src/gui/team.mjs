/** Validate canonical metadata; inherited stamps are never membership proof. */
export function teamsIn(sessions, directory) {
  return sessions.flatMap((lead) => {
    const stamp = lead.metadata?.capyTeam
    if (lead.location?.directory !== directory || !stamp || stamp.leadID !== lead.id || !Array.isArray(stamp.workers)) return []
    const seen = new Set([lead.id])
    const workers = stamp.workers.filter((worker) => {
      if (!worker || typeof worker.sessionID !== "string" || typeof worker.role !== "string" || seen.has(worker.sessionID)) return false
      seen.add(worker.sessionID)
      // A moved/deleted position must not be navigable even before reconciliation.
      return sessions.some((info) => info.id === worker.sessionID && info.location?.directory === directory)
    })
    return [{ lead, workers }]
  })
}

export function membership(teams, sessionID) {
  const own = teams.find((team) => team.lead.id === sessionID)
  if (own) return { team: own, role: "lead", worker: undefined }
  for (const team of teams) {
    const worker = team.workers.find((item) => item.sessionID === sessionID)
    if (worker) return { team, role: "worker", worker }
  }
}

export function teamRows(team, status) {
  return [
    { sessionID: team.lead.id, role: "Lead", running: status(team.lead.id) === "running", outcome: null, waiting: null },
    ...team.workers.map((worker) => ({ ...worker, running: status(worker.sessionID) === "running", outcome: worker.lastOutcome ?? null })),
  ]
}

/** Snapshot reads are atomic and stale requests cannot publish after scope disposal. */
export function createTeamSource(client, directory, publish, failure) {
  let disposed = false
  let running = false
  let again = false
  const abort = new AbortController()
  const refresh = async () => {
    if (disposed) return
    if (running) { again = true; return }
    running = true
    try {
      const sessions = []
      let cursor
      do {
        const page = await client().session.list({ directory, limit: 100, ...(cursor ? { cursor } : {}) }, { signal: abort.signal })
        if (disposed) return
        sessions.push(...page.data)
        cursor = page.cursor.next
      } while (cursor)
      publish(sessions)
    } catch (error) {
      if (!disposed) failure(error)
    } finally {
      running = false
      if (again && !disposed) { again = false; void refresh() }
    }
  }
  return { refresh, dispose() { disposed = true; abort.abort() } }
}
