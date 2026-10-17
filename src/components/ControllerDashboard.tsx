import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Battery,
  BatteryCharging,
  Camera,
  Download,
  Lock,
  Maximize2,
  Monitor,
  Pause,
  RefreshCw,
  Settings,
  Smartphone,
  Square,
  Trash2,
  Unlock,
  Video,
  Wifi,
  X,
} from 'lucide-react';
import {
  changeControllerPin,
  deletePairedDevice,
  ensureDefaultPinInitialized,
  subscribeToDevices,
  upsertDeviceStateChange,
  verifyControllerPin,
} from '../lib/firebase';
import {
  enumerateCameraLenses,
  getNetworkConnectionType,
  getOrCreateAutoDeviceIdentity,
  releaseHardwareMediaZeroHold,
} from '../lib/hardwareTelemetry';
import {
  emitLocalControlMessage,
  getLocalMediaStreams,
  onLocalControlMessage,
  onLocalMediaStream,
} from '../lib/loopbackBus';
import {
  PreWarmedMultiplexPeer,
  createDiagnosticOpticalStream,
} from '../lib/webrtcEngine';
import {
  ADAPTIVE_QUALITY_TIERS,
  DeviceAgentRecord,
  P2PControlMessage,
  TelemetrySnapshot,
} from '../types/opticlink';

const SESSION_UNLOCKED_KEY = 'opticlink_clean_controller_unlocked_v2';

export const ControllerDashboard: React.FC = () => {
  const localIdentity = useRef(getOrCreateAutoDeviceIdentity()).current;

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

  // Auto-Registered Phones List
  const [devices, setDevices] = useState<DeviceAgentRecord[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  const [selectedLensId, setSelectedLensId] = useState<string>('default-back');

  // Active Media & Decoded Frame State (prevents blank <video> from hiding live WebP frames)
  const [hasActiveMedia, setHasActiveMedia] = useState<boolean>(false);
  const [videoHasDecodedFrames, setVideoHasDecodedFrames] = useState<boolean>(false);
  const [webpFallbackFrameUrl, setWebpFallbackFrameUrl] = useState<string | null>(null);
  const [connectingStreamLabel, setConnectingStreamLabel] = useState<string | null>(null);

  // Telemetry State
  const [telemetry, setTelemetry] = useState<TelemetrySnapshot>({
    pingMs: 22,
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
  const peerRef = useRef<PreWarmedMultiplexPeer | null>(null);
  const activeMediaStreamRef = useRef<MediaStream | null>(null);
  const fallbackLocalStreamRef = useRef<MediaStream | null>(null);
  const stopSyntheticRef = useRef<(() => void) | null>(null);
  const localFallbackTimerRef = useRef<number | null>(null);

  // Initialize default "0000" PIN and subscribe to auto-registered phones
  useEffect(() => {
    ensureDefaultPinInitialized().catch(() => {});
    const unsub = subscribeToDevices(async (list) => {
      if (list.length === 0) {
        const lenses = await enumerateCameraLenses();
        const autoDevice: DeviceAgentRecord = {
          deviceUuid: localIdentity.deviceId,
          customName: localIdentity.autoAssignedName,
          locationTag: 'Local Device',
          hardwareModel: localIdentity.hardwareModel,
          osVersion: localIdentity.osVersion,
          batteryLevel: 96,
          isCharging: true,
          networkType: getNetworkConnectionType(),
          streamState: 'IDLE',
          activeEngine: 'RTP',
          screenPreAuthorized: false,
          wakeLockActive: false,
          uptimeStartedAt: Date.now(),
          lastStateChangeAt: Date.now(),
          lastPingLatencyMs: 18,
          deviceSecretHash: 'auto-registered',
          availableLenses: lenses,
          qualityTier: 'TIER_720P_30',
        };
        await upsertDeviceStateChange(autoDevice).catch(() => {});
        return;
      }

      // Sort real remote Phone Agents ahead of local desktop placeholder
      const sorted = [...list].sort((a, b) => {
        const aIsRemotePhone = a.deviceUuid !== localIdentity.deviceId ? 1 : 0;
        const bIsRemotePhone = b.deviceUuid !== localIdentity.deviceId ? 1 : 0;
        if (aIsRemotePhone !== bIsRemotePhone) return bIsRemotePhone - aIsRemotePhone;
        return b.lastStateChangeAt - a.lastStateChangeAt;
      });

      setDevices(sorted);
      setSelectedDeviceId((prev) => {
        // If a remote Phone Agent is available and we were previously on the local desktop ID, switch to the remote Phone Agent
        const remotePhone = sorted.find((d) => d.deviceUuid !== localIdentity.deviceId);
        if (remotePhone && (!prev || prev === localIdentity.deviceId)) {
          return remotePhone.deviceUuid;
        }
        if (prev && sorted.some((d) => d.deviceUuid === prev)) return prev;
        return sorted[0]?.deviceUuid || '';
      });
    });
    return () => unsub();
  }, [localIdentity]);

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
      activeMediaStreamRef.current = stream;
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

  const stopLocalFallbackHardware = useCallback(async () => {
    if (localFallbackTimerRef.current) {
      window.clearTimeout(localFallbackTimerRef.current);
      localFallbackTimerRef.current = null;
    }
    stopSyntheticRef.current?.();
    stopSyntheticRef.current = null;
    if (fallbackLocalStreamRef.current) {
      await releaseHardwareMediaZeroHold({
        stream: fallbackLocalStreamRef.current,
        videoElement: videoRef.current,
        waitForSettleMs: 100,
      });
      fallbackLocalStreamRef.current = null;
    }
  }, []);

  // Pre-Warmed P2P Connection to Selected Phone Agent
  useEffect(() => {
    if (!isUnlocked || !selectedDeviceId) return;

    setWebpFallbackFrameUrl(null);
    setVideoHasDecodedFrames(false);
    setConnectingStreamLabel(null);

    const peer = new PreWarmedMultiplexPeer({
      localId: 'controller-main',
      remoteId: selectedDeviceId,
      polite: false,
      callbacks: {
        onControlMessage: (msg) => {
          if (msg.type === 'EVT_WEBP_FALLBACK_FRAME') {
            if (localFallbackTimerRef.current) {
              window.clearTimeout(localFallbackTimerRef.current);
              localFallbackTimerRef.current = null;
            }
            setWebpFallbackFrameUrl(msg.dataUrl);
            setHasActiveMedia(true);
            setConnectingStreamLabel(null);
          } else if (msg.type === 'EVT_PONG') {
            const rtt = Math.max(1, Date.now() - msg.sentAt);
            setTelemetry((prev) => ({ ...prev, pingMs: rtt }));
          }
        },
        onRemoteCameraStream: (stream) => {
          if (localFallbackTimerRef.current) {
            window.clearTimeout(localFallbackTimerRef.current);
            localFallbackTimerRef.current = null;
          }
          attachMediaToPlayer(stream);
        },
        onRemoteScreenStream: (stream) => {
          if (localFallbackTimerRef.current) {
            window.clearTimeout(localFallbackTimerRef.current);
            localFallbackTimerRef.current = null;
          }
          attachMediaToPlayer(stream);
        },
        onTelemetryUpdate: (snap) => {
          setTelemetry(snap);
          checkVideoDecodedDimensions();
        },
      },
    });
    peerRef.current = peer;

    const localExisting = getLocalMediaStreams(selectedDeviceId);
    if (localExisting.camera || localExisting.screen) {
      attachMediaToPlayer(localExisting.camera || localExisting.screen);
    }

    const unsubLocalMedia = onLocalMediaStream((devId, _kind, stream) => {
      if (devId !== selectedDeviceId) return;
      if (stream && localFallbackTimerRef.current) {
        window.clearTimeout(localFallbackTimerRef.current);
        localFallbackTimerRef.current = null;
      }
      attachMediaToPlayer(stream);
    });

    const unsubLocalCtrl = onLocalControlMessage((fromId, toId, msg) => {
      if (fromId !== selectedDeviceId || (toId !== 'controller-main' && toId !== '*')) return;
      if (msg.type === 'EVT_WEBP_FALLBACK_FRAME') {
        if (localFallbackTimerRef.current) {
          window.clearTimeout(localFallbackTimerRef.current);
          localFallbackTimerRef.current = null;
        }
        setWebpFallbackFrameUrl(msg.dataUrl);
        setHasActiveMedia(true);
        setConnectingStreamLabel(null);
      } else if (msg.type === 'EVT_PONG') {
        const rtt = Math.max(1, Date.now() - msg.sentAt);
        setTelemetry((prev) => ({ ...prev, pingMs: rtt }));
      }
    });

    return () => {
      unsubLocalMedia();
      unsubLocalCtrl();
      peer.destroy();
      peerRef.current = null;
    };
  }, [isUnlocked, selectedDeviceId, attachMediaToPlayer, checkVideoDecodedDimensions]);

  // Used ONLY when testing on the exact same browser device (where no separate Phone Agent tab is open)
  const activateLocalFallbackStream = useCallback(
    async (
      targetDevice: DeviceAgentRecord,
      mode: 'STREAMING_CAMERA' | 'STREAMING_SCREEN',
      facing?: 'front' | 'back',
      lensId?: string
    ) => {
      await stopLocalFallbackHardware();

      let stream: MediaStream;
      const desiredFacing = facing === 'front' ? 'user' : 'environment';

      if (mode === 'STREAMING_CAMERA') {
        const useExact = lensId && !lensId.startsWith('default-');
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: useExact
              ? {
                  deviceId: { exact: lensId },
                  width: { ideal: 1280, max: 1280 },
                  height: { ideal: 720, max: 720 },
                  frameRate: { ideal: 30, max: 30 },
                }
              : {
                  facingMode: { ideal: desiredFacing },
                  width: { ideal: 1280, max: 1280 },
                  height: { ideal: 720, max: 720 },
                  frameRate: { ideal: 30, max: 30 },
                },
          });
        } catch {
          try {
            stream = await navigator.mediaDevices.getUserMedia({
              audio: false,
              video: true,
            });
          } catch {
            const diag = createDiagnosticOpticalStream(
              1280,
              720,
              30,
              `${targetDevice.customName} • ${facing === 'front' ? 'Front Camera' : 'Back Camera'}`,
              'camera'
            );
            stream = diag.stream;
            stopSyntheticRef.current = diag.stopSynthetic;
          }
        }
      } else {
        try {
          stream = await navigator.mediaDevices.getDisplayMedia({
            video: {
              width: { ideal: 1280, max: 1280 },
              height: { ideal: 720, max: 720 },
              frameRate: { ideal: 30, max: 30 },
            },
            audio: false,
          });
        } catch {
          const diag = createDiagnosticOpticalStream(
            1280,
            720,
            30,
            `${targetDevice.customName} • Screen Share`,
            'screen'
          );
          stream = diag.stream;
          stopSyntheticRef.current = diag.stopSynthetic;
        }
      }

      fallbackLocalStreamRef.current = stream;
      setWebpFallbackFrameUrl(null);
      attachMediaToPlayer(stream);
      setConnectingStreamLabel(null);

      await upsertDeviceStateChange({
        ...targetDevice,
        streamState: mode,
        activeEngine: 'RTP',
        whatsappYielded: false,
        activeFacing: facing || 'back',
      });
    },
    [stopLocalFallbackHardware, attachMediaToPlayer]
  );

  // Dispatch 1-Click Command to Phone Agent
  const sendCommandToPhone = useCallback(
    async (targetDevice: DeviceAgentRecord, msg: P2PControlMessage) => {
      const switchingDevice = targetDevice.deviceUuid !== selectedDeviceId;
      if (switchingDevice) {
        setSelectedDeviceId(targetDevice.deviceUuid);
      }

      // Send over PreWarmedMultiplexPeer (DataChannel + Firestore redundant control delivery)
      setTimeout(
        () => {
          peerRef.current?.sendControlMessage(msg);
          emitLocalControlMessage('controller-main', targetDevice.deviceUuid, msg);
        },
        switchingDevice ? 80 : 0
      );

      if (msg.type === 'CMD_START_STREAM') {
        const label =
          msg.mode === 'STREAMING_SCREEN'
            ? 'Starting Remote Screen Share...'
            : msg.facing === 'front'
            ? 'Starting Remote Front Camera (720p • 30 FPS)...'
            : 'Starting Remote Back Camera (720p • 30 FPS)...';
        setConnectingStreamLabel(label);

        if (localFallbackTimerRef.current) {
          window.clearTimeout(localFallbackTimerRef.current);
          localFallbackTimerRef.current = null;
        }

        // ONLY use local fallback camera if this targetDevice IS the current local browser
        // (never hijack a remote phone with the PC's camera!)
        if (targetDevice.deviceUuid === localIdentity.deviceId) {
          localFallbackTimerRef.current = window.setTimeout(() => {
            if (!activeMediaStreamRef.current && !webpFallbackFrameUrl) {
              activateLocalFallbackStream(
                targetDevice,
                msg.mode,
                msg.facing,
                msg.lensId
              );
            }
          }, 500);
        }
      } else if (msg.type === 'CMD_SWITCH_LENS') {
        setConnectingStreamLabel('Switching Remote Camera Lens...');
        if (
          targetDevice.deviceUuid === localIdentity.deviceId &&
          fallbackLocalStreamRef.current
        ) {
          await activateLocalFallbackStream(
            targetDevice,
            'STREAMING_CAMERA',
            msg.facing,
            msg.lensId
          );
        }
      } else if (msg.type === 'CMD_STOP_STREAM' || msg.type === 'CMD_WARM_PAUSE') {
        await stopLocalFallbackHardware();
        setWebpFallbackFrameUrl(null);
        setVideoHasDecodedFrames(false);
        setConnectingStreamLabel(null);
        attachMediaToPlayer(null);
        await upsertDeviceStateChange({
          ...targetDevice,
          streamState: msg.type === 'CMD_WARM_PAUSE' ? 'PAUSED' : 'IDLE',
          activeEngine: 'RTP',
        });
      } else if (msg.type === 'CMD_PING') {
        const rtt = Math.max(8, telemetry.pingMs);
        await upsertDeviceStateChange({
          ...targetDevice,
          lastPingLatencyMs: rtt,
        });
      }
    },
    [
      selectedDeviceId,
      localIdentity.deviceId,
      webpFallbackFrameUrl,
      activateLocalFallbackStream,
      stopLocalFallbackHardware,
      attachMediaToPlayer,
      telemetry.pingMs,
    ]
  );

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

  // Snapshot PNG Download
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
      a.download = `snapshot-${Date.now()}.png`;
      a.click();
    } else if (webpFallbackFrameUrl) {
      const a = document.createElement('a');
      a.href = webpFallbackFrameUrl;
      a.download = `snapshot-${Date.now()}.webp`;
      a.click();
    }
  };

  // Fullscreen Player Toggle
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
  // RENDER 1: 4-DIGIT PIN LOCK SCREEN (Default "0000", Masked Input)
  // ============================================================================
  if (!isUnlocked) {
    return (
      <div className="w-full max-w-sm mx-auto my-6 sm:my-12 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] p-5 sm:p-6">
        <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-4">
          <div>
            <h2 className="text-base font-bold text-slate-900 dark:text-white">
              Web Controller PIN Lock
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Enter 4-digit PIN (default 0000)
            </p>
          </div>
          <Lock className="w-5 h-5 text-blue-600 dark:text-blue-400 shrink-0" />
        </div>

        <form onSubmit={handleUnlockSubmit} className="mt-4 space-y-4" autoComplete="off">
          <div>
            <input
              type="password"
              inputMode="numeric"
              maxLength={4}
              value={pinInput}
              onChange={(e) => setPinInput(e.target.value.replace(/[^0-9]/g, ''))}
              placeholder="••••"
              autoComplete="off"
              className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-4 py-3 text-center text-2xl font-mono tracking-[0.5em] text-slate-900 dark:text-white"
              required
            />
          </div>

          {pinError && (
            <div className="rounded-lg bg-red-50 dark:bg-red-950/60 border border-red-200 dark:border-red-900 px-3 py-2 text-xs text-red-700 dark:text-red-300">
              {pinError}
            </div>
          )}

          <button
            type="submit"
            disabled={pinBusy || pinInput.length !== 4}
            className="w-full min-h-[46px] rounded-xl bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-semibold text-sm flex items-center justify-center gap-2 transition-colors cursor-pointer"
          >
            <Unlock className="w-4 h-4" />
            <span>{pinBusy ? 'Unlocking...' : 'Unlock Dashboard'}</span>
          </button>
        </form>
      </div>
    );
  }

  // ============================================================================
  // RENDER 2: RESPONSIVE WEB CONTROLLER DASHBOARD (320px Mobile -> 1920px+ Desktop)
  // ============================================================================
  const availableLenses =
    selectedDevice?.availableLenses && selectedDevice.availableLenses.length > 0
      ? selectedDevice.availableLenses
      : [
          { deviceId: 'default-back', label: 'Back Camera', facing: 'back' as const },
          { deviceId: 'default-front', label: 'Front Camera', facing: 'front' as const },
        ];

  const isStreaming =
    videoHasDecodedFrames ||
    Boolean(webpFallbackFrameUrl) ||
    Boolean(connectingStreamLabel) ||
    (selectedDevice !== null &&
      (selectedDevice.streamState === 'STREAMING_CAMERA' ||
        selectedDevice.streamState === 'STREAMING_SCREEN'));

  const tierSpec =
    ADAPTIVE_QUALITY_TIERS[selectedDevice?.qualityTier || telemetry.tierId] ||
    ADAPTIVE_QUALITY_TIERS.TIER_720P_30;

  return (
    <div className="w-full max-w-full overflow-x-hidden">
      {/* Settings Modal (Change 4-Digit PIN) */}
      {settingsOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
          <div className="w-full max-w-sm rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] p-5 sm:p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-slate-900 dark:text-white">
                Controller PIN Settings
              </h3>
              <button
                type="button"
                onClick={() => setSettingsOpen(false)}
                className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleChangePinSubmit} className="space-y-3" autoComplete="off">
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
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
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-center font-mono tracking-[0.4em] text-slate-900 dark:text-white"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
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
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-center font-mono tracking-[0.4em] text-slate-900 dark:text-white"
                  required
                />
              </div>

              {settingsStatus && (
                <div
                  className={`rounded-lg px-3 py-2 text-xs ${
                    settingsStatus.ok
                      ? 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300'
                      : 'bg-red-50 dark:bg-red-950/60 text-red-700 dark:text-red-300'
                  }`}
                >
                  {settingsStatus.msg}
                </div>
              )}

              <button
                type="submit"
                className="w-full min-h-[42px] rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold cursor-pointer"
              >
                Save New 4-Digit PIN
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Responsive 12-Column Studio Grid:
          - Small Screens (<640px): Clean vertical stack, zero horizontal overflow
          - Tablet (640px-1023px): Full-width player + 2-column device grid
          - Large & Ultra-Wide Desktop (1024px-1920px+): 8/4 or 9/3 split with sticky device dock */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 sm:gap-5 xl:gap-6 items-start">
        {/* LEFT / CENTER COLUMN: Live Video Viewport + Quick Controls */}
        <div className="lg:col-span-7 xl:col-span-8 2xl:col-span-9 w-full max-w-full space-y-4">
          <div
            ref={playerContainerRef}
            className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-slate-950 overflow-hidden shadow-sm flex flex-col"
          >
            {/* Top Player Bar: Responsive for 320px Mobile and 1920px Desktop */}
            <div className="p-2.5 sm:px-4 sm:py-3 bg-slate-900 border-b border-slate-800 flex flex-col md:flex-row md:items-center justify-between gap-2.5">
              <div className="flex flex-wrap items-center justify-between md:justify-start gap-2 min-w-0">
                <span className="text-xs sm:text-sm font-bold text-white truncate max-w-[190px] sm:max-w-xs xl:max-w-md">
                  {selectedDevice ? selectedDevice.customName : 'No Phone Selected'}
                </span>

                {/* Live Resolution, FPS, and Bitrate Badge */}
                <span className="text-[11px] sm:text-xs font-mono tabular-nums text-emerald-400 shrink-0">
                  {tierSpec.badgeLabel} • {telemetry.bitrateKbps} kbps
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-1.5 sm:gap-2 w-full md:w-auto">
                {/* Lens Switcher Dropdown */}
                <select
                  value={selectedLensId}
                  onChange={(e) => {
                    const nextId = e.target.value;
                    setSelectedLensId(nextId);
                    if (selectedDevice) {
                      const lensObj = availableLenses.find((l) => l.deviceId === nextId);
                      sendCommandToPhone(selectedDevice, {
                        type: 'CMD_SWITCH_LENS',
                        lensId: nextId,
                        facing: lensObj?.facing === 'front' ? 'front' : 'back',
                      });
                    }
                  }}
                  className="flex-1 md:flex-none min-w-[125px] rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs text-slate-200 min-h-[38px]"
                >
                  {availableLenses.map((lens) => (
                    <option key={lens.deviceId} value={lens.deviceId}>
                      {lens.label}
                    </option>
                  ))}
                </select>

                {/* Snapshot PNG Download Button */}
                <button
                  type="button"
                  disabled={!videoHasDecodedFrames && !webpFallbackFrameUrl}
                  onClick={handleDownloadSnapshotPng}
                  className="min-h-[38px] px-2.5 sm:px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-xs font-semibold text-white flex items-center justify-center gap-1.5 cursor-pointer whitespace-nowrap"
                  title="Download Snapshot PNG"
                >
                  <Download className="w-3.5 h-3.5 shrink-0" />
                  <span className="hidden xs:inline sm:inline">Snapshot</span>
                </button>

                {/* Fullscreen Button */}
                <button
                  type="button"
                  onClick={handleToggleFullscreen}
                  className="min-h-[38px] px-2.5 sm:px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-white flex items-center justify-center gap-1.5 cursor-pointer whitespace-nowrap"
                  title="Fullscreen Video"
                >
                  <Maximize2 className="w-3.5 h-3.5 shrink-0" />
                  <span className="hidden sm:inline">Fullscreen</span>
                </button>

                {/* PIN Settings */}
                <button
                  type="button"
                  onClick={() => setSettingsOpen(true)}
                  className="min-h-[38px] px-2.5 py-1.5 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-xs text-slate-300 cursor-pointer"
                  title="PIN Settings"
                >
                  <Settings className="w-3.5 h-3.5" />
                </button>

                {/* Lock Controller */}
                <button
                  type="button"
                  onClick={() => {
                    setIsUnlocked(false);
                    sessionStorage.removeItem(SESSION_UNLOCKED_KEY);
                  }}
                  className="min-h-[38px] px-2.5 py-1.5 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-xs text-slate-300 cursor-pointer"
                  title="Lock Controller"
                >
                  <Lock className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* Video Stage: Scales cleanly from 320px phones up to widescreen monitors */}
            <div className="relative aspect-video w-full max-h-[68vh] bg-slate-950 flex items-center justify-center overflow-hidden">
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

              {/* Live WebP Frame Stream: Displays immediately (<250ms) while WebRTC RTP settles or if UDP is blocked */}
              {!videoHasDecodedFrames && webpFallbackFrameUrl && (
                <img
                  src={webpFallbackFrameUrl}
                  alt="Live Remote Camera Stream"
                  referrerPolicy="no-referrer"
                  className="w-full h-full object-contain"
                />
              )}

              {/* Connecting Indicator while remote camera lens opens */}
              {!videoHasDecodedFrames && !webpFallbackFrameUrl && connectingStreamLabel && (
                <div className="text-center p-4 sm:p-8 space-y-3">
                  <div className="w-9 h-9 rounded-full border-2 border-blue-500/30 border-t-blue-400 animate-spin mx-auto" />
                  <div className="text-xs sm:text-sm font-semibold text-white">
                    {connectingStreamLabel}
                  </div>
                  <p className="text-xs text-slate-400 font-mono">
                    control-plane DataChannel + 10-Candidate ICE Pool Active
                  </p>
                </div>
              )}

              {/* Standby Empty State */}
              {!videoHasDecodedFrames && !webpFallbackFrameUrl && !connectingStreamLabel && (
                <div className="text-center p-4 sm:p-8 space-y-2.5">
                  <Video className="w-8 h-8 text-slate-600 mx-auto" />
                  <div className="text-xs sm:text-sm font-semibold text-slate-300">
                    {selectedDevice
                      ? selectedDevice.whatsappYielded
                        ? `${selectedDevice.customName} yielded camera to WhatsApp`
                        : `${selectedDevice.customName} is in Standby (Camera 100% Released)`
                      : 'Waiting for Phone Agent Auto-Registration...'}
                  </div>
                  <p className="text-xs text-slate-500 max-w-md mx-auto">
                    Tap Back Camera ON, Front Camera ON, or Screen Share ON below to stream live at up to 720p • 30 FPS.
                  </p>
                </div>
              )}
            </div>

            {/* Integrated 1-Click Remote Control Dock Under Player */}
            {selectedDevice && (
              <div className="p-2.5 sm:p-3 bg-slate-900 border-t border-slate-800 grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-5 gap-2">
                <button
                  type="button"
                  onClick={() =>
                    sendCommandToPhone(selectedDevice, {
                      type: 'CMD_START_STREAM',
                      mode: 'STREAMING_CAMERA',
                      facing: 'back',
                    })
                  }
                  className="min-h-[42px] px-2.5 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold flex items-center justify-center gap-1.5 cursor-pointer whitespace-nowrap"
                >
                  <Camera className="w-3.5 h-3.5 shrink-0" />
                  <span>Back Camera ON</span>
                </button>

                <button
                  type="button"
                  onClick={() =>
                    sendCommandToPhone(selectedDevice, {
                      type: 'CMD_START_STREAM',
                      mode: 'STREAMING_CAMERA',
                      facing: 'front',
                    })
                  }
                  className="min-h-[42px] px-2.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-white text-xs font-semibold flex items-center justify-center gap-1.5 cursor-pointer whitespace-nowrap"
                >
                  <Camera className="w-3.5 h-3.5 shrink-0" />
                  <span>Front Camera ON</span>
                </button>

                <button
                  type="button"
                  onClick={() =>
                    sendCommandToPhone(selectedDevice, {
                      type: 'CMD_START_STREAM',
                      mode: 'STREAMING_SCREEN',
                    })
                  }
                  className="min-h-[42px] px-2.5 py-2 rounded-xl border border-slate-700 bg-slate-800/80 hover:bg-slate-700 text-slate-200 text-xs font-semibold flex items-center justify-center gap-1.5 cursor-pointer whitespace-nowrap"
                >
                  <Monitor className="w-3.5 h-3.5 shrink-0" />
                  <span>Screen Share ON</span>
                </button>

                <button
                  type="button"
                  onClick={() =>
                    sendCommandToPhone(selectedDevice, {
                      type: 'CMD_WARM_PAUSE',
                    })
                  }
                  className="min-h-[42px] px-2.5 py-2 rounded-xl border border-amber-500/40 bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 text-xs font-semibold flex items-center justify-center gap-1.5 cursor-pointer whitespace-nowrap"
                >
                  <Pause className="w-3.5 h-3.5 shrink-0" />
                  <span>Warm Pause</span>
                </button>

                <button
                  type="button"
                  onClick={() =>
                    sendCommandToPhone(selectedDevice, {
                      type: 'CMD_STOP_STREAM',
                      reason: 'STOP (Release Camera)',
                    })
                  }
                  className="col-span-2 sm:col-span-2 xl:col-span-1 min-h-[42px] px-2.5 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-semibold flex items-center justify-center gap-1.5 cursor-pointer whitespace-nowrap"
                >
                  <Square className="w-3.5 h-3.5 shrink-0" />
                  <span>STOP (Release Camera)</span>
                </button>
              </div>
            )}
          </div>
        </div>

        {/* RIGHT COLUMN: Auto-Registered Phones List & Per-Phone 1-Click Remote Controls */}
        <div className="lg:col-span-5 xl:col-span-4 2xl:col-span-3 lg:sticky lg:top-4 w-full max-w-full space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm sm:text-base font-bold text-slate-900 dark:text-white truncate">
              Auto-Registered Phones ({devices.length})
            </h2>
            <span className="text-[11px] font-mono text-slate-500 dark:text-slate-400 shrink-0">
              {isStreaming ? 'Streaming Live' : 'Pre-Warmed'}
            </span>
          </div>

          {devices.length === 0 ? (
            <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] p-6 text-center space-y-2">
              <Smartphone className="w-7 h-7 text-slate-400 mx-auto" />
              <div className="text-sm font-bold text-slate-900 dark:text-white">
                Syncing Phone Agents...
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Phones appear here automatically with zero login or typing.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-1 gap-3 lg:max-h-[calc(100vh-7rem)] lg:overflow-y-auto lg:pr-0.5">
              {devices.map((dev) => {
                const isSelected = dev.deviceUuid === selectedDeviceId;
                const isOnline = Date.now() - dev.lastStateChangeAt < 24 * 60 * 60 * 1000;
                return (
                  <div
                    key={dev.deviceUuid}
                    onClick={() => setSelectedDeviceId(dev.deviceUuid)}
                    className={`rounded-2xl border p-3.5 sm:p-4 space-y-3 transition-colors cursor-pointer ${
                      isSelected
                        ? 'border-blue-600 dark:border-blue-500 bg-white dark:bg-[#111827]'
                        : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827]'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <h3 className="text-sm sm:text-base font-bold text-slate-900 dark:text-white truncate">
                          {dev.customName}
                        </h3>
                        <div className="flex flex-wrap items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400 mt-1 font-mono tabular-nums">
                          <span
                            className={
                              isOnline
                                ? 'text-emerald-600 dark:text-emerald-400 font-semibold'
                                : 'text-slate-400'
                            }
                          >
                            {isOnline ? 'Online' : 'Offline'}
                          </span>
                          <span>•</span>
                          <span className="flex items-center gap-1">
                            {dev.isCharging ? (
                              <BatteryCharging className="w-3.5 h-3.5 text-emerald-500" />
                            ) : (
                              <Battery className="w-3.5 h-3.5 text-slate-400" />
                            )}
                            {dev.batteryLevel}% {dev.isCharging ? 'Chg' : ''}
                          </span>
                          <span>•</span>
                          <span className="flex items-center gap-1">
                            <Wifi className="w-3.5 h-3.5 text-blue-500" />
                            {dev.networkType}
                          </span>
                        </div>
                      </div>

                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            sendCommandToPhone(dev, {
                              type: 'CMD_PING',
                              sentAt: Date.now(),
                            });
                          }}
                          className="px-2 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-xs font-mono text-slate-700 dark:text-slate-300 flex items-center gap-1 cursor-pointer whitespace-nowrap"
                          title="Ping Latency Check"
                        >
                          <RefreshCw className="w-3 h-3" />
                          <span>{dev.lastPingLatencyMs ?? telemetry.pingMs}ms</span>
                        </button>

                        {devices.length > 1 && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              deletePairedDevice(dev.deviceUuid);
                            }}
                            className="p-1.5 rounded-lg text-slate-400 hover:text-red-600 dark:hover:text-red-400 cursor-pointer"
                            title="Remove Device"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    </div>

                    {/* 1-Click Remote Controls per Phone */}
                    <div
                      onClick={(e) => e.stopPropagation()}
                      className="grid grid-cols-2 gap-2 pt-2.5 border-t border-slate-100 dark:border-slate-800"
                    >
                      <button
                        type="button"
                        onClick={() =>
                          sendCommandToPhone(dev, {
                            type: 'CMD_START_STREAM',
                            mode: 'STREAMING_CAMERA',
                            facing: 'back',
                          })
                        }
                        className="min-h-[40px] px-2.5 py-1.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold flex items-center justify-center gap-1.5 cursor-pointer whitespace-nowrap"
                      >
                        <Camera className="w-3.5 h-3.5 shrink-0" />
                        <span>Back Camera ON</span>
                      </button>

                      <button
                        type="button"
                        onClick={() =>
                          sendCommandToPhone(dev, {
                            type: 'CMD_START_STREAM',
                            mode: 'STREAMING_CAMERA',
                            facing: 'front',
                          })
                        }
                        className="min-h-[40px] px-2.5 py-1.5 rounded-xl bg-slate-900 dark:bg-slate-800 hover:bg-slate-800 dark:hover:bg-slate-700 text-white text-xs font-semibold flex items-center justify-center gap-1.5 cursor-pointer whitespace-nowrap"
                      >
                        <Camera className="w-3.5 h-3.5 shrink-0" />
                        <span>Front Camera ON</span>
                      </button>

                      <button
                        type="button"
                        onClick={() =>
                          sendCommandToPhone(dev, {
                            type: 'CMD_START_STREAM',
                            mode: 'STREAMING_SCREEN',
                          })
                        }
                        className="min-h-[40px] px-2.5 py-1.5 rounded-xl border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-800 dark:text-slate-200 text-xs font-semibold flex items-center justify-center gap-1.5 cursor-pointer whitespace-nowrap"
                      >
                        <Monitor className="w-3.5 h-3.5 shrink-0" />
                        <span>Screen Share ON</span>
                      </button>

                      <button
                        type="button"
                        onClick={() =>
                          sendCommandToPhone(dev, {
                            type: 'CMD_WARM_PAUSE',
                          })
                        }
                        className="min-h-[40px] px-2.5 py-1.5 rounded-xl border border-amber-500/40 bg-amber-500/10 hover:bg-amber-500/20 text-amber-700 dark:text-amber-300 text-xs font-semibold flex items-center justify-center gap-1.5 cursor-pointer whitespace-nowrap"
                      >
                        <Pause className="w-3.5 h-3.5 shrink-0" />
                        <span>Warm Pause</span>
                      </button>

                      <button
                        type="button"
                        onClick={() =>
                          sendCommandToPhone(dev, {
                            type: 'CMD_STOP_STREAM',
                            reason: 'STOP (Release Camera)',
                          })
                        }
                        className="col-span-2 min-h-[40px] px-2.5 py-1.5 rounded-xl bg-red-600 hover:bg-red-700 text-white text-xs font-semibold flex items-center justify-center gap-1.5 cursor-pointer whitespace-nowrap"
                      >
                        <Square className="w-3.5 h-3.5 shrink-0" />
                        <span>STOP (Release Camera)</span>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
