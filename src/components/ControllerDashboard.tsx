import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  Battery,
  BatteryCharging,
  Camera,
  Download,
  Lock,
  Maximize2,
  Monitor,
  Pause,
  Radio,
  RefreshCw,
  Settings,
  Smartphone,
  Square,
  SwitchCamera,
  Trash2,
  Unlock,
  Video,
  Wifi,
  X,
} from 'lucide-react';
import {
  changeControllerPin,
  deletePairedDevice,
  dispatchDirectDeviceCommand,
  ensureDefaultPinInitialized,
  generateSafeId,
  subscribeToDevices,
  upsertDeviceStateChange,
  verifyControllerPin,
} from '../lib/firebase';
import { WebRTCManager } from '../lib/webrtcEngine';
import {
  ADAPTIVE_QUALITY_TIERS,
  DeviceAgentRecord,
  P2PControlMessage,
  RemoteNodeCommand,
  TelemetrySnapshot,
} from '../types/opticlink';

const SESSION_UNLOCKED_KEY = 'opticlink_command_center_unlocked_v3';

interface ControllerDashboardProps {
  onSwitchToNode?: () => void;
  darkMode: boolean;
  onToggleDarkMode: () => void;
}

export const ControllerDashboard: React.FC<ControllerDashboardProps> = ({
  onSwitchToNode,
}) => {
  const [isUnlocked, setIsUnlocked] = useState<boolean>(() => {
    return sessionStorage.getItem(SESSION_UNLOCKED_KEY) === 'true';
  });

  const [pinInput, setPinInput] = useState('');
  const [pinError, setPinError] = useState<string | null>(null);
  const [pinBusy, setPinBusy] = useState(false);

  // Settings Modal (Change 4-Digit PIN)
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [currentPinInput, setCurrentPinInput] = useState('');
  const [newPinInput, setNewPinInput] = useState('');
  const [settingsStatus, setSettingsStatus] = useState<{ ok: boolean; msg: string } | null>(
    null
  );

  // Auto-Discovered Phone Nodes
  const [devices, setDevices] = useState<DeviceAgentRecord[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  const [activeCameraFacing, setActiveCameraFacing] = useState<'front' | 'back'>('back');

  // Video & Hybrid Stream State
  const [hasActiveMedia, setHasActiveMedia] = useState<boolean>(false);
  const [videoHasDecodedFrames, setVideoHasDecodedFrames] = useState<boolean>(false);
  const [webpFallbackFrameUrl, setWebpFallbackFrameUrl] = useState<string | null>(null);
  const [connectingStreamLabel, setConnectingStreamLabel] = useState<string | null>(null);

  // Real-Time WebRTC Telemetry HUD State
  const [telemetry, setTelemetry] = useState<TelemetrySnapshot>({
    pingMs: 18,
    activeEngine: 'RTP',
    resolution: '720p',
    fps: 30,
    bitrateKbps: 1200,
    packetLossPct: 0,
    iceState: 'connected',
    dataChannelReady: true,
    tierId: 'TIER_720P_30',
  });

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const playerContainerRef = useRef<HTMLDivElement | null>(null);
  const peerRef = useRef<WebRTCManager | null>(null);

  useEffect(() => {
    ensureDefaultPinInitialized().catch(() => {});
    const unsub = subscribeToDevices((list) => {
      setDevices(list);
      setSelectedDeviceId((prev) => {
        if (prev && list.some((d) => d.deviceUuid === prev)) return prev;
        return list[0]?.deviceUuid || '';
      });
    });
    return () => unsub();
  }, []);

  const selectedDevice = devices.find((d) => d.deviceUuid === selectedDeviceId) || null;

  const checkVideoDecodedDimensions = useCallback(() => {
    const el = videoRef.current;
    if (el && el.videoWidth > 0 && el.readyState >= 2) {
      setVideoHasDecodedFrames(true);
      setConnectingStreamLabel(null);
    }
  }, []);

  const attachMediaToPlayer = useCallback(
    (stream: MediaStream | null) => {
      setHasActiveMedia(Boolean(stream));
      if (!stream) {
        setVideoHasDecodedFrames(false);
      }
      const el = videoRef.current;
      if (el) {
        if (el.srcObject !== stream) {
          el.srcObject = stream;
        }
        if (stream) {
          el.play()
            .then(() => {
              checkVideoDecodedDimensions();
            })
            .catch(() => {});
        }
      }
    },
    [checkVideoDecodedDimensions]
  );

  // Pre-Warmed WebRTC Connection to Selected Phone Node
  useEffect(() => {
    if (!isUnlocked || !selectedDeviceId) return;

    setWebpFallbackFrameUrl(null);
    setVideoHasDecodedFrames(false);
    setConnectingStreamLabel(null);

    const peer = new WebRTCManager({
      localId: 'controller-main',
      remoteId: selectedDeviceId,
      polite: false,
      callbacks: {
        onControlMessage: (msg) => {
          if (msg.type === 'EVT_WEBP_FALLBACK_FRAME') {
            setWebpFallbackFrameUrl(msg.dataUrl);
            setHasActiveMedia(true);
            setConnectingStreamLabel(null);
          } else if (msg.type === 'EVT_PONG') {
            const rtt = Math.max(1, Date.now() - msg.sentAt);
            setTelemetry((prev) => ({ ...prev, pingMs: rtt }));
          }
        },
        onRemoteCameraStream: (stream) => {
          attachMediaToPlayer(stream);
        },
        onRemoteScreenStream: (stream) => {
          attachMediaToPlayer(stream);
        },
        onTelemetryUpdate: (snap) => {
          setTelemetry(snap);
          checkVideoDecodedDimensions();
        },
      },
    });
    peerRef.current = peer;

    return () => {
      peer.destroy();
      peerRef.current = null;
    };
  }, [isUnlocked, selectedDeviceId, attachMediaToPlayer, checkVideoDecodedDimensions]);

  // Instant 1-Click Remote Command Trigger (Dual-Path: WebRTC DataChannel + Direct Firestore Node Command)
  const triggerNodeAction = useCallback(
    async (
      targetDevice: DeviceAgentRecord,
      action: RemoteNodeCommand['action'],
      facing?: 'front' | 'back',
      lensId?: string
    ) => {
      const commandId = generateSafeId('cmd');
      const switchingDevice = targetDevice.deviceUuid !== selectedDeviceId;
      if (switchingDevice) {
        setSelectedDeviceId(targetDevice.deviceUuid);
      }
      if (facing) {
        setActiveCameraFacing(facing);
      }

      // 1. Write direct command onto /devices/{deviceId} so the Phone Node's onSnapshot
      //    receives it immediately even if WebRTC ICE is still negotiating
      const directCmd: RemoteNodeCommand = {
        commandId,
        issuedAt: Date.now(),
        action,
        facing,
        lensId,
      };
      dispatchDirectDeviceCommand(targetDevice, directCmd).catch(() => {});

      // 2. Also send over pre-warmed WebRTC 'control-plane' DataChannel (<20ms when open)
      let p2pMsg: P2PControlMessage;
      if (action === 'START_CAMERA') {
        setConnectingStreamLabel(
          `Connecting to ${facing === 'front' ? 'Front Camera' : 'Back Camera'} (720p @ 30 FPS)...`
        );
        p2pMsg = {
          type: 'CMD_START_STREAM',
          mode: 'STREAMING_CAMERA',
          facing: facing || 'back',
          lensId,
          commandId,
        };
      } else if (action === 'START_SCREEN') {
        setConnectingStreamLabel('Connecting to Phone Screen Share (720p @ 30 FPS)...');
        p2pMsg = {
          type: 'CMD_START_STREAM',
          mode: 'STREAMING_SCREEN',
          commandId,
        };
      } else if (action === 'WARM_PAUSE') {
        setWebpFallbackFrameUrl(null);
        setVideoHasDecodedFrames(false);
        setConnectingStreamLabel(null);
        attachMediaToPlayer(null);
        p2pMsg = {
          type: 'CMD_WARM_PAUSE',
          commandId,
        };
        upsertDeviceStateChange({
          ...targetDevice,
          streamState: 'PAUSED',
          remoteCommand: directCmd,
        }).catch(() => {});
      } else if (action === 'STOP_STREAM') {
        setWebpFallbackFrameUrl(null);
        setVideoHasDecodedFrames(false);
        setConnectingStreamLabel(null);
        attachMediaToPlayer(null);
        p2pMsg = {
          type: 'CMD_STOP_STREAM',
          reason: 'Stop Stream',
          commandId,
        };
        upsertDeviceStateChange({
          ...targetDevice,
          streamState: 'IDLE',
          remoteCommand: directCmd,
        }).catch(() => {});
      } else {
        p2pMsg = {
          type: 'CMD_PING',
          sentAt: Date.now(),
          commandId,
        };
      }

      setTimeout(
        () => {
          peerRef.current?.sendControlMessage(p2pMsg);
        },
        switchingDevice ? 60 : 0
      );
    },
    [selectedDeviceId, attachMediaToPlayer]
  );

  // Camera Flip Button (Toggles Front <-> Back Camera)
  const handleFlipCamera = () => {
    if (!selectedDevice) return;
    const nextFacing = activeCameraFacing === 'back' ? 'front' : 'back';
    setActiveCameraFacing(nextFacing);
    triggerNodeAction(selectedDevice, 'START_CAMERA', nextFacing);
  };

  // Unlock with 4-Digit PIN (Default "0000")
  const handleUnlockSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setPinError(null);
    const clean = pinInput.replace(/[^0-9]/g, '');
    if (clean.length !== 4) {
      setPinError('Enter 4-digit PIN (default 0000).');
      return;
    }
    setPinBusy(true);
    try {
      const res = await verifyControllerPin(clean);
      setPinInput('');
      if (res.unlocked) {
        setIsUnlocked(true);
        sessionStorage.setItem(SESSION_UNLOCKED_KEY, 'true');
      } else {
        setPinError(res.error || 'Incorrect 4-digit PIN.');
      }
    } finally {
      setPinBusy(false);
    }
  };

  // Change 4-Digit PIN in Settings
  const handleChangePinSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSettingsStatus(null);
    const cPin = currentPinInput.replace(/[^0-9]/g, '');
    const nPin = newPinInput.replace(/[^0-9]/g, '');
    if (cPin.length !== 4 || nPin.length !== 4) {
      setSettingsStatus({ ok: false, msg: 'Both current and new PINs must be 4 digits.' });
      return;
    }
    const res = await changeControllerPin(cPin, nPin);
    setCurrentPinInput('');
    setNewPinInput('');
    if (res.success) {
      setSettingsStatus({ ok: true, msg: '4-Digit PIN updated successfully.' });
    } else {
      setSettingsStatus({ ok: false, msg: res.error || 'Failed to update PIN.' });
    }
  };

  // Snapshot PNG Capture
  const handleDownloadSnapshotPng = () => {
    const videoEl = videoRef.current;
    if (!videoEl && !webpFallbackFrameUrl) return;

    const canvas = document.createElement('canvas');
    canvas.width = videoEl?.videoWidth || 1280;
    canvas.height = videoEl?.videoHeight || 720;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    if (videoEl && videoEl.readyState >= 2 && videoEl.videoWidth > 0) {
      ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
      const url = canvas.toDataURL('image/png');
      const a = document.createElement('a');
      a.href = url;
      a.download = `opticlink-snapshot-${Date.now()}.png`;
      a.click();
    } else if (webpFallbackFrameUrl) {
      const a = document.createElement('a');
      a.href = webpFallbackFrameUrl;
      a.download = `opticlink-snapshot-${Date.now()}.webp`;
      a.click();
    }
  };

  // Fullscreen Toggle
  const handleToggleFullscreen = () => {
    const el = playerContainerRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      el.requestFullscreen?.().catch(() => {});
    }
  };

  // ============================================================================
  // RENDER 1: 4-DIGIT PIN LOCK SCREEN (Default "0000")
  // ============================================================================
  if (!isUnlocked) {
    return (
      <div className="min-h-screen w-full bg-[#090D16] text-slate-100 flex flex-col justify-between p-4 sm:p-6">
        <div className="w-full max-w-sm mx-auto my-auto rounded-2xl border border-slate-800 bg-[#111827] p-6 space-y-5 shadow-xl">
          <div className="flex items-center justify-between border-b border-slate-800 pb-4">
            <div>
              <h1 className="text-base font-bold text-white font-display">
                OpticLink Command Center
              </h1>
              <p className="text-xs text-slate-400 mt-0.5">
                Enter 4-digit PIN (default 0000)
              </p>
            </div>
            <Lock className="w-5 h-5 text-blue-400 shrink-0" />
          </div>

          <form onSubmit={handleUnlockSubmit} className="space-y-4" autoComplete="off">
            <input
              type="password"
              inputMode="numeric"
              maxLength={4}
              value={pinInput}
              onChange={(e) => setPinInput(e.target.value.replace(/[^0-9]/g, ''))}
              placeholder="••••"
              autoComplete="off"
              className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-center text-2xl font-mono tracking-[0.5em] text-white focus:border-blue-500 focus:outline-none"
              required
            />

            {pinError && (
              <div className="rounded-lg bg-red-950/60 border border-red-900 px-3 py-2 text-xs text-red-300">
                {pinError}
              </div>
            )}

            <button
              type="submit"
              disabled={pinBusy || pinInput.length !== 4}
              className="w-full min-h-[46px] rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-semibold text-sm flex items-center justify-center gap-2 transition-colors cursor-pointer"
            >
              <Unlock className="w-4 h-4" />
              <span>{pinBusy ? 'Unlocking...' : 'Unlock Command Center'}</span>
            </button>
          </form>
        </div>

        <footer className="w-full max-w-7xl mx-auto pt-4 flex items-center justify-between text-xs text-slate-500">
          <span>OpticLink Command Center</span>
          {onSwitchToNode && (
            <button
              type="button"
              onClick={onSwitchToNode}
              className="text-slate-400 hover:text-white underline underline-offset-4 cursor-pointer"
            >
              Switch to OpticLink Node (Phone View)
            </button>
          )}
        </footer>
      </div>
    );
  }

  // ============================================================================
  // RENDER 2: PROFESSIONAL WEB COMMAND CENTER DASHBOARD
  // ============================================================================
  const tierSpec =
    ADAPTIVE_QUALITY_TIERS[selectedDevice?.qualityTier || telemetry.tierId] ||
    ADAPTIVE_QUALITY_TIERS.TIER_720P_30;

  return (
    <div className="min-h-screen w-full bg-[#090D16] text-slate-100 flex flex-col justify-between overflow-x-hidden">
      {/* PIN Settings Modal */}
      {settingsOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4">
          <div className="w-full max-w-sm rounded-2xl border border-slate-800 bg-[#111827] p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-white">Command Center PIN Settings</h3>
              <button
                type="button"
                onClick={() => setSettingsOpen(false)}
                className="p-1 text-slate-400 hover:text-white cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleChangePinSubmit} className="space-y-3" autoComplete="off">
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">
                  Current 4-Digit PIN
                </label>
                <input
                  type="password"
                  inputMode="numeric"
                  maxLength={4}
                  value={currentPinInput}
                  onChange={(e) => setCurrentPinInput(e.target.value.replace(/[^0-9]/g, ''))}
                  placeholder="••••"
                  autoComplete="off"
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-center font-mono tracking-[0.4em] text-white"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">
                  New 4-Digit PIN
                </label>
                <input
                  type="password"
                  inputMode="numeric"
                  maxLength={4}
                  value={newPinInput}
                  onChange={(e) => setNewPinInput(e.target.value.replace(/[^0-9]/g, ''))}
                  placeholder="••••"
                  autoComplete="new-password"
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-center font-mono tracking-[0.4em] text-white"
                  required
                />
              </div>

              {settingsStatus && (
                <div
                  className={`rounded-lg px-3 py-2 text-xs ${
                    settingsStatus.ok
                      ? 'bg-emerald-950/60 text-emerald-300'
                      : 'bg-red-950/60 text-red-300'
                  }`}
                >
                  {settingsStatus.msg}
                </div>
              )}

              <button
                type="submit"
                className="w-full min-h-[42px] rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold cursor-pointer"
              >
                Save New 4-Digit PIN
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Top Command Center Header */}
      <header className="w-full border-b border-slate-800/80 bg-[#0D1322] px-4 sm:px-6 py-3">
        <div className="max-w-[1760px] mx-auto flex items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <Radio className="w-4 h-4 text-blue-400 shrink-0" />
            <span className="text-base sm:text-lg font-bold tracking-tight text-white font-display">
              OpticLink Command Center
            </span>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              className="min-h-[36px] px-3 py-1.5 rounded-lg border border-slate-800 bg-slate-900 hover:bg-slate-800 text-xs font-medium text-slate-300 flex items-center gap-1.5 cursor-pointer"
            >
              <Settings className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">PIN Settings</span>
            </button>

            <button
              type="button"
              onClick={() => {
                setIsUnlocked(false);
                sessionStorage.removeItem(SESSION_UNLOCKED_KEY);
              }}
              className="min-h-[36px] px-3 py-1.5 rounded-lg border border-slate-800 bg-slate-900 hover:bg-slate-800 text-xs font-medium text-slate-300 flex items-center gap-1.5 cursor-pointer"
            >
              <Lock className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Lock</span>
            </button>
          </div>
        </div>
      </header>

      {/* Main Command Center Workspace: Left Sidebar (Phone Nodes) + Right Main Stage */}
      <main className="flex-1 w-full max-w-[1760px] mx-auto px-3 sm:px-6 py-4 sm:py-6">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
          {/* LEFT SIDEBAR (4 cols on lg, 3 cols on xl): Live List of Auto-Discovered Phone Nodes */}
          <aside className="lg:col-span-4 xl:col-span-3 w-full space-y-3 lg:sticky lg:top-5">
            <div className="flex items-center justify-between">
              <h2 className="text-xs sm:text-sm font-mono uppercase tracking-wider font-bold text-slate-400">
                Phone Nodes ({devices.length})
              </h2>
              <span className="text-[11px] font-mono text-emerald-400">
                Auto-Discovery
              </span>
            </div>

            {devices.length === 0 ? (
              <div className="rounded-2xl border border-slate-800 bg-[#0F1626] p-5 text-center space-y-2.5">
                <Smartphone className="w-7 h-7 text-slate-500 mx-auto" />
                <div className="text-sm font-bold text-white">
                  Listening for Phone Nodes...
                </div>
                <p className="text-xs text-slate-400 leading-relaxed">
                  Open this app or the Android APK on your phone. It registers here automatically in 0 clicks.
                </p>
              </div>
            ) : (
              <div className="space-y-2.5 max-h-[75vh] overflow-y-auto pr-0.5">
                {devices.map((dev) => {
                  const isSelected = dev.deviceUuid === selectedDeviceId;
                  const lastSeen = dev.heartbeatAt || dev.lastStateChangeAt || 0;
                  const isOnline =
                    dev.online !== false && Date.now() - lastSeen < 120 * 1000;
                  const isNodeStreaming =
                    dev.streamState === 'STREAMING_CAMERA' ||
                    dev.streamState === 'STREAMING_SCREEN';

                  return (
                    <div
                      key={dev.deviceUuid}
                      onClick={() => setSelectedDeviceId(dev.deviceUuid)}
                      className={`rounded-2xl border p-4 space-y-3 transition-colors cursor-pointer ${
                        isSelected
                          ? 'border-blue-500 bg-[#131C31]'
                          : 'border-slate-800 bg-[#0F1626] hover:border-slate-700'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 space-y-1">
                          <div className="flex items-center gap-2">
                            <span className="relative flex h-2.5 w-2.5 shrink-0">
                              {isOnline && (
                                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                              )}
                              <span
                                className={`relative inline-flex rounded-full h-2.5 w-2.5 ${
                                  isOnline ? 'bg-emerald-500' : 'bg-slate-600'
                                }`}
                              />
                            </span>
                            <h3 className="text-sm font-bold text-white truncate">
                              {dev.customName}
                            </h3>
                          </div>

                          <div className="flex flex-wrap items-center gap-2 text-xs font-mono text-slate-400 tabular-nums">
                            <span className={isOnline ? 'text-emerald-400' : 'text-slate-500'}>
                              {isNodeStreaming
                                ? 'LIVE'
                                : isOnline
                                ? 'Online'
                                : 'Standby'}
                            </span>
                            <span>•</span>
                            <span className="flex items-center gap-1">
                              {dev.isCharging ? (
                                <BatteryCharging className="w-3.5 h-3.5 text-emerald-400" />
                              ) : (
                                <Battery className="w-3.5 h-3.5 text-slate-400" />
                              )}
                              {dev.batteryLevel}%
                            </span>
                            <span>•</span>
                            <span className="flex items-center gap-1">
                              <Wifi className="w-3 h-3 text-blue-400" />
                              {dev.networkType}
                            </span>
                          </div>
                        </div>

                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              triggerNodeAction(dev, 'PING');
                            }}
                            className="px-2 py-1 rounded-lg border border-slate-700 bg-slate-900 hover:bg-slate-800 text-[11px] font-mono text-slate-300 flex items-center gap-1 cursor-pointer"
                            title="1-Click Ping Test"
                          >
                            <RefreshCw className="w-3 h-3" />
                            <span>{dev.lastPingLatencyMs ?? telemetry.pingMs}ms</span>
                          </button>

                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              deletePairedDevice(dev.deviceUuid);
                            }}
                            className="p-1 rounded-lg text-slate-500 hover:text-red-400 cursor-pointer"
                            title="Remove Node"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </aside>

          {/* RIGHT MAIN STAGE (8 cols on lg, 9 cols on xl): Top Control Bar + 16:9 Live Video Monitor */}
          <section className="lg:col-span-8 xl:col-span-9 w-full space-y-4">
            {/* TOP CONTROL BAR FOR SELECTED PHONE NODE (Instant 1-Click Remote Triggers) */}
            <div className="rounded-2xl border border-slate-800 bg-[#0F1626] p-3 sm:p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-xs sm:text-sm font-bold text-white truncate">
                    {selectedDevice
                      ? `Target Node: ${selectedDevice.customName}`
                      : 'Select or Open a Phone Node'}
                  </span>
                </div>
                <span className="text-xs font-mono text-emerald-400 tabular-nums">
                  {tierSpec.badgeLabel} • {telemetry.bitrateKbps} kbps • RTT {telemetry.pingMs} ms
                </span>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-5 gap-2">
                <button
                  type="button"
                  disabled={!selectedDevice}
                  onClick={() =>
                    selectedDevice &&
                    triggerNodeAction(selectedDevice, 'START_CAMERA', 'back')
                  }
                  className="min-h-[44px] px-3 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-xs font-bold flex items-center justify-center gap-1.5 cursor-pointer whitespace-nowrap"
                >
                  <Camera className="w-4 h-4 shrink-0" />
                  <span>🎥 Back Camera (720p)</span>
                </button>

                <button
                  type="button"
                  disabled={!selectedDevice}
                  onClick={() =>
                    selectedDevice &&
                    triggerNodeAction(selectedDevice, 'START_CAMERA', 'front')
                  }
                  className="min-h-[44px] px-3 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-xs font-bold flex items-center justify-center gap-1.5 cursor-pointer whitespace-nowrap"
                >
                  <Camera className="w-4 h-4 shrink-0" />
                  <span>🤳 Front Camera (720p)</span>
                </button>

                <button
                  type="button"
                  disabled={!selectedDevice}
                  onClick={() =>
                    selectedDevice && triggerNodeAction(selectedDevice, 'START_SCREEN')
                  }
                  className="min-h-[44px] px-3 py-2 rounded-xl border border-slate-700 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-100 text-xs font-bold flex items-center justify-center gap-1.5 cursor-pointer whitespace-nowrap"
                >
                  <Monitor className="w-4 h-4 shrink-0" />
                  <span>📱 Screen Share</span>
                </button>

                <button
                  type="button"
                  disabled={!selectedDevice}
                  onClick={() =>
                    selectedDevice && triggerNodeAction(selectedDevice, 'WARM_PAUSE')
                  }
                  className="min-h-[44px] px-3 py-2 rounded-xl border border-amber-500/40 bg-amber-500/10 hover:bg-amber-500/20 disabled:opacity-40 text-amber-300 text-xs font-bold flex items-center justify-center gap-1.5 cursor-pointer whitespace-nowrap"
                >
                  <Pause className="w-4 h-4 shrink-0" />
                  <span>⏸️ Warm Pause</span>
                </button>

                <button
                  type="button"
                  disabled={!selectedDevice}
                  onClick={() =>
                    selectedDevice && triggerNodeAction(selectedDevice, 'STOP_STREAM')
                  }
                  className="col-span-2 sm:col-span-1 xl:col-span-1 min-h-[44px] px-3 py-2 rounded-xl bg-red-600 hover:bg-red-500 disabled:opacity-40 text-white text-xs font-bold flex items-center justify-center gap-1.5 cursor-pointer whitespace-nowrap"
                >
                  <Square className="w-4 h-4 shrink-0" />
                  <span>⏹️ Stop Stream</span>
                </button>
              </div>
            </div>

            {/* MAIN VIEWPORT: Large 16:9 Live Video Monitor + Real-Time WebRTC Telemetry HUD */}
            <div
              ref={playerContainerRef}
              className="rounded-2xl border border-slate-800 bg-black overflow-hidden shadow-xl flex flex-col"
            >
              {/* Monitor Header Bar */}
              <div className="px-4 py-2.5 bg-[#0D1322] border-b border-slate-800 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-xs font-mono text-slate-300 tabular-nums">
                  <Activity className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  <span>
                    {tierSpec.badgeLabel} • {telemetry.bitrateKbps} kbps • RTT {telemetry.pingMs} ms
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  {/* Camera Flip Button */}
                  <button
                    type="button"
                    disabled={!selectedDevice}
                    onClick={handleFlipCamera}
                    className="min-h-[34px] px-2.5 py-1 rounded-lg border border-slate-700 bg-slate-900 hover:bg-slate-800 disabled:opacity-40 text-xs font-medium text-slate-200 flex items-center gap-1.5 cursor-pointer"
                    title="Flip Front / Back Camera"
                  >
                    <SwitchCamera className="w-3.5 h-3.5" />
                    <span>Flip Camera</span>
                  </button>

                  {/* Snapshot PNG Capture */}
                  <button
                    type="button"
                    disabled={!videoHasDecodedFrames && !webpFallbackFrameUrl}
                    onClick={handleDownloadSnapshotPng}
                    className="min-h-[34px] px-2.5 py-1 rounded-lg border border-slate-700 bg-slate-900 hover:bg-slate-800 disabled:opacity-40 text-xs font-medium text-slate-200 flex items-center gap-1.5 cursor-pointer"
                    title="Download Snapshot PNG"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>Snapshot PNG</span>
                  </button>

                  {/* Fullscreen Toggle */}
                  <button
                    type="button"
                    onClick={handleToggleFullscreen}
                    className="min-h-[34px] px-2.5 py-1 rounded-lg border border-slate-700 bg-slate-900 hover:bg-slate-800 text-xs font-medium text-slate-200 flex items-center gap-1.5 cursor-pointer"
                    title="Toggle Fullscreen"
                  >
                    <Maximize2 className="w-3.5 h-3.5" />
                    <span className="hidden sm:inline">Fullscreen</span>
                  </button>
                </div>
              </div>

              {/* 16:9 Live Video Stage */}
              <div className="relative aspect-video w-full max-h-[70vh] bg-black flex items-center justify-center overflow-hidden">
                <video
                  ref={videoRef}
                  muted
                  playsInline
                  autoPlay
                  onLoadedData={checkVideoDecodedDimensions}
                  onPlaying={checkVideoDecodedDimensions}
                  onResize={checkVideoDecodedDimensions}
                  className={`w-full h-full object-contain ${
                    hasActiveMedia && videoHasDecodedFrames ? 'block' : 'hidden'
                  }`}
                />

                {!videoHasDecodedFrames && webpFallbackFrameUrl && (
                  <img
                    src={webpFallbackFrameUrl}
                    alt="Live Remote Node Stream"
                    referrerPolicy="no-referrer"
                    className="w-full h-full object-contain"
                  />
                )}

                {!videoHasDecodedFrames && !webpFallbackFrameUrl && connectingStreamLabel && (
                  <div className="text-center p-6 space-y-3">
                    <div className="w-9 h-9 rounded-full border-2 border-blue-500/30 border-t-blue-400 animate-spin mx-auto" />
                    <div className="text-sm font-semibold text-white">
                      {connectingStreamLabel}
                    </div>
                    <p className="text-xs text-slate-400 font-mono">
                      10-Candidate ICE Pool + Direct Node Trigger Active
                    </p>
                  </div>
                )}

                {!videoHasDecodedFrames && !webpFallbackFrameUrl && !connectingStreamLabel && (
                  <div className="text-center p-6 space-y-2.5">
                    <Video className="w-9 h-9 text-slate-700 mx-auto" />
                    <div className="text-sm font-semibold text-slate-300">
                      {selectedDevice
                        ? selectedDevice.whatsappYielded
                          ? `${selectedDevice.customName} yielded camera to external call`
                          : `${selectedDevice.customName} Ready (${
                              selectedDevice.streamState === 'PAUSED'
                                ? 'Warm Paused — Camera Released'
                                : 'Standby — Camera 100% Free'
                            })`
                        : 'Waiting for Phone Node...'}
                    </div>
                    <p className="text-xs text-slate-500 max-w-md mx-auto">
                      Click Back Camera (720p), Front Camera (720p), or Screen Share above to start streaming immediately.
                    </p>
                  </div>
                )}
              </div>
            </div>
          </section>
        </div>
      </main>

      {/* Footer with Subtle Role Switcher Link */}
      <footer className="w-full border-t border-slate-900 bg-[#090D16] px-4 sm:px-6 py-3">
        <div className="max-w-[1760px] mx-auto flex items-center justify-between text-xs text-slate-500">
          <span className="font-mono">OpticLink Command Center • 720p @ 30 FPS Adaptive WebRTC</span>
          {onSwitchToNode && (
            <button
              type="button"
              onClick={onSwitchToNode}
              className="text-slate-400 hover:text-white underline underline-offset-4 cursor-pointer"
            >
              Switch to OpticLink Node (Phone View)
            </button>
          )}
        </div>
      </footer>
    </div>
  );
};
