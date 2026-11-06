<script setup lang="ts">
// Logic lives in the sibling ARCLinkPage.ts factory — keep this block thin.
import { createARCLinkPageState } from './ARCLinkPage'
const {
  status,
  config,
  saving,
  errorMessage,
  start,
  stop,
  toggle,
  activeTab,
  configDraft,
  statusLabel,
  statusColor,
  statusDetail,
  yawDegrees,
  speed,
  portSummary,
  configPreview,
  onTabChange,
  handleSave,
  handleReset,
  formatNumber
} = createARCLinkPageState()
</script>

<template>
  <div class="page-view">
    <div class="header">
      <h1>ARC Link</h1>
      <p>Mirror your VRChat movement to a partner's machine over the network.</p>
    </div>

    <div v-if="errorMessage" class="arclink-error-box" role="alert">
      <strong>Something went wrong:</strong>
      <span>{{ errorMessage }}</span>
    </div>

    <div class="card">
      <h3>Connection Status</h3>
      <div class="connection-status">
        <span class="status-indicator" :class="status.enabled ? 'status-connected' : 'status-disconnected'"></span>
        <span :style="{ color: statusColor, fontWeight: 700 }">{{ statusLabel }}</span>
      </div>
      <p class="arclink-status-detail">{{ statusDetail }}</p>
      <div class="arclink-control-row">
        <button class="btn" :class="status.enabled ? 'btn-danger' : 'btn-primary'" @click="toggle">
          {{ status.enabled ? 'Stop ARC Link' : 'Start ARC Link' }}
        </button>
      </div>
      <div class="arclink-note-box">
        <small>
          <strong>Note:</strong> VRChat's OSC must be enabled (Action Menu &rarr; Osc &rarr; Enabled) for the link to read your movement.
          The link starts in the <em>stopped</em> state so it never moves your avatar just because the client booted.
        </small>
      </div>
    </div>

    <div class="card">
      <h3>Live Movement</h3>
      <p class="arclink-hint">
        The reconstructed movement is what gets sent to your partner. It is read from the movement
        VRChat publishes, then turned back into the input commands that would produce it.
      </p>
      <div class="arclink-movement-grid">
        <div class="arclink-movement-panel">
          <div class="arclink-movement-label">FORWARD</div>
          <div class="arclink-movement-value vertical">{{ formatNumber(status.frame.forward) }}</div>
          <div class="arclink-movement-range">-1.0 to 1.0</div>
        </div>
        <div class="arclink-movement-panel">
          <div class="arclink-movement-label">STRAFE</div>
          <div class="arclink-movement-value horizontal">{{ formatNumber(status.frame.strafe) }}</div>
          <div class="arclink-movement-range">-1.0 to 1.0</div>
        </div>
        <div class="arclink-movement-panel">
          <div class="arclink-movement-label">TURN</div>
          <div class="arclink-movement-value turn">{{ formatNumber(status.frame.turn) }}</div>
          <div class="arclink-movement-range">-1.0 to 1.0</div>
        </div>
      </div>
      <div class="arclink-state-grid">
        <div class="arclink-state-item">
          <span class="arclink-state-label">World velocity</span>
          <span class="arclink-state-value">
            x {{ formatNumber(status.velocity.x) }} &middot; z {{ formatNumber(status.velocity.z) }}
          </span>
        </div>
        <div class="arclink-state-item">
          <span class="arclink-state-label">Speed</span>
          <span class="arclink-state-value">{{ speed }} m/s</span>
        </div>
        <div class="arclink-state-item">
          <span class="arclink-state-label">Turn rate</span>
          <span class="arclink-state-value">{{ formatNumber(status.angularY) }} rad/s</span>
        </div>
        <div class="arclink-state-item">
          <span class="arclink-state-label">Head yaw</span>
          <span class="arclink-state-value">{{ yawDegrees }}&deg;</span>
        </div>
      </div>
    </div>

    <div class="card">
      <h3>Traffic</h3>
      <p class="arclink-hint">
        <strong>In</strong> is what VRChat publishes to the link. <strong>Out</strong> is what the
        link sends on. <strong>Echo</strong> counts frames the link recognised as its own echo and
        deliberately did <em>not</em> send back — that is what stops the movement doubling on every
        round trip.
      </p>
      <div class="arclink-stats-grid">
        <div class="arclink-stat">
          <div class="arclink-stat-value">{{ status.stats.received }}</div>
          <div class="arclink-stat-label">Received</div>
        </div>
        <div class="arclink-stat">
          <div class="arclink-stat-value">{{ status.stats.forwarded }}</div>
          <div class="arclink-stat-label">Sent to partner</div>
        </div>
        <div class="arclink-stat">
          <div class="arclink-stat-value">{{ status.stats.inbound }}</div>
          <div class="arclink-stat-label">From partner</div>
        </div>
        <div class="arclink-stat">
          <div class="arclink-stat-value">{{ status.stats.applied }}</div>
          <div class="arclink-stat-label">Applied locally</div>
        </div>
        <div class="arclink-stat">
          <div class="arclink-stat-value">{{ status.stats.echoSuppressed }}</div>
          <div class="arclink-stat-label">Echo suppressed</div>
        </div>
      </div>
      <p v-if="status.lastError" class="arclink-error-text">{{ status.lastError }}</p>
    </div>

    <div class="card">
      <h3>Configuration</h3>
      <div class="arclink-config-actions">
        <button class="btn btn-success" :disabled="saving" @click="handleSave">{{ saving ? 'Saving...' : 'Save Changes' }}</button>
        <button class="btn btn-warning" @click="handleReset">Reset to Defaults</button>
      </div>
      <div class="tabs arclink-tabs">
        <button class="tab" :class="{ active: activeTab === 'status' }" @click="onTabChange('status')">Enable &amp; Controls</button>
        <button class="tab" :class="{ active: activeTab === 'connection' }" @click="onTabChange('connection')">Connection</button>
        <button class="tab" :class="{ active: activeTab === 'tuning' }" @click="onTabChange('tuning')">Movement Tuning</button>
        <button class="tab" :class="{ active: activeTab === 'advanced' }" @click="onTabChange('advanced')">Advanced</button>
      </div>

      <div v-if="activeTab === 'status'" class="arclink-config-section">
        <div class="form-group">
          <label for="config-enable-parameter">Enable Avatar Parameter</label>
          <input id="config-enable-parameter" v-model="configDraft.enableParameter" type="text" />
          <small>
            The avatar parameter that switches the link on and off. VRChat publishes it on every
            change, so any menu or OSC panel that drives
            <code>/avatar/parameters/{{ configDraft.enableParameter || 'ArcLink' }}</code> works.
          </small>
        </div>
        <div class="form-group">
          <label class="arclink-inline-toggle">
            <input v-model="configDraft.mirrorJump" type="checkbox" />
            <span>Mirror the jump</span>
          </label>
          <small>
            The jump is inferred from VRChat's <code>Grounded</code> parameter, because VRChat does
            not echo <code>/input/Jump</code> back. Leaving the ground and landing again is a jump.
          </small>
        </div>
        <div class="form-group">
          <label class="arclink-inline-toggle">
            <input v-model="configDraft.startEnabled" type="checkbox" />
            <span>Start the link enabled</span>
          </label>
          <small>Keep this off. A link should not move your avatar just because the client booted.</small>
        </div>
      </div>

      <div v-else-if="activeTab === 'connection'" class="arclink-config-section">
        <div class="arclink-config-grid-two">
          <div class="form-group">
            <label for="config-local-ip">Local IP</label>
            <input id="config-local-ip" v-model="configDraft.localIp" type="text" />
            <small>The address this machine binds to. 0.0.0.0 listens on every interface.</small>
          </div>
          <div class="form-group">
            <label for="config-peer-ip">Partner IP</label>
            <input id="config-peer-ip" v-model="configDraft.peerIp" type="text" />
            <small>The partner's LAN address. Their config points back at yours.</small>
          </div>
          <div class="form-group">
            <label for="config-in-port">VRChat In Port</label>
            <input id="config-in-port" v-model.number="configDraft.inPort" type="number" min="1" max="65535" />
            <small>Where VRChat's OSC output arrives. VRChat sends on 9001 by default.</small>
          </div>
          <div class="form-group">
            <label for="config-out-port">Link In Port</label>
            <input id="config-out-port" v-model.number="configDraft.outPort" type="number" min="1" max="65535" />
            <small>Where the partner connects. Keep this off 9000/9001 — those belong to VRChat.</small>
          </div>
          <div class="form-group">
            <label for="config-peer-out-port">Partner Port</label>
            <input id="config-peer-out-port" v-model.number="configDraft.peerOutPort" type="number" min="1" max="65535" />
            <small>Must match the partner's Link In Port.</small>
          </div>
          <div class="form-group">
            <label for="config-vrchat-in-port">VRChat Out Port</label>
            <input id="config-vrchat-in-port" v-model.number="configDraft.vrchatInPort" type="number" min="1" max="65535" />
            <small>Where the link sends the mirrored movement. VRChat receives on 9000 by default.</small>
          </div>
        </div>
        <div class="arclink-preview-block">
          <strong>Port Summary:</strong>
          <div class="arclink-preview-box">{{ portSummary }}</div>
        </div>
      </div>

      <div v-else-if="activeTab === 'tuning'" class="arclink-config-section">
        <div class="arclink-config-grid-two">
          <div class="form-group">
            <label for="config-max-speed">Max Speed (m/s)</label>
            <input id="config-max-speed" v-model.number="configDraft.maxSpeed" type="range" min="0.5" max="10" step="0.1" />
            <span>{{ formatNumber(configDraft.maxSpeed, 1) }}</span>
            <small>The speed that maps to a full-scale input. Raise it if fast movement does not carry over fully.</small>
          </div>
          <div class="form-group">
            <label for="config-max-turn-rate">Max Turn Rate (rad/s)</label>
            <input id="config-max-turn-rate" v-model.number="configDraft.maxTurnRate" type="range" min="0.5" max="8" step="0.1" />
            <span>{{ formatNumber(configDraft.maxTurnRate, 1) }}</span>
            <small>The turn rate that maps to a full-scale input.</small>
          </div>
          <div class="form-group">
            <label for="config-smoothing">Smoothing</label>
            <input id="config-smoothing" v-model.number="configDraft.smoothing" type="range" min="0" max="1" step="0.05" />
            <span>{{ formatNumber(configDraft.smoothing) }}</span>
            <small>0 is frozen, 1 is raw. Lower is smoother but laggier.</small>
          </div>
          <div class="form-group">
            <label for="config-deadzone">Deadzone</label>
            <input id="config-deadzone" v-model.number="configDraft.deadzone" type="range" min="0" max="0.5" step="0.01" />
            <span>{{ formatNumber(configDraft.deadzone) }}</span>
            <small>Movement below this counts as standing still, so the avatar does not drift.</small>
          </div>
        </div>
      </div>

      <div v-else class="arclink-config-section">
        <div class="arclink-config-grid-two">
          <div class="form-group">
            <label for="config-refresh-interval">Refresh Interval (ms)</label>
            <input id="config-refresh-interval" v-model.number="configDraft.refreshIntervalMs" type="range" min="50" max="1000" step="50" />
            <span>{{ configDraft.refreshIntervalMs }}ms</span>
            <small>How often the current movement is re-sent. VRChat's axes latch, so this keeps the remote state correct.</small>
          </div>
          <div class="form-group">
            <label for="config-echo-suppress">Echo Suppression (ms)</label>
            <input id="config-echo-suppress" v-model.number="configDraft.echoSuppressMs" type="range" min="100" max="2000" step="50" />
            <span>{{ configDraft.echoSuppressMs }}ms</span>
            <small>How long our own output is ignored after applying a remote command.</small>
          </div>
        </div>
        <div class="arclink-config-grid-two">
          <div class="form-group">
            <label for="config-yaw-sign">Yaw Sign</label>
            <select id="config-yaw-sign" v-model.number="configDraft.yawSign">
              <option :value="1">1 (default)</option>
              <option :value="-1">-1 (invert)</option>
            </select>
            <small>Use -1 if the remote avatar strafes the wrong way.</small>
          </div>
          <div class="form-group">
            <label for="config-angular-sign">Turn Sign</label>
            <select id="config-angular-sign" v-model.number="configDraft.angularYSign">
              <option :value="1">1 (default)</option>
              <option :value="-1">-1 (invert)</option>
            </select>
            <small>Use -1 if the remote avatar spins the wrong way.</small>
          </div>
        </div>
        <div class="form-group">
          <label class="arclink-inline-toggle">
            <input v-model="configDraft.forwardIsNegativeZ" type="checkbox" />
            <span>Avatar faces -Z at yaw 0</span>
          </label>
          <small>Turn this on if the remote avatar walks backwards.</small>
        </div>
        <div class="form-group">
          <label class="arclink-inline-toggle">
            <input v-model="configDraft.logging" type="checkbox" />
            <span>Enable debug logging</span>
          </label>
          <small>Show every forwarded message in the console.</small>
        </div>
      </div>

      <div class="arclink-preview-block">
        <strong>Current Settings Preview:</strong>
        <div class="arclink-preview-box">{{ configPreview }}</div>
      </div>
    </div>

    <div class="card">
      <h3>How the link works</h3>
      <p class="arclink-hint">
        VRChat does <strong>not</strong> echo <code>/input/*</code> back on its OSC output port, so
        the obvious approach — mirroring the input addresses — has nothing to mirror. Instead the link
        reads the movement VRChat <em>publishes</em> and works out which input commands would produce
        it, then sends those to your partner.
      </p>
      <div class="arclink-parameters">
        <strong>Reads from VRChat:</strong><br />
        <code class="listen">/avatar/parameters/VelocityX</code> - World velocity, X axis<br />
        <code class="listen">/avatar/parameters/VelocityY</code> - World velocity, Y axis<br />
        <code class="listen">/avatar/parameters/VelocityZ</code> - World velocity, Z axis<br />
        <code class="listen">/avatar/parameters/AngularY</code> - Turn rate, rad/s<br />
        <code class="listen">/avatar/parameters/Grounded</code> - On the ground (used to spot a jump)<br />
        <code class="listen">/tracking/vrsystem/head/pose</code> - Head rotation, in <strong>degrees</strong><br /><br />
        <strong>Sends to VRChat and to the partner:</strong><br />
        <code class="vertical">/input/Vertical</code> - Forward / backward<br />
        <code class="horizontal">/input/Horizontal</code> - Strafe left / right<br />
        <code class="turn">/input/LookHorizontal</code> - Turn left / right<br />
        <code class="run">/input/Jump</code> - Jump (press and release, buttons latch)<br /><br />
        <strong>Enable surfaces:</strong><br />
        <code class="listen">/avatar/parameters/{{ configDraft.enableParameter || 'ArcLink' }}</code> - The avatar parameter<br />
        <code class="listen">/arclink/enable</code> - Plain OSC, works with no avatar loaded
      </div>
      <p class="arclink-hint">
        Each side reads its <em>own</em> enable surface, so neither machine has to trust the other's
        toggle. When the link is disabled every axis is explicitly reset to zero on both sides —
        VRChat's axes latch, so without that the avatars would stay stuck mid-stride.
      </p>
    </div>

    <div class="card">
      <h3>Setting up a partner</h3>
      <p class="arclink-hint">
        Both machines run ARC Link. On yours, set the <strong>Partner IP</strong> to theirs; on
        theirs, set it back to yours. The <strong>Link In Port</strong> and <strong>Partner
        Port</strong> must match on both sides (9010 by default).
      </p>
      <p class="arclink-hint">
        Open UDP <strong>9001</strong> (VRChat) and <strong>9010</strong> (the link) inbound on both
        machines, and make sure the two are on the same network — a VPN such as Tailscale works
        well for machines in different places.
      </p>
      <p class="arclink-hint">
        If the remote avatar walks backwards, strafes the wrong way, or spins the wrong way, flip the
        signs in the <strong>Advanced</strong> tab above.
      </p>
    </div>
  </div>
</template>

<style scoped>
.arclink-error-box {
  background: rgba(231, 76, 60, 0.12);
  border: 1px solid rgba(231, 76, 60, 0.45);
  border-radius: var(--radius-md, 6px);
  padding: var(--space-3, 12px) var(--space-4, 16px);
  margin-bottom: var(--space-4, 16px);
  display: flex;
  flex-direction: column;
  gap: 4px;
  color: #e74c3c;
}

.arclink-error-text {
  color: #e74c3c;
  font-size: 0.85em;
  margin: var(--space-2, 8px) 0 0;
}

.arclink-status-detail {
  color: var(--text-tertiary, #888);
  font-size: 0.9em;
  margin: var(--space-2, 8px) 0;
}

.arclink-control-row {
  display: flex;
  align-items: center;
  gap: var(--space-3, 12px);
  flex-wrap: wrap;
  margin-top: var(--space-3, 12px);
}

.arclink-note-box {
  margin-top: var(--space-3, 12px);
  padding: var(--space-3, 12px);
  border-radius: var(--radius-md, 6px);
  background: var(--surface-2, rgba(127, 127, 127, 0.08));
  color: var(--text-secondary, #ccc);
  line-height: 1.5;
}

.arclink-hint {
  color: var(--text-secondary, #ccc);
  font-size: 0.9em;
  line-height: 1.6;
  margin: 0 0 var(--space-3, 12px);
}

.arclink-movement-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--space-3, 12px);
  margin-bottom: var(--space-4, 16px);
}

.arclink-movement-panel {
  background: var(--surface-2, rgba(127, 127, 127, 0.08));
  border-radius: var(--radius-md, 6px);
  padding: var(--space-3, 12px);
  text-align: center;
}

.arclink-movement-label {
  color: var(--text-tertiary, #888);
  font-size: 0.75em;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.arclink-movement-value {
  font-size: 1.9em;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
  line-height: 1.2;
  margin: 4px 0;
}

.arclink-movement-value.vertical { color: #5dade2; }
.arclink-movement-value.horizontal { color: #58d68d; }
.arclink-movement-value.turn { color: #f5b041; }

.arclink-movement-range {
  color: var(--text-tertiary, #888);
  font-size: 0.75em;
}

.arclink-state-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: var(--space-2, 8px);
}

.arclink-state-item {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: var(--space-2, 8px);
  padding: var(--space-2, 8px) var(--space-3, 12px);
  background: var(--surface-2, rgba(127, 127, 127, 0.08));
  border-radius: var(--radius-sm, 4px);
}

.arclink-state-label {
  color: var(--text-tertiary, #888);
  font-size: 0.8em;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.arclink-state-value {
  color: var(--text-primary, #fff);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.arclink-stats-grid {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: var(--space-2, 8px);
}

.arclink-stat {
  background: var(--surface-2, rgba(127, 127, 127, 0.08));
  border-radius: var(--radius-md, 6px);
  padding: var(--space-3, 12px);
  text-align: center;
}

.arclink-stat-value {
  font-size: 1.4em;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
  color: var(--text-primary, #fff);
}

.arclink-stat-label {
  color: var(--text-tertiary, #888);
  font-size: 0.72em;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-top: 4px;
}

.arclink-config-actions {
  display: flex;
  gap: var(--space-3, 12px);
  margin-bottom: var(--space-4, 16px);
  flex-wrap: wrap;
}

.arclink-tabs {
  display: flex;
  gap: var(--space-2, 8px);
  flex-wrap: wrap;
  margin-bottom: var(--space-4, 16px);
}

.arclink-config-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-3, 12px);
}

.arclink-config-grid-two {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: var(--space-3, 12px);
}

.arclink-inline-toggle {
  display: flex;
  align-items: center;
  gap: var(--space-2, 8px);
  cursor: pointer;
}

.arclink-preview-block {
  margin-top: var(--space-4, 16px);
}

.arclink-preview-box {
  margin-top: var(--space-2, 8px);
  padding: var(--space-3, 12px);
  border-radius: var(--radius-md, 6px);
  background: var(--surface-2, rgba(127, 127, 127, 0.08));
  color: var(--text-secondary, #ccc);
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: 0.82em;
  line-height: 1.6;
  white-space: pre-wrap;
}

.arclink-parameters {
  color: var(--text-secondary, #ccc);
  line-height: 1.7;
  font-size: 0.9em;
  margin-bottom: var(--space-3, 12px);
}

.arclink-parameters code {
  background: var(--surface-2, rgba(127, 127, 127, 0.12));
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 0.95em;
}

.arclink-parameters code.vertical { color: #5dade2; }
.arclink-parameters code.horizontal { color: #58d68d; }
.arclink-parameters code.turn { color: #f5b041; }
.arclink-parameters code.run { color: #af7ac5; }
.arclink-parameters code.listen { color: #e59866; }

@media (max-width: 720px) {
  .arclink-movement-grid,
  .arclink-config-grid-two,
  .arclink-state-grid {
    grid-template-columns: 1fr;
  }

  .arclink-stats-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}
</style>
