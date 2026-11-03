import type { OpenCodeClient, SessionInfo } from "@opencode/client"

export interface Worker {
  sessionID: string
  role: string
  lastOutcome?: string | null
  lastOutcomeTime?: number | null
  waiting?: string | null
}
export interface Team {
  lead: SessionInfo
  workers: Worker[]
  name: string
  activity: number
  created: number
}
export type Member = { team: Team; role: "lead"; worker?: undefined } | { team: Team; role: "worker"; worker: Worker }
export interface Row {
  sessionID: string
  role: string
  running: boolean
  outcome: string | null
  waiting?: string | null
}
export function teamsIn(sessions: readonly SessionInfo[], directory: string): Team[]
export function membership(teams: readonly Team[], sessionID: string): Member | undefined
export function teamRows(team: Team, status: (id: string) => string): Row[]
export function createTeamSource(client: () => OpenCodeClient, directory: string, publish: (sessions: SessionInfo[]) => void, failure: (error: unknown) => void): {
  refresh(): Promise<void>
  dispose(): void
}
