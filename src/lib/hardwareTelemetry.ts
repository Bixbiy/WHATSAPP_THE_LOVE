import { AppRole, CameraLensInfo, StreamState } from '../types/opticlink';

export interface ParsedHardwareIdentity {
  hardwareModel: string;
  osVersion: string;
  browserLabel: string;
}

export function detectDefaultAppRole(): AppRole {
  if (typeof window === 'undefined') return 'CONTROLLER';

  const params = new URLSearchParams(window.location.search);
  const roleParam = (params.get('role') || '').toLowerCase();
  if (roleParam === 'node' || roleParam === 'agent') return 'NODE';
  if (roleParam === 'controller' || roleParam === 'dashboard') return 'CONTROLLER';

  const hasCapacitor = Boolean((window as unknown as { Capacitor?: unknown }).Capacitor);
  const hasAndroidBridge = Boolean(window.AndroidBridge);
  const ua = navigator.userAgent || '';
  const isMobileUA = /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
  const isSmallScreen = window.innerWidth < 768;

  return hasCapacitor || hasAndroidBridge || isMobileUA || isSmallScreen
    ? 'NODE'
    : 'CONTROLLER';
}

export function parseHardwareAndOS(): ParsedHardwareIdentity {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  let osVersion = 'Android';
  let hardwareModel = 'Mobile Node';

  if (/Android\s+([0-9.]+)/i.test(ua)) {
    const match = ua.match(/Android\s+([0-9.]+)/i);
    osVersion = `Android ${match?.[1] || ''}`.trim();
    const modelMatch =
      ua.match(/;\s*([^;)]+)\s+Build\//i) || ua.match(/Android[^;]+;\s*([^)]+)\)/i);
    const rawModel = modelMatch?.[1]?.trim() || 'Android Node';
    hardwareModel = rawModel.replace(/^wv$/i, 'Android Node');
  } else if (/iPhone|iPad|iPod/i.test(ua)) {
    const osMatch = ua.match(/OS\s+([0-9_]+)/i);
    const ver = osMatch?.[1]?.replace(/_/g, '.') || '';
    osVersion = `iOS ${ver}`.trim();
    hardwareModel = /iPad/i.test(ua) ? 'Apple iPad' : 'Apple iPhone';
  } else if (/Mac OS X\s+([0-9_]+)/i.test(ua)) {
    osVersion = 'macOS';
    hardwareModel = 'Mac Node';
  } else if (/Windows NT\s+([0-9.]+)/i.test(ua)) {
    osVersion = 'Windows';
    hardwareModel = 'PC Node';
  } else if (/Linux/i.test(ua)) {
    osVersion = 'Android';
    hardwareModel = 'Android Node';
  }

  let browserName = 'WebView';
  if (/Edg\//i.test(ua)) browserName = 'Edge';
  else if (/Chrome\//i.test(ua)) browserName = 'Chrome';
  else if (/Safari\//i.test(ua) && !/Chrome/i.test(ua)) browserName = 'Safari';
  else if (/Firefox\//i.test(ua)) browserName = 'Firefox';

  return {
    hardwareModel,
    osVersion,
    browserLabel: `${browserName} • ${osVersion}`,
  };
}

// Immediately generates or loads a persistent deviceId from localStorage and detects model from navigator.userAgent
export function getOrCreateAutoDeviceIdentity(): {
  deviceId: string;
  autoAssignedName: string;
  hardwareModel: string;
  osVersion: string;
} {
  const STORAGE_ID_KEY = 'opticlink_auto_device_id_v2';
  const STORAGE_TAG_KEY = 'opticlink_auto_device_tag_v2';

  let deviceId = localStorage.getItem(STORAGE_ID_KEY);
  let shortHex = localStorage.getItem(STORAGE_TAG_KEY);

  if (!shortHex) {
    shortHex = Math.floor(256 + Math.random() * 3839)
      .toString(16)
      .toUpperCase()
      .slice(0, 3);
    localStorage.setItem(STORAGE_TAG_KEY, shortHex);
  }

  if (!deviceId) {
    deviceId = `node-${shortHex.toLowerCase()}-${Math.random().toString(36).substring(2, 8)}`;
    localStorage.setItem(STORAGE_ID_KEY, deviceId);
  }

  const parsed = parseHardwareAndOS();
  const osShort = parsed.osVersion.split(' ')[0] || 'Android';
  const autoAssignedName = `${parsed.hardwareModel} • ${osShort} (#${shortHex})`;

  return {
    deviceId,
    autoAssignedName,
    hardwareModel: parsed.hardwareModel,
    osVersion: parsed.osVersion,
  };
}

export function getNetworkConnectionType(): string {
  const nav = navigator as unknown as {
    connection?: {
      type?: string;
      effectiveType?: string;
    };
  };
  const conn = nav.connection;
  if (!conn) return navigator.onLine ? 'Wi-Fi' : 'Offline';
  if (conn.type === 'wifi') return 'Wi-Fi';
  if (conn.type === 'cellular') return (conn.effectiveType || '4G').toUpperCase();
  if (conn.type === 'ethernet') return 'Wi-Fi';
  if (conn.effectiveType) {
    return conn.effectiveType === '4g' ? 'Wi-Fi / 4G' : conn.effectiveType.toUpperCase();
  }
  return 'Wi-Fi';
}

export async function subscribeToBatteryChanges(
  onUpdate: (level: number, charging: boolean) => void
): Promise<() => void> {
  const nav = navigator as unknown as {
    getBattery?: () => Promise<{
      level: number;
      charging: boolean;
      addEventListener: (type: string, fn: () => void) => void;
      removeEventListener: (type: string, fn: () => void) => void;
    }>;
  };

  if (!nav.getBattery) {
    onUpdate(96, true);
    return () => {};
  }

  try {
    const battery = await nav.getBattery();
    const emit = () => {
      onUpdate(Math.round(battery.level * 100), Boolean(battery.charging));
    };
    emit();
    battery.addEventListener('levelchange', emit);
    battery.addEventListener('chargingchange', emit);
    return () => {
      battery.removeEventListener('levelchange', emit);
      battery.removeEventListener('chargingchange', emit);
    };
  } catch {
    onUpdate(96, true);
    return () => {};
  }
}

export function subscribeToNetworkChanges(
  onNetworkChange: (networkType: string) => void
): () => void {
  const nav = navigator as unknown as {
    connection?: {
      addEventListener?: (type: string, fn: () => void) => void;
      removeEventListener?: (type: string, fn: () => void) => void;
    };
  };
  const handler = () => {
    onNetworkChange(getNetworkConnectionType());
  };
  window.addEventListener('online', handler);
  window.addEventListener('offline', handler);
  nav.connection?.addEventListener?.('change', handler);

  return () => {
    window.removeEventListener('online', handler);
    window.removeEventListener('offline', handler);
    nav.connection?.removeEventListener?.('change', handler);
  };
}

export async function enumerateCameraLenses(): Promise<CameraLensInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) {
    return [
      { deviceId: 'default-back', label: 'Back Camera', facing: 'back' },
      { deviceId: 'default-front', label: 'Front Camera', facing: 'front' },
    ];
  }
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoInputs = devices.filter((d) => d.kind === 'videoinput');
    if (videoInputs.length === 0) {
      return [
        { deviceId: 'default-back', label: 'Back Camera', facing: 'back' },
        { deviceId: 'default-front', label: 'Front Camera', facing: 'front' },
      ];
    }
    return videoInputs.map((d, idx) => {
      const lower = (d.label || '').toLowerCase();
      let facing: 'front' | 'back' | 'external' = idx === 0 ? 'back' : 'front';
      if (lower.includes('front') || lower.includes('user') || lower.includes('selfie')) {
        facing = 'front';
      } else if (lower.includes('back') || lower.includes('rear') || lower.includes('environment')) {
        facing = 'back';
      }
      return {
        deviceId: d.deviceId || `lens-${idx}`,
        label: d.label || `${facing === 'back' ? 'Back Camera' : 'Front Camera'} #${idx + 1}`,
        facing,
      };
    });
  } catch {
    return [
      { deviceId: 'default-back', label: 'Back Camera', facing: 'back' },
      { deviceId: 'default-front', label: 'Front Camera', facing: 'front' },
    ];
  }
}

export async function releaseHardwareMediaZeroHold(options: {
  stream: MediaStream | null;
  videoElement?: HTMLVideoElement | null;
  rtpSender?: RTCRtpSender | null;
  waitForSettleMs?: number;
}): Promise<void> {
  const { stream, videoElement, rtpSender, waitForSettleMs = 150 } = options;

  if (rtpSender) {
    try {
      await rtpSender.replaceTrack(null);
    } catch {
      // Ignore if closed
    }
  }

  if (stream) {
    stream.getTracks().forEach((track) => {
      try {
        track.stop();
      } catch {
        // Ignore
      }
    });
  }

  if (videoElement) {
    videoElement.srcObject = null;
  }

  if (waitForSettleMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitForSettleMs));
  }
}

// Silent Web Audio API keep-alive oscillator (0.001 gain) so WebView timers never throttle
let keepAliveAudioCtx: AudioContext | null = null;
let keepAliveOsc: OscillatorNode | null = null;

export function startSilentAudioKeepAlive(): void {
  try {
    const AudioContextClass =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;

    if (!keepAliveAudioCtx) {
      keepAliveAudioCtx = new AudioContextClass();
    }
    if (keepAliveAudioCtx.state === 'suspended') {
      keepAliveAudioCtx.resume().catch(() => {});
    }
    if (!keepAliveOsc) {
      const osc = keepAliveAudioCtx.createOscillator();
      const gain = keepAliveAudioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(40, keepAliveAudioCtx.currentTime);
      gain.gain.setValueAtTime(0.001, keepAliveAudioCtx.currentTime);
      osc.connect(gain);
      gain.connect(keepAliveAudioCtx.destination);
      osc.start();
      keepAliveOsc = osc;
    }
  } catch {
    // Ignore audio context restriction
  }
}

export function start24HourIdleRefreshWatchdog(
  getStreamState: () => StreamState,
  bootedAt: number
): () => void {
  const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
  const interval = window.setInterval(() => {
    const elapsed = Date.now() - bootedAt;
    if (elapsed >= TWENTY_FOUR_HOURS_MS && getStreamState() === 'IDLE') {
      window.location.reload();
    }
  }, 60 * 1000);

  return () => window.clearInterval(interval);
}
