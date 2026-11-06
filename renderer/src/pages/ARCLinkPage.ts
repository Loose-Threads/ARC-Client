// ====
// ARCLinkPage state factory — sibling script module for ARCLinkPage.vue.
// Owns the config draft, the save/reset handlers, and the display
// formatting. Shared cross-page state lives in composables/useARCLink.ts.
// Call createARCLinkPageState() once from <script setup>.
// ====
import { ref, computed, watch } from 'vue'
import { useARCLink, DEFAULT_ARCLINK_CONFIG, type ARCLinkConfig } from '../composables/useARCLink'

export function createARCLinkPageState() {
  const { status, config, saving, errorMessage, start, stop, toggle, saveConfig, resetConfig } = useARCLink()

  const activeTab = ref<'status' | 'connection' | 'tuning' | 'advanced'>('status')
  const configDraft = ref<ARCLinkConfig>({ ...DEFAULT_ARCLINK_CONFIG })

  watch(
    config,
    (value) => {
      configDraft.value = { ...DEFAULT_ARCLINK_CONFIG, ...(value ?? {}) }
    },
    { immediate: true, deep: true }
  )

  const statusLabel = computed(() => {
    if (!status.value.enabled) return 'Stopped'
    if (status.value.linkActive) return 'Linking'
    return 'Running'
  })

  const statusColor = computed(() => {
    if (!status.value.enabled) return '#95a5a6'
    if (status.value.linkActive) return '#2ecc71'
    return '#f39c12'
  })

  const statusDetail = computed(() => {
    if (!status.value.enabled) return 'ARC Link is stopped. Start it to begin mirroring movement.'
    if (status.value.linkActive) return 'The link is active — your movement is being mirrored to the partner.'
    return 'ARC Link is running, but the link is not enabled yet. Set the avatar parameter or send /arclink/enable to switch it on.'
  })

  const yawDegrees = computed(() =>
    status.value.yawValid ? ((status.value.yaw * 180) / Math.PI).toFixed(1) : '—'
  )

  const speed = computed(() => {
    const v = status.value.velocity
    return Math.hypot(v.x, v.z).toFixed(2)
  })

  const portSummary = computed(() => {
    const c = configDraft.value
    return [
      `vrchat in  ${c.localIp}:${c.inPort}`,
      `link in    ${c.localIp}:${c.outPort}`,
      `peer       ${c.peerIp}:${c.peerOutPort}`,
      `vrchat out ${c.vrchatIp}:${c.vrchatInPort}`
    ].join('\n')
  })

  const configPreview = computed(() => {
    const c = configDraft.value
    return [
      `yawSign=${c.yawSign}`,
      `forwardIsNegativeZ=${c.forwardIsNegativeZ}`,
      `angularYSign=${c.angularYSign}`,
      `maxSpeed=${c.maxSpeed}`,
      `maxTurnRate=${c.maxTurnRate}`,
      `smoothing=${c.smoothing}`,
      `deadzone=${c.deadzone}`,
      `refreshIntervalMs=${c.refreshIntervalMs}`,
      `echoSuppressMs=${c.echoSuppressMs}`,
      `mirrorJump=${c.mirrorJump}`,
      `enableParameter=${c.enableParameter}`,
      `startEnabled=${c.startEnabled}`,
      `logging=${c.logging}`
    ].join('\n')
  })

  async function handleSave() {
    await saveConfig({ ...configDraft.value })
  }

  async function handleReset() {
    await resetConfig()
  }

  function onTabChange(tab: 'status' | 'connection' | 'tuning' | 'advanced') {
    activeTab.value = tab
  }

  function formatNumber(value: unknown, digits = 2): string {
    const num = Number(value)
    if (!Number.isFinite(num)) return '—'
    return num.toFixed(digits)
  }

  return {
    // composable state
    status,
    config,
    saving,
    errorMessage,
    start,
    stop,
    toggle,
    // page-local state
    activeTab,
    configDraft,
    // computed
    statusLabel,
    statusColor,
    statusDetail,
    yawDegrees,
    speed,
    portSummary,
    configPreview,
    // handlers
    onTabChange,
    handleSave,
    handleReset,
    // helpers
    formatNumber
  }
}
