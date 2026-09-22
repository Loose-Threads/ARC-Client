import { onMounted, ref } from 'vue'
import { useElectronAPI } from './useElectronAPI'
import { debugLog } from './useDebugLog'

type ServerType = 'live' | 'beta' | 'custom'

const SERVER_URLS: Record<ServerType, string> = {
    live: 'wss://arcosc.app:48255',
    beta: 'wss://beta.arcosc.app:48255',
    custom: 'wss://127.0.0.1:48255'
}

const serverUrl = ref('wss://arcosc.app:48255')
const activeServer = ref<ServerType>('live')
const snowEnabled = ref(true)
const logLevel = ref('info')
const clientVersion = ref('')
const runtimeDisplay = ref('00:00:00')

/* ----- Theme system additions (style-only, no logic impact) ----- */
export type ThemePreset = 'aurora' | 'gothic' | 'gothic-purple' | 'terminal'
export type Density = 'compact' | 'default' | 'comfortable'
export type FontScale = 'compact' | 'default' | 'large'

export interface AppearanceSettings {
    preset: ThemePreset
    density: Density
    fontScale: FontScale
    accent: string
    radiusScale: number
    reducedMotion: boolean
}

const DEFAULT_APPEARANCE: AppearanceSettings = {
    preset: 'aurora',
    density: 'default',
    fontScale: 'default',
    accent: '',
    radiusScale: 1,
    reducedMotion: false
}

const appearance = ref<AppearanceSettings>({ ...DEFAULT_APPEARANCE })

function applyAppearance(a: AppearanceSettings) {
    if (typeof document === 'undefined') return
    const root = document.documentElement
    // App is dark-only — always set dark-theme on body so the
    // :global(body.dark-theme) overrides in pages apply universally.
    document.body.classList.add('dark-theme')
    root.setAttribute('data-theme', a.preset)
    root.setAttribute('data-density', a.density)
    root.setAttribute('data-font-scale', a.fontScale)
    root.setAttribute('data-motion', a.reducedMotion ? 'reduced' : 'normal')
    root.style.setProperty('--radius-scale', String(a.radiusScale))
    if (a.accent && a.accent.trim() !== '') {
        root.style.setProperty('--accent', a.accent)
        root.style.setProperty('--accent-soft', hexToRgba(a.accent, 0.18))
    } else {
        root.style.removeProperty('--accent')
        root.style.removeProperty('--accent-soft')
    }
}

function hexToRgba(hex: string, alpha: number): string {
    let h = hex.replace('#', '').trim()
    if (h.length === 3) {
        h = h.split('').map((c) => c + c).join('')
    }
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return `rgba(52, 152, 219, ${alpha})`
    const r = parseInt(h.slice(0, 2), 16)
    const g = parseInt(h.slice(2, 4), 16)
    const b = parseInt(h.slice(4, 6), 16)
    return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

async function persistAppearance(a: AppearanceSettings) {
    try {
        const api = useElectronAPI()
        const settings = await api.getAppSettings()
        settings.appearance = a
        await api.setAppSettings(settings)
    } catch (e) {
        debugLog(`Failed to persist appearance settings: ${String(e)}`)
    }
    // Mirror to localStorage so the boot script in index.html can apply
    // the theme synchronously on next launch.
    try {
        if (typeof localStorage !== 'undefined') {
            localStorage.setItem('arc.appearance', JSON.stringify(a))
        }
    } catch {
        // ignore (storage may be unavailable)
    }
}

async function setAppearance(patch: Partial<AppearanceSettings>) {
    appearance.value = { ...appearance.value, ...patch }
    applyAppearance(appearance.value)
    await persistAppearance(appearance.value)
}

async function setAccent(color: string) {
    await setAppearance({ accent: color })
}

async function setRadiusScale(scale: number) {
    await setAppearance({ radiusScale: scale })
}

async function setPreset(preset: ThemePreset) {
    await setAppearance({ preset })
}

async function setDensity(density: Density) {
    await setAppearance({ density })
}

async function setFontScale(fontScale: FontScale) {
    await setAppearance({ fontScale })
}

async function setReducedMotion(reducedMotion: boolean) {
    await setAppearance({ reducedMotion })
}
/* ----- End theme system additions ----- */

let startTime = Date.now()
let runtimeInterval: ReturnType<typeof setInterval> | null = null
let settingsInitialized = false
let settingsInitPromise: Promise<void> | null = null

export function useSettings() {
    const api = useElectronAPI()

    function detectServer(url: string): ServerType {
        if (url.includes('beta.arcosc.app')) return 'beta'
        if (url.includes('arcosc.app')) return 'live'
        return 'custom'
    }
    function updateRuntime() {
        const elapsed = Date.now() - startTime
        const h = Math.floor(elapsed / 3600000)
        const m = Math.floor((elapsed % 3600000) / 60000)
        const s = Math.floor((elapsed % 60000) / 1000)
        runtimeDisplay.value = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    }
    async function loadSettings() {
        const config = await api.getServerConfig()
        serverUrl.value = config.websocketServerUrl ?? 'wss://arcosc.app:48255'
        activeServer.value = detectServer(serverUrl.value)
        debugLog('Configuration loaded from saved settings')
        const settings = await api.getAppSettings()
        snowEnabled.value = settings?.snowEnabled !== false
        logLevel.value = settings?.logLevel ?? 'info'
        /* Load appearance if present (otherwise use defaults) */
        const savedAppearance = (settings as any)?.appearance as Partial<AppearanceSettings> | undefined
        if (savedAppearance) {
            appearance.value = { ...DEFAULT_APPEARANCE, ...savedAppearance }
            applyAppearance(appearance.value)
        } else {
            applyAppearance(appearance.value)
        }
        debugLog('Application settings loaded from saved config')
        const ver = await api.getClientVersion()
        clientVersion.value = ver ?? ''
    }
    async function toggleSnow() {
        snowEnabled.value = !snowEnabled.value
        const settings = await api.getAppSettings()
        settings.snowEnabled = snowEnabled.value
        await api.setAppSettings(settings)
        debugLog(`Snow overlay ${snowEnabled.value ? 'enabled' : 'disabled'}`)
    }
    async function switchToServer(type: ServerType) {
        const url = type === 'custom' ? serverUrl.value : SERVER_URLS[type]
        serverUrl.value = url
        activeServer.value = type
        await api.setConfig({ websocketServerUrl: url })
    }
    async function updateCustomServerUrl(url: string) {
        if (url.includes('arcosc.app') || url.includes('beta.arcosc.app')) return
        serverUrl.value = url
        activeServer.value = 'custom'
        await api.setConfig({ websocketServerUrl: url })
    }
    async function updateLogLevel(level: string) {
        logLevel.value = level
        const settings = await api.getAppSettings()
        settings.logLevel = level
        await api.setAppSettings(settings)
        debugLog(`Application settings updated - Log level: ${level}`)
    }
    async function getDebugStats() {
        return api.getDebugStats()
    }
    async function getMemoryStats() {
        return api.getMemoryStats()
    }
    async function forceMemoryCleanup() {
        return api.forceMemoryCleanup()
    }
    async function clearDebugLogs() {
        return api.clearDebugLogs()
    }
    async function initialize() {
        if (settingsInitialized) return
        if (settingsInitPromise) return settingsInitPromise
        settingsInitPromise = (async () => {
            await loadSettings()
            startTime = Date.now()
            updateRuntime()
            if (!runtimeInterval) {
                runtimeInterval = setInterval(updateRuntime, 1000)
            }
            debugLog('Application initialized')
            settingsInitialized = true
        })()
        await settingsInitPromise
    }

    onMounted(async () => {
        await initialize()
    })

    return {
        serverUrl,
        activeServer,
        snowEnabled,
        logLevel,
        clientVersion,
        runtimeDisplay,
        toggleSnow,
        switchToServer,
        updateCustomServerUrl,
        updateLogLevel,
        getDebugStats,
        getMemoryStats,
        forceMemoryCleanup,
        clearDebugLogs,
        /* Theme system additions */
        appearance,
        setAppearance,
        setAccent,
        setRadiusScale,
        setPreset,
        setDensity,
        setFontScale,
        setReducedMotion
    }
}
