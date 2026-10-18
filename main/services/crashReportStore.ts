// ====
// Crash report store — persists the most recent crash to disk so the
// renderer can show it after an automatic restart. The report is written
// BEFORE any teardown runs, otherwise cleanup() would race the read.
// Resolved via app.getPath('userData') to match configManager/sqlDbService.
// ====
import fs from 'node:fs'
import path from 'node:path'

const REPORT_FILENAME = 'crash-report.json'
const MAX_LOG_TAIL_LINES = 200

const CRASH_TYPE_LABELS = {
  'renderer-gone': 'Renderer Process Crashed',
  'renderer-unresponsive': 'Application Unresponsive',
  'uncaught-exception': 'Critical Error',
  'unhandled-rejection': 'Critical Error'
} as const

export type CrashType = keyof typeof CRASH_TYPE_LABELS

export interface CrashReport {
  id: string
  crashType: CrashType
  crashLabel: string
  reason: string | null
  exitCode: number | null
  message: string
  stack: string | null
  appVersion: string
  platform: string
  arch: string
  electronVersion: string
  nodeVersion: string
  occurredAt: string
  upstreamSeconds: number
  logTail: string[]
}

function reportPath(): string {
  const electron = require('electron')
  const base = electron.app ? electron.app.getPath('userData') : path.join(__dirname, '..')
  return path.join(base, REPORT_FILENAME)
}

export function buildCrashReport(input: {
  crashType: CrashType
  reason?: string | null
  exitCode?: number | null
  message?: string
  stack?: string | null
  upstreamSeconds?: number
  logTail?: string[]
}): CrashReport {
  const electron = require('electron')
  const appVersion = electron.app?.getVersion?.() ?? 'unknown'
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    crashType: input.crashType,
    crashLabel: CRASH_TYPE_LABELS[input.crashType],
    reason: input.reason ?? null,
    exitCode: input.exitCode ?? null,
    message: input.message ?? 'No further details were reported.',
    stack: input.stack ?? null,
    appVersion,
    platform: process.platform,
    arch: process.arch,
    electronVersion: process.versions.electron ?? 'unknown',
    nodeVersion: process.versions.node,
    occurredAt: new Date().toISOString(),
    upstreamSeconds: input.upstreamSeconds ?? 0,
    logTail: (input.logTail ?? []).slice(-MAX_LOG_TAIL_LINES)
  }
}

export function writeCrashReport(report: CrashReport): void {
  try {
    fs.writeFileSync(reportPath(), JSON.stringify(report, null, 2), 'utf8')
  } catch (err) {
    console.error('[CrashReportStore] Failed to persist crash report:', err)
  }
}

export function readCrashReport(): CrashReport | null {
  try {
    const raw = fs.readFileSync(reportPath(), 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || typeof parsed.crashType !== 'string') return null
    return parsed as CrashReport
  } catch {
    return null
  }
}

export function clearCrashReport(): void {
  try {
    const target = reportPath()
    if (fs.existsSync(target)) fs.unlinkSync(target)
  } catch (err) {
    console.error('[CrashReportStore] Failed to clear crash report:', err)
  }
}