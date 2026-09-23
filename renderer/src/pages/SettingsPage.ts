// ====
// SettingsPage state factory — sibling script module for SettingsPage.vue.
// Owns the custom-server URL draft, pending log level, debug/memory stats
// display state, and their load/apply handlers.
// Shared state lives in composables/useSettings.ts.
// Call createSettingsPageState() once from <script setup>.
// ====
import { ref, watch } from 'vue'
import {
  useSettings,
  type ThemePreset,
  type Density,
  type FontScale
} from '../composables/useSettings'

const PRESET_OPTIONS: Array<{ value: ThemePreset; label: string; description: string }> = [
  { value: 'original', label: 'Original', description: 'Flat slate with classic blue accent' },
  { value: 'aurora', label: 'Aurora Soft', description: 'Clean, friendly, modern flat' },
  { value: 'gothic', label: 'Gothic Crimson', description: 'Velvet blacks with deep crimson accents' },
  { value: 'gothic-purple', label: 'Gothic Purple', description: 'Deep violet, glossy, dark cathedral' },
  { value: 'terminal', label: 'Terminal Mono', description: 'Amber HUD / monospace' }
]

const DENSITY_OPTIONS: Array<{ value: Density; label: string }> = [
  { value: 'compact', label: 'Compact' },
  { value: 'default', label: 'Default' },
  { value: 'comfortable', label: 'Comfortable' }
]

const FONT_SCALE_OPTIONS: Array<{ value: FontScale; label: string }> = [
  { value: 'compact', label: 'Small' },
  { value: 'default', label: 'Default' },
  { value: 'large', label: 'Large' }
]

export function createSettingsPageState() {
  const {
    serverUrl, activeServer, logLevel,
    switchToServer,
    updateCustomServerUrl, updateLogLevel,
    getDebugStats, getMemoryStats, forceMemoryCleanup, clearDebugLogs,
    appearance,
    setPreset, setDensity, setFontScale,
    setAccent, setRadiusScale, setReducedMotion
  } = useSettings()
  const customUrl = ref('')
  const pendingLogLevel = ref<'info' | 'warn' | 'error'>('info')
  const debugStats = ref<any>(null)
  const memoryStats = ref<any>(null)
  const accentInput = ref(appearance.value.accent || '#3498db')
  const radiusInput = ref(appearance.value.radiusScale ?? 1)
  watch(serverUrl, (value) => {
    customUrl.value = value
  }, { immediate: true })
  watch(logLevel, (value) => {
    pendingLogLevel.value = value === 'warning' ? 'warn' : (value as 'info' | 'warn' | 'error')
  }, { immediate: true })
  watch(appearance, (value) => {
    accentInput.value = value.accent || '#3498db'
    radiusInput.value = value.radiusScale ?? 1
  }, { deep: true })
  async function handleCustomServer() {
    const url = customUrl.value.trim()
    if (!url) return
    await updateCustomServerUrl(url)
  }
  async function handleUpdateApplicationSettings() {
    await updateLogLevel(pendingLogLevel.value)
  }
  async function loadDebugStats() {
    debugStats.value = await getDebugStats()
  }
  async function loadMemoryStats() {
    memoryStats.value = await getMemoryStats()
  }
  async function handlePresetChange(e: Event) {
    await setPreset((e.target as HTMLSelectElement).value as ThemePreset)
  }
  async function handleDensityChange(e: Event) {
    await setDensity((e.target as HTMLSelectElement).value as Density)
  }
  async function handleFontScaleChange(e: Event) {
    await setFontScale((e.target as HTMLSelectElement).value as FontScale)
  }
  async function handleAccentChange(e: Event) {
    const v = (e.target as HTMLInputElement).value
    accentInput.value = v
    await setAccent(v)
  }
  async function handleResetAccent() {
    accentInput.value = ''
    await setAccent('')
  }
  async function handleRadiusChange(e: Event) {
    const v = Number((e.target as HTMLInputElement).value)
    radiusInput.value = v
    await setRadiusScale(v)
  }
  async function handleReducedMotionChange(e: Event) {
    await setReducedMotion((e.target as HTMLInputElement).checked)
  }
  return {
    serverUrl,
    activeServer,
    logLevel,
    switchToServer,
    forceMemoryCleanup,
    clearDebugLogs,
    customUrl,
    pendingLogLevel,
    debugStats,
    memoryStats,
    handleCustomServer,
    handleUpdateApplicationSettings,
    loadDebugStats,
    loadMemoryStats,
    /* Appearance additions */
    appearance,
    PRESET_OPTIONS,
    DENSITY_OPTIONS,
    FONT_SCALE_OPTIONS,
    accentInput,
    radiusInput,
    handlePresetChange,
    handleDensityChange,
    handleFontScaleChange,
    handleAccentChange,
    handleResetAccent,
    handleRadiusChange,
    handleReducedMotionChange
  }
}
