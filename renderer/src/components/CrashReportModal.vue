<script setup lang="ts">
// Logic lives in the sibling CrashReportModal.ts factory — keep this block thin.
import { createCrashReportModalState } from './CrashReportModal'
const {
  report,
  visible,
  copyState,
  submitState,
  submitError,
  logExpanded,
  formatDuration,
  copyReport,
  sendReport,
  dismiss,
  toggleLog
} = createCrashReportModalState()
</script>

<template>
  <div v-if="visible && report" class="modal-overlay crash-report-overlay" role="dialog" aria-modal="true" aria-labelledby="crash-report-title">
    <div class="modal-content crash-report-modal">
      <div class="modal-header">
        <h3 id="crash-report-title">ARC-Client Crashed</h3>
        <p class="crash-report-subtitle">
          {{ report.crashLabel }} &mdash; the application restarted automatically.
          Copy this report and paste it in the ARC Discord <code>#bug-reports</code> channel.
        </p>
      </div>

      <div class="modal-body">
        <dl class="crash-report-meta">
          <div><dt>Type</dt><dd>{{ report.crashLabel }}</dd></div>
          <div v-if="report.reason"><dt>Reason</dt><dd>{{ report.reason }}</dd></div>
          <div v-if="report.exitCode !== null"><dt>Exit code</dt><dd>{{ report.exitCode }}</dd></div>
          <div><dt>Occurred</dt><dd>{{ report.occurredAt }}</dd></div>
          <div><dt>Uptime</dt><dd>{{ formatDuration(report.upstreamSeconds) }}</dd></div>
          <div><dt>Version</dt><dd>{{ report.appVersion }}</dd></div>
          <div><dt>Platform</dt><dd>{{ report.platform }} {{ report.arch }}</dd></div>
          <div><dt>Electron</dt><dd>{{ report.electronVersion }}</dd></div>
          <div><dt>Node</dt><dd>{{ report.nodeVersion }}</dd></div>
        </dl>

        <section class="crash-report-block">
          <h4>Message</h4>
          <pre class="crash-report-pre">{{ report.message }}</pre>
        </section>

        <section v-if="report.stack" class="crash-report-block">
          <h4>Stack</h4>
          <pre class="crash-report-pre">{{ report.stack }}</pre>
        </section>

        <section v-if="report.logTail.length > 0" class="crash-report-block">
          <h4>
            <button type="button" class="crash-report-toggle" @click="toggleLog">
              {{ logExpanded ? 'Hide' : 'Show' }} log tail ({{ report.logTail.length }} lines)
            </button>
          </h4>
          <pre v-if="logExpanded" class="crash-report-pre crash-report-pre-scroll">{{ report.logTail.join('\n') }}</pre>
        </section>

        <p v-if="submitError" class="crash-report-error">{{ submitError }}</p>
      </div>

      <div class="modal-footer crash-report-actions">
        <button type="button" class="btn btn-secondary" @click="dismiss">Dismiss</button>
        <button type="button" class="btn btn-secondary" @click="copyReport">
          {{ copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy Report' }}
        </button>
        <button type="button" class="btn btn-primary" :disabled="submitState === 'sending' || submitState === 'sent'" @click="sendReport">
          {{ submitState === 'sending' ? 'Sending...' : submitState === 'sent' ? 'Report Sent' : submitState === 'failed' ? 'Retry Send' : 'Send Report' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.crash-report-overlay {
  z-index: 2000;
}

.crash-report-modal {
  max-width: 760px;
}

.crash-report-subtitle {
  margin: var(--space-2) 0 0;
  font-size: 0.85rem;
  color: var(--text-secondary);
}

.crash-report-meta {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: var(--space-2) var(--space-4);
  margin: 0 0 var(--space-4);
}

.crash-report-meta div {
  display: flex;
  gap: var(--space-2);
}

.crash-report-meta dt {
  font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap;
}

.crash-report-meta dd {
  margin: 0;
  color: var(--text-secondary);
  word-break: break-word;
}

.crash-report-block {
  margin-bottom: var(--space-4);
}

.crash-report-block h4 {
  margin: 0 0 var(--space-2);
  font-size: 0.8rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-secondary);
}

.crash-report-pre {
  margin: 0;
  padding: var(--space-3);
  background: var(--surface-2);
  border: var(--hairline) solid var(--border-subtle);
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: 0.75rem;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text-primary);
}

.crash-report-pre-scroll {
  max-height: 220px;
  overflow-y: auto;
}

.crash-report-toggle {
  background: none;
  border: none;
  padding: 0;
  color: var(--color-accent, var(--text-secondary));
  cursor: pointer;
  font: inherit;
  text-transform: inherit;
  letter-spacing: inherit;
  text-decoration: underline;
}

.crash-report-error {
  margin: 0;
  color: var(--color-danger);
  font-size: 0.8rem;
}

.crash-report-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}
</style>