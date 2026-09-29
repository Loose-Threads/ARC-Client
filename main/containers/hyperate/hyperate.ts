import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import WebSocket from 'ws'
import Database from 'better-sqlite3'
import debug from '../../services/debugger'
import configManager from '../../services/configManager'
import { getDb } from '../../services/sqlDbService'

interface TrackerData {
  joinedAt: number
  lastHeartRate: number
  lastUpdate?: number
}

interface HyperateSecrets {
  hyperate?: { apiKey: string }
}

interface HyperateConfig {
  enabled: boolean
  primaryTracker: string | null
  trackers: string[]
  trackerNames: Record<string, string>
  trackerStates: Record<string, boolean>
}

interface OscService {
  isListening: boolean
  sendMessage(address: string, value: number, type: string): void
}

// Per-tracker connection slot. Each tracker gets its own WebSocket because
// HypeRate's Phoenix Channels backend only delivers hr_update events for a
// single subscribed topic per socket — joining multiple hr:X topics on one
// socket silently drops all but one. Keeping each tracker on its own
// connection side-steps the fan-out limitation.
interface ConnectionSlot {
  ws: WebSocket | null
  heartbeatInterval: ReturnType<typeof setInterval> | null
  reconnectTimeout: ReturnType<typeof setTimeout> | null
  watchdogInterval: ReturnType<typeof setInterval> | null
  watchdogCount: number
  lastHrUpdate: number | null
  reconnectAttempts: number
  cancelled: boolean
}

class HyperateAddon {
  enabled: boolean
  // Map<trackerId, ConnectionSlot>. One entry per tracker; tracks each WS
  // lifecycle independently so adding/removing trackers doesn't disturb the
  // others, and reconnects happen per-tracker rather than globally.
  connections: Map<string, ConnectionSlot>
  trackers: Map<string, TrackerData>
  primaryTracker: string | null
  secrets: HyperateSecrets | null
  config: HyperateConfig
  lastHeartRate: number
  reconnectDelay: number
  maxReconnectAttempts: number
  trackerNames: Record<string, string>
  trackerStates: Record<string, boolean>
  onStatusChange: ((status: ReturnType<HyperateAddon['getStatus']>) => void) | null
  onHeartRateUpdate: ((data: { heartRate: number, deviceId: string }) => void) | null
  lastError: string | null
  // True when at least one per-tracker loop is in a backoff/reconnect cycle.
  // Drives `reconnecting` in getStatus() for UI; computed from any slot's
  // reconnectTimeout presence rather than stored as a single flag.
  oscService: OscService | null
  readonly STALE_THRESHOLD_MS: number
  // HR history DB members
  private hrFlushTimer: ReturnType<typeof setInterval> | null
  private hrCleanupTimer: ReturnType<typeof setInterval> | null
  private hrWriteBuffer: Array<{ trackerId: string; heartRate: number; recordedAt: number }>
  private hrFlushStmt: Database.Statement | null
  private lastCaptureTime: number
  private captureRateMs: number
  private static readonly HR_FLUSH_MS = 2000
  private static readonly HR_CLEANUP_MS = 24 * 60 * 60 * 1000
  private static readonly HR_RETENTION_MAP: Record<number, number> = {
    1: 1 * 24 * 60 * 60 * 1000,
    3: 3 * 24 * 60 * 60 * 1000,
    7: 7 * 24 * 60 * 60 * 1000,
    30: 30 * 24 * 60 * 60 * 1000,
    [-1]: -1
  }
  constructor() {
    this.enabled = false
    this.connections = new Map()
    this.trackers = new Map()
    this.primaryTracker = null
    this.secrets = this.loadSecrets()
    this.config = this.loadConfig()
    this.lastHeartRate = 0
    this.maxReconnectAttempts = 5
    this.reconnectDelay = 10000 // 10 seconds
    this.primaryTracker = this.config.primaryTracker || null
    this.trackerNames = this.config.trackerNames || {}
    this.trackerStates = this.config.trackerStates || {} // Store enabled/disabled state
    this.onStatusChange = null // Callback for status changes
    this.onHeartRateUpdate = null // Callback for heart rate updates
    this.lastError = null // Last error message for UI display
    this.oscService = null
    this.STALE_THRESHOLD_MS = 3 * 60 * 1000 // 3 minutes — matches HypeRDesktop STALE_SECS
    this.hrFlushTimer = null
    this.hrCleanupTimer = null
    this.hrWriteBuffer = []
    this.hrFlushStmt = null
    this.lastCaptureTime = 0
    this.captureRateMs = this.loadCaptureRate()
    debug.info('HypeRate addon initialized')
  }
  setStatusChangeCallback(callback: ((status: ReturnType<HyperateAddon['getStatus']>) => void) | null): void {
    this.onStatusChange = callback
  }
  setHeartRateCallback(callback: ((data: { heartRate: number, deviceId: string }) => void) | null): void {
    this.onHeartRateUpdate = callback
  }
  notifyStatusChange(): void {
    if (typeof this.onStatusChange === 'function') {
      this.onStatusChange(this.getStatus())
    }
  }
  getSecretsCandidatePaths(): string[] {
    const candidatePaths = [
      path.join(process.cwd(), 'secrets.json'),
      path.join(app.getAppPath(), 'secrets.json'),
      path.resolve(__dirname, '..', '..', '..', 'secrets.json')
    ]
    return [...new Set(candidatePaths)]
  }
  loadSecrets(): HyperateSecrets | null {
    try {
      for (const secretsPath of this.getSecretsCandidatePaths()) {
        if (!fs.existsSync(secretsPath)) {
          continue
        }
        const secrets = JSON.parse(fs.readFileSync(secretsPath, 'utf8'))
        if (secrets.hyperate && secrets.hyperate.apiKey) {
          return secrets
        }
      }
      debug.warn('HypeRate API key not found in secrets.json')
      return null
    } catch (error) {
      debug.logError(`Failed to load HypeRate secrets: ${(error as Error).message}`)
      return null
    }
  }
  loadConfig(): HyperateConfig {
    try {
      const hyperateConfig = configManager.getHyperateConfig()
      if (hyperateConfig) {
        debug.info('HypeRate config loaded from config manager')
        return hyperateConfig as unknown as HyperateConfig
      }
    } catch (error) {
      debug.logError(`Failed to load HypeRate config: ${(error as Error).message}`)
    }
    return {
      enabled: false,
      primaryTracker: null,
      trackers: [],
      trackerNames: {},
      trackerStates: {}
    }
  }
  saveConfig(): void {
    try {
      // Get all unique tracker IDs from both active trackers and saved config
      const savedTrackers = this.config.trackers || []
      const activeTrackers = Array.from(this.trackers.keys())
      const allTrackers = [...new Set([...savedTrackers, ...activeTrackers])]
      const config = {
        primaryTracker: this.primaryTracker,
        trackers: allTrackers,
        trackerNames: this.trackerNames,
        trackerStates: this.trackerStates
      }
      
      // Update the hyperate section in the main config
      configManager.updateHyperateConfig(config)
      debug.info('HypeRate config saved via config manager')
    } catch (error) {
      debug.logError(`Failed to save HypeRate config: ${(error as Error).message}`)
    }
  }
  isEnabled(): boolean {
    return this.enabled
  }
  start(oscService: OscService | null = null): boolean {
    this.secrets = this.loadSecrets()
    if (!this.secrets || !this.secrets.hyperate || !this.secrets.hyperate.apiKey) {
      debug.logError('Cannot start HypeRate: No API key found in secrets.json')
      return false
    }
    if (this.enabled) {
      debug.warn('HypeRate addon already running')
      return true
    }
    this.enabled = true
    this.oscService = oscService // OSC service is optional
    this.lastError = null // Clear any previous errors
    this.prepareHrStatement()
    this.startHrTimers()
    this.notifyStatusChange() // Notify UI of state change immediately
    // Spawn one connection loop per tracker currently in config (config.json
    // order — see this.getTrackers() which iterates this.config.trackers).
    // Each loop manages its own WS, heartbeat, watchdog, and reconnect so
    // adding/removing one tracker never disturbs the others.
    this.startAllTrackers()
    debug.info('HypeRate addon started')
    return true
  }
  stop(): void {
    if (!this.enabled) {
      debug.info('HypeRate addon already stopped')
      return
    }
    debug.info('HypeRate addon stopping...')
    this.enabled = false
    this.lastError = null // Clear error on manual stop
    this.stopAllTrackers()
    this.stopHrTimers()
    this.flushHrBuffer()
    this.notifyStatusChange() // Notify UI of state change immediately
    debug.info('HypeRate addon stopped successfully')
  }
  /** Spawn a connection loop for every tracker in config.trackers, in order. */
  startAllTrackers(): void {
    const ids = this.config.trackers || []
    for (const id of ids) {
      this.startTracker(id)
    }
  }
  /** Tear down every per-tracker connection loop. */
  stopAllTrackers(): void {
    for (const id of Array.from(this.connections.keys())) {
      this.stopTracker(id)
    }
  }
  /**
   * Open (or reuse) a connection loop for a single tracker. Idempotent: a
   * no-op if a slot already exists for this id.
   */
  startTracker(deviceId: string): void {
    if (!this.enabled) return
    if (!this.secrets || !this.secrets.hyperate || !this.secrets.hyperate.apiKey) {
      debug.logError(`Cannot start tracker ${deviceId}: No API key`)
      return
    }
    if (this.connections.has(deviceId)) {
      // Already running — nothing to do. (Re)joinChannel on demand is
      // handled by joinChannel() below.
      return
    }
    const slot: ConnectionSlot = {
      ws: null,
      heartbeatInterval: null,
      reconnectTimeout: null,
      watchdogInterval: null,
      watchdogCount: 0,
      lastHrUpdate: null,
      reconnectAttempts: 0,
      cancelled: false
    }
    this.connections.set(deviceId, slot)
    // Insert into this.trackers as well so getTrackers() reports it.
    if (!this.trackers.has(deviceId)) {
      this.trackers.set(deviceId, { joinedAt: Date.now(), lastHeartRate: 0 })
    }
    this.connectTracker(deviceId)
  }
  /** Close + cleanup a single tracker's loop. */
  stopTracker(deviceId: string): void {
    const slot = this.connections.get(deviceId)
    if (!slot) return
    slot.cancelled = true
    // Best-effort phx_leave
    if (slot.ws && slot.ws.readyState === WebSocket.OPEN) {
      try {
        slot.ws.send(JSON.stringify({
          topic: `hr:${deviceId}`,
          event: 'phx_leave',
          payload: {},
          ref: 0
        }))
      } catch (e) {
        debug.warn(`[hyperate] phx_leave send failed for ${deviceId}: ${(e as Error).message}`)
      }
    }
    if (slot.heartbeatInterval) { clearInterval(slot.heartbeatInterval); slot.heartbeatInterval = null }
    if (slot.watchdogInterval) { clearInterval(slot.watchdogInterval); slot.watchdogInterval = null }
    if (slot.reconnectTimeout) { clearTimeout(slot.reconnectTimeout); slot.reconnectTimeout = null }
    if (slot.ws) {
      try { slot.ws.removeAllListeners() } catch { /* ignore */ }
      try {
        if (slot.ws.readyState === WebSocket.OPEN || slot.ws.readyState === WebSocket.CONNECTING) {
          slot.ws.close()
        }
      } catch { /* ignore */ }
      slot.ws = null
    }
    this.connections.delete(deviceId)
    // Keep this.trackers intact so the UI still shows the row at the right
    // position with isActive:false until the user explicitly removes it.
    debug.info(`[hyperate] stopped connection for ${deviceId}`)
  }
  /** Open a fresh WebSocket for the given tracker and wire up the lifecycle. */
  connectTracker(deviceId: string): void {
    const slot = this.connections.get(deviceId)
    if (!slot) return
    if (slot.cancelled) return
    const apiKey = this.secrets!.hyperate!.apiKey
    const apiUrl = `wss://app.hyperate.io/socket/websocket?token=${apiKey}`
    debug.info(`[hyperate:${deviceId}] connecting...`)
    try {
      const ws = new WebSocket(apiUrl)
      slot.ws = ws
      ws.on('open', () => {
        if (slot.cancelled) { try { ws.close() } catch { /* ignore */ } return }
        slot.reconnectAttempts = 0
        slot.lastHrUpdate = null
        slot.watchdogCount = 0
        debug.info(`[hyperate:${deviceId}] connected`)
        // Join this tracker's topic immediately. Each socket only subscribes
        // to one hr:X topic to avoid the HypeRate fan-out limitation.
        try {
          ws.send(JSON.stringify({
            topic: `hr:${deviceId}`,
            event: 'phx_join',
            payload: {},
            ref: 0
          }))
          debug.info(`[hyperate:${deviceId}] phx_join sent`)
        } catch (e) {
          debug.warn(`[hyperate:${deviceId}] phx_join failed: ${(e as Error).message}`)
        }
        this.setupHeartbeat(deviceId)
        this.setupWatchdog(deviceId)
        // Emit a snapshot so the UI re-renders with isActive:true for this
        // tracker.
        this.notifyStatusChange()
      })
      ws.on('close', () => {
        debug.info(`[hyperate:${deviceId}] connection closed`)
        if (slot.heartbeatInterval) { clearInterval(slot.heartbeatInterval); slot.heartbeatInterval = null }
        if (slot.watchdogInterval) { clearInterval(slot.watchdogInterval); slot.watchdogInterval = null }
        slot.ws = null
        this.notifyStatusChange()
        if (this.enabled && !slot.cancelled) {
          this.scheduleReconnect(deviceId)
        }
      })
      ws.on('error', (error: Error) => {
        debug.logError(`[hyperate:${deviceId}] WS error: ${error.message}`)
        if (!this.lastError) this.lastError = error.message || 'Connection error'
        this.notifyStatusChange()
      })
      ws.on('message', (data: WebSocket.RawData) => {
        try {
          const message = JSON.parse(data.toString())
          this.handleMessage(deviceId, message)
        } catch (error) {
          debug.logError(`[hyperate:${deviceId}] message parse error: ${(error as Error).message}`)
        }
      })
    } catch (error) {
      debug.logError(`[hyperate:${deviceId}] failed to create WebSocket: ${(error as Error).message}`)
      this.scheduleReconnect(deviceId)
    }
  }
  /** Schedule a single tracker's reconnect after a closed/failed socket. */
  scheduleReconnect(deviceId: string): void {
    const slot = this.connections.get(deviceId)
    if (!slot || slot.cancelled) return
    if (slot.reconnectTimeout) return
    if (slot.reconnectAttempts >= this.maxReconnectAttempts) {
      debug.warn(`[hyperate:${deviceId}] max reconnect attempts reached — resetting counter`)
      slot.reconnectAttempts = 0
    }
    slot.reconnectAttempts++
    debug.info(`[hyperate:${deviceId}] scheduling reconnect attempt ${slot.reconnectAttempts} in ${this.reconnectDelay / 1000}s`)
    slot.reconnectTimeout = setTimeout(() => {
      slot.reconnectTimeout = null
      if (this.enabled && !slot.cancelled) {
        this.connectTracker(deviceId)
      }
    }, this.reconnectDelay)
    this.notifyStatusChange()
  }
  /** Per-tracker heartbeat. */
  setupHeartbeat(deviceId: string): void {
    const slot = this.connections.get(deviceId)
    if (!slot) return
    if (slot.heartbeatInterval) clearInterval(slot.heartbeatInterval)
    slot.heartbeatInterval = setInterval(() => {
      if (!slot.ws || slot.ws.readyState !== WebSocket.OPEN) return
      try {
        slot.ws.send(JSON.stringify({
          topic: 'phoenix',
          event: 'heartbeat',
          payload: {},
          ref: 0
        }))
      } catch (error) {
        debug.warn(`[hyperate:${deviceId}] heartbeat send failed: ${(error as Error).message}`)
        try { slot.ws!.close() } catch { /* ignore */ }
      }
    }, 30000)
  }
  /** Per-tracker watchdog: re-join or force reconnect on stale data. */
  setupWatchdog(deviceId: string): void {
    const slot = this.connections.get(deviceId)
    if (!slot) return
    if (slot.watchdogInterval) clearInterval(slot.watchdogInterval)
    slot.watchdogCount = 0
    slot.watchdogInterval = setInterval(() => {
      const now = Date.now()
      const stale = slot.lastHrUpdate === null || (now - slot.lastHrUpdate) > this.STALE_THRESHOLD_MS
      if (!stale) {
        slot.watchdogCount = 0
        return
      }
      slot.watchdogCount++
      const since = slot.lastHrUpdate
        ? `${Math.round((now - slot.lastHrUpdate) / 1000)}s ago`
        : 'never'
      if (slot.watchdogCount >= 2) {
        debug.warn(`[hyperate:${deviceId}] watchdog: ${slot.watchdogCount} stale checks — forcing reconnect (last HR: ${since})`)
        slot.reconnectAttempts = 0
        try { slot.ws?.close() } catch { /* ignore */ }
      } else {
        debug.warn(`[hyperate:${deviceId}] watchdog: no HR for ${since} — re-joining (attempt ${slot.watchdogCount})`)
        if (slot.ws && slot.ws.readyState === WebSocket.OPEN) {
          try {
            slot.ws.send(JSON.stringify({
              topic: `hr:${deviceId}`,
              event: 'phx_join',
              payload: {},
              ref: 0
            }))
          } catch (e) {
            debug.warn(`[hyperate:${deviceId}] watchdog phx_join failed: ${(e as Error).message}`)
          }
        }
      }
    }, 30000)
  }
  /** Backwards-compat: no longer needed (each tracker auto-starts on add), but
   *  kept so any external callers don't break. Just delegates to startAllTrackers. */
  loadSavedTrackers(): void {
    debug.info('loadSavedTrackers() is a no-op now; trackers start via startAllTrackers()')
  }
  /** Public API: ensure a tracker has a live connection. Idempotent. */
  joinChannel(deviceId: string): boolean {
    if (!this.enabled) {
      debug.warn(`Cannot join HypeRate channel ${deviceId}: addon not enabled`)
      return false
    }
    this.startTracker(deviceId)
    // Set as primary if no primary exists.
    if (!this.primaryTracker) {
      this.primaryTracker = deviceId
      this.saveConfig()
    }
    debug.info(`Joined HypeRate channel: ${deviceId}`)
    return true
  }
  /** Public API: stop a tracker's connection (data still in config). */
  leaveChannel(deviceId: string): boolean {
    this.stopTracker(deviceId)
    // If removing primary tracker, set new primary based on remaining config.
    if (this.primaryTracker === deviceId) {
      const remaining = (this.config.trackers || []).filter(id => id !== deviceId)
      this.primaryTracker = remaining.length > 0 ? remaining[0] : null
      this.saveConfig()
    }
    debug.info(`Left HypeRate channel: ${deviceId}`)
    return true
  }
  handleMessage(slotId: string, data: { event: string, topic: string, payload: unknown }): void {
    // Each slot only subscribes to its own topic, so any hr_update arriving
    // here is for slotId. (We still cross-check the topic defensively in
    // case HypeRate ever broadcasts on a different topic.)
    if (data.event === "hr_update") {
      this.handleHeartRateUpdate(slotId, data as { event: string, topic: string, payload: { hr: number } })
    }
  }
  handleHeartRateUpdate(slotId: string, data: { event: string, topic: string, payload: { hr: number } }): void {
    try {
      const topicId = data.topic.split(":")[1]
      const heartRate = data.payload.hr
      if (!topicId || typeof heartRate !== 'number') {
        debug.warn(`[hyperate] Invalid heart rate data received on slot ${slotId}`)
        return
      }
      // Defensive: ensure the message topic matches the slot that received it.
      if (topicId !== slotId) {
        debug.warn(`[hyperate] hr_update topic ${topicId} != slot ${slotId}; ignoring (cross-topic leak)`)
        return
      }
      const deviceId = slotId
      // Update per-slot watchdog state.
      const slot = this.connections.get(deviceId)
      if (slot) {
        slot.lastHrUpdate = Date.now()
        slot.watchdogCount = 0
      }
      // Update tracker data (shared `this.trackers` map).
      if (this.trackers.has(deviceId)) {
        const tracker = this.trackers.get(deviceId)!
        tracker.lastHeartRate = heartRate
        tracker.lastUpdate = Date.now()
        this.trackers.set(deviceId, tracker)
      }
      this.bufferHrReading(deviceId, heartRate)
      // Always notify the renderer of per-tracker updates so non-primary
      // trackers update live instead of waiting on the 2s polling fallback.
      if (typeof this.onHeartRateUpdate === 'function') {
        this.onHeartRateUpdate({ heartRate, deviceId })
      }
      // Only the primary drives the OSC parameter + the legacy lastHeartRate
      // field on status (used by getStatus() / polling refresh).
      if (deviceId === this.primaryTracker) {
        this.lastHeartRate = heartRate
        this.sendHeartRateToVRChat(heartRate)
      }
    } catch (error) {
      debug.logError(`Error handling heart rate update: ${(error as Error).message}`)
    }
  }
  sendHeartRateToVRChat(heartRate: number): void {
    // Check if OSC service is available and listening before attempting to send
    if (!this.oscService || !this.oscService.isListening) {
      return
    }
    const address = '/avatar/parameters/ARCOSC/Heartrate/Value'
    this.oscService.sendMessage(address, heartRate, 'f')
  }
  addTracker(deviceId: string, deviceName: string | null = null): boolean {
    if (!deviceId || typeof deviceId !== 'string') {
      debug.warn('Invalid device ID provided to addTracker')
      return false
    }
    // Check if tracker already exists in saved trackers or active trackers
    const savedTrackers = this.config.trackers || []
    if (this.trackers.has(deviceId) || savedTrackers.includes(deviceId)) {
      debug.info(`Tracker ${deviceId} already exists`)
      return true
    }
    // Save device name if provided
    if (deviceName && deviceName.trim()) {
      this.trackerNames[deviceId] = deviceName.trim()
    }
    // Add to saved trackers list
    if (!savedTrackers.includes(deviceId)) {
      this.config.trackers = [...savedTrackers, deviceId]
    }
    // Set as primary if no primary exists
    if (!this.primaryTracker) {
      this.primaryTracker = deviceId
    }
    // Save configuration regardless of connection state
    this.saveConfig()
    // If the addon is enabled, kick off a per-tracker connection loop for the
    // newly-added id. Otherwise the connection will start on the next
    // startAllTrackers() call (i.e. when the user enables the addon).
    if (this.enabled) {
      this.joinChannel(deviceId)
      debug.info(`Added and started HypeRate tracker: ${deviceId}`)
    } else {
      debug.info(`Added HypeRate tracker: ${deviceId} (will connect when HypeRate starts)`)
    }
    return true
  }
  removeTracker(deviceId: string): boolean {
    // Check if tracker exists in either active trackers or saved trackers
    const savedTrackers = this.config.trackers || []
    const existsInActive = this.trackers.has(deviceId)
    const existsInSaved = savedTrackers.includes(deviceId)
    if (!existsInActive && !existsInSaved) {
      debug.warn(`Tracker ${deviceId} not found`)
      return false
    }
    // Always tear down the connection slot (if any) for the removed tracker.
    if (this.connections.has(deviceId)) {
      this.stopTracker(deviceId)
    }
    // Drop from runtime trackers map so the UI doesn't show it as active.
    this.trackers.delete(deviceId)
    // Remove from saved trackers list (preserves order of remaining entries).
    if (existsInSaved) {
      this.config.trackers = savedTrackers.filter(id => id !== deviceId)
    }
    // Remove device name
    delete this.trackerNames[deviceId]
    // If removing primary tracker, set new primary
    if (this.primaryTracker === deviceId) {
      const remainingTrackers = this.config.trackers || []
      this.primaryTracker = remainingTrackers.length > 0 ? remainingTrackers[0] : null
    }
    this.saveConfig()
    debug.info(`Removed HypeRate tracker: ${deviceId}`)
    return true
  }
  updateTrackerName(deviceId: string, newName: string | null): boolean {
    if (!this.trackers.has(deviceId) && !this.config.trackers.includes(deviceId)) {
      debug.warn(`Cannot update name: ${deviceId} not found`)
      return false
    }
    if (newName && newName.trim()) {
      this.trackerNames[deviceId] = newName.trim()
    } else {
      delete this.trackerNames[deviceId]
    }
    this.saveConfig()
    debug.info(`Updated tracker name for ${deviceId}: ${newName}`)
    return true
  }
  updateTrackerState(deviceId: string, enabled: boolean): boolean {
    // Always return true since we no longer support enabling/disabling individual trackers
    return true
  }
  setPrimaryTracker(deviceId: string): boolean {
    const savedTrackers = this.config.trackers || []
    if (!this.trackers.has(deviceId) && !savedTrackers.includes(deviceId)) {
      debug.warn(`Cannot set primary tracker: ${deviceId} not found`)
      return false
    }
    this.primaryTracker = deviceId
    this.saveConfig()
    debug.info(`Set primary tracker to: ${deviceId}`)
    return true
  }
  getStatus() {
    this.secrets = this.loadSecrets()
    // "connected" is true if any per-tracker socket is currently OPEN.
    // "reconnecting" is true if any slot is currently in a backoff.
    const slots = Array.from(this.connections.values())
    const connected = slots.some(s => !!s.ws && s.ws.readyState === WebSocket.OPEN)
    const reconnecting = slots.some(s => !!s.reconnectTimeout)
    const maxAttempts = slots.reduce((m, s) => Math.max(m, s.reconnectAttempts), 0)
    return {
      enabled: this.enabled,
      connected,
      trackers: Array.from(this.trackers.keys()),
      primaryTracker: this.primaryTracker,
      lastHeartRate: this.lastHeartRate,
      reconnectAttempts: maxAttempts,
      maxReconnectAttempts: this.maxReconnectAttempts,
      hasApiKey: !!(this.secrets && this.secrets.hyperate && this.secrets.hyperate.apiKey),
      lastError: this.lastError,
      reconnecting
    }
  }
  // --- HR History DB methods ---
  private prepareHrStatement(): void {
    try {
      const db = getDb()
      this.hrFlushStmt = db.prepare(
        'INSERT INTO heartrate_log (tracker_id, recorded_at, heart_rate) VALUES (?, ?, ?)'
      )
      debug.info('[HypeRate] HR statement prepared')
    } catch (error) {
      debug.error(`[HypeRate] HR statement prep failed: ${(error as Error).message}`)
    }
  }
  private bufferHrReading(trackerId: string, heartRate: number): void {
    if (heartRate <= 0) return
    this.hrWriteBuffer.push({ trackerId, heartRate, recordedAt: Date.now() })
  }
  private flushHrBuffer(): void {
    if (!this.hrFlushStmt || this.hrWriteBuffer.length === 0) return
    const batch = this.hrWriteBuffer.splice(0, this.hrWriteBuffer.length)
    try {
      const db = getDb()
      const insertMany = db.transaction((rows: typeof batch) => {
        for (const row of rows) {
          this.hrFlushStmt!.run(row.trackerId, row.recordedAt, row.heartRate)
        }
      })
      insertMany(batch)
    } catch (error) {
      debug.error(`[HypeRate] HR flush failed: ${(error as Error).message}`)
    }
  }
  private startHrTimers(): void {
    this.stopHrTimers()
    this.hrFlushTimer = setInterval(() => this.flushHrBuffer(), HyperateAddon.HR_FLUSH_MS)
    this.hrCleanupTimer = setInterval(() => {
      const ret = this.getHistoryRetention()
      this.runHrCleanup(ret)
    }, HyperateAddon.HR_CLEANUP_MS)
  }
  private stopHrTimers(): void {
    if (this.hrFlushTimer) { clearInterval(this.hrFlushTimer); this.hrFlushTimer = null }
    if (this.hrCleanupTimer) { clearInterval(this.hrCleanupTimer); this.hrCleanupTimer = null }
  }
  private runHrCleanup(retentionDays: number): void {
    const retentionMs = HyperateAddon.HR_RETENTION_MAP[retentionDays in HyperateAddon.HR_RETENTION_MAP ? retentionDays : 7]
    if (retentionMs === -1) return
    try {
      const db = getDb()
      const cutoff = Date.now() - retentionMs
      const result = db.prepare('DELETE FROM heartrate_log WHERE recorded_at < ?').run(cutoff)
      if (result.changes > 0) {
        debug.info(`[HypeRate] Cleaned up ${result.changes} old HR records`)
      }
    } catch (error) {
      debug.error(`[HypeRate] HR cleanup failed: ${(error as Error).message}`)
    }
  }
  getHistory(trackerId: string, fromMs: number, toMs: number, maxPoints?: number) {
    this.flushHrBuffer()
    try {
      const db = getDb()
      let rows: { recorded_at: number; heart_rate: number }[]
      if (maxPoints && maxPoints > 0) {
        const rangeMs = toMs - fromMs
        const bucketMs = rangeMs / maxPoints
        rows = db.prepare(`
          SELECT CAST((recorded_at - ?) / ? AS INTEGER) AS bucket,
                 AVG(heart_rate) AS heart_rate, MIN(recorded_at) AS recorded_at
          FROM heartrate_log
          WHERE tracker_id = ? AND recorded_at >= ? AND recorded_at <= ?
          GROUP BY bucket ORDER BY recorded_at ASC
        `).all(fromMs, bucketMs, trackerId, fromMs, toMs) as any[]
      } else {
        rows = db.prepare(`
          SELECT recorded_at, heart_rate FROM heartrate_log
          WHERE tracker_id = ? AND recorded_at >= ? AND recorded_at <= ?
          ORDER BY recorded_at ASC LIMIT 50000
        `).all(trackerId, fromMs, toMs) as any[]
      }
      return rows.map(r => ({ time: r.recorded_at, value: Math.round(r.heart_rate) }))
    } catch (error) {
      debug.error(`[HypeRate] HR query failed: ${(error as Error).message}`)
      return []
    }
  }
  getHistoryStats(trackerId: string, fromMs: number, toMs: number) {
    this.flushHrBuffer()
    try {
      const db = getDb()
      const row = db.prepare(`
        SELECT MIN(heart_rate) AS min_hr, MAX(heart_rate) AS max_hr,
               ROUND(AVG(heart_rate)) AS avg_hr, COUNT(*) AS count,
               MIN(recorded_at) AS first_at, MAX(recorded_at) AS last_at
        FROM heartrate_log
        WHERE tracker_id = ? AND recorded_at >= ? AND recorded_at <= ?
      `).get(trackerId, fromMs, toMs) as any
      if (!row || row.count === 0) {
        return { min: null, max: null, avg: null, count: 0, firstAt: null, lastAt: null }
      }
      return { min: row.min_hr, max: row.max_hr, avg: row.avg_hr, count: row.count, firstAt: row.first_at, lastAt: row.last_at }
    } catch (error) {
      debug.error(`[HypeRate] HR stats failed: ${(error as Error).message}`)
      return { min: null, max: null, avg: null, count: 0, firstAt: null, lastAt: null }
    }
  }
  getHistoryConfig() {
    return { retentionDays: this.getHistoryRetention() }
  }
  setHistoryRetention(retentionDays: number): boolean {
    configManager.updateHyperateConfig({ retentionDays } as any)
    this.runHrCleanup(retentionDays)
    debug.info(`[HypeRate] History retention set to ${retentionDays} days`)
    return true
  }
  getHistoryRetention(): number {
    const cfg = configManager.getHyperateConfig()
    return (cfg as any).retentionDays ?? 7
  }
  private loadCaptureRate(): number {
    const cfg = configManager.getHyperateConfig()
    const val = (cfg as any).captureRateMs
    return typeof val === 'number' && val >= 500 ? val : 2000
  }
  getCaptureRate(): number {
    return this.captureRateMs
  }
  setCaptureRate(ms: number): boolean {
    const clamped = Math.max(500, Math.min(30000, ms))
    this.captureRateMs = clamped
    configManager.updateHyperateConfig({ captureRateMs: clamped } as any)
    debug.info(`[HypeRate] Capture rate set to ${clamped}ms`)
    return true
  }
  getTrackers() {
    const trackerList: {
      deviceId: string
      name: string | null
      isPrimary: boolean
      isActive: boolean
      lastHeartRate: number
      lastUpdate: number | null
      joinedAt: number | null
    }[] = []
    // Order is the source of truth: saved config order (a JSON array, so
    // config.json order is preserved). Append any Map-only entries at the
    // end — these are trackers that joined the WS but never made it into
    // config (race during WS connect) and shouldn't reorder the UI.
    //
    // Previously this used `new Set([...map.keys(), ...config])` which
    // deduped but produced a non-deterministic order whenever Map insertion
    // order disagreed with config order.
    const seen = new Set<string>()
    const savedOrder = this.config.trackers || []
    for (const deviceId of savedOrder) {
      if (seen.has(deviceId)) continue
      seen.add(deviceId)
      const trackerData = this.trackers.get(deviceId)
      const isActive = this.enabled && !!trackerData
      trackerList.push({
        deviceId,
        name: this.trackerNames[deviceId] || null,
        isPrimary: deviceId === this.primaryTracker,
        isActive,
        lastHeartRate: isActive ? (trackerData!.lastHeartRate || 0) : 0,
        lastUpdate: isActive ? (trackerData!.lastUpdate || trackerData!.joinedAt) : null,
        joinedAt: isActive ? trackerData!.joinedAt : null
      })
    }
    for (const deviceId of this.trackers.keys()) {
      if (seen.has(deviceId)) continue
      seen.add(deviceId)
      const trackerData = this.trackers.get(deviceId)!
      trackerList.push({
        deviceId,
        name: this.trackerNames[deviceId] || null,
        isPrimary: deviceId === this.primaryTracker,
        isActive: this.enabled,
        lastHeartRate: this.enabled ? (trackerData.lastHeartRate || 0) : 0,
        lastUpdate: this.enabled ? (trackerData.lastUpdate || trackerData.joinedAt) : null,
        joinedAt: this.enabled ? trackerData.joinedAt : null
      })
    }
    return trackerList
  }
}
export default HyperateAddon