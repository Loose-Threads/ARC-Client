/**
 * useARCLink — shared state for the ARC Link module page.
 *
 * Holds the live link status, the reconstructed movement frame, and the
 * persisted configuration, and exposes the actions the page needs:
 * starting and stopping the link, and saving the configuration.
 *
 * The status and movement frames arrive as push events from the main
 * process, so the page updates live without polling. A slow poll is kept
 * as a safety net for the case where the renderer reloads while the
 * module is already running.
 */
import { ref, onMounted, onUnmounted } from 'vue'
import { useElectronAPI } from './useElectronAPI'

export interface ARCLinkFrame {
  forward: number
  strafe: number
  turn: number
}

export interface ARCLinkStatus {
  enabled: boolean
  connected: boolean
  connectionCount: number
  linkActive: boolean
  frame: ARCLinkFrame
  velocity: { x: number; y: number; z: number }
  angularY: number
  yaw: number
  yawValid: boolean
  stats: {
    received: number
    forwarded: number
    inbound: number
    applied: number
    echoSuppressed: number
  }
  lastError: string | null
}

export interface ARCLinkConfig {
  localIp: string
  inPort: number
  outPort: number
  peerIp: string
  peerOutPort: number
  vrchatIp: string
  vrchatInPort: number
  yawSign: number
  forwardIsNegativeZ: boolean
  angularYSign: number
  maxSpeed: number
  maxTurnRate: number
  smoothing: number
  deadzone: number
  refreshIntervalMs: number
  echoSuppressMs: number
  mirrorJump: boolean
  enableParameter: string
  startEnabled: boolean
  logging: boolean
  [key: string]: unknown
}

export const DEFAULT_ARCLINK_CONFIG: ARCLinkConfig = {
  localIp: '0.0.0.0',
  inPort: 9001,
  outPort: 9010,
  peerIp: '127.0.0.1',
  peerOutPort: 9010,
  vrchatIp: '127.0.0.1',
  vrchatInPort: 9000,
  yawSign: 1,
  forwardIsNegativeZ: false,
  angularYSign: 1,
  maxSpeed: 3.0,
  maxTurnRate: 2.0,
  smoothing: 0.35,
  deadzone: 0.02,
  refreshIntervalMs: 100,
  echoSuppressMs: 500,
  mirrorJump: true,
  enableParameter: 'ArcLink',
  startEnabled: false,
  logging: false
}

const EMPTY_STATUS: ARCLinkStatus = {
  enabled: false,
  connected: false,
  connectionCount: 0,
  linkActive: false,
  frame: { forward: 0, strafe: 0, turn: 0 },
  velocity: { x: 0, y: 0, z: 0 },
  angularY: 0,
  yaw: 0,
  yawValid: false,
  stats: { received: 0, forwarded: 0, inbound: 0, applied: 0, echoSuppressed: 0 },
  lastError: null
}

function normalizeStatus(result: unknown): ARCLinkStatus {
  if (!result || typeof result !== 'object') {
    return { ...EMPTY_STATUS }
  }
  const raw = result as Partial<ARCLinkStatus>
  return {
    ...EMPTY_STATUS,
    ...raw,
    frame: { ...EMPTY_STATUS.frame, ...(raw.frame ?? {}) },
    velocity: { ...EMPTY_STATUS.velocity, ...(raw.velocity ?? {}) },
    stats: { ...EMPTY_STATUS.stats, ...(raw.stats ?? {}) }
  }
}

function normalizeConfig(result: unknown): ARCLinkConfig {
  if (!result || typeof result !== 'object') {
    return { ...DEFAULT_ARCLINK_CONFIG }
  }
  return { ...DEFAULT_ARCLINK_CONFIG, ...(result as Partial<ARCLinkConfig>) }
}

export function useARCLink() {
  const api = useElectronAPI()
  const status = ref<ARCLinkStatus>({ ...EMPTY_STATUS })
  const config = ref<ARCLinkConfig>({ ...DEFAULT_ARCLINK_CONFIG })
  const saving = ref(false)
  const errorMessage = ref<string | null>(null)
  let pollTimer: ReturnType<typeof setInterval> | null = null

  async function refreshStatus() {
    try {
      const result = await api.arcLinkGetStatus()
      status.value = normalizeStatus(result)
    } catch (error) {
      errorMessage.value = (error as Error).message
    }
  }

  async function loadConfig() {
    try {
      config.value = normalizeConfig(await api.arcLinkGetConfig())
    } catch (error) {
      errorMessage.value = (error as Error).message
    }
  }

  async function saveConfig(updated: Partial<ARCLinkConfig>) {
    saving.value = true
    errorMessage.value = null
    try {
      const merged = { ...DEFAULT_ARCLINK_CONFIG, ...(config.value ?? {}), ...updated } as ARCLinkConfig
      const result = await api.arcLinkUpdateConfig(merged)
      if (result && result.success === false) {
        errorMessage.value = result.error ?? 'Failed to save the configuration'
      }
      await loadConfig()
      await refreshStatus()
    } catch (error) {
      errorMessage.value = (error as Error).message
    } finally {
      saving.value = false
    }
  }

  async function resetConfig() {
    await saveConfig({ ...DEFAULT_ARCLINK_CONFIG })
  }

  async function start() {
    errorMessage.value = null
    try {
      const result = await api.arcLinkStart()
      if (result && result.success === false) {
        errorMessage.value = result.error ?? 'Failed to start ARC Link'
      }
    } catch (error) {
      errorMessage.value = (error as Error).message
    }
    await refreshStatus()
  }

  async function stop() {
    errorMessage.value = null
    try {
      await api.arcLinkStop()
    } catch (error) {
      errorMessage.value = (error as Error).message
    }
    await refreshStatus()
  }

  async function toggle() {
    if (status.value.enabled) {
      await stop()
    } else {
      await start()
    }
  }

  function startPolling() {
    pollTimer = setInterval(refreshStatus, 1000)
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  onMounted(() => {
    refreshStatus()
    loadConfig()
    startPolling()
    api.onARCLinkStatusUpdate((data: any) => {
      status.value = normalizeStatus(data)
    })
    api.onARCLinkMovement((data: any) => {
      status.value = {
        ...status.value,
        frame: {
          forward: data?.forward ?? status.value.frame.forward,
          strafe: data?.strafe ?? status.value.frame.strafe,
          turn: data?.turn ?? status.value.frame.turn
        }
      }
    })
  })

  onUnmounted(() => {
    stopPolling()
    api.removeAllListeners('arclink-status-update')
    api.removeAllListeners('arclink-movement-data')
  })

  return {
    status,
    config,
    saving,
    errorMessage,
    start,
    stop,
    toggle,
    saveConfig,
    resetConfig,
    loadConfig,
    refreshStatus
  }
}
