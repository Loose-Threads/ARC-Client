// ====
// Restart guard — bounds automatic crash restarts to stop restart loops.
// State is persisted to disk because app.relaunch() spawns a fresh process;
// an in-memory counter would reset on every relaunch and never trip.
// Entries older than WINDOW_MS are pruned on every read/write, and that
// ageing-out IS the reset: a boot that survives WINDOW_MS is automatically
// forgiven, so there is no explicit clear path and no stuck state if the
// process is killed hard.
// ====
import fs from 'node:fs'
import path from 'node:path'

const MAX_RESTARTS = 3
const WINDOW_MS = 60_000
const STATE_FILENAME = 'restart-state.json'

interface RestartState {
  restarts: number[]
}

function resolveStateDir(): string {
  const override = process.env.ARC_CRASH_DATA_DIR
  if (override) return override
  try {
    // Electron may be unavailable (tests, or an early crash before app ready).
    const electron = require('electron')
    if (electron?.app?.getPath) {
      return electron.app.getPath('userData')
    }
  } catch {
    // fall through to the directory-relative default
  }
  return path.join(__dirname, '..')
}

function statePath(): string {
  return path.join(resolveStateDir(), STATE_FILENAME)
}

function readState(): RestartState {
  try {
    const raw = fs.readFileSync(statePath(), 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || !Array.isArray(parsed.restarts)) return { restarts: [] }
    const restarts = parsed.restarts.filter((value: unknown): value is number => typeof value === 'number' && Number.isFinite(value))
    return { restarts }
  } catch {
    return { restarts: [] }
  }
}

function writeState(state: RestartState): void {
  try {
    fs.writeFileSync(statePath(), JSON.stringify(state), 'utf8')
  } catch (err) {
    // Never let state persistence itself escalate a crash.
    console.error('[RestartGuard] Failed to persist restart state:', err)
  }
}

function prune(restarts: number[], now: number): number[] {
  return restarts.filter(stamp => now - stamp < WINDOW_MS)
}

export function canRestart(): boolean {
  const now = Date.now()
  const state = readState()
  const recent = prune(state.restarts, now)
  if (recent.length !== state.restarts.length) {
    writeState({ restarts: recent })
  }
  return recent.length < MAX_RESTARTS
}

export function recordRestart(): number {
  const now = Date.now()
  const recent = prune(readState().restarts, now)
  recent.push(now)
  writeState({ restarts: recent })
  return recent.length
}

export function restartCount(): number {
  return prune(readState().restarts, Date.now()).length
}

export function clearRestartState(): void {
  writeState({ restarts: [] })
}

export const RESTART_GUARD_LIMITS = {
  MAX_RESTARTS,
  WINDOW_MS
} as const