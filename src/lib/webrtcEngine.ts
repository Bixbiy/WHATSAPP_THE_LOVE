import {
  ADAPTIVE_QUALITY_TIERS,
  AdaptiveQualityTierId,
  StreamState,
  TransportEngine,
} from '../types/opticlink';
import {
  PREWARMED_RTC_CONFIG,
  WebRTCManager,
  WebRTCManagerCallbacks,
  WebRTCManagerOptions,
} from './WebRTCManager';

// Re-export WebRTCManager and PreWarmedMultiplexPeer alias
export {
  PREWARMED_RTC_CONFIG,
  PREWARMED_RTC_CONFIG as WEBRTC_RTC_CONFIG,
  WebRTCManager,
  WebRTCManager as PreWarmedMultiplexPeer,
};
export type { WebRTCManagerCallbacks as MultiplexSessionCallbacks, WebRTCManagerOptions };

// Diagnostic stream fallback ONLY used when a device has no physical camera hardware at all
export function createDiagnosticOpticalStream(
  width: number,
  height: number,
  fps: number,
  label: string,
  kind: 'camera' | 'screen' = 'camera'
): { stream: MediaStream; stopSynthetic: () => void } {
  const canvas = document.createElement('canvas');
  canvas.width = Math.min(1280, width);
  canvas.height = Math.min(720, height);
  const ctx = canvas.getContext('2d');

  const draw = () => {
    if (!ctx) return;
    const w = canvas.width;
    const h = canvas.height;

    ctx.fillStyle = kind === 'camera' ? '#090D16' : '#0F172A';
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle =
      kind === 'camera' ? 'rgba(59, 130, 246, 0.16)' : 'rgba(16, 185, 129, 0.16)';
    ctx.lineWidth = 1;
    for (let x = 0; x < w; x += 48) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    for (let y = 0; y < h; y += 48) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    const t = Date.now() / 1000;
    const objX = w * 0.5 + Math.cos(t * 1.3) * (w * 0.24);
    const objY = h * 0.52 + Math.sin(t * 1.7) * (h * 0.2);

    ctx.fillStyle = kind === 'camera' ? '#3B82F6' : '#10B981';
    ctx.beginPath();
    ctx.arc(objX, objY, 28, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = '#60A5FA';
    ctx.lineWidth = 2;
    ctx.strokeRect(objX - 42, objY - 42, 84, 84);

    ctx.fillStyle = 'rgba(15, 23, 42, 0.88)';
    ctx.fillRect(16, 16, Math.min(w - 32, 460), 64);
    ctx.strokeStyle = 'rgba(59, 130, 246, 0.5)';
    ctx.strokeRect(16, 16, Math.min(w - 32, 460), 64);

    ctx.fillStyle = '#F8FAFC';
    ctx.font = 'bold 14px "JetBrains Mono", monospace';
    ctx.fillText(`${label.toUpperCase()}`, 28, 40);
    ctx.fillStyle = '#93C5FD';
    ctx.font = '12px "JetBrains Mono", monospace';
    ctx.fillText(
      `LIVE ${w}x${h} • ${fps} FPS • ${new Date().toISOString().slice(11, 19)}`,
      28,
      62
    );
  };

  draw();
  const timer = window.setInterval(draw, Math.max(33, Math.round(1000 / fps)));
  const stream = canvas.captureStream(fps);

  return {
    stream,
    stopSynthetic: () => {
      window.clearInterval(timer);
      stream.getTracks().forEach((tr) => tr.stop());
    },
  };
}

// Compute Adaptive Quality Tier based on RTT, Packet Loss, Battery %, and Charging status
export function computeAdaptiveQualityTier(params: {
  rttMs: number;
  packetLossPct: number;
  batteryLevel: number;
  isCharging: boolean;
}): AdaptiveQualityTierId {
  const { rttMs, packetLossPct, batteryLevel, isCharging } = params;

  if (rttMs > 250 || packetLossPct > 5 || (!isCharging && batteryLevel < 15)) {
    return 'TIER_360P_20';
  }

  if (
    (rttMs >= 120 && rttMs <= 250) ||
    (!isCharging && batteryLevel >= 15 && batteryLevel <= 25)
  ) {
    return 'TIER_480P_24';
  }

  return 'TIER_720P_30';
}

export async function applyAdaptiveTierToStream(
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

// ============================================================================
// INSTANT WEBP + RTP HYBRID WATCHDOG
// Streams live WebP camera frames immediately on stream start so the Web
// Controller renders the remote camera in <250ms, and seamlessly hands off to
// hardware 720p @ 30 FPS RTP once outbound/inbound RTP frames are flowing.
// ============================================================================
export class AntiBlankScreenWatchdog {
  private watchdogTimer: number | null = null;
  private webpInterval: number | null = null;
  private lastFramesEncoded = -1;
  private lastBytesSent = -1;
  private stallStartedAt: number | null = null;
  private rebirthAttempted = false;
  private isWebpActive = false;

  public start(options: {
    pc: RTCPeerConnection | null;
    getStreamState: () => StreamState;
    getVideoTrack: () => MediaStreamTrack | null;
    getVideoElement: () => HTMLVideoElement | null;
    onAttemptTrackRebirth: () => Promise<void>;
    onSwitchEngine: (engine: TransportEngine) => void;
    onEmitWebpFrame: (dataUrl: string, width: number, height: number) => void;
  }) {
    this.stop();

    const offscreenCanvas = document.createElement('canvas');
    const ctx = offscreenCanvas.getContext('2d');

    this.activateWebpFallback(options.getVideoElement, offscreenCanvas, ctx, options);

    this.watchdogTimer = window.setInterval(async () => {
      const state = options.getStreamState();
      if (state === 'IDLE' || state === 'PAUSED') {
        this.stallStartedAt = null;
        return;
      }

      const track = options.getVideoTrack();
      const videoEl = options.getVideoElement();

      const trackHealthy =
        track !== null &&
        track.readyState === 'live' &&
        !track.muted &&
        (!videoEl || videoEl.videoWidth > 0);

      let framesEncoded = 0;
      let bytesSent = 0;
      let iceConnected = false;

      if (options.pc) {
        iceConnected =
          options.pc.iceConnectionState === 'connected' ||
          options.pc.iceConnectionState === 'completed';
        try {
          const stats = await options.pc.getStats();
          stats.forEach((report) => {
            if (report.type === 'outbound-rtp' && report.kind === 'video') {
              framesEncoded += report.framesEncoded || 0;
              bytesSent += report.bytesSent || 0;
            }
          });
        } catch {
          // Ignore
        }
      }

      const encodingAdvancing =
        iceConnected &&
        framesEncoded > 15 &&
        (framesEncoded > this.lastFramesEncoded || bytesSent > this.lastBytesSent);

      this.lastFramesEncoded = framesEncoded;
      this.lastBytesSent = bytesSent;

      if (trackHealthy && encodingAdvancing) {
        this.stallStartedAt = null;
        if (this.isWebpActive) {
          if (this.webpInterval) {
            window.clearInterval(this.webpInterval);
            this.webpInterval = null;
          }
          this.isWebpActive = false;
          options.onSwitchEngine('RTP');
        }
      } else {
        if (!this.stallStartedAt) {
          this.stallStartedAt = Date.now();
        } else if (Date.now() - this.stallStartedAt >= 3000) {
          if (!this.rebirthAttempted) {
            this.rebirthAttempted = true;
            await options.onAttemptTrackRebirth();
          }
        }
        if (!this.isWebpActive) {
          this.activateWebpFallback(options.getVideoElement, offscreenCanvas, ctx, options);
        }
      }
    }, 2000);
  }

  private activateWebpFallback(
    getVideoElement: () => HTMLVideoElement | null,
    canvas: HTMLCanvasElement,
    ctx: CanvasRenderingContext2D | null,
    options: {
      onSwitchEngine: (engine: TransportEngine) => void;
      onEmitWebpFrame: (dataUrl: string, width: number, height: number) => void;
    }
  ) {
    if (this.isWebpActive) return;
    this.isWebpActive = true;

    if (this.webpInterval) {
      window.clearInterval(this.webpInterval);
    }

    const emitFrame = () => {
      const videoEl = getVideoElement();
      if (!videoEl || !ctx || videoEl.readyState < 2 || videoEl.videoWidth === 0) return;
      const w = videoEl.videoWidth;
      const h = videoEl.videoHeight || 360;
      const targetW = Math.min(540, w);
      const targetH = Math.round((targetW / w) * h) || 304;
      canvas.width = targetW;
      canvas.height = targetH;
      try {
        ctx.drawImage(videoEl, 0, 0, targetW, targetH);
        const dataUrl = canvas.toDataURL('image/webp', 0.62);
        options.onEmitWebpFrame(dataUrl, targetW, targetH);
      } catch {
        // Ignore
      }
    };

    setTimeout(emitFrame, 120);
    setTimeout(emitFrame, 280);
    this.webpInterval = window.setInterval(emitFrame, 250);
  }

  public stop() {
    if (this.watchdogTimer) {
      window.clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    if (this.webpInterval) {
      window.clearInterval(this.webpInterval);
      this.webpInterval = null;
    }
    this.isWebpActive = false;
    this.stallStartedAt = null;
    this.rebirthAttempted = false;
  }
}
