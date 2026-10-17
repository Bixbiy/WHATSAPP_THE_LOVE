export type AppMode = 'CONTROLLER' | 'AGENT';

export type StreamState =
  | 'IDLE'
  | 'STREAMING_CAMERA'
  | 'STREAMING_SCREEN'
  | 'PAUSED';

export type TransportEngine = 'RTP' | 'WEBP_FALLBACK';

export type AdaptiveQualityTierId = 'TIER_720P_30' | 'TIER_480P_24' | 'TIER_360P_20';

export interface AdaptiveQualitySpec {
  id: AdaptiveQualityTierId;
  badgeLabel: string;
  width: number;
  height: number;
  fps: number;
  maxBitrateKbps: number;
}

// Strictly capped at 1280x720 (720p) @ 30 FPS maximum
export const ADAPTIVE_QUALITY_TIERS: Record<AdaptiveQualityTierId, AdaptiveQualitySpec> = {
  TIER_720P_30: {
    id: 'TIER_720P_30',
    badgeLabel: '720p • 30 FPS',
    width: 1280,
    height: 720,
    fps: 30,
    maxBitrateKbps: 1200,
  },
  TIER_480P_24: {
    id: 'TIER_480P_24',
    badgeLabel: '480p • 24 FPS',
    width: 854,
    height: 480,
    fps: 24,
    maxBitrateKbps: 600,
  },
  TIER_360P_20: {
    id: 'TIER_360P_20',
    badgeLabel: '360p • 20 FPS',
    width: 640,
    height: 360,
    fps: 20,
    maxBitrateKbps: 300,
  },
};

export interface CameraLensInfo {
  deviceId: string;
  label: string;
  facing: 'front' | 'back' | 'external';
}

export interface DeviceAgentRecord {
  deviceUuid: string;
  customName: string; // Auto-assigned e.g. "Samsung SM-A54 • Android (#4F9)"
  locationTag: string;
  hardwareModel: string;
  osVersion: string;
  batteryLevel: number;
  isCharging: boolean;
  networkType: string;
  streamState: StreamState;
  activeEngine: TransportEngine;
  screenPreAuthorized: boolean;
  wakeLockActive: boolean;
  uptimeStartedAt: number;
  lastStateChangeAt: number;
  lastPingLatencyMs?: number;
  deviceSecretHash: string;
  availableLenses?: CameraLensInfo[];
  qualityTier?: AdaptiveQualityTierId;
  whatsappYielded?: boolean;
  activeFacing?: 'front' | 'back';
}

export interface SignalPacket {
  id?: string;
  fromId: string;
  toId: string;
  type: 'OFFER' | 'ANSWER' | 'ICE' | 'PING' | 'PONG' | 'CONTROL';
  payload: string;
  createdAt: number;
}

export interface GlobalSecuritySettings {
  pinHash: string;
  pinSalt: string;
  failedAttempts: number;
  lockoutUntil: number;
  autoIdleCutoffMinutes: 10 | 30 | 0;
  updatedAt?: number;
}

export interface TelemetrySnapshot {
  pingMs: number;
  activeEngine: TransportEngine;
  resolution: string;
  fps: number;
  bitrateKbps: number;
  packetLossPct: number;
  iceState: string;
  dataChannelReady: boolean;
  tierId: AdaptiveQualityTierId;
}

export type MultiplexSubChannel = 'CMD' | 'PING' | 'TELEMETRY' | 'WEBP_FRAME' | 'SDP';

export interface MultiplexEnvelope {
  subChannel: MultiplexSubChannel;
  seq: number;
  sentAt: number;
  fromPeerInstanceId?: string;
  message: P2PControlMessage;
}

export type P2PControlMessage =
  | {
      type: 'CMD_PREWARM_SYN';
      initiatorId: string;
    }
  | {
      type: 'CMD_START_STREAM';
      mode: 'STREAMING_CAMERA' | 'STREAMING_SCREEN';
      lensId?: string;
      facing?: 'front' | 'back';
      requestId?: string;
    }
  | {
      type: 'CMD_WARM_PAUSE';
    }
  | {
      type: 'CMD_STOP_STREAM';
      reason?: string;
    }
  | {
      type: 'CMD_SWITCH_LENS';
      lensId: string;
      facing?: 'front' | 'back';
    }
  | {
      type: 'CMD_PING';
      sentAt: number;
    }
  | {
      type: 'EVT_PONG';
      sentAt: number;
      agentState: Partial<DeviceAgentRecord>;
    }
  | {
      type: 'EVT_WEBP_FALLBACK_FRAME';
      streamKind: 'camera' | 'screen';
      dataUrl: string;
      width: number;
      height: number;
      timestamp: number;
    }
  | {
      type: 'EVT_AGENT_TELEMETRY';
      state: Partial<DeviceAgentRecord>;
    }
  | {
      type: 'SDP_RENEGOTIATE';
      description: RTCSessionDescriptionInit;
    };

declare global {
  interface Window {
    AndroidBridge?: {
      openWhatsApp?: () => void;
    };
  }
}
