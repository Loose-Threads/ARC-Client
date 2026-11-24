import { ref, onMounted, onUnmounted } from 'vue'
import { useElectronAPI } from './useElectronAPI'

export interface LogEntry {
  timestamp: number
  address: string
  value: any
  connectionId?: string | null
}

const BUFFER_SIZE = 100
const FLUSH_INTERVAL = 1000
const MAX_ENTRIES = 2000
const FLOAT_THROTTLE_INTERVAL = 750
const MAX_FLOAT_TRACK = 1500

// Module-level state — persists across navigation while a consumer is mounted.
// Collection is demand-driven: the OSC streams are only acquired from the main
// process while at least one component is using this composable.
const receivedLogs = ref<LogEntry[]>([])
const forwardedLogs = ref<LogEntry[]>([])
const arcReceivedLogs = ref<LogEntry[]>([])
let buffer: { type: string; address: string; value: any; connectionId?: string | null; timestamp: number }[] = []
let lastFlush = 0
let flushTimer: ReturnType<typeof setInterval> | null = null
const lastFloatLogTimes = new Map<string, number>()
const lastFloatValues = new Map<string, any>()
const pendingFloatTimeouts = new Map<string, ReturnType<typeof setTimeout>>()
let unsubscribers: Array<() => void> = []
let consumerCount = 0

export function useOscLogs() {
  const api = useElectronAPI()

  function isFloat(value: any): boolean {
    if (typeof value === 'number') return !Number.isInteger(value)
    if (typeof value === 'string') {
      const n = parseFloat(value)
      return !isNaN(n) && value.includes('.') && !Number.isInteger(n)
    }
    return false
  }
  function appendLog(list: LogEntry[], entry: LogEntry) {
    if (list.length >= MAX_ENTRIES) list.splice(0, list.length - MAX_ENTRIES + 1)
    list.push(entry)
  }
  function handleFloatLog(type: string, address: string, value: any, connectionId?: string | null) {
    const key = `${type}-${address}`
    const now = Date.now()
    const lastTime = lastFloatLogTimes.get(key) ?? 0
    lastFloatValues.set(key, { type, address, value, connectionId, timestamp: now })
    if (lastFloatLogTimes.size > MAX_FLOAT_TRACK) {
      const pruneCount = Math.floor(MAX_FLOAT_TRACK * 0.1)
      const sorted = [...lastFloatLogTimes.entries()].sort((a, b) => a[1] - b[1])
      for (let i = 0; i < pruneCount; i++) {
        const staleKey = sorted[i][0]
        lastFloatLogTimes.delete(staleKey)
        lastFloatValues.delete(staleKey)
        // The timeout map must be pruned alongside the timestamp map,
        // otherwise it grows without bound for the life of the process.
        const staleTimeout = pendingFloatTimeouts.get(staleKey)
        if (staleTimeout) {
          clearTimeout(staleTimeout)
          pendingFloatTimeouts.delete(staleKey)
        }
      }
    }
    const existing = pendingFloatTimeouts.get(key)
    if (existing) clearTimeout(existing)
    if (now - lastTime >= FLOAT_THROTTLE_INTERVAL) {
      logFloatImmediate(type, address, value, connectionId)
      lastFloatLogTimes.set(key, now)
      return
    }
    const tid = setTimeout(() => {
      const final = lastFloatValues.get(key)
      if (final) {
        logFloatImmediate(final.type, final.address, final.value, final.connectionId)
        lastFloatLogTimes.set(key, Date.now())
      }
      pendingFloatTimeouts.delete(key)
    }, FLOAT_THROTTLE_INTERVAL)
    pendingFloatTimeouts.set(key, tid)
  }
  function logFloatImmediate(type: string, address: string, value: any, connectionId?: string | null) {
    const entry: LogEntry = { timestamp: Date.now(), address, value, connectionId }
    if (type === 'received') appendLog(receivedLogs.value, entry)
    else if (type === 'forwarded') appendLog(forwardedLogs.value, entry)
    else if (type === 'arc-received') appendLog(arcReceivedLogs.value, entry)
  }
  function handleOscReceived(data: any) {
    if (isFloat(data.value)) {
      handleFloatLog('received', data.address, data.value, data.connectionId)
      return
    }
    buffer.push({ type: 'received', address: data.address, value: data.value, connectionId: data.connectionId, timestamp: Date.now() })
    if (buffer.length >= BUFFER_SIZE || Date.now() - lastFlush >= FLUSH_INTERVAL) flushBuffer()
  }
  function handleOscForwarded(data: any) {
    if (isFloat(data.value)) {
      handleFloatLog('forwarded', data.address, data.value, data.connectionId)
      return
    }
    buffer.push({ type: 'forwarded', address: data.address, value: data.value, connectionId: data.connectionId, timestamp: Date.now() })
    if (buffer.length >= BUFFER_SIZE || Date.now() - lastFlush >= FLUSH_INTERVAL) flushBuffer()
  }
  function handleArcReceived(data: any) {
    if (isFloat(data.value)) {
      handleFloatLog('arc-received', data.address, data.value, null)
      return
    }
    appendLog(arcReceivedLogs.value, { timestamp: Date.now(), address: data.address, value: data.value })
  }
  function flushBuffer() {
    if (buffer.length === 0) return
    const received = buffer.filter(m => m.type === 'received')
    const forwarded = buffer.filter(m => m.type === 'forwarded')
    for (const m of received) appendLog(receivedLogs.value, { timestamp: m.timestamp, address: m.address, value: m.value, connectionId: m.connectionId })
    for (const m of forwarded) appendLog(forwardedLogs.value, { timestamp: m.timestamp, address: m.address, value: m.value, connectionId: m.connectionId })
    buffer = []
    lastFlush = Date.now()
  }
  function clearReceived() { receivedLogs.value = [] }
  function clearForwarded() { forwardedLogs.value = [] }
  function clearArcReceived() { arcReceivedLogs.value = [] }
  function clearAll() {
    clearReceived(); clearForwarded(); clearArcReceived()
    lastFloatLogTimes.clear()
    lastFloatValues.clear()
    pendingFloatTimeouts.forEach(t => clearTimeout(t))
    pendingFloatTimeouts.clear()
  }

  function startCollection() {
    if (consumerCount === 0) {
      unsubscribers = [
        api.onOscReceived(handleOscReceived),
        api.onOscForwarded(handleOscForwarded),
        api.onOscReceivedBatch((batch: any[]) => { for (const d of batch) handleOscReceived(d) }),
        api.onOscForwardedBatch((batch: any[]) => { for (const d of batch) handleOscForwarded(d) }),
        api.onWebSocketOscData(handleArcReceived)
      ]
      flushTimer = setInterval(() => { if (buffer.length > 0) flushBuffer() }, FLUSH_INTERVAL)
    }
    consumerCount++
  }

  function stopCollection() {
    consumerCount = Math.max(0, consumerCount - 1)
    if (consumerCount > 0) return
    for (const unsubscribe of unsubscribers) unsubscribe()
    unsubscribers = []
    if (flushTimer) {
      clearInterval(flushTimer)
      flushTimer = null
    }
    buffer = []
    pendingFloatTimeouts.forEach(t => clearTimeout(t))
    pendingFloatTimeouts.clear()
  }

  onMounted(startCollection)
  onUnmounted(stopCollection)

  return {
    receivedLogs,
    forwardedLogs,
    arcReceivedLogs,
    clearReceived,
    clearForwarded,
    clearArcReceived,
    clearAll
  }
}
