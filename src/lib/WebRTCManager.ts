import {
  consumeSignalPacket,
  sendSignalPacket,
  subscribeToSignalsForTarget,
} from './firebase';
import {
  ADAPTIVE_QUALITY_TIERS,
  AdaptiveQualityTierId,
  MultiplexEnvelope,
  MultiplexSubChannel,
  P2PControlMessage,
  TelemetrySnapshot,
  TransportEngine,
} from '../types/opticlink';

// ============================================================================
// PRE-WARMED RTCPeerConnection CONFIGURATION (10-CANDIDATE ICE POOL & MULTI-STUN)
// ============================================================================
export const PREWARMED_RTC_CONFIG: RTCConfiguration = {
  iceCandidatePoolSize: 10,
  bundlePolicy: 'max-bundle',
  rtcpMuxPolicy: 'require',
  iceServers: [
    {
      urls: [
        'stun:stun.cloudflare.com:3478',
        'stun:stun.l.google.com:19302',
        'stun:stun1.l.google.com:19302',
        'stun:stun2.l.google.com:19302',
      ],
    },
  ],
};

export interface WebRTCManagerCallbacks {
  onControlMessage: (msg: P2PControlMessage) => void;
  onRemoteCameraStream?: (stream: MediaStream) => void;
  onRemoteScreenStream?: (stream: MediaStream) => void;
  onTelemetryUpdate?: (telemetry: TelemetrySnapshot) => void;
  onConnectionStateChange?: (state: string, dcOpen: boolean) => void;
}

export interface WebRTCManagerOptions {
  localId: string;
  remoteId: string;
  polite: boolean;
  callbacks: WebRTCManagerCallbacks;
}

// ============================================================================
// WebRTCManager Utility
// - Pre-warms RTCPeerConnection with iceCandidatePoolSize: 10 & multiple STUNs
// - Establishes persistent 'control-plane' RTCDataChannel for <250ms execution
// - Pre-allocates 'sendrecv' camera & screen transceivers while hardware is OFF
// - Supports in-band SDP renegotiation over 'control-plane' DataChannel
// ============================================================================
export class WebRTCManager {
  public pc: RTCPeerConnection;
  public controlChannel: RTCDataChannel | null = null;
  public cameraTransceiver: RTCRtpTransceiver | null = null;
  public screenTransceiver: RTCRtpTransceiver | null = null;

  private localId: string;
  private remoteId: string;
  private polite: boolean;
  private peerInstanceId: string;
  private callbacks: WebRTCManagerCallbacks;
  private unsubscribeSignals: (() => void) | null = null;

  private makingOffer = false;
  private ignoreOffer = false;
  private isSettingRemoteAnswerPending = false;
  private pendingIceCandidates: RTCIceCandidateInit[] = [];
  private outboundMessageQueue: string[] = [];
  private seqCounter = 0;
  private seenEnvelopeKeys = new Set<string>();

  private activeLocalCameraTrack: MediaStreamTrack | null = null;
  private activeLocalScreenTrack: MediaStreamTrack | null = null;

  private statsInterval: number | null = null;
  private prevBytes = 0;
  private prevTimestamp = 0;
  private lastPingMs = 18;
  private lastPacketLossPct = 0;
  private activeEngine: TransportEngine = 'RTP';
  private currentTierId: AdaptiveQualityTierId = 'TIER_720P_30';
  private sessionBootedAt = Date.now();
  public inboundFramesDecoded = 0;
  private hasEmittedDecodedStream = false;

  constructor(options: WebRTCManagerOptions) {
    this.localId = options.localId;
    this.remoteId = options.remoteId;
    this.polite = options.polite;
    this.peerInstanceId = `${options.localId}-${Math.random().toString(36).slice(2, 8)}`;
    this.callbacks = options.callbacks;

    this.pc = new RTCPeerConnection(PREWARMED_RTC_CONFIG);
    this.initializePreWarmedConnection();
    this.initializeSignalingChannel();
  }

  private rebuildPeerConnection() {
    try {
      this.controlChannel?.close();
      this.pc.close();
    } catch {
      // Ignore
    }
    this.makingOffer = false;
    this.ignoreOffer = false;
    this.isSettingRemoteAnswerPending = false;
    this.pendingIceCandidates = [];
    this.cameraTransceiver = null;
    this.screenTransceiver = null;
    this.hasEmittedDecodedStream = false;

    this.pc = new RTCPeerConnection(PREWARMED_RTC_CONFIG);
    this.initializePreWarmedConnection();
  }

  private initializePreWarmedConnection() {
    // 1. Create persistent 'control-plane' RTCDataChannel (negotiated id: 0 for instant P2P)
    try {
      this.controlChannel = this.pc.createDataChannel('control-plane', {
        negotiated: true,
        id: 0,
        ordered: true,
      });
      this.bindControlDataChannel(this.controlChannel);
    } catch {
      if (!this.polite) {
        this.controlChannel = this.pc.createDataChannel('control-plane', {
          ordered: true,
        });
        this.bindControlDataChannel(this.controlChannel);
      } else {
        this.pc.ondatachannel = (event) => {
          if (event.channel.label === 'control-plane' || !this.controlChannel) {
            this.controlChannel = event.channel;
            this.bindControlDataChannel(event.channel);
          }
        };
      }
    }

    // 2. Pre-allocate two video transceivers ('sendrecv') while camera/screen remain 100% OFF
    if (!this.polite) {
      this.cameraTransceiver = this.pc.addTransceiver('video', {
        direction: 'sendrecv',
      });
      this.screenTransceiver = this.pc.addTransceiver('video', {
        direction: 'sendrecv',
      });
      this.bindReceiverTrackEvents(this.cameraTransceiver, 'camera');
      this.bindReceiverTrackEvents(this.screenTransceiver, 'screen');
    }

    // 3. Handle remote media tracks and unmute transitions when replaceTrack() executes
    this.pc.ontrack = (event) => {
      const track = event.track;
      const videoTransceivers = this.pc
        .getTransceivers()
        .filter((t) => t.receiver.track?.kind === 'video');
      const idx = videoTransceivers.findIndex((t) => t.receiver.track?.id === track.id);
      const isScreen = idx === 1;

      const emitStream = () => {
        const freshStream = new MediaStream([track]);
        if (isScreen) {
          this.callbacks.onRemoteScreenStream?.(freshStream);
        } else {
          this.callbacks.onRemoteCameraStream?.(freshStream);
        }
      };

      track.onunmute = () => {
        emitStream();
      };

      if (!track.muted) {
        emitStream();
      }
    };

    // 4. Trickle ICE from the 10-candidate pre-warmed pool
    this.pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        sendSignalPacket({
          fromId: this.localId,
          toId: this.remoteId,
          type: 'ICE',
          payload: JSON.stringify(candidate.toJSON()),
          createdAt: Date.now(),
        }).catch(() => {});
      }
    };

    // 5. Seamless Wi-Fi <-> 4G Roaming via automatic ICE restart
    this.pc.oniceconnectionstatechange = () => {
      const state = this.pc.iceConnectionState;
      this.callbacks.onConnectionStateChange?.(
        state,
        this.controlChannel?.readyState === 'open'
      );
      if (state === 'disconnected' || state === 'failed') {
        try {
          this.pc.restartIce();
          if (!this.polite) {
            this.initiateOrRenegotiateOffer();
          }
        } catch {
          // Ignore
        }
      }
    };
  }

  private bindControlDataChannel(channel: RTCDataChannel) {
    channel.onopen = () => {
      this.callbacks.onConnectionStateChange?.(this.pc.iceConnectionState, true);
      if (this.outboundMessageQueue.length > 0) {
        const queued = [...this.outboundMessageQueue];
        this.outboundMessageQueue = [];
        for (const payload of queued) {
          try {
            channel.send(payload);
          } catch {
            // Ignore
          }
        }
      }
    };

    channel.onclose = () => {
      this.callbacks.onConnectionStateChange?.(this.pc.iceConnectionState, false);
    };

    channel.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data);
        this.processRawControlPayload(parsed);
      } catch {
        // Ignore malformed frame
      }
    };
  }

  private initializeSignalingChannel() {
    this.unsubscribeSignals = subscribeToSignalsForTarget(this.localId, async (packet) => {
      if (packet.fromId !== this.remoteId) return;
      if (packet.createdAt && packet.createdAt < this.sessionBootedAt - 90000) {
        if (packet.id) consumeSignalPacket(packet.id).catch(() => {});
        return;
      }

      try {
        if (packet.type === 'OFFER' || packet.type === 'ANSWER') {
          const description = JSON.parse(packet.payload) as RTCSessionDescriptionInit;
          await this.handleRemoteSdpDescription(description);
        } else if (packet.type === 'ICE') {
          const candidate = JSON.parse(packet.payload) as RTCIceCandidateInit;
          if (this.pc.remoteDescription && this.pc.remoteDescription.type) {
            try {
              await this.pc.addIceCandidate(candidate);
            } catch {
              // Ignore
            }
          } else {
            this.pendingIceCandidates.push(candidate);
          }
        } else if (packet.type === 'CONTROL') {
          const parsed = JSON.parse(packet.payload);
          this.processRawControlPayload(parsed);
        }
      } catch {
        // Ignore transient signaling race
      } finally {
        if (packet.id) {
          consumeSignalPacket(packet.id).catch(() => {});
        }
      }
    });

    if (this.polite) {
      sendSignalPacket({
        fromId: this.localId,
        toId: this.remoteId,
        type: 'CONTROL',
        payload: JSON.stringify({
          type: 'CMD_PREWARM_SYN',
          initiatorId: this.localId,
        } satisfies P2PControlMessage),
        createdAt: Date.now(),
      }).catch(() => {});
    } else {
      setTimeout(() => {
        this.initiateOrRenegotiateOffer();
      }, 40);
    }

    this.statsInterval = window.setInterval(() => {
      this.collectTelemetryStats();
    }, 1000);
  }

  private async handleRemoteSdpDescription(description: RTCSessionDescriptionInit) {
    if (
      this.polite &&
      description.type === 'offer' &&
      (this.pc.signalingState === 'closed' || this.pc.iceConnectionState === 'failed')
    ) {
      this.rebuildPeerConnection();
    }

    const readyForOffer =
      !this.makingOffer &&
      (this.pc.signalingState === 'stable' || this.isSettingRemoteAnswerPending);
    const offerCollision = description.type === 'offer' && !readyForOffer;

    this.ignoreOffer = !this.polite && offerCollision;
    if (this.ignoreOffer) {
      return;
    }

    if (offerCollision && this.polite) {
      try {
        await this.pc.setLocalDescription({ type: 'rollback' });
      } catch {
        // Ignore rollback error
      }
    }

    this.isSettingRemoteAnswerPending = description.type === 'answer';
    await this.pc.setRemoteDescription(description);
    this.isSettingRemoteAnswerPending = false;

    const videoTransceivers = this.pc
      .getTransceivers()
      .filter((t) => t.receiver.track?.kind === 'video' || t.sender.track?.kind === 'video');

    if (videoTransceivers[0]) {
      this.cameraTransceiver = videoTransceivers[0];
      this.cameraTransceiver.direction = 'sendrecv';
      this.bindReceiverTrackEvents(this.cameraTransceiver, 'camera');
      if (
        this.activeLocalCameraTrack &&
        this.activeLocalCameraTrack.readyState === 'live' &&
        this.cameraTransceiver.sender.track !== this.activeLocalCameraTrack
      ) {
        try {
          await this.cameraTransceiver.sender.replaceTrack(this.activeLocalCameraTrack);
        } catch {
          // Ignore
        }
      }
    }

    if (videoTransceivers[1]) {
      this.screenTransceiver = videoTransceivers[1];
      this.screenTransceiver.direction = 'sendrecv';
      this.bindReceiverTrackEvents(this.screenTransceiver, 'screen');
      if (
        this.activeLocalScreenTrack &&
        this.activeLocalScreenTrack.readyState === 'live' &&
        this.screenTransceiver.sender.track !== this.activeLocalScreenTrack
      ) {
        try {
          await this.screenTransceiver.sender.replaceTrack(this.activeLocalScreenTrack);
        } catch {
          // Ignore
        }
      }
    }

    await this.flushPendingIceCandidates();

    if (description.type === 'offer') {
      await this.pc.setLocalDescription();
      if (this.pc.localDescription) {
        const answerDesc: RTCSessionDescriptionInit = {
          type: this.pc.localDescription.type,
          sdp: this.pc.localDescription.sdp,
        };
        if (this.controlChannel && this.controlChannel.readyState === 'open') {
          this.sendControlMessage({
            type: 'SDP_RENEGOTIATE',
            description: answerDesc,
          });
        }
        await sendSignalPacket({
          fromId: this.localId,
          toId: this.remoteId,
          type: 'ANSWER',
          payload: JSON.stringify(answerDesc),
          createdAt: Date.now(),
        });
      }
    }
  }

  private processRawControlPayload(parsed: unknown) {
    if (!parsed || typeof parsed !== 'object') return;
    if ('subChannel' in parsed && 'message' in parsed) {
      const env = parsed as MultiplexEnvelope;
      if (env.fromPeerInstanceId && typeof env.seq === 'number') {
        const dedupeKey = `${env.fromPeerInstanceId}:${env.seq}`;
        if (this.seenEnvelopeKeys.has(dedupeKey)) {
          return;
        }
        this.seenEnvelopeKeys.add(dedupeKey);
        if (this.seenEnvelopeKeys.size > 300) {
          const first = this.seenEnvelopeKeys.values().next().value;
          if (first) this.seenEnvelopeKeys.delete(first);
        }
      }
      this.handleIncomingControlMessage(env.message);
    } else {
      this.handleIncomingControlMessage(parsed as P2PControlMessage);
    }
  }

  private bindReceiverTrackEvents(
    transceiver: RTCRtpTransceiver,
    kind: 'camera' | 'screen'
  ) {
    const track = transceiver.receiver?.track;
    if (!track) return;
    track.onunmute = () => {
      const stream = new MediaStream([track]);
      if (kind === 'camera') {
        this.callbacks.onRemoteCameraStream?.(stream);
      } else {
        this.callbacks.onRemoteScreenStream?.(stream);
      }
    };
  }

  public getReceiverMediaStream(kind: 'camera' | 'screen'): MediaStream | null {
    const videoTransceivers = this.pc
      .getTransceivers()
      .filter((t) => t.receiver.track?.kind === 'video');
    const transceiver =
      kind === 'camera'
        ? this.cameraTransceiver || videoTransceivers[0]
        : this.screenTransceiver || videoTransceivers[1];
    const track = transceiver?.receiver?.track;
    if (track && track.readyState === 'live') {
      return new MediaStream([track]);
    }
    return null;
  }

  public async applyStreamEncodingParameters(
    tierId: AdaptiveQualityTierId,
    track: MediaStreamTrack | null,
    sender: RTCRtpSender | null
  ): Promise<void> {
    const spec = ADAPTIVE_QUALITY_TIERS[tierId] || ADAPTIVE_QUALITY_TIERS.TIER_720P_30;

    if (track && track.readyState === 'live') {
      try {
        await track.applyConstraints({
          width: { ideal: spec.width, max: 1280 },
          height: { ideal: spec.height, max: 720 },
          frameRate: { ideal: spec.fps, max: 30 },
        });
      } catch {
        // Ignore if hardware doesn't support dynamic constraint resize
      }
    }

    if (sender) {
      try {
        const params = sender.getParameters();
        if (!params.encodings || params.encodings.length === 0) {
          params.encodings = [{}];
        }
        params.encodings[0].maxBitrate = spec.maxBitrateKbps * 1000;
        params.encodings[0].maxFramerate = spec.fps;
        await sender.setParameters(params);
      } catch {
        // Ignore
      }
    }
  }

  public async attachMediaTrackToTransceiver(
    kind: 'camera' | 'screen',
    track: MediaStreamTrack | null,
    tierId: AdaptiveQualityTierId
  ): Promise<RTCRtpSender | null> {
    if (kind === 'camera') {
      this.activeLocalCameraTrack = track;
    } else {
      this.activeLocalScreenTrack = track;
    }

    const videoTransceivers = this.pc
      .getTransceivers()
      .filter((t) => t.receiver.track?.kind === 'video' || t.sender.track?.kind === 'video');

    let transceiver =
      kind === 'camera'
        ? this.cameraTransceiver || videoTransceivers[0]
        : this.screenTransceiver || videoTransceivers[1];

    if (!transceiver) {
      if (!track) return null;
      transceiver = this.pc.addTransceiver(track, { direction: 'sendrecv' });
      if (kind === 'camera') this.cameraTransceiver = transceiver;
      else this.screenTransceiver = transceiver;
      await this.applyStreamEncodingParameters(tierId, track, transceiver.sender);
      await this.initiateOrRenegotiateOffer();
      return transceiver.sender;
    }

    transceiver.direction = 'sendrecv';
    await transceiver.sender.replaceTrack(track);
    if (track) {
      await this.applyStreamEncodingParameters(tierId, track, transceiver.sender);
      await this.initiateOrRenegotiateOffer();
    }

    return transceiver.sender;
  }

  public async initiateOrRenegotiateOffer(): Promise<void> {
    if (this.makingOffer || this.pc.signalingState !== 'stable') return;
    try {
      this.makingOffer = true;
      await this.pc.setLocalDescription();
      if (this.pc.localDescription) {
        const offerDesc: RTCSessionDescriptionInit = {
          type: this.pc.localDescription.type,
          sdp: this.pc.localDescription.sdp,
        };
        if (this.controlChannel && this.controlChannel.readyState === 'open') {
          this.sendControlMessage({
            type: 'SDP_RENEGOTIATE',
            description: offerDesc,
          });
        }
        await sendSignalPacket({
          fromId: this.localId,
          toId: this.remoteId,
          type: offerDesc.type === 'offer' ? 'OFFER' : 'ANSWER',
          payload: JSON.stringify(offerDesc),
          createdAt: Date.now(),
        });
      }
    } catch {
      // Ignore
    } finally {
      this.makingOffer = false;
    }
  }

  private async flushPendingIceCandidates(): Promise<void> {
    if (this.pendingIceCandidates.length === 0) return;
    const queued = [...this.pendingIceCandidates];
    this.pendingIceCandidates = [];
    for (const candidate of queued) {
      try {
        await this.pc.addIceCandidate(candidate);
      } catch {
        // Ignore
      }
    }
  }

  private resolveSubChannel(msg: P2PControlMessage): MultiplexSubChannel {
    switch (msg.type) {
      case 'CMD_PING':
      case 'EVT_PONG':
        return 'PING';
      case 'EVT_AGENT_TELEMETRY':
        return 'TELEMETRY';
      case 'EVT_WEBP_FALLBACK_FRAME':
        return 'WEBP_FRAME';
      case 'SDP_RENEGOTIATE':
        return 'SDP';
      default:
        return 'CMD';
    }
  }

  private handleIncomingControlMessage(msg: P2PControlMessage) {
    if (msg.type === 'CMD_PREWARM_SYN') {
      if (!this.polite) {
        this.initiateOrRenegotiateOffer();
      }
      return;
    }
    if (msg.type === 'SDP_RENEGOTIATE') {
      this.handleRemoteSdpDescription(msg.description).catch(() => {});
      return;
    }
    if (msg.type === 'CMD_PING') {
      this.sendControlMessage({
        type: 'EVT_PONG',
        sentAt: msg.sentAt,
        agentState: {},
      });
    } else if (msg.type === 'EVT_PONG') {
      this.lastPingMs = Math.max(1, Date.now() - msg.sentAt);
    } else if (msg.type === 'EVT_WEBP_FALLBACK_FRAME') {
      if (this.inboundFramesDecoded === 0) {
        this.activeEngine = 'WEBP_FALLBACK';
      }
    }
    this.callbacks.onControlMessage(msg);
  }

  // Dispatches control commands over the 'control-plane' RTCDataChannel (~20ms)
  // with sequence-deduplicated Firestore signaling backup for <250ms execution
  public sendControlMessage(msg: P2PControlMessage): boolean {
    const subChannel = this.resolveSubChannel(msg);
    const envelope: MultiplexEnvelope = {
      subChannel,
      seq: ++this.seqCounter,
      sentAt: Date.now(),
      fromPeerInstanceId: this.peerInstanceId,
      message: msg,
    };
    const serialized = JSON.stringify(envelope);

    let sentOverDataChannel = false;
    if (this.controlChannel && this.controlChannel.readyState === 'open') {
      try {
        this.controlChannel.send(serialized);
        sentOverDataChannel = true;
      } catch {
        sentOverDataChannel = false;
      }
    }

    const isCriticalCommand =
      msg.type === 'CMD_START_STREAM' ||
      msg.type === 'CMD_STOP_STREAM' ||
      msg.type === 'CMD_WARM_PAUSE' ||
      msg.type === 'CMD_SWITCH_LENS' ||
      msg.type === 'CMD_PING' ||
      msg.type === 'EVT_PONG';

    if ((!sentOverDataChannel || isCriticalCommand) && serialized.length < 62000) {
      if (!sentOverDataChannel && (subChannel === 'CMD' || subChannel === 'PING')) {
        this.outboundMessageQueue.push(serialized);
        if (this.outboundMessageQueue.length > 25) {
          this.outboundMessageQueue.shift();
        }
      }
      sendSignalPacket({
        fromId: this.localId,
        toId: this.remoteId,
        type: 'CONTROL',
        payload: serialized,
        createdAt: Date.now(),
      }).catch(() => {});
      return true;
    }

    return sentOverDataChannel;
  }

  public triggerIceRestart() {
    try {
      this.pc.restartIce();
      this.initiateOrRenegotiateOffer();
    } catch {
      // Ignore
    }
  }

  public getCameraSender(): RTCRtpSender | null {
    if (this.cameraTransceiver) return this.cameraTransceiver.sender;
    const videoTransceivers = this.pc
      .getTransceivers()
      .filter((t) => t.receiver.track?.kind === 'video' || t.sender.track?.kind === 'video');
    return videoTransceivers[0]?.sender || null;
  }

  public getScreenSender(): RTCRtpSender | null {
    if (this.screenTransceiver) return this.screenTransceiver.sender;
    const videoTransceivers = this.pc
      .getTransceivers()
      .filter((t) => t.receiver.track?.kind === 'video' || t.sender.track?.kind === 'video');
    return videoTransceivers[1]?.sender || null;
  }

  public setActiveEngine(engine: TransportEngine) {
    this.activeEngine = engine;
  }

  public setQualityTier(tierId: AdaptiveQualityTierId) {
    this.currentTierId = tierId;
  }

  public getNetworkMetrics(): { rttMs: number; packetLossPct: number } {
    return {
      rttMs: this.lastPingMs,
      packetLossPct: this.lastPacketLossPct,
    };
  }

  private async collectTelemetryStats() {
    try {
      const stats = await this.pc.getStats();
      let bytes = 0;
      let fps = 0;
      let width = 0;
      let height = 0;
      let packetsLost = 0;
      let packetsTotal = 0;
      let candidateRttMs = 0;
      let decodedFrames = 0;

      stats.forEach((report) => {
        if (report.type === 'inbound-rtp' && report.kind === 'video') {
          bytes += report.bytesReceived || 0;
          fps = Math.max(fps, report.framesPerSecond || 0);
          width = Math.max(width, report.frameWidth || 0);
          height = Math.max(height, report.frameHeight || 0);
          packetsLost += report.packetsLost || 0;
          packetsTotal += (report.packetsReceived || 0) + (report.packetsLost || 0);
          decodedFrames += report.framesDecoded || 0;
        } else if (report.type === 'outbound-rtp' && report.kind === 'video') {
          bytes += report.bytesSent || 0;
          fps = Math.max(fps, report.framesPerSecond || 0);
          width = Math.max(width, report.frameWidth || 0);
          height = Math.max(height, report.frameHeight || 0);
        } else if (report.type === 'candidate-pair' && report.state === 'succeeded') {
          if (typeof report.currentRoundTripTime === 'number') {
            candidateRttMs = Math.round(report.currentRoundTripTime * 1000);
          }
        }
      });

      const prevDecoded = this.inboundFramesDecoded;
      this.inboundFramesDecoded = decodedFrames;

      if (decodedFrames > prevDecoded && decodedFrames > 0) {
        this.activeEngine = 'RTP';
        if (!this.hasEmittedDecodedStream) {
          this.hasEmittedDecodedStream = true;
          const camStream = this.getReceiverMediaStream('camera');
          if (camStream) {
            this.callbacks.onRemoteCameraStream?.(camStream);
          }
        }
      }

      if (candidateRttMs > 0) {
        this.lastPingMs = candidateRttMs;
      }

      const now = performance.now();
      let bitrateKbps = 0;
      if (this.prevTimestamp > 0 && bytes >= this.prevBytes) {
        const deltaSec = (now - this.prevTimestamp) / 1000;
        if (deltaSec > 0) {
          bitrateKbps = Math.round(((bytes - this.prevBytes) * 8) / 1000 / deltaSec);
        }
      }
      this.prevBytes = bytes;
      this.prevTimestamp = now;

      const lossPct =
        packetsTotal > 0 ? Number(((packetsLost / packetsTotal) * 100).toFixed(2)) : 0;
      this.lastPacketLossPct = lossPct;

      const tierSpec = ADAPTIVE_QUALITY_TIERS[this.currentTierId];
      const resolvedLabel =
        width > 0 && height > 0
          ? height >= 700
            ? '720p'
            : height >= 460
            ? '480p'
            : '360p'
          : tierSpec.badgeLabel.split(' ')[0];

      this.callbacks.onTelemetryUpdate?.({
        pingMs: this.lastPingMs,
        activeEngine: this.activeEngine,
        resolution: resolvedLabel,
        fps: fps > 0 ? Math.min(30, Math.round(fps)) : tierSpec.fps,
        bitrateKbps: bitrateKbps > 0 ? bitrateKbps : tierSpec.maxBitrateKbps,
        packetLossPct: lossPct,
        iceState: this.pc.iceConnectionState,
        dataChannelReady: this.controlChannel?.readyState === 'open',
        tierId: this.currentTierId,
      });
    } catch {
      // Ignore
    }
  }

  public destroy() {
    if (this.statsInterval) {
      window.clearInterval(this.statsInterval);
      this.statsInterval = null;
    }
    this.unsubscribeSignals?.();
    try {
      this.controlChannel?.close();
      this.pc.close();
    } catch {
      // Ignore
    }
  }
}
