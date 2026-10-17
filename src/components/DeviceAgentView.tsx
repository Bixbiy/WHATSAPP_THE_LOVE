import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  Battery,
  BatteryCharging,
  Cpu,
  EyeOff,
  Radio,
  Square,
  Wifi,
} from 'lucide-react';
import {
  sendNodeHeartbeat,
  subscribeToSingleDeviceNode,
  upsertDeviceStateChange,
} from '../lib/firebase';
import {
  enumerateCameraLenses,
  getNetworkConnectionType,
  getOrCreateAutoDeviceIdentity,
  releaseHardwareMediaZeroHold,
  start24HourIdleRefreshWatchdog,
  startSilentAudioKeepAlive,
  subscribeToBatteryChanges,
  subscribeToNetworkChanges,
} from '../lib/hardwareTelemetry';
import {
  AntiBlankScreenWatchdog,
  WebRTCManager,
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
  RemoteNodeCommand,
  StreamState,
  TransportEngine,
} from '../types/opticlink';

interface DeviceAgentViewProps {
  onSwitchToController?: () => void;
}

export const DeviceAgentView: React.FC<DeviceAgentViewProps> = ({
  onSwitchToController,
}) => {
  const autoIdentity = useRef(getOrCreateAutoDeviceIdentity()).current;
  const bootedAtRef = useRef<number>(Date.now());

  const [batteryLevel, setBatteryLevel] = useState<number>(96);
  const [isCharging, setIsCharging] = useState<boolean>(true);
  const [networkType, setNetworkType] = useState<string>(() => getNetworkConnectionType());
  const [livePingMs, setLivePingMs] = useState<number>(18);

  const [streamState, setStreamState] = useState<StreamState>('IDLE');
  const streamStateRef = useRef<StreamState>('IDLE');
  streamStateRef.current = streamState;

  const [activeFacing, setActiveFacing] = useState<'front' | 'back'>('back');
  const [activeEngine, setActiveEngine] = useState<TransportEngine>('RTP');
  const [qualityTier, setQualityTier] = useState<AdaptiveQualityTierId>('TIER_720P_30');
  const [availableLenses, setAvailableLenses] = useState<CameraLensInfo[]>([]);
  const [selectedLensId, setSelectedLensId] = useState<string>('default-back');
  const [wakeLockActive, setWakeLockActive] = useState<boolean>(false);
  const [oledDimmed, setOledDimmed] = useState<boolean>(false);
  const [whatsappYielded, setWhatsappYielded] = useState<boolean>(false);

  const cameraStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const stopSyntheticCamRef = useRef<(() => void) | null>(null);
  const stopSyntheticScreenRef = useRef<(() => void) | null>(null);

  const hiddenCameraVideoRef = useRef<HTMLVideoElement | null>(null);
  const hiddenScreenVideoRef = useRef<HTMLVideoElement | null>(null);
  const peerRef = useRef<WebRTCManager | null>(null);
  const watchdogRef = useRef<AntiBlankScreenWatchdog>(new AntiBlankScreenWatchdog());
  const wakeLockSentinelRef = useRef<{ release: () => Promise<void> } | null>(null);
  const executedCommandIdsRef = useRef<Set<string>>(new Set());

  const markCommandExecuted = useCallback((cmdId?: string): boolean => {
    if (!cmdId) return true;
    if (executedCommandIdsRef.current.has(cmdId)) return false;
    executedCommandIdsRef.current.add(cmdId);
    if (executedCommandIdsRef.current.size > 200) {
      const first = executedCommandIdsRef.current.values().next().value;
      if (first) executedCommandIdsRef.current.delete(first);
    }
    return true;
  }, []);

  const buildDeviceSnapshot = useCallback(
    (overrides?: Partial<DeviceAgentRecord>): DeviceAgentRecord => {
      return {
        deviceUuid: autoIdentity.deviceId,
        customName: autoIdentity.autoAssignedName,
        locationTag: 'Auto-Discovered Phone Node',
        hardwareModel: autoIdentity.hardwareModel,
        osVersion: autoIdentity.osVersion,
        online: true,
        heartbeatAt: Date.now(),
        batteryLevel,
        isCharging,
        networkType,
        streamState: streamStateRef.current,
        activeEngine,
        screenPreAuthorized: false,
        wakeLockActive,
        uptimeStartedAt: bootedAtRef.current,
        lastStateChangeAt: Date.now(),
        lastPingLatencyMs: livePingMs,
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
      livePingMs,
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
    },
    [buildDeviceSnapshot]
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
      // Ignore if wakeLock requires gesture on desktop
    }
    setWakeLockActive(true);
  }, []);

  // ============================================================================
  // ZERO-HOLD HARDWARE CAMERA RELEASE (100% Free for Phone Calls & WhatsApp)
  // ============================================================================
  const stopAllHardwareStreams = useCallback(
    async (targetNextState: StreamState = 'IDLE', yieldedToExternalApp = false) => {
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
        waitForSettleMs: 120,
      });
      cameraStreamRef.current = null;

      await releaseHardwareMediaZeroHold({
        stream: screenStreamRef.current,
        videoElement: hiddenScreenVideoRef.current,
        rtpSender: peerRef.current?.getScreenSender() || null,
        waitForSettleMs: 50,
      });
      screenStreamRef.current = null;

      setStreamState(targetNextState);
      streamStateRef.current = targetNextState;
      setWhatsappYielded(yieldedToExternalApp);
      setActiveEngine('RTP');

      await pushStateTransitionToFirestore({
        streamState: targetNextState,
        activeEngine: 'RTP',
        whatsappYielded: yieldedToExternalApp,
      });
    },
    [qualityTier, pushStateTransitionToFirestore]
  );

  // ============================================================================
  // PROGRESSIVE 4-STAGE 720p @ 30 FPS CAMERA ACQUISITION + ONMUTE YIELD
  // ============================================================================
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
          waitForSettleMs: 120,
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
          try {
            stream = await navigator.mediaDevices.getUserMedia({
              audio: false,
              video: true,
            });
          } catch {
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
        // Cleanly pause and release camera if WhatsApp or another phone app claims the camera
        videoTrack.onmute = () => {
          stopAllHardwareStreams('PAUSED', true);
        };
        videoTrack.onended = () => {
          stopAllHardwareStreams('PAUSED', true);
        };
        await peerRef.current?.attachMediaTrackToTransceiver(
          'camera',
          videoTrack,
          qualityTier
        );
      }

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
    ]
  );

  // ============================================================================
  // DYNAMIC 720p @ 30 FPS QUALITY CONTROLLER (Runs Every 3 Seconds)
  // ============================================================================
  useEffect(() => {
    if (streamState !== 'STREAMING_CAMERA' && streamState !== 'STREAMING_SCREEN') {
      return;
    }

    const interval = window.setInterval(async () => {
      const metrics = peerRef.current?.getNetworkMetrics() || {
        rttMs: livePingMs,
        packetLossPct: 0,
      };
      setLivePingMs(metrics.rttMs);

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
  }, [streamState, batteryLevel, isCharging, livePingMs, pushStateTransitionToFirestore]);

  const handleControlMessage = useCallback(
    async (msg: P2PControlMessage) => {
      switch (msg.type) {
        case 'CMD_START_STREAM':
          if (!markCommandExecuted(msg.commandId)) return;
          await handleStartStreamMode(msg.mode, msg.lensId, msg.facing);
          break;
        case 'CMD_WARM_PAUSE':
          if (!markCommandExecuted(msg.commandId)) return;
          await stopAllHardwareStreams('PAUSED', false);
          break;
        case 'CMD_STOP_STREAM':
          if (!markCommandExecuted(msg.commandId)) return;
          await stopAllHardwareStreams('IDLE', false);
          break;
        case 'CMD_SWITCH_LENS':
          if (!markCommandExecuted(msg.commandId)) return;
          setSelectedLensId(msg.lensId);
          if (msg.facing) setActiveFacing(msg.facing);
          await handleStartStreamMode('STREAMING_CAMERA', msg.lensId, msg.facing);
          break;
        case 'CMD_PING': {
          if (!markCommandExecuted(msg.commandId)) return;
          const rtt = Math.max(4, Date.now() - msg.sentAt);
          setLivePingMs(rtt);
          const pong: P2PControlMessage = {
            type: 'EVT_PONG',
            sentAt: msg.sentAt,
            agentState: buildDeviceSnapshot({ lastPingLatencyMs: rtt }),
          };
          peerRef.current?.sendControlMessage(pong);
          await pushStateTransitionToFirestore({ lastPingLatencyMs: rtt });
          break;
        }
        default:
          break;
      }
    },
    [
      markCommandExecuted,
      handleStartStreamMode,
      stopAllHardwareStreams,
      buildDeviceSnapshot,
      pushStateTransitionToFirestore,
    ]
  );

  const handleDirectFirestoreCommand = useCallback(
    async (cmd: RemoteNodeCommand) => {
      if (!cmd || !cmd.commandId) return;
      // Ignore stale commands older than 30 seconds
      if (Date.now() - cmd.issuedAt > 30000) return;
      if (!markCommandExecuted(cmd.commandId)) return;

      switch (cmd.action) {
        case 'START_CAMERA':
          await handleStartStreamMode('STREAMING_CAMERA', cmd.lensId, cmd.facing);
          break;
        case 'START_SCREEN':
          await handleStartStreamMode('STREAMING_SCREEN');
          break;
        case 'WARM_PAUSE':
          await stopAllHardwareStreams('PAUSED', false);
          break;
        case 'STOP_STREAM':
          await stopAllHardwareStreams('IDLE', false);
          break;
        case 'PING': {
          const rtt = Math.max(6, Date.now() - cmd.issuedAt);
          setLivePingMs(rtt);
          peerRef.current?.sendControlMessage({
            type: 'EVT_PONG',
            sentAt: cmd.issuedAt,
            agentState: buildDeviceSnapshot({ lastPingLatencyMs: rtt }),
          });
          await pushStateTransitionToFirestore({ lastPingLatencyMs: rtt });
          break;
        }
      }
    },
    [
      markCommandExecuted,
      handleStartStreamMode,
      stopAllHardwareStreams,
      buildDeviceSnapshot,
      pushStateTransitionToFirestore,
    ]
  );

  const handleControlMessageRef = useRef(handleControlMessage);
  handleControlMessageRef.current = handleControlMessage;

  const handleDirectCommandRef = useRef(handleDirectFirestoreCommand);
  handleDirectCommandRef.current = handleDirectFirestoreCommand;

  // ============================================================================
  // ZERO-CLICK AUTO-BOOT ON MOUNT (Immediate Registration + 15s Heartbeat + WebRTC)
  // ============================================================================
  useEffect(() => {
    enableBackgroundWakeLockAndKeepAlive();

    // 1. Immediately register node as online: true and enumerate camera lenses
    enumerateCameraLenses().then((lenses) => {
      setAvailableLenses(lenses);
      if (lenses.length > 0) {
        setSelectedLensId(lenses[0].deviceId);
      }
      upsertDeviceStateChange({
        ...buildDeviceSnapshot({
          online: true,
          heartbeatAt: Date.now(),
          availableLenses: lenses,
          streamState: 'IDLE',
        }),
      }).catch(() => {});
    });

    // 2. Start 15-second live Firestore heartbeat
    const heartbeatTimer = window.setInterval(() => {
      sendNodeHeartbeat(autoIdentity.deviceId, {
        customName: autoIdentity.autoAssignedName,
        hardwareModel: autoIdentity.hardwareModel,
        osVersion: autoIdentity.osVersion,
        batteryLevel,
        isCharging,
        networkType,
        streamState: streamStateRef.current,
        lastPingLatencyMs: livePingMs,
      }).catch(() => {});
    }, 15000);

    // 3. Attach instant Firestore onSnapshot command listener for this node
    const unsubNodeDoc = subscribeToSingleDeviceNode(autoIdentity.deviceId, (docData) => {
      if (docData.remoteCommand) {
        handleDirectCommandRef.current(docData.remoteCommand);
      }
    });

    // 4. Pre-warm WebRTCManager (10-candidate ICE pool + 'control-plane' DataChannel)
    const peer = new WebRTCManager({
      localId: autoIdentity.deviceId,
      remoteId: 'controller-main',
      polite: true,
      callbacks: {
        onControlMessage: (msg) => {
          handleControlMessageRef.current(msg);
        },
        onTelemetryUpdate: (snap) => {
          if (snap.pingMs > 0) {
            setLivePingMs(snap.pingMs);
          }
        },
      },
    });
    peerRef.current = peer;

    return () => {
      window.clearInterval(heartbeatTimer);
      unsubNodeDoc();
      peer.destroy();
      peerRef.current = null;
    };
  }, [autoIdentity.deviceId]);

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

  const isStreaming =
    streamState === 'STREAMING_CAMERA' || streamState === 'STREAMING_SCREEN';
  const tierSpec = ADAPTIVE_QUALITY_TIERS[qualityTier] || ADAPTIVE_QUALITY_TIERS.TIER_720P_30;

  return (
    <div className="min-h-screen w-full bg-[#090D16] text-slate-100 flex flex-col justify-between p-4 sm:p-6 select-none overflow-x-hidden">
      {/* Offscreen video capture elements (never display:none so mobile WebView hardware decodes frames) */}
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

      {/* Full-Screen #000000 OLED Power Saver Dimmer */}
      {oledDimmed && (
        <div
          onClick={() => setOledDimmed(false)}
          className="fixed inset-0 z-50 bg-[#000000] flex flex-col items-center justify-between p-6 cursor-pointer"
        >
          <div className="w-full flex items-center justify-between text-[11px] font-mono text-neutral-800">
            <span>OLED POWER SAVER • NODE ONLINE</span>
            <span>{batteryLevel}%</span>
          </div>
          <div className="text-xs font-mono text-neutral-800">
            Tap anywhere to restore Node HUD
          </div>
        </div>
      )}

      {/* Top Node Header */}
      <header className="w-full max-w-md mx-auto flex items-center justify-between border-b border-slate-800/80 pb-3.5">
        <div className="flex items-center gap-2">
          <Radio className="w-4 h-4 text-emerald-400" />
          <span className="text-sm font-bold tracking-tight text-white font-display">
            OpticLink Node
          </span>
        </div>
        <span className="text-[11px] font-mono text-emerald-400">
          AUTO-BOOT ACTIVE
        </span>
      </header>

      {/* Center IoT Hardware Node Telemetry Console */}
      <main className="w-full max-w-md mx-auto my-auto py-6 space-y-5">
        {/* Animated Emerald Connection Pulse Banner */}
        <div className="rounded-2xl border border-emerald-500/30 bg-emerald-950/20 p-5 space-y-3">
          <div className="flex items-center gap-3">
            <span className="relative flex h-3.5 w-3.5 shrink-0">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-3.5 w-3.5 bg-emerald-500" />
            </span>
            <span className="text-xs sm:text-sm font-mono font-bold tracking-wide text-emerald-400">
              {isStreaming
                ? `STREAMING LIVE — ${tierSpec.badgeLabel.replace('•', '@')}`
                : 'NODE ONLINE • LISTENING FOR CONTROLLER'}
            </span>
          </div>

          <p className="text-xs text-slate-400 leading-relaxed">
            {isStreaming
              ? `Transmitting ${
                  streamState === 'STREAMING_SCREEN'
                    ? 'Screen Share'
                    : activeFacing === 'front'
                    ? 'Front Camera'
                    : 'Back Camera'
                } over Pre-Warmed WebRTC (${tierSpec.maxBitrateKbps} kbps).`
              : whatsappYielded
              ? 'Camera yielded cleanly to external call/app. Listening for next Web Controller trigger.'
              : 'Zero-Hold Standby — Camera & Microphone 100% Free for Phone Calls & WhatsApp.'}
          </p>
        </div>

        {/* Device Identity Card */}
        <div className="rounded-2xl border border-slate-800 bg-[#0F1626] p-4 space-y-2">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span className="flex items-center gap-1.5">
              <Cpu className="w-3.5 h-3.5 text-blue-400" />
              <span>Auto-Assigned Node Identity</span>
            </span>
            <span className="font-mono text-[11px] text-slate-500">15s Heartbeat</span>
          </div>
          <div className="text-base sm:text-lg font-bold text-white break-words">
            {autoIdentity.autoAssignedName}
          </div>
          <div className="text-xs font-mono text-slate-400 break-all">
            ID: {autoIdentity.deviceId}
          </div>
        </div>

        {/* Live Telemetry Grid: Ping (ms), Battery %, Network */}
        <div className="grid grid-cols-3 gap-2.5">
          <div className="rounded-xl border border-slate-800 bg-[#0F1626] p-3.5 space-y-1">
            <div className="flex items-center gap-1 text-[11px] text-slate-400">
              <Activity className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              <span>Ping</span>
            </div>
            <div className="text-sm sm:text-base font-mono font-bold text-white tabular-nums">
              {livePingMs} ms
            </div>
          </div>

          <div className="rounded-xl border border-slate-800 bg-[#0F1626] p-3.5 space-y-1">
            <div className="flex items-center gap-1 text-[11px] text-slate-400">
              {isCharging ? (
                <BatteryCharging className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              ) : (
                <Battery className="w-3.5 h-3.5 text-amber-400 shrink-0" />
              )}
              <span>Battery</span>
            </div>
            <div className="text-sm sm:text-base font-mono font-bold text-white tabular-nums">
              {batteryLevel}%{isCharging ? ' ⚡' : ''}
            </div>
          </div>

          <div className="rounded-xl border border-slate-800 bg-[#0F1626] p-3.5 space-y-1">
            <div className="flex items-center gap-1 text-[11px] text-slate-400">
              <Wifi className="w-3.5 h-3.5 text-blue-400 shrink-0" />
              <span>Link</span>
            </div>
            <div className="text-sm sm:text-base font-mono font-bold text-white truncate">
              {networkType}
            </div>
          </div>
        </div>

        {/* Optional OLED Dimmer & Emergency Stop Stream (when active) */}
        <div className="space-y-2.5 pt-1">
          {isStreaming && (
            <button
              type="button"
              onClick={() => stopAllHardwareStreams('IDLE', false)}
              className="w-full min-h-[48px] rounded-xl bg-red-600 hover:bg-red-500 text-white font-bold text-xs sm:text-sm px-4 py-3 flex items-center justify-center gap-2 transition-colors cursor-pointer"
            >
              <Square className="w-4 h-4 shrink-0" />
              <span>Emergency Stop Stream</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => {
              enableBackgroundWakeLockAndKeepAlive();
              setOledDimmed(true);
            }}
            className="w-full min-h-[46px] rounded-xl border border-slate-800 bg-[#0F1626] hover:bg-slate-900 text-slate-300 font-semibold text-xs sm:text-sm px-4 py-2.5 flex items-center justify-center gap-2 transition-colors cursor-pointer"
          >
            <EyeOff className="w-4 h-4 text-slate-400 shrink-0" />
            <span>Dim Screen (OLED Power Saver)</span>
          </button>
        </div>
      </main>

      {/* Subtle Footer Role Switch Link */}
      <footer className="w-full max-w-md mx-auto pt-3 border-t border-slate-900 flex items-center justify-between text-[11px] text-slate-500">
        <span className="font-mono">720p @ 30 FPS Engine</span>
        {onSwitchToController && (
          <button
            type="button"
            onClick={onSwitchToController}
            className="text-slate-400 hover:text-white underline underline-offset-4 cursor-pointer"
          >
            Switch to Web Controller
          </button>
        )}
      </footer>
    </div>
  );
};
