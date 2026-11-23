<script setup lang="ts">
// Logic lives in the sibling SoundBoardPage.ts factory — keep this block thin.
import { createSoundBoardPageState } from './SoundBoardPage'
const {
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
} = createSoundBoardPageState()
</script>
<template>
  <div class="page-view">
    <div class="header">
      <h1>SoundBoard</h1>
      <p>Trigger sounds from incoming OSC messages and route playback to a chosen audio output device</p>
    </div>
    <div class="card planning-banner">
      <span class="planning-badge">Planning</span>
      <div>
        <h3>This module is in planning</h3>
        <p>
          The SoundBoard is a placeholder design while the feature is being planned. OSC trigger
          listening and audio device enumeration below are live previews — actual sound playback,
          file management, and device routing are not implemented yet.
        </p>
      </div>
    </div>
    <div class="card">
      <h3>Output Device</h3>
      <p class="section-hint">Sounds will play through the selected audio output device.</p>
      <div class="device-row">
        <select class="config-select" :value="selectedDeviceId" @change="selectDevice(($event.target as HTMLSelectElement).value)">
          <option value="">System default</option>
          <option v-for="device in outputDevices" :key="device.deviceId" :value="device.deviceId">{{ device.label }}</option>
        </select>
        <button class="btn btn-secondary btn-small" type="button" @click="refreshDevices">Refresh</button>
        <span class="device-current">Active: {{ selectedDeviceLabel }}</span>
      </div>
      <p v-if="outputDevices.length === 0" class="section-hint">
        No output devices found — they will appear once audio permissions are granted.
      </p>
    </div>
    <div class="card">
      <h3>OSC Triggers</h3>
      <p class="section-hint">Each trigger maps an incoming OSC address to a sound file.</p>
      <div class="trigger-list">
        <div v-for="trigger in triggers" :key="trigger.id" class="trigger-row" :class="{ disabled: !trigger.enabled }">
          <button
            class="trigger-toggle"
            type="button"
            :title="trigger.enabled ? 'Disable trigger' : 'Enable trigger'"
            @click="toggleTrigger(trigger.id)"
          >{{ trigger.enabled ? '●' : '○' }}</button>
          <span class="trigger-address">{{ trigger.address }}</span>
          <span class="trigger-arrow">→</span>
          <span class="trigger-sound">{{ trigger.soundName }}</span>
          <button class="trigger-remove" type="button" title="Remove trigger" @click="removeTrigger(trigger.id)">×</button>
        </div>
        <p v-if="triggers.length === 0" class="section-hint">No triggers yet — add one below.</p>
      </div>
      <div class="trigger-add-row">
        <input v-model="newTriggerAddress" type="text" placeholder="/avatar/parameters/..." @keyup.enter="addTrigger" />
        <input v-model="newTriggerSound" type="text" placeholder="sound file (e.g. airhorn.mp3)" @keyup.enter="addTrigger" />
        <button class="btn btn-primary btn-small" type="button" :disabled="!newTriggerAddress.trim()" @click="addTrigger">Add Trigger</button>
      </div>
      <p class="section-hint placeholder-note">Sound file assignment and playback are placeholders — not yet functional.</p>
    </div>
    <div class="card">
      <h3>OSC Activity</h3>
      <p class="section-hint">Live feed of incoming OSC messages (for trigger debugging).</p>
      <div v-if="recentEvents.length === 0" class="empty-state">
        <p>No OSC messages received yet</p>
        <p class="section-hint">Messages will appear here as they arrive from VRChat.</p>
      </div>
      <div v-else class="event-list">
        <div v-for="event in recentEvents" :key="event.id" class="event-row">
          <span class="event-time">{{ event.time }}</span>
          <span class="event-address">{{ event.address }}</span>
          <span class="event-value">{{ event.value }}</span>
        </div>
      </div>
    </div>
    <div class="card">
      <h3>Sound Library</h3>
      <div class="empty-state">
        <p>Sound library placeholder</p>
        <p class="section-hint">Imported sound files will be listed here with preview and per-sound volume controls.</p>
      </div>
    </div>
  </div>
</template>
<style scoped>
.planning-banner {
  display: flex;
  gap: 14px;
  align-items: flex-start;
  border-left: 4px solid #f39c12;
}
.planning-badge {
  flex-shrink: 0;
  background: #f39c12;
  color: #1a1a1a;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  padding: 4px 10px;
  border-radius: 999px;
}
.planning-banner h3 {
  margin-top: 0;
}
.planning-banner p {
  margin-bottom: 0;
  color: var(--text-tertiary);
  font-size: 13px;
}
.section-hint {
  font-size: 12px;
  color: var(--text-tertiary);
  margin: 6px 0;
}
.placeholder-note {
  opacity: 0.7;
  font-style: italic;
}
.device-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.config-select {
  padding: 6px 10px;
  border-radius: 6px;
  border: 1px solid rgba(0, 0, 0, 0.15);
  font-size: 13px;
  background: white;
  min-width: 220px;
}
.device-current {
  font-size: 12px;
  font-weight: 600;
  opacity: 0.75;
}
.trigger-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 12px;
}
.trigger-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.03);
  border: 1px solid rgba(0, 0, 0, 0.06);
  font-size: 13px;
}
.trigger-row.disabled {
  opacity: 0.5;
}
.trigger-toggle {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 14px;
  color: #2ecc71;
  padding: 0;
}
.trigger-row.disabled .trigger-toggle {
  color: var(--text-tertiary);
}
.trigger-address {
  font-family: monospace;
  font-size: 12px;
}
.trigger-arrow {
  opacity: 0.5;
}
.trigger-sound {
  font-weight: 600;
}
.trigger-remove {
  margin-left: auto;
  background: none;
  border: none;
  cursor: pointer;
  font-size: 16px;
  color: var(--text-tertiary);
  padding: 0 4px;
}
.trigger-remove:hover {
  color: #e74c3c;
}
.trigger-add-row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.trigger-add-row input {
  flex: 1;
  min-width: 160px;
  padding: 6px 10px;
  border-radius: 6px;
  border: 1px solid rgba(0, 0, 0, 0.15);
  font-size: 13px;
}
.event-list {
  max-height: 300px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.event-row {
  display: flex;
  gap: 12px;
  padding: 6px 10px;
  border-radius: 6px;
  font-size: 12px;
  background: rgba(0, 0, 0, 0.03);
  font-family: monospace;
}
.event-time {
  opacity: 0.6;
  flex-shrink: 0;
}
.event-address {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.event-value {
  font-weight: 600;
  flex-shrink: 0;
}
.empty-state {
  text-align: center;
  padding: 24px;
  color: var(--text-tertiary);
}
.empty-state p {
  margin: 4px 0;
}
</style>
