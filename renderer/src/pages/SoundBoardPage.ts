// SoundBoard page state factory — sibling script module for SoundBoardPage.vue.
// Owns output-device enumeration, OSC trigger bindings, and the live OSC
// activity feed. Playback and device routing are placeholders while the
// feature is in planning; the OSC listener and device list are live.
import { ref, computed, onMounted } from 'vue'
import { useElectronAPI } from '../composables/useElectronAPI'

const STORAGE_KEY = 'soundboard.outputDeviceId'
let oscListenerRegistered = false
let nextEventId = 1
const recentEvents = ref<SoundBoardEvent[]>([])
const triggers = ref<SoundBoardTrigger[]>([
  { id: 'trigger-1', address: '/avatar/parameters/SoundBoard1', soundName: 'airhorn.mp3', enabled: true },
  { id: 'trigger-2', address: '/avatar/parameters/SoundBoard2', soundName: 'drum-roll.wav', enabled: true },
  { id: 'trigger-3', address: '/avatar/parameters/SoundBoard3', soundName: 'trombone.mp3', enabled: false }
])

export interface SoundBoardDevice {
  deviceId: string
  label: string
}

export interface SoundBoardTrigger {
  id: string
  address: string
  soundName: string
  enabled: boolean
}

export interface SoundBoardEvent {
  id: number
  address: string
  value: unknown
  time: string
}

export function createSoundBoardPageState() {
  const api = useElectronAPI()
  const isPlanning = true
  const outputDevices = ref<SoundBoardDevice[]>([])
  const selectedDeviceId = ref<string>(localStorage.getItem(STORAGE_KEY) ?? '')
  const newTriggerAddress = ref('')
  const newTriggerSound = ref('')

  const selectedDeviceLabel = computed(() => {
    const match = outputDevices.value.find((d) => d.deviceId === selectedDeviceId.value)
    return match?.label ?? 'System default'
  })

  async function refreshDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      outputDevices.value = devices
        .filter((d) => d.kind === 'audiooutput')
        .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Output device ${i + 1}` }))
      if (selectedDeviceId.value && !outputDevices.value.some((d) => d.deviceId === selectedDeviceId.value)) {
        selectedDeviceId.value = ''
      }
    } catch {
      outputDevices.value = []
    }
  }

  function selectDevice(deviceId: string) {
    selectedDeviceId.value = deviceId
    localStorage.setItem(STORAGE_KEY, deviceId)
  }

  function addTrigger() {
    const address = newTriggerAddress.value.trim()
    const soundName = newTriggerSound.value.trim()
    if (!address) return
    triggers.value.push({
      id: `trigger-${Date.now()}`,
      address,
      soundName: soundName || 'unassigned',
      enabled: true
    })
    newTriggerAddress.value = ''
    newTriggerSound.value = ''
  }

  function removeTrigger(id: string) {
    triggers.value = triggers.value.filter((t) => t.id !== id)
  }

  function toggleTrigger(id: string) {
    const trigger = triggers.value.find((t) => t.id === id)
    if (trigger) trigger.enabled = !trigger.enabled
  }

  function handleOscReceived(data: { address?: string; value?: unknown }) {
    if (!data?.address) return
    recentEvents.value.unshift({
      id: nextEventId++,
      address: data.address,
      value: data.value,
      time: new Date().toLocaleTimeString()
    })
    if (recentEvents.value.length > 50) recentEvents.value.length = 50
  }

  onMounted(() => {
    void refreshDevices()
    if (oscListenerRegistered) return
    oscListenerRegistered = true
    api.onOscReceived(handleOscReceived)
    api.onOscReceivedBatch((batch: unknown) => {
      if (Array.isArray(batch)) batch.forEach((d) => handleOscReceived(d as { address?: string; value?: unknown }))
    })
  })

  return {
    isPlanning,
    outputDevices,
    selectedDeviceId,
    selectedDeviceLabel,
    triggers,
    recentEvents,
    newTriggerAddress,
    newTriggerSound,
    refreshDevices,
    selectDevice,
    addTrigger,
    removeTrigger,
    toggleTrigger
  }
}
