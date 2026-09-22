<script setup lang="ts">
// Logic lives in the sibling SettingsPage.ts factory — keep this block thin.
import { createSettingsPageState } from './SettingsPage'
const {
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
} = createSettingsPageState()
</script>

<template>
  <div class="page-view">
    <div class="header">
      <h1>Settings</h1>
      <p>Configure your ARC-OSC Client settings</p>
    </div>

    <div class="card">
      <h3>Appearance</h3>
      <p class="description-text">Customize the look and feel of the application. Changes apply instantly.</p>

      <div class="form-group">
        <label for="theme-preset">Theme Preset</label>
        <select id="theme-preset" :value="appearance.preset" @change="handlePresetChange">
          <option v-for="opt in PRESET_OPTIONS" :key="opt.value" :value="opt.value">
            {{ opt.label }} — {{ opt.description }}
          </option>
        </select>
      </div>

      <div class="form-group">
        <label for="theme-density">Density</label>
        <select id="theme-density" :value="appearance.density" @change="handleDensityChange">
          <option v-for="opt in DENSITY_OPTIONS" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
        </select>
        <small>Adjusts spacing and padding throughout the app.</small>
      </div>

      <div class="form-group">
        <label for="theme-fontscale">Font Size</label>
        <select id="theme-fontscale" :value="appearance.fontScale" @change="handleFontScaleChange">
          <option v-for="opt in FONT_SCALE_OPTIONS" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
        </select>
        <small>Scales all text proportionally.</small>
      </div>

      <div class="form-group">
        <label for="theme-accent">Accent Color</label>
        <div style="display: flex; align-items: center; gap: 10px;">
          <input
            id="theme-accent"
            type="color"
            :value="accentInput || '#3498db'"
            style="width: 56px; height: 36px; padding: 2px; cursor: pointer;"
            @input="handleAccentChange"
          />
          <input
            type="text"
            :value="accentInput"
            placeholder="#3498db"
            style="flex: 1; max-width: 200px;"
            @input="handleAccentChange"
          />
          <button type="button" class="btn btn-secondary btn-small" @click="handleResetAccent">Use Preset</button>
        </div>
        <small>Overrides the preset accent. Click "Use Preset" to restore.</small>
      </div>

      <div class="form-group">
        <label for="theme-radius">Corner Radius ({{ Math.round(radiusInput * 100) }}%)</label>
        <input
          id="theme-radius"
          type="range"
          min="0"
          max="2"
          step="0.05"
          :value="radiusInput"
          @input="handleRadiusChange"
        />
        <small>Multiplies the preset's corner roundness.</small>
      </div>

      <div class="form-group">
        <label class="toggle-inline">
          <input type="checkbox" :checked="appearance.reducedMotion" @change="handleReducedMotionChange" />
          <span>Reduce motion (disable animations/transitions)</span>
        </label>
      </div>
    </div>

    <div class="card">
      <h3>Server Configuration</h3>
      <div class="form-group">
        <label>Quick Server Selection</label>
        <div class="settings-server-buttons">
          <button class="btn" :class="activeServer === 'live' ? 'btn-primary server-btn-active' : 'btn-primary'" type="button" @click="switchToServer('live')">ARC-Live</button>
          <button class="btn" :class="activeServer === 'beta' ? 'btn-secondary server-btn-active' : 'btn-secondary'" type="button" @click="switchToServer('beta')">ARC-Beta</button>
          <button class="btn" :class="activeServer === 'custom' ? 'btn-warning server-btn-active' : 'btn-warning'" type="button" @click="switchToServer('custom')">Custom (Dev)</button>
        </div>
        <div id="current-server-status" class="server-status-box">
          <strong>Current Server:</strong>
          <span>{{ activeServer === 'live' ? 'ARC-Live' : activeServer === 'beta' ? 'ARC-Beta' : 'Custom (Dev)' }}</span>
        </div>
      </div>
      <div class="form-group">
        <label for="server-url-settings">WebSocket Server URL</label>
        <input id="server-url-settings" v-model="customUrl" type="text" @keypress.enter="handleCustomServer" />
        <small>Use Quick Server Selection above for Live/Beta. Manual entry only for custom dev servers.</small>
      </div>
      <button class="btn btn-primary" type="button" @click="handleCustomServer">Apply Custom Server URL</button>
    </div>

    <div class="card">
      <h3>Application Settings</h3>
      <div class="form-group">
        <label for="log-level">Log Level</label>
        <select id="log-level" v-model="pendingLogLevel">
          <option value="info">Info</option>
          <option value="warn">Warning</option>
          <option value="error">Error</option>
        </select>
      </div>
      <button class="btn btn-primary" type="button" @click="handleUpdateApplicationSettings">Update Application Settings</button>
    </div>

    <div class="card">
      <h3>Diagnostics</h3>
      <div class="settings-action-row">
        <button class="btn btn-secondary" type="button" @click="loadDebugStats">Load Debug Stats</button>
        <button class="btn btn-secondary" type="button" @click="loadMemoryStats">Load Memory Stats</button>
        <button class="btn btn-warning" type="button" @click="forceMemoryCleanup">Force Memory Cleanup</button>
        <button class="btn btn-danger" type="button" @click="clearDebugLogs">Clear Debug Logs</button>
      </div>
      <div v-if="debugStats" class="stats-box">
        <h4>Debug Stats</h4>
        <pre>{{ JSON.stringify(debugStats, null, 2) }}</pre>
      </div>
      <div v-if="memoryStats" class="stats-box">
        <h4>Memory Stats</h4>
        <pre>{{ JSON.stringify(memoryStats, null, 2) }}</pre>
      </div>
    </div>
  </div>
</template>
