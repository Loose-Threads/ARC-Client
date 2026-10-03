// ============================================================================
// ARC-Client OSCQuery test suite
// ============================================================================
//
// Regression tests for main/services/oscQueryService.ts: Bonjour/mDNS
// advertisement and discovery, the OSCQuery HTTP protocol (HOST_INFO +
// parameter tree), OSC UDP delivery, and VRChat connection recovery.
//
// USAGE - run from the repository root:
//
//   npm run test:oscquery                # preferred (same as below)
//   node --test tests/test-oscquery.cjs
//
//   (paths inside this file resolve relative to __dirname, so a direct
//    `node --test tests/test-oscquery.cjs` works from anywhere too)
//
// OPTIONAL environment variables:
//
//   ARC_OSCQUERY_LIVE_PROBE=1   Extends the wire test with a 20-second live
//                               window against a real running VRChat client.
//                               Prints only a JSON summary (service name,
//                               discovered yes/no, message COUNT). Never logs
//                               avatar parameter values. Off by default.
//
// HOW IT WORKS:
//
//   - main/services/oscQueryService.ts is transpiled in memory by the
//     TypeScript compiler and loaded with a stubbed `debugger.js` require,
//     so the suite needs no Electron, no build step, and writes no source or
//     build output. Re-run as often as you like.
//   - The tests bind real TCP/UDP sockets and speak real mDNS on this
//     machine's interfaces (loopback + LAN). Allow a few seconds for the full
//     run; ports are allocated at random and every test cleans up after
//     itself.
//   - Uses only node:test, node built-ins, and this project's own runtime
//     dependencies. Keep new tests dependency-light in the same style.
//
// ADDING TESTS:
//
//   This directory is the home for the ARC-Client test suite going forward.
//   Drop new *.test.js / *.test.cjs files here (or extend this one) as
//   coverage grows. Suggested convention: one file per service under
//   main/services/. Run everything with `node --test tests/`.
//
// COVERAGE MAP (test name -> behavior):
//
//   1. resolved A records take precedence over SRV hostname; remote loopback
//      uses packet source ................ _resolveServiceHost() selection
//   2. cached discovery retries a temporarily unavailable HTTP endpoint;
//      reconnect emits cleared state .... discovery retry + forceReconnect()
//   3. real mDNS -> loopback HTTP HOST_INFO -> OSC UDP delivery, then clean
//      restart .......................... full wire path + persistent restart
//   4. publication reclaims the persistent name even while another publisher
//      holds it ......................... probe-free name reclaim (no silent
//                                          publication death on conflict)
//   5. mDNS socket error rejects publication wait and removes temporary
//      listeners ........................ _waitForPublication() error path
//   6. stopped discovery cannot be resurrected by an in-flight HTTP reply
//      .................................. discovery generation guard
//   7. UDP bind failure rejects startup and releases HTTP instead of
//      advertising a dead receiver ...... startup atomicity + cleanup
// ============================================================================
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')
const http = require('node:http')
const dgram = require('node:dgram')
const { once, EventEmitter } = require('node:events')
const { Bonjour } = require('bonjour-service')
const osc = require('osc')

const filename = path.resolve(__dirname, '..', 'main', 'services', 'oscQueryService.ts')
const compiled = new Module(filename, module)
compiled.filename = filename
compiled.paths = Module._nodeModulePaths(path.dirname(filename))
const originalRequire = compiled.require.bind(compiled)
compiled.require = name => name === './debugger.js'
    ? { info() {}, warn() {}, error() {} } : originalRequire(name)
compiled._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
}).outputText, filename)
const { OSCQueryService } = compiled.exports
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(predicate, timeout = 4000) {
    const end = Date.now() + timeout
    while (!predicate()) {
        if (Date.now() > end) throw new Error('Condition timed out')
        await delay(25)
    }
}
function get(port, query) {
    return new Promise((resolve, reject) => {
        const request = http.get(`http://127.0.0.1:${port}/${query}`, res => {
            let body = ''
            res.on('data', chunk => { body += chunk })
            res.on('end', () => resolve(JSON.parse(body)))
        })
        request.on('error', reject)
    })
}

test('resolved A records take precedence over SRV hostname; remote loopback uses packet source', () => {
    const service = new OSCQueryService()
    service._localIpAddresses = ['192.0.2.10']
    assert.equal(service._resolveServiceHost({ host: 'unresolvable.local', addresses: ['127.0.0.1'] }), '127.0.0.1')
    assert.equal(service._resolveServiceHost({ addresses: ['127.0.0.1'], referer: { address: '192.0.2.10' } }), '127.0.0.1')
    assert.equal(service._resolveServiceHost({ addresses: ['127.0.0.1'], referer: { address: '192.0.2.20' } }), '192.0.2.20')
})

test('cached discovery retries a temporarily unavailable HTTP endpoint; reconnect emits cleared state', async () => {
    let ready = false
    const server = http.createServer((req, res) => {
        res.statusCode = ready ? 200 : 503
        res.end(JSON.stringify({ OSC_PORT: 19000 }))
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const service = new OSCQueryService()
    service.isRunning = true
    service.bonjour = {} // triggerDiscovery's initialized guard only
    const candidate = { name: 'VRChat-Client-test', host: 'unresolvable.local', addresses: ['127.0.0.1'], port: server.address().port }
    service._persistentBrowser = { services: [candidate], update() {} }
    try {
        await service._handleServiceDiscovered(candidate)
        assert.equal(service.getVRChatOscAddress(), null)
        ready = true
        service.triggerDiscovery()
        await until(() => service.getVRChatOscAddress() === '127.0.0.1:19000')
        let cleared = false
        service.on('vrchat-addresses-changed', state => { if (state.oscAddress === null) cleared = true })
        service.forceReconnect()
        assert.equal(cleared, true)
        await until(() => service.getVRChatOscAddress() === '127.0.0.1:19000')
    } finally {
        service.isRunning = false
        await new Promise(resolve => server.close(resolve))
    }
})

test('real mDNS -> loopback HTTP HOST_INFO -> OSC UDP delivery, then clean restart', { timeout: 45000 }, async () => {
    const service = new OSCQueryService()
    service.on('error', error => { throw error })
    const observer = new Bonjour({ bind: '0.0.0.0' })
    const browser = observer.find({ type: 'oscjson' })
    const sender = dgram.createSocket('udp4')
    try {
        await service.initialize()
        await service.start()
        assert.equal(service.bonjourService.published, true)
        await until(() => browser.services.some(found => found.name === service.appName))
        const found = browser.services.find(found => found.name === service.appName)
        assert.deepEqual(found.addresses, ['127.0.0.1'])
        const packetReceived = new Promise(resolve => {
            const mdns = observer.server.mdns
            const listener = packet => {
                if (packet.answers.some(record => record.type === 'SRV' && record.name === service.bonjourService.fqdn)) {
                    mdns.removeListener('response', listener)
                    resolve()
                }
            }
            mdns.on('response', listener)
        })
        service.triggerDiscovery()
        await packetReceived
        const host = await get(found.port, '?HOST_INFO')
        assert.equal(host.OSC_IP, '127.0.0.1')
        assert.equal(host.OSC_PORT, service.oscPort)
        const tree = await get(found.port, '')
        assert.equal(tree.CONTENTS.avatar.CONTENTS.parameters.ACCESS, 2)
        const message = once(service, 'osc-message')
        sender.send(Buffer.from(osc.writePacket({ address: '/avatar/parameters/TestProbe', args: [{ type: 'f', value: 0.5 }] }, { metadata: true })), host.OSC_PORT, host.OSC_IP)
        assert.equal((await message)[0].value, 0.5)
        // Optional live diagnostic: only count traffic, never print avatar values.
        if (process.env.ARC_OSCQUERY_LIVE_PROBE === '1') {
            let received = 0
            service.on('osc-message', () => { received++ })
            await delay(20000)
            console.log('[LIVE PROBE]', JSON.stringify({
                serviceName: service.appName,
                vrchatDiscovered: !!service.getVRChatOscQueryAddress(),
                receivedMessagesAfterSyntheticTest: received,
            }))
        }
        const previousPort = service.httpPort
        await service.stop()
        assert.equal(service.httpServer, null)
        assert.equal(service.bonjour, null)
        await service.initialize()
        await service.start()
        assert.equal(service.httpPort, previousPort)
        assert.equal(service.bonjourService.published, true)
    } finally {
        await service.stop()
        browser.stop()
        await new Promise(resolve => observer.destroy(resolve))
        sender.close()
    }
})

test('mDNS socket error rejects publication wait and removes temporary listeners', async () => {
    const service = new OSCQueryService()
    const mdns = new EventEmitter()
    const publication = new EventEmitter()
    publication.fqdn = 'test._oscjson._tcp.local'
    service.bonjour = { server: { mdns } }
    const pending = service._waitForPublication(publication)
    mdns.emit('error', new Error('bind EACCES'))
    await assert.rejects(pending, /EACCES/)
    assert.equal(publication.listenerCount('up'), 0)
    assert.equal(mdns.listenerCount('error'), 0)
})

test('stopped discovery cannot be resurrected by an in-flight HTTP reply', async () => {
    const service = new OSCQueryService()
    service.isRunning = true
    let complete
    service._verifyVRChatService = () => new Promise(resolve => { complete = resolve })
    const pending = service._handleServiceDiscovered({ name: 'VRChat-Client-test', addresses: ['127.0.0.1'], port: 19001 })
    service.isRunning = false
    service._stopVRChatDiscovery()
    complete(true)
    await pending
    assert.equal(service.getVRChatOscQueryAddress(), null)
    assert.equal(service._discoveryInFlight.size, 0)
})

test('publication reclaims the persistent name even while another publisher holds it', { timeout: 20000 }, async () => {
    const residual = new Bonjour({ bind: '0.0.0.0' })
    const held = residual.publish({ name: 'ARC-OSC-Client-RECLAIM', type: 'oscjson', protocol: 'tcp', port: 45999 })
    await once(held, 'up') // residual/stale publisher established first
    const service = new OSCQueryService()
    service.on('error', error => { throw error })
    try {
        service.assignedAppName = 'ARC-OSC-Client-RECLAIM'
        await service.initialize()
        const started = await service.start()
        assert.equal(started.serviceName, 'ARC-OSC-Client-RECLAIM')
        assert.equal(service.bonjourService.published, true)
    } finally {
        await service.stop()
        await new Promise(resolve => held.stop(resolve))
        await new Promise(resolve => residual.destroy(resolve))
    }
})

test('UDP bind failure rejects startup and releases HTTP instead of advertising a dead receiver', { timeout: 6000 }, async () => {
    const occupied = dgram.createSocket('udp4')
    occupied.bind(0, '0.0.0.0')
    await once(occupied, 'listening')
    const service = new OSCQueryService()
    service.on('error', () => {})
    try {
        await service.initialize()
        service.oscPort = occupied.address().port
        await assert.rejects(service.start(), /EADDRINUSE/)
        assert.equal(service.isRunning, false)
        assert.equal(service.httpServer, null)
        assert.equal(service.bonjour, null)
    } finally {
        await service.stop()
        occupied.close()
    }
})
