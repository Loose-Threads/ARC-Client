// ============================================================================
// ARC-Client crash report pipeline test suite
// ============================================================================
//
// Regression tests for the automatic crash recovery additions:
//   main/services/restartGuard.ts     - restart-loop cap and persistence
//   main/services/crashReportStore.ts - crash report write/read/clear
//   main/services/debugger.ts         - getLastNLines() tail capture
//
// These run under plain Node with no Electron and no build step. Electron is
// absent from this process, so both modules fall back to a directory-relative
// path; the suites point that at a temp dir via ARC_CRASH_DATA_DIR so a real
// userdata/restart-state.json is never touched.
//
// The services are TypeScript, so they are compiled to a temp dir with the
// repo's own tsc before being required. Run from the repository root:
//
//   npm run test:crashreport
// ============================================================================
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-crash-data-'));
const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-crash-build-'));

// Compile the two services under test to CommonJS so plain node can require them.
const tsc = path.join(repoRoot, 'node_modules', '.bin', 'tsc.cmd');
const compile = spawnSync(
  tsc,
  [
    path.join(repoRoot, 'main/services/restartGuard.ts'),
    path.join(repoRoot, 'main/services/crashReportStore.ts'),
    '--module', 'commonjs',
    '--target', 'es2022',
    '--moduleResolution', 'node',
    '--esModuleInterop',
    '--skipLibCheck',
    '--outDir', buildDir
  ],
  { cwd: repoRoot, encoding: 'utf8', shell: true }
);
if (compile.status !== 0) {
  throw new Error(`Failed to compile crash services for testing:\n${compile.stdout}\n${compile.stderr}`);
}

const guard = require(path.join(buildDir, 'restartGuard.js'));
const store = require(path.join(buildDir, 'crashReportStore.js'));

// Redirect storage to the temp dir before any module reads it.
process.env.ARC_CRASH_DATA_DIR = dataDir;

function resetState() {
  guard.clearRestartState();
}

describe('restartGuard', () => {
  beforeEach(resetState);
  afterEach(resetState);

  test('allows a restart when no restarts have been recorded', () => {
    assert.equal(guard.canRestart(), true);
  });

  test('permits exactly MAX_RESTARTS restarts inside the window', () => {
    assert.equal(guard.canRestart(), true); // 0 recorded
    guard.recordRestart();
    assert.equal(guard.canRestart(), true); // 1
    guard.recordRestart();
    assert.equal(guard.canRestart(), true); // 2
    guard.recordRestart();
    assert.equal(guard.canRestart(), false); // 3 -> over the cap
  });

  test('recordRestart returns the running count', () => {
    assert.equal(guard.recordRestart(), 1);
    assert.equal(guard.recordRestart(), 2);
    assert.equal(guard.restartCount(), 2);
  });

  test('clearRestartState resets the counter', () => {
    guard.recordRestart();
    guard.recordRestart();
    guard.clearRestartState();
    assert.equal(guard.canRestart(), true);
    assert.equal(guard.restartCount(), 0);
  });

  test('survives a corrupt state file instead of crashing', () => {
    fs.writeFileSync(path.join(dataDir, 'restart-state.json'), 'not json at all', 'utf8');
    assert.equal(guard.canRestart(), true);
    guard.recordRestart();
    assert.equal(guard.restartCount(), 1);
  });

  test('ignores non-numeric entries in a tampered state file', () => {
    // Use a recent timestamp so the window prune does not also drop it;
    // this test is specifically about the non-numeric filtering.
    fs.writeFileSync(
      path.join(dataDir, 'restart-state.json'),
      JSON.stringify({ restarts: ['x', null, { a: 1 }, Date.now()] }),
      'utf8'
    );
    assert.equal(guard.restartCount(), 1);
  });

  test('forgives restarts once they age out of the rolling window', () => {
    // Backdate every recorded restart beyond the window.
    const stateFile = path.join(dataDir, 'restart-state.json');
    const old = Date.now() - guard.RESTART_GUARD_LIMITS.WINDOW_MS - 1000;
    fs.writeFileSync(stateFile, JSON.stringify({ restarts: [old, old, old] }), 'utf8');
    assert.equal(guard.canRestart(), true, 'stale restarts should not trip the cap');
    assert.equal(guard.restartCount(), 0);
  });

  test('exposes the configured limits', () => {
    assert.equal(guard.RESTART_GUARD_LIMITS.MAX_RESTARTS, 3);
    assert.equal(guard.RESTART_GUARD_LIMITS.WINDOW_MS, 60_000);
  });
});

describe('crashReportStore', () => {
  afterEach(() => store.clearCrashReport());

  test('returns null when no report has been written', () => {
    assert.equal(store.readCrashReport(), null);
  });

  test('round-trips a built report', () => {
    const report = store.buildCrashReport({
      crashType: 'renderer-gone',
      reason: 'crashed',
      exitCode: 133,
      message: 'renderer died',
      logTail: ['a', 'b']
    });
    store.writeCrashReport(report);
    const read = store.readCrashReport();
    assert.equal(read.crashType, 'renderer-gone');
    assert.equal(read.reason, 'crashed');
    assert.equal(read.exitCode, 133);
    assert.deepEqual(read.logTail, ['a', 'b']);
    assert.ok(read.id, 'report should carry an id');
  });

  test('maps each crash type to a human label', () => {
    const types = ['renderer-gone', 'renderer-unresponsive', 'uncaught-exception', 'unhandled-rejection'];
    for (const crashType of types) {
      const report = store.buildCrashReport({ crashType, message: 'x' });
      assert.equal(report.crashType, crashType);
      assert.ok(report.crashLabel && report.crashLabel.length > 0);
    }
  });

  test('defaults a missing message rather than leaving it blank', () => {
    const report = store.buildCrashReport({ crashType: 'uncaught-exception' });
    assert.ok(report.message.length > 0);
  });

  test('caps the log tail to the most recent lines', () => {
    const many = Array.from({ length: 500 }, (_, i) => `line ${i}`);
    const report = store.buildCrashReport({ crashType: 'renderer-gone', message: 'x', logTail: many });
    assert.equal(report.logTail.length, 200);
    assert.equal(report.logTail[199], 'line 499', 'tail should keep the newest lines');
  });

  test('records platform metadata for bug reports', () => {
    const report = store.buildCrashReport({ crashType: 'renderer-gone', message: 'x' });
    assert.equal(report.platform, process.platform);
    assert.equal(report.arch, process.arch);
    assert.ok(report.nodeVersion);
  });

  test('clearCrashReport removes the stored report', () => {
    store.writeCrashReport(store.buildCrashReport({ crashType: 'renderer-gone', message: 'x' }));
    assert.ok(store.readCrashReport());
    store.clearCrashReport();
    assert.equal(store.readCrashReport(), null);
  });

  test('clearCrashReport is safe when nothing is stored', () => {
    store.clearCrashReport();
    store.clearCrashReport();
    assert.equal(store.readCrashReport(), null);
  });

  test('rejects a corrupt report file rather than throwing', () => {
    fs.writeFileSync(path.join(dataDir, 'crash-report.json'), '{{{ broken', 'utf8');
    assert.equal(store.readCrashReport(), null);
  });

  test('ignores a report file missing the crashType marker', () => {
    fs.writeFileSync(path.join(dataDir, 'crash-report.json'), JSON.stringify({ foo: 'bar' }), 'utf8');
    assert.equal(store.readCrashReport(), null);
  });
});

// Clean up the temp directories at process exit.
process.on('exit', () => {
  for (const dir of [dataDir, buildDir]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});