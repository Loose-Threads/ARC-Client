/**
 * ARC Link Container
 *
 * Mirrors the local player's VRChat movement to a partner machine and
 * applies the movement the partner sends back.
 *
 * WHY IT WORKS BACKWARDS FROM STATE
 * ----------------------------------
 *
 * The obvious design - forward `/input/Vertical` and friends - does not
 * work, because VRChat does NOT echo the input addresses back on its OSC
 * output port. `/input/*` is a one-way control API: whatever sends to it
 * drives the avatar, and nothing is published in return.
 *
 * What VRChat DOES publish is state:
 *
 *   /avatar/parameters/VelocityX|Y|Z   the avatar's world velocity
 *   /avatar/parameters/AngularY        the avatar's turn rate
 *   /avatar/parameters/Grounded        whether the avatar is on the ground
 *   /tracking/vrsystem/head/pose        head position + rotation
 *
 * So this container reconstructs the input commands that would reproduce
 * the movement it observes, and sends those to the partner. The partner
 * applies them to its own VRChat, and the mirrored avatar moves.
 *
 * THE FOUR SOCKETS
 * ----------------
 *
 *   VRChat receiver   bound to local.inPort   - VRChat's published state
 *   Link receiver     bound to local.outPort  - commands from the partner
 *   Peer sender       -> peer.ip:peer.outPort - commands to the partner
 *   VRChat sender     -> vrchat.ip:inPort     - commands applied locally
 *
 * The partner sits in the middle deliberately: it has to know what it
 * applied, so it can tell its own echo apart from genuine new input.
 *
 * LOOP PREVENTION
 * ---------------
 *
 * Applying a command to VRChat makes the avatar move, which makes VRChat
 * publish new state, which would otherwise be mirrored straight back to
 * the partner - doubling the motion every round trip.
 *
 * Two guards stop that:
 *
 *   1. FRAME MATCHING. The container remembers the last frame it applied.
 *      If the reconstructed frame matches it, the movement is our own
 *      echo and is not forwarded.
 *
 *   2. A SUPPRESSION WINDOW. Right after applying a frame, forwarding is
 *      paused for `echoSuppressMs`, which covers the delay between
 *      injecting the command and VRChat publishing the result.
 *
 * LATCHING
 * --------
 *
 * VRChat's input axes LATCH - a value left at 1 keeps the avatar moving
 * forever. The container therefore re-sends the current frame on a
 * timer, and explicitly resets every axis to 0 when the link goes down.
 *
 * ANGLES ARE IN DEGREES ON THE WIRE
 * ---------------------------------
 *
 * VRChat publishes the head pose rotation as Euler ANGLES IN DEGREES, not
 * radians. This is settled by VRChat's own official receiver sample
 * (vrchat-community/vrc-oscquery-lib, Samples/Tracking/HeadAndWristsReceiver.cs),
 * which feeds the published pose straight into Unity's `Quaternion.Euler`
 * - and Unity's `Quaternion.Euler` takes degrees.
 *
 * Everything inside this container is therefore in RADIANS, and the
 * conversion happens once, at the boundary where the pose is read.
 */

import { EventEmitter } from 'node:events'
import osc from 'osc'
import debug from '../../services/debugger'
import configManager from '../../services/configManager'

/**
 * The input axes the link reconstructs and exchanges.
 */
const INPUT_AXIS_ADDRESSES = {
  forward: '/input/Vertical',
  strafe: '/input/Horizontal',
  turn: '/input/LookHorizontal'
} as const

/**
 * The discrete player controls the link exchanges.
 */
const INPUT_BUTTON_ADDRESSES = {
  jump: '/input/Jump'
} as const

/**
 * The plain OSC address that gates the link.
 */
const LINK_ENABLE_ADDRESS = '/arclink/enable'

/**
 * The avatar parameter that gates the link.
 */
const DEFAULT_ENABLE_PARAMETER = 'ArcLink'

/**
 * The default port the partner ARC-Link talks to us on.
 */
const DEFAULT_LINK_PORT = 9010

/**
 * The default port VRChat sends its OSC output on.
 */
const DEFAULT_VRCHAT_OUT_PORT = 9001

/**
 * The default port VRChat receives OSC input on.
 */
const DEFAULT_VRCHAT_IN_PORT = 9000

/**
 * The persisted ARC-Link configuration.
 */
export interface ARCLinkConfig {
  /** The address this machine binds its sockets to. */
  localIp: string
  /** The port VRChat's OSC output arrives on. */
  inPort: number
  /** The port the partner ARC-Link connects to. */
  outPort: number
  /** The partner's LAN address. */
  peerIp: string
  /** The partner's ARC-Link port. */
  peerOutPort: number
  /** The address of this machine's VRChat OSC input. */
  vrchatIp: string
  /** This machine's VRChat OSC input port. */
  vrchatInPort: number
  /** Multiplier applied to the head yaw. */
  yawSign: number
  /** True when the avatar faces -Z at yaw 0 instead of +Z. */
  forwardIsNegativeZ: boolean
  /** Multiplier applied to the avatar's turn rate. */
  angularYSign: number
  /** The speed, in m/s, that maps to a full-scale input. */
  maxSpeed: number
  /** The turn rate, in rad/s, that maps to a full-scale input. */
  maxTurnRate: number
  /** The exponential smoothing factor, 0 (frozen) to 1 (raw). */
  smoothing: number
  /** Inputs below this magnitude are treated as zero. */
  deadzone: number
  /** How often, in ms, the current state is re-sent. */
  refreshIntervalMs: number
  /** How long, in ms, our own output is ignored after an injection. */
  echoSuppressMs: number
  /** Whether the jump is mirrored. */
  mirrorJump: boolean
  /** The avatar parameter that gates the link. */
  enableParameter: string
  /** Whether the link starts enabled before either surface reports. */
  startEnabled: boolean
  /** Whether to log every forwarded message. */
  logging: boolean
  [key: string]: unknown
}

/**
 * The status the renderer sees.
 */
export interface ARCLinkStatus {
  enabled: boolean
  connected: boolean
  connectionCount: number
  /** Whether the link is currently exchanging movement. */
  linkActive: boolean
  /** The last reconstructed frame. */
  frame: { forward: number; strafe: number; turn: number }
  /** The observed world velocity. */
  velocity: { x: number; y: number; z: number }
  /** The observed turn rate, rad/s. */
  angularY: number
  /** The observed head yaw, in radians. */
  yaw: number
  /** Whether the head yaw is known. */
  yawValid: boolean
  /** Counters for the diagnostics view. */
  stats: {
    received: number
    forwarded: number
    inbound: number
    applied: number
    echoSuppressed: number
  }
  /** The last error, if any. */
  lastError: string | null
}

/**
 * A movement frame, in the -1..1 range VRChat expects.
 */
interface MotionFrame {
  forward: number
  strafe: number
  turn: number
}

/**
 * The neutral frame.
 */
const ZERO_FRAME: MotionFrame = { forward: 0, strafe: 0, turn: 0 }

/**
 * The default configuration.
 */
const DEFAULT_CONFIG: ARCLinkConfig = {
  localIp: '0.0.0.0',
  inPort: DEFAULT_VRCHAT_OUT_PORT,
  outPort: DEFAULT_LINK_PORT,
  peerIp: '127.0.0.1',
  peerOutPort: DEFAULT_LINK_PORT,
  vrchatIp: '127.0.0.1',
  vrchatInPort: DEFAULT_VRCHAT_IN_PORT,
  yawSign: 1,
  forwardIsNegativeZ: false,
  angularYSign: 1,
  maxSpeed: 3.0,
  maxTurnRate: 2.0,
  smoothing: 0.35,
  deadzone: 0.02,
  refreshIntervalMs: 100,
  echoSuppressMs: 500,
  mirrorJump: true,
  enableParameter: DEFAULT_ENABLE_PARAMETER,
  startEnabled: false,
  logging: false
}

/**
 * Clamp a value to the -1..1 range VRChat expects.
 */
function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value > 1) return 1
  if (value < -1) return -1
  return value
}

/**
 * Apply the deadzone to a value.
 */
function applyDeadzone(value: number, deadzone: number): number {
  return Math.abs(value) < deadzone ? 0 : value
}

/**
 * Convert an angle in degrees to radians.
 */
function degreesToRadians(degrees: number): number {
  return (degrees * Math.PI) / 180
}

/**
 * Interpret a value as a boolean.
 */
function isTruthy(value: unknown): boolean {
  if (value === undefined || value === null) return false
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    return value.length > 0 && value !== '0' && value.toLowerCase() !== 'false'
  }
  return Number(value) !== 0
}

/**
 * The ARC Link service.
 *
 * Emits:
 *   - `status`   - the status changed
 *   - `movement` - a new movement frame was reconstructed
 */
class ARCLink extends EventEmitter {
  enabled: boolean
  connected: boolean
  connections: Array<{ id: string }>

  /** The socket VRChat's published state arrives on. */
  private vrchatPort: InstanceType<typeof osc.UDPPort> | null = null
  /** The socket the partner's commands arrive on. */
  private linkPort: InstanceType<typeof osc.UDPPort> | null = null
  /** Sends commands to the partner ARC-Link. */
  private peerPort: InstanceType<typeof osc.UDPPort> | null = null
  /** Sends commands to the local VRChat. */
  private vrchatSender: InstanceType<typeof osc.UDPPort> | null = null

  private config: ARCLinkConfig
  /**
   * The configuration supplied to the constructor.
   *
   * These take precedence over the persisted settings, so an explicit
   * override always wins. The merge order is:
   *
   *   defaults < persisted settings < constructor overrides
   */
  private overrides: Partial<ARCLinkConfig>
  private refreshTimer: NodeJS.Timeout | null = null
  private lastError: string | null = null

  /** The observed movement state. */
  private velocityX = 0
  private velocityY = 0
  private velocityZ = 0
  private angularY = 0
  private yaw = 0
  private yawValid = false

  /** The smoothed frame currently being held. */
  private smoothed: MotionFrame = { forward: 0, strafe: 0, turn: 0 }
  /** The frame currently being held on the wire. */
  private currentFrame: MotionFrame = { forward: 0, strafe: 0, turn: 0 }
  /** The last frame applied to the local VRChat, used to spot the echo. */
  private lastAppliedFrame: MotionFrame | null = null
  /** When forwarding resumes after an injection. */
  private suppressUntil = 0

  /** Whether the link is currently exchanging movement. */
  private linkActive = false
  /** The last value seen on the enable avatar parameter. */
  private parameterValue: unknown = undefined
  /** The last value seen on the enable OSC address. */
  private addressValue: unknown = undefined

  /** Whether the local avatar was on the ground last time VRChat reported. */
  private grounded = true
  /** Whether the grounded state is known yet. */
  private groundedKnown = false
  /** Whether a jump we applied ourselves is awaiting its landing. */
  private pendingLocalJump = false
  /** Whether the airborne report for our own jump has been seen. */
  private localJumpInFlight = false
  /** When the pending local jump was applied. */
  private pendingLocalJumpAt = 0
  /** Whether a jump is currently held down locally. */
  private jumpHeld = false

  private stats = {
    received: 0,
    forwarded: 0,
    inbound: 0,
    applied: 0,
    echoSuppressed: 0
  }

  constructor(configData: Partial<ARCLinkConfig> | null = null) {
    super()
    this.enabled = false
    this.connected = false
    this.connections = []
    this.overrides = { ...(configData ?? {}) }
    this.config = { ...DEFAULT_CONFIG, ...this.overrides }
  }

  /**
   * Initialize the service.
   */
  async init(): Promise<void> {
    this.config = { ...DEFAULT_CONFIG, ...this.readStoredConfig(), ...this.overrides }
    this.enabled = this.config.startEnabled
    this.linkActive = this.enabled
    debug.info('[ARCLink] Service initialized')
  }

  /**
   * Start the ARC Link service.
   */
  async start(): Promise<{ success: boolean; error?: string }> {
    if (this.vrchatPort) {
      return { success: true }
    }

    // The persisted config fills in anything the caller did not supply,
    // so an explicit constructor config always wins over what is stored.
    this.config = { ...DEFAULT_CONFIG, ...this.readStoredConfig(), ...this.overrides }

    try {
      this.openSockets()
    } catch (error: any) {
      this.lastError = error?.message ?? String(error)
      debug.error(`[ARCLink] Failed to start: ${this.lastError}`)
      this.closeSockets()
      this.emitStatus()
      return { success: false, error: this.lastError ?? undefined }
    }

    this.connected = true
    this.refreshTimer = setInterval(() => this.refresh(), this.config.refreshIntervalMs)
    debug.info(
      `[ARCLink] Started. vrchat in ${this.config.localIp}:${this.config.inPort}, ` +
        `link in ${this.config.localIp}:${this.config.outPort}, peer ${this.config.peerIp}:${this.config.peerOutPort}`
    )
    this.emitStatus()
    return { success: true }
  }

  /**
   * Stop the ARC Link service.
   */
  async stop(): Promise<{ success: boolean }> {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer)
      this.refreshTimer = null
    }
    this.resetAxes()
    this.closeSockets()
    this.connected = false
    this.linkActive = false
    debug.info('[ARCLink] Service stopped')
    this.emitStatus()
    return { success: true }
  }

  /**
   * Get the current service status.
   */
  getStatus(): ARCLinkStatus {
    return {
      enabled: this.enabled,
      connected: this.connected,
      connectionCount: this.connections.length,
      linkActive: this.linkActive,
      frame: { ...this.smoothed },
      velocity: { x: this.velocityX, y: this.velocityY, z: this.velocityZ },
      angularY: this.angularY,
      yaw: this.yaw,
      yawValid: this.yawValid,
      stats: { ...this.stats },
      lastError: this.lastError
    }
  }

  /**
   * Whether the module is active, for the WebSocket module list.
   */
  isEnabled(): boolean {
    return this.enabled
  }

  /**
   * Update the configuration.
   */
  updateConfig(patch: Partial<ARCLinkConfig>): { success: boolean; error?: string } {
    const restartNeeded =
      (patch.localIp !== undefined && patch.localIp !== this.config.localIp) ||
      (patch.inPort !== undefined && patch.inPort !== this.config.inPort) ||
      (patch.outPort !== undefined && patch.outPort !== this.config.outPort) ||
      (patch.peerIp !== undefined && patch.peerIp !== this.config.peerIp) ||
      (patch.peerOutPort !== undefined && patch.peerOutPort !== this.config.peerOutPort) ||
      (patch.vrchatIp !== undefined && patch.vrchatIp !== this.config.vrchatIp) ||
      (patch.vrchatInPort !== undefined && patch.vrchatInPort !== this.config.vrchatInPort)

    this.config = { ...this.config, ...patch }
    // Keep the overrides in step, so a restart re-applies the same
    // settings rather than reverting to whatever was persisted.
    this.overrides = { ...this.overrides, ...patch }

    if (restartNeeded && this.connected) {
      this.closeSockets()
      try {
        this.openSockets()
      } catch (error: any) {
        this.lastError = error?.message ?? String(error)
        debug.error(`[ARCLink] Failed to restart with new config: ${this.lastError}`)
        this.emitStatus()
        return { success: false, error: this.lastError ?? undefined }
      }
    }

    if (patch.refreshIntervalMs !== undefined && this.refreshTimer) {
      clearInterval(this.refreshTimer)
      this.refreshTimer = setInterval(() => this.refresh(), this.config.refreshIntervalMs)
    }

    this.emitStatus()
    return { success: true }
  }

  /**
   * Read the persisted configuration.
   */
  private readStoredConfig(): Partial<ARCLinkConfig> {
    try {
      const stored = configManager.getARCLinkConfig()
      return stored as Partial<ARCLinkConfig>
    } catch (_error) {
      return {}
    }
  }

  /**
   * Open the four sockets.
   */
  private openSockets(): void {
    const { localIp, inPort, outPort, peerIp, peerOutPort, vrchatIp, vrchatInPort } = this.config

    // VRChat's published state.
    this.vrchatPort = new osc.UDPPort({
      localAddress: localIp,
      localPort: inPort,
      remoteAddress: '127.0.0.1',
      remotePort: inPort,
      metadata: true
    })
    this.vrchatPort.on('message', (message: any) => this.handleVrchatMessage(message))
    this.vrchatPort.on('error', (error: Error) => this.handleSocketError('vrchat-in', error))
    this.vrchatPort.open()

    // The partner's commands.
    this.linkPort = new osc.UDPPort({
      localAddress: localIp,
      localPort: outPort,
      remoteAddress: '127.0.0.1',
      remotePort: outPort,
      metadata: true
    })
    this.linkPort.on('message', (message: any) => this.handleLinkMessage(message))
    this.linkPort.on('error', (error: Error) => this.handleSocketError('link-in', error))
    this.linkPort.open()

    // Outbound: to the partner.
    this.peerPort = new osc.UDPPort({
      localAddress: '0.0.0.0',
      localPort: 0,
      remoteAddress: peerIp,
      remotePort: peerOutPort,
      metadata: true
    })
    this.peerPort.on('error', (error: Error) => this.handleSocketError('peer-out', error))
    this.peerPort.open()

    // Outbound: to the local VRChat.
    this.vrchatSender = new osc.UDPPort({
      localAddress: '0.0.0.0',
      localPort: 0,
      remoteAddress: vrchatIp,
      remotePort: vrchatInPort,
      metadata: true
    })
    this.vrchatSender.on('error', (error: Error) => this.handleSocketError('vrchat-out', error))
    this.vrchatSender.open()
  }

  /**
   * Close the four sockets.
   */
  private closeSockets(): void {
    const ports = [this.vrchatPort, this.linkPort, this.peerPort, this.vrchatSender]
    for (const port of ports) {
      if (!port) continue
      try {
        port.removeAllListeners()
        port.close()
      } catch (error) {
        const err = error as Error & { code?: string }
        if (err.code !== 'ERR_SOCKET_DGRAM_NOT_RUNNING') {
          debug.warn(`[ARCLink] Error closing socket: ${err.message}`)
        }
      }
    }
    this.vrchatPort = null
    this.linkPort = null
    this.peerPort = null
    this.vrchatSender = null
  }

  /**
   * Record a socket error.
   */
  private handleSocketError(which: string, error: Error): void {
    this.lastError = `${which}: ${error.message}`
    debug.error(`[ARCLink] Socket error on ${which}: ${error.message}`)
    this.emitStatus()
  }

  // -------------------------------------------------------------------
  // Incoming: VRChat's published state
  // -------------------------------------------------------------------

  /**
   * Handle a message published by the local VRChat.
   */
  private handleVrchatMessage(message: any): void {
    this.stats.received++

    const address: string = message?.address
    if (typeof address !== 'string') return

    const args: any[] = Array.isArray(message?.args) ? message.args : []
    const value = args.length > 0 ? args[0]?.value : undefined

    // The enable surfaces are consumed locally and never forwarded.
    if (address === `/avatar/parameters/${this.config.enableParameter}`) {
      this.parameterValue = value
      this.updateEnabledState()
      return
    }
    if (address === LINK_ENABLE_ADDRESS) {
      this.addressValue = value
      this.updateEnabledState()
      return
    }

    if (address === '/avatar/parameters/VelocityX') {
      this.velocityX = Number(value) || 0
      return
    }
    if (address === '/avatar/parameters/VelocityY') {
      this.velocityY = Number(value) || 0
      return
    }
    if (address === '/avatar/parameters/VelocityZ') {
      this.velocityZ = Number(value) || 0
      return
    }
    if (address === '/avatar/parameters/AngularY') {
      this.angularY = Number(value) || 0
      return
    }
    if (address === '/avatar/parameters/Grounded') {
      this.handleGrounded(value)
      return
    }

    // The head pose carries the facing direction, which is what turns a
    // world velocity into a local forward/strafe pair. The layout is
    // [x, y, z, rotX, rotY, rotZ] - six floats, Unity Euler angles IN
    // DEGREES.
    if (address === '/tracking/vrsystem/head/pose') {
      const rotY = args[4]?.value
      if (typeof rotY === 'number') {
        this.setYaw(rotY)
      }
      return
    }
    if (address === '/tracking/track/head/rotation') {
      const rotY = args[1]?.value
      if (typeof rotY === 'number') {
        this.setYaw(rotY)
      }
      return
    }
  }

  /**
   * Record the head yaw. VRChat publishes it in DEGREES.
   */
  private setYaw(yawDegrees: number): void {
    if (!Number.isFinite(yawDegrees)) return
    this.yaw = degreesToRadians(yawDegrees)
    this.yawValid = true
  }

  /**
   * Handle a change to the grounded state and mirror a jump if needed.
   *
   * A jump is the transition from grounded to airborne, followed by a
   * landing. The link fires on the LANDING, because that is the point at
   * which the player has definitely completed the jump.
   *
   * The state machine tracks the jump we applied ourselves exactly, so
   * only a landing that follows an airborne report we witnessed is
   * recognised as our own echo.
   */
  private handleGrounded(value: unknown): void {
    const grounded = isTruthy(value)
    const previous = this.grounded
    const hadState = this.groundedKnown

    this.grounded = grounded
    this.groundedKnown = true

    if (!hadState) {
      if (!grounded && this.pendingLocalJump) {
        this.localJumpInFlight = true
      }
      return
    }

    if (grounded === previous) return

    if (!grounded) {
      if (this.pendingLocalJump) {
        this.localJumpInFlight = true
      }
      return
    }

    // Landing.
    if (this.pendingLocalJump) {
      if (this.localJumpInFlight) {
        this.stats.echoSuppressed++
        this.pendingLocalJump = false
        this.localJumpInFlight = false
        return
      }
      // We applied a jump but never left the ground - the world probably
      // does not support jumping. Drop it so a later genuine jump is not
      // swallowed.
      this.pendingLocalJump = false
    }

    this.sendJump()
  }

  // -------------------------------------------------------------------
  // Incoming: the partner's commands
  // -------------------------------------------------------------------

  /**
   * Handle a command received from the partner ARC-Link.
   *
   * These are applied to the local VRChat but never re-forwarded.
   */
  private handleLinkMessage(message: any): void {
    this.stats.inbound++

    const address: string = message?.address
    if (typeof address !== 'string') return

    const args: any[] = Array.isArray(message?.args) ? message.args : []
    const value = args.length > 0 ? args[0]?.value : undefined

    // The partner's enable surfaces are honoured too.
    if (address === `/avatar/parameters/${this.config.enableParameter}`) {
      this.parameterValue = value
      this.updateEnabledState()
      return
    }
    if (address === LINK_ENABLE_ADDRESS) {
      this.addressValue = value
      this.updateEnabledState()
      return
    }

    if (!this.linkActive) return

    if (address === INPUT_AXIS_ADDRESSES.forward) {
      this.currentFrame.forward = Number(value) || 0
      this.applyFrame()
      return
    }
    if (address === INPUT_AXIS_ADDRESSES.strafe) {
      this.currentFrame.strafe = Number(value) || 0
      this.applyFrame()
      return
    }
    if (address === INPUT_AXIS_ADDRESSES.turn) {
      this.currentFrame.turn = Number(value) || 0
      this.applyFrame()
      return
    }
    if (address === INPUT_BUTTON_ADDRESSES.jump) {
      this.applyJump(value)
      return
    }
  }

  // -------------------------------------------------------------------
  // Outgoing
  // -------------------------------------------------------------------

  /**
   * Reconstruct the current movement frame and send it to the partner.
   */
  private refresh(): void {
    this.expireStaleJump()

    if (!this.linkActive) return

    const frame = this.reconstruct()
    this.smoothed = frame
    this.emit('movement', { ...frame })

    // GUARD 1: the suppression window.
    if (Date.now() < this.suppressUntil) {
      this.stats.echoSuppressed++
      return
    }

    // GUARD 2: the frame match.
    if (this.lastAppliedFrame && this.framesMatch(frame, this.lastAppliedFrame)) {
      this.stats.echoSuppressed++
      return
    }

    this.sendFrameToPeer(frame)
  }

  /**
   * Reconstruct the movement commands for the observed state.
   */
  private reconstruct(): MotionFrame {
    const { yawSign, forwardIsNegativeZ, angularYSign, maxSpeed, maxTurnRate, smoothing, deadzone } = this.config

    const speed = Math.hypot(this.velocityX, this.velocityZ)

    let forward: number
    let strafe: number

    if (this.yawValid) {
      const angle = yawSign * this.yaw
      const facing = { x: Math.sin(angle), z: forwardIsNegativeZ ? -Math.cos(angle) : Math.cos(angle) }
      const right = { x: Math.cos(angle), z: forwardIsNegativeZ ? Math.sin(angle) : -Math.sin(angle) }
      forward = this.velocityX * facing.x + this.velocityZ * facing.z
      strafe = this.velocityX * right.x + this.velocityZ * right.z
    } else {
      // Without a head pose the facing direction is unknown, so only the
      // magnitude can be reconstructed. Treat it as forward motion.
      forward = speed
      strafe = 0
    }

    const target = {
      forward: clamp(forward / (maxSpeed > 0 ? maxSpeed : 1)),
      strafe: clamp(strafe / (maxSpeed > 0 ? maxSpeed : 1)),
      turn: clamp((this.angularY * angularYSign) / (maxTurnRate > 0 ? maxTurnRate : 1))
    }

    target.forward = applyDeadzone(target.forward, deadzone)
    target.strafe = applyDeadzone(target.strafe, deadzone)
    target.turn = applyDeadzone(target.turn, deadzone)

    const factor = smoothing
    return {
      forward: this.smoothed.forward + (target.forward - this.smoothed.forward) * factor,
      strafe: this.smoothed.strafe + (target.strafe - this.smoothed.strafe) * factor,
      turn: this.smoothed.turn + (target.turn - this.smoothed.turn) * factor
    }
  }

  /**
   * Send a movement frame to the partner.
   */
  private sendFrameToPeer(frame: MotionFrame): void {
    if (!this.peerPort) return

    const sent =
      this.sendTo(this.peerPort, INPUT_AXIS_ADDRESSES.forward, frame.forward, 'f') &&
      this.sendTo(this.peerPort, INPUT_AXIS_ADDRESSES.strafe, frame.strafe, 'f') &&
      this.sendTo(this.peerPort, INPUT_AXIS_ADDRESSES.turn, frame.turn, 'f')

    if (sent) {
      this.stats.forwarded++
      if (this.config.logging) {
        console.log(
          `[ARCLink] -> partner  forward=${frame.forward.toFixed(3)} ` +
            `strafe=${frame.strafe.toFixed(3)} turn=${frame.turn.toFixed(3)}`
        )
      }
    }
  }

  /**
   * Apply the current frame to the local VRChat.
   */
  private applyFrame(): void {
    if (!this.linkActive || !this.vrchatSender) return

    const frame = { ...this.currentFrame }

    const sent =
      this.sendTo(this.vrchatSender, INPUT_AXIS_ADDRESSES.forward, frame.forward, 'f') &&
      this.sendTo(this.vrchatSender, INPUT_AXIS_ADDRESSES.strafe, frame.strafe, 'f') &&
      this.sendTo(this.vrchatSender, INPUT_AXIS_ADDRESSES.turn, frame.turn, 'f')

    if (!sent) return

    this.stats.applied++
    this.lastAppliedFrame = frame
    this.suppressUntil = Date.now() + this.config.echoSuppressMs

    // Prime the tracker so the echo guard recognises the movement VRChat
    // is about to publish in response to this command.
    this.primeFromFrame(frame)

    if (this.config.logging) {
      console.log(
        `[ARCLink] -> vrchat   forward=${frame.forward.toFixed(3)} ` +
          `strafe=${frame.strafe.toFixed(3)} turn=${frame.turn.toFixed(3)}`
      )
    }
  }

  /**
   * Prime the observed state with the movement a command represents.
   *
   * Without this, the smoothed frame would ramp up towards the new state
   * while the command that caused it sat at its final value - so the two
   * would not match and the echo guard would fail.
   */
  private primeFromFrame(frame: MotionFrame): void {
    const { yawSign, forwardIsNegativeZ, angularYSign, maxSpeed, maxTurnRate } = this.config

    this.angularY = (frame.turn * (maxTurnRate > 0 ? maxTurnRate : 1)) / angularYSign

    if (this.yawValid) {
      const angle = yawSign * this.yaw
      const facing = { x: Math.sin(angle), z: forwardIsNegativeZ ? -Math.cos(angle) : Math.cos(angle) }
      const right = { x: Math.cos(angle), z: forwardIsNegativeZ ? Math.sin(angle) : -Math.sin(angle) }
      const speed = frame.forward * (maxSpeed > 0 ? maxSpeed : 1)
      const strafeSpeed = frame.strafe * (maxSpeed > 0 ? maxSpeed : 1)
      this.velocityX = speed * facing.x + strafeSpeed * right.x
      this.velocityZ = speed * facing.z + strafeSpeed * right.z
    } else {
      this.velocityX = 0
      this.velocityZ = frame.forward * (maxSpeed > 0 ? maxSpeed : 1)
    }

    this.smoothed = { ...frame }
  }

  /**
   * Send a jump to the partner.
   */
  private sendJump(): void {
    if (!this.config.mirrorJump || !this.linkActive || !this.peerPort) return

    // Buttons latch in VRChat, so a press has to be followed by a release.
    const sent = this.sendTo(this.peerPort, INPUT_BUTTON_ADDRESSES.jump, 1, 'i')
    this.sendTo(this.peerPort, INPUT_BUTTON_ADDRESSES.jump, 0, 'i')

    if (sent) {
      this.stats.forwarded++
      if (this.config.logging) {
        console.log('[ARCLink] -> partner  jump')
      }
    }
  }

  /**
   * Apply a jump from the partner to the local VRChat.
   */
  private applyJump(value: unknown): void {
    if (!this.config.mirrorJump || !this.linkActive || !this.vrchatSender) return

    const pressed = isTruthy(value)
    if (pressed === this.jumpHeld) return
    this.jumpHeld = pressed

    this.sendTo(this.vrchatSender, INPUT_BUTTON_ADDRESSES.jump, pressed ? 1 : 0, 'i')
    this.stats.applied++

    if (pressed) {
      // Our own jump will take us off the ground and bring us back, so
      // the landing must not be mirrored back to the partner.
      this.pendingLocalJump = true
      this.localJumpInFlight = false
      this.pendingLocalJumpAt = Date.now()
    }

    if (this.config.logging) {
      console.log(`[ARCLink] -> vrchat   jump=${pressed ? 1 : 0}`)
    }
  }

  /**
   * Drop a pending local jump that never produced a landing.
   */
  private expireStaleJump(): void {
    if (!this.pendingLocalJump) return
    if (Date.now() - this.pendingLocalJumpAt < this.config.echoSuppressMs) return
    this.pendingLocalJump = false
    this.localJumpInFlight = false
  }

  // -------------------------------------------------------------------
  // Enable / disable
  // -------------------------------------------------------------------

  /**
   * Recompute the enabled state and emit a change if it moved.
   */
  private updateEnabledState(): void {
    const next = isTruthy(this.parameterValue) || isTruthy(this.addressValue)
    if (next === this.linkActive) return

    this.linkActive = next
    this.enabled = next

    if (!next) {
      // The link just went down - release every latched axis so the
      // avatars do not stay stuck mid-stride.
      this.resetAxes()
    }

    debug.info(`[ARCLink] Link ${next ? 'ENABLED' : 'DISABLED'}`)
    this.emitStatus()
  }

  /**
   * Send a zero for every axis, to both the local VRChat and the partner.
   */
  private resetAxes(): void {
    this.currentFrame = { ...ZERO_FRAME }
    this.lastAppliedFrame = null
    this.smoothed = { ...ZERO_FRAME }
    this.velocityX = 0
    this.velocityY = 0
    this.velocityZ = 0
    this.angularY = 0

    if (this.jumpHeld) {
      this.jumpHeld = false
      this.sendTo(this.vrchatSender, INPUT_BUTTON_ADDRESSES.jump, 0, 'i')
      this.sendTo(this.peerPort, INPUT_BUTTON_ADDRESSES.jump, 0, 'i')
    }

    this.pendingLocalJump = false
    this.localJumpInFlight = false

    if (this.vrchatSender) {
      this.sendTo(this.vrchatSender, INPUT_AXIS_ADDRESSES.forward, 0, 'f')
      this.sendTo(this.vrchatSender, INPUT_AXIS_ADDRESSES.strafe, 0, 'f')
      this.sendTo(this.vrchatSender, INPUT_AXIS_ADDRESSES.turn, 0, 'f')
    }
    if (this.peerPort) {
      this.sendTo(this.peerPort, INPUT_AXIS_ADDRESSES.forward, 0, 'f')
      this.sendTo(this.peerPort, INPUT_AXIS_ADDRESSES.strafe, 0, 'f')
      this.sendTo(this.peerPort, INPUT_AXIS_ADDRESSES.turn, 0, 'f')
    }
  }

  // -------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------

  /**
   * Send one OSC message on a port.
   */
  private sendTo(
    port: InstanceType<typeof osc.UDPPort> | null,
    address: string,
    value: number,
    type: 'f' | 'i'
  ): boolean {
    if (!port) return false
    try {
      port.send({ address, args: [{ type, value }] })
      return true
    } catch (error) {
      const err = error as Error
      this.lastError = err.message
      debug.error(`[ARCLink] Error sending ${address}: ${err.message}`)
      return false
    }
  }

  /**
   * Whether two frames describe the same movement.
   */
  private framesMatch(a: MotionFrame, b: MotionFrame): boolean {
    const tolerance = 0.05
    return (
      Math.abs(a.forward - b.forward) <= tolerance &&
      Math.abs(a.strafe - b.strafe) <= tolerance &&
      Math.abs(a.turn - b.turn) <= tolerance
    )
  }

  /**
   * Emit the current status to the renderer.
   */
  private emitStatus(): void {
    this.emit('status', this.getStatus())
  }

  /**
   * Clean up resources.
   */
  async close(): Promise<void> {
    await this.stop()
    this.removeAllListeners()
    debug.info('[ARCLink] Service closed')
  }
}

export default ARCLink
