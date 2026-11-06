// ============================================================================
// ARC-Client ARC Link test suite
// ============================================================================
//
// End-to-end tests for main/containers/arclink/arclink.ts: the OSC sockets,
// the movement reconstruction maths, the echo guards and the jump state
// machine.
//
// The tests drive the REAL container code. Two container instances are
// pointed at each other on the loopback interface, with a fake VRChat on
// each side.
//
// USAGE - run from the repository root:
//
//   npm run test:arclink                 # preferred (same as below)
//   node --test tests/test-arclink.cjs
//
// HOW IT WORKS:
//
//   1. The container is compiled from TypeScript into a temporary build
//      directory (the Electron main bundle is a single file, so the
//      container cannot be required from it directly).
//   2. `electron` is stubbed via the require cache, because the container
//      imports configManager, which needs app.getPath('userData') to find
//      its config file. The stub points that at a throwaway temp
//      directory so the test never touches a real config.
//   3. Each test drives real UDP sockets on the loopback interface.
//
// The ports used are high enough not to clash with a real VRChat or a
// running ARC Link.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const BUILD_DIR = path.join(ROOT, 'tests', '.arclink-build');

// -----------------------------------------------------------------------------
// Stub `electron` before anything else pulls it in.
// -----------------------------------------------------------------------------

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arclink-test-'));

const electronStub = {
    app: {
        getPath: (name) => (name === 'userData' ? userDataDir : os.tmpdir()),
        getName: () => 'arclink-test',
        getVersion: () => '0.0.0'
    },
    ipcMain: { handle: () => {}, on: () => {} },
    ipcRenderer: { invoke: () => {}, send: () => {}, on: () => {} },
    BrowserWindow: class {},
    contextBridge: { exposeInMainWorld: () => {} }
};

const Module = require('node:module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    if (request === 'electron') {
        return 'electron-stub';
    }
    return originalResolve.call(this, request, ...rest);
};
require.cache['electron-stub'] = {
    id: 'electron-stub',
    filename: 'electron-stub',
    loaded: true,
    exports: electronStub
};

// -----------------------------------------------------------------------------
// Compile the container.
// -----------------------------------------------------------------------------

function buildContainer() {
    fs.rmSync(BUILD_DIR, { recursive: true, force: true });
    // Invoke tsc through the local TypeScript package directly rather than
    // the .bin shim, because the Windows .cmd shim is not executable via
    // execFileSync.
    const tscCli = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
    execFileSync(
        process.execPath,
        [
            tscCli,
            path.join('main', 'containers', 'arclink', 'arclink.ts'),
            '--outDir', BUILD_DIR,
            '--module', 'commonjs',
            '--target', 'es2020',
            '--esModuleInterop',
            '--skipLibCheck',
            '--moduleResolution', 'node'
        ],
        { cwd: ROOT, stdio: 'pipe' }
    );
    return path.join(BUILD_DIR, 'containers', 'arclink', 'arclink.js');
}

const CONTAINER_PATH = buildContainer();
const osc = require('osc');
const { default: ARCLink } = require(CONTAINER_PATH);

// -----------------------------------------------------------------------------
// Test helpers.
// -----------------------------------------------------------------------------

const PORTS = {
    aVrchatOut: 19701,
    aLink: 19710,
    aVrchatIn: 19700,
    bVrchatOut: 19702,
    bLink: 19711,
    bVrchatIn: 19703
};

/**
 * A fake VRChat: listens for input commands and publishes movement state.
 */
class FakeVRChat {
    constructor(outPort, inPort) {
        this.received = [];
        this.grounded = true;
        this.port = new osc.UDPPort({
            localAddress: '127.0.0.1',
            localPort: inPort,
            remoteAddress: '127.0.0.1',
            remotePort: inPort,
            metadata: true
        });
        this.port.on('message', (message) => {
            const value = message.args[0] && message.args[0].value;
            this.received.push({ addr: message.address, value });
            if (message.address === '/input/Jump' && value === 1) {
                this.leaveGround();
            }
        });
        this.port.open();
        this.sender = new osc.UDPPort({
            localAddress: '127.0.0.1',
            localPort: 0,
            remoteAddress: '127.0.0.1',
            remotePort: outPort,
            metadata: true
        });
        this.sender.open();
    }

    publishFloat(address, value) {
        this.sender.send({ address, args: [{ type: 'f', value }] });
    }

    publishPose(yawDegrees) {
        this.sender.send({
            address: '/tracking/vrsystem/head/pose',
            args: [
                { type: 'f', value: 0 },
                { type: 'f', value: 0 },
                { type: 'f', value: 0 },
                { type: 'f', value: 0 },
                { type: 'f', value: yawDegrees },
                { type: 'f', value: 0 }
            ]
        });
    }

    leaveGround() {
        if (!this.grounded) return;
        this.grounded = false;
        this.publishFloat('/avatar/parameters/Grounded', 0);
        setTimeout(() => {
            if (this.grounded) return;
            this.grounded = true;
            this.publishFloat('/avatar/parameters/Grounded', 1);
        }, 150);
    }

    jump() {
        this.leaveGround();
    }

    close() {
        this.sender.close();
        this.port.close();
    }
}

/**
 * Build a container configured for the given ports.
 */
function makeContainer(local, peer, vrchat) {
    return new ARCLink({
        localIp: '127.0.0.1',
        inPort: local.inPort,
        outPort: local.outPort,
        peerIp: '127.0.0.1',
        peerOutPort: peer.outPort,
        vrchatIp: '127.0.0.1',
        vrchatInPort: vrchat.inPort,
        yawSign: 1,
        forwardIsNegativeZ: false,
        angularYSign: 1,
        maxSpeed: 3.0,
        maxTurnRate: 2.0,
        smoothing: 0.35,
        deadzone: 0.02,
        refreshIntervalMs: 50,
        echoSuppressMs: 300,
        mirrorJump: true,
        enableParameter: 'ArcLink',
        startEnabled: true,
        logging: false
    });
}

/**
 * Wait for a condition, or time out.
 */
async function waitFor(predicate, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return predicate();
}

/**
 * Start both sides of the link.
 */
async function startPair() {
    const vrchatA = new FakeVRChat(PORTS.aVrchatOut, PORTS.aVrchatIn);
    const vrchatB = new FakeVRChat(PORTS.bVrchatOut, PORTS.bVrchatIn);

    const engineA = makeContainer(
        { inPort: PORTS.aVrchatOut, outPort: PORTS.aLink },
        { outPort: PORTS.bLink },
        { inPort: PORTS.aVrchatIn }
    );
    const engineB = makeContainer(
        { inPort: PORTS.bVrchatOut, outPort: PORTS.bLink },
        { outPort: PORTS.aLink },
        { inPort: PORTS.bVrchatIn }
    );

    await engineA.init();
    await engineB.init();
    const startedA = await engineA.start();
    const startedB = await engineB.start();
    assert.ok(startedA.success, `engine A failed to start: ${startedA.error}`);
    assert.ok(startedB.success, `engine B failed to start: ${startedB.error}`);

    await new Promise((resolve) => setTimeout(resolve, 300));

    return { vrchatA, vrchatB, engineA, engineB };
}

/**
 * Tear the pair down.
 */
async function stopPair(pair) {
    await pair.engineA.close();
    await pair.engineB.close();
    pair.vrchatA.close();
    pair.vrchatB.close();
    await new Promise((resolve) => setTimeout(resolve, 150));
}

// -----------------------------------------------------------------------------
// The tests.
// -----------------------------------------------------------------------------

test('ARC Link mirrors movement between two machines', async (t) => {
    const pair = await startPair();
    t.after(() => stopPair(pair));

    const { vrchatA, vrchatB } = pair;

    // ---- movement crosses the link ----
    vrchatA.publishFloat('/avatar/parameters/VelocityZ', 2.0);

    const forwardArrived = await waitFor(() =>
        vrchatB.received.some((m) => m.addr === '/input/Vertical' && m.value > 0.1)
    );
    assert.ok(forwardArrived, '/input/Vertical never reached side B');

    // ---- the turn axis crosses too ----
    vrchatA.publishFloat('/avatar/parameters/AngularY', 1.0);
    const turnArrived = await waitFor(() =>
        vrchatB.received.some((m) => m.addr === '/input/LookHorizontal' && Math.abs(m.value) > 0.1)
    );
    assert.ok(turnArrived, '/input/LookHorizontal never reached side B');
});

test('ARC Link reads the head pose in degrees', async (t) => {
    const pair = await startPair();
    t.after(() => stopPair(pair));

    const { vrchatA, vrchatB } = pair;

    // Clear the ground, then turn the head 90 degrees.
    vrchatB.received.length = 0;
    vrchatA.publishFloat('/avatar/parameters/VelocityX', 0);
    vrchatA.publishFloat('/avatar/parameters/VelocityZ', 0);
    vrchatA.publishPose(90);
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Facing +X, moving along +X is full forward motion and no strafe.
    vrchatA.publishFloat('/avatar/parameters/VelocityX', 2.0);

    const becameForward = await waitFor(() =>
        vrchatB.received.some((m) => m.addr === '/input/Vertical' && m.value > 0.6)
    );
    assert.ok(becameForward, 'a +X velocity with the head turned 90 degrees was not forward motion');

    // The discriminating check: the strafe axis must stay at zero. If the
    // pose were read as radians, the axes would be mixed up instead.
    const lastStrafe = vrchatB.received.filter((m) => m.addr === '/input/Horizontal').pop();
    assert.ok(lastStrafe, 'no strafe message was sent');
    assert.ok(
        Math.abs(lastStrafe.value) < 0.05,
        `the strafe axis should stay at zero when facing +X, got ${lastStrafe.value}`
    );
});

test('ARC Link does not echo its own movement back', async (t) => {
    const pair = await startPair();
    t.after(() => stopPair(pair));

    const { vrchatA, vrchatB } = pair;

    vrchatA.publishFloat('/avatar/parameters/VelocityZ', 2.0);
    await new Promise((resolve) => setTimeout(resolve, 400));

    // Side B applied the movement, which makes side B's VRChat publish the
    // resulting movement back to side B's own container. Side B must
    // recognise that as its own echo and NOT forward it back to side A.
    const before = vrchatA.received.length;
    await new Promise((resolve) => setTimeout(resolve, 900));

    const echoed = vrchatA.received.slice(before).filter((m) => m.addr.startsWith('/input/'));
    assert.strictEqual(
        echoed.length,
        0,
        `side A received ${echoed.length} echoed input messages: ${echoed.map((m) => `${m.addr}=${m.value}`).join(', ')}`
    );
});

test('ARC Link mirrors the jump and does not echo it', async (t) => {
    const pair = await startPair();
    t.after(() => stopPair(pair));

    const { vrchatA, vrchatB } = pair;

    vrchatB.received.length = 0;
    vrchatA.jump();

    const jumped = await waitFor(() =>
        vrchatB.received.some((m) => m.addr === '/input/Jump' && m.value === 1)
    );
    assert.ok(jumped, 'the jump never reached side B');

    // VRChat's buttons latch, so the press has to be followed by a release.
    const released = await waitFor(() =>
        vrchatB.received.some((m) => m.addr === '/input/Jump' && m.value === 0)
    );
    assert.ok(released, 'the jump button was never released');

    // Side B applied the jump, so its VRChat goes airborne and lands again.
    // That landing is side B's own echo and must not come back.
    const before = vrchatA.received.length;
    await new Promise((resolve) => setTimeout(resolve, 900));

    const jumpEcho = vrchatA.received.slice(before).filter((m) => m.addr === '/input/Jump');
    assert.strictEqual(jumpEcho.length, 0, `side A received ${jumpEcho.length} echoed jump messages`);
});

test('ARC Link resets the axes when it is disabled', async (t) => {
    const pair = await startPair();
    t.after(() => stopPair(pair));

    const { vrchatA, vrchatB } = pair;

    vrchatA.publishFloat('/avatar/parameters/VelocityZ', 2.0);
    await new Promise((resolve) => setTimeout(resolve, 400));

    vrchatB.received.length = 0;
    vrchatA.publishFloat('/avatar/parameters/ArcLink', 0);
    await new Promise((resolve) => setTimeout(resolve, 400));

    const reset = vrchatB.received.some((m) => m.addr === '/input/Vertical' && m.value === 0);
    assert.ok(reset, 'disabling the link did not reset the axes');
});

test.after(() => {
    fs.rmSync(BUILD_DIR, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
});
