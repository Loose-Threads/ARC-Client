// ====
// CrashReportModal state factory — sibling script module for
// CrashReportModal.vue. Owns the persisted crash report lookup, the
// Copy Report / Send Report / Dismiss actions, and submission status.
// Mirrors the paired-file convention used by AutoStatusPage.
// ====
import { onMounted, ref } from 'vue'
import { useElectronAPI } from '../composables/useElectronAPI'

export type CrashSubmitState = 'idle' | 'sending' | 'sent' | 'failed'

export interface CrashReport {
  id: string
  crashType: string
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

export function createCrashReportModalState() {
  const api = useElectronAPI()
  const report = ref<CrashReport | null>(null)
  const visible = ref(false)
  const copyState = ref<'idle' | 'copied' | 'failed'>('idle')
  const submitState = ref<CrashSubmitState>('idle')
  const submitError = ref('')
  const logExpanded = ref(false)

  function buildCopyText(source: CrashReport): string {
    const meta = [
      `Type: ${source.crashLabel}`,
      source.reason ? `Reason: ${source.reason}` : '',
      source.exitCode !== null ? `Exit code: ${source.exitCode}` : '',
      `Occurred: ${source.occurredAt}`,
      `Uptime before crash: ${formatDuration(source.upstreamSeconds)}`,
      `App version: ${source.appVersion}`,
      `Platform: ${source.platform} ${source.arch}`,
      `Electron: ${source.electronVersion}`,
      `Node: ${source.nodeVersion}`
    ].filter(Boolean).join('\n')
    const logTail = source.logTail.length > 0
      ? `\n\n--- Log tail ---\n${source.logTail.join('\n')}`
      : ''
    return [
      '```',
      meta,
      `\n--- Message ---\n${source.message}`,
      source.stack ? `\n--- Stack ---\n${source.stack}` : '',
      logTail,
      '```'
    ].filter(Boolean).join('\n')
  }

  function formatDuration(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) return 'unknown'
    if (seconds < 60) return `${seconds}s`
    const minutes = Math.floor(seconds / 60)
    const remainder = seconds % 60
    return `${minutes}m ${remainder}s`
  }

  async function copyReport() {
    if (!report.value) return
    try {
      await api.clipboardWriteText(buildCopyText(report.value))
      copyState.value = 'copied'
    } catch {
      copyState.value = 'failed'
    }
    window.setTimeout(() => { copyState.value = 'idle' }, 2500)
  }

  async function sendReport() {
    if (!report.value || submitState.value === 'sending') return
    submitState.value = 'sending'
    submitError.value = ''
    try {
      await api.crashReportSubmit()
      submitState.value = 'sent'
    } catch (error: unknown) {
      submitState.value = 'failed'
      submitError.value = error instanceof Error ? error.message : String(error)
    }
  }

  function dismiss() {
    visible.value = false
    report.value = null
    submitState.value = 'idle'
    submitError.value = ''
    void api.crashReportClear().catch(() => { /* best effort */ })
  }

  function toggleLog() {
    logExpanded.value = !logExpanded.value
  }

  onMounted(() => {
    void (async () => {
      try {
        const stored = await api.crashReportGet()
        if (stored) {
          report.value = stored
          visible.value = true
        }
      } catch { /* no report available */ }
    })()
  })

  return {
    report,
    visible,
    copyState,
    submitState,
    submitError,
    logExpanded,
    formatDuration,
    copyReport,
    sendReport,
    dismiss,
    toggleLog
  }
}