# OpticLink — Dual-Mode WebRTC Remote Camera, Screen Share & Telemetry PWA

OpticLink is a responsive, production-grade Progressive Web Application (PWA) that operates as both a **Web Controller Dashboard** and a **Device Agent** for ultra-low-latency (< 250ms) remote camera streaming, interactive screen sharing, and hardware telemetry monitoring with zero-polling Firestore quota protection.

## User Review & Critical Decisions

> [!IMPORTANT]
> The following architectural and UX choices incorporate your confirmed selections and establish the blueprint for implementation.

- **Confirmed Decision 1 — Visual Aesthetic & Theme**: **Clean Industrial Slate with Adaptive Light & Dark Theme Toggle**. High-contrast slate surfaces, crisp 1px structural hairlines, tabular monospace telemetry metrics (`JetBrains Mono`), and a persistent light/dark theme toggle.
- **Confirmed Decision 2 — Master Admin PIN Initialization**: **First-Launch Onboarding Prompt**. When launching the Web Controller Dashboard for the first time, an onboarding modal prompts the administrator to create and confirm their 4-digit Master Admin PIN (stored hashed/secured in `/settings/global`, never pre-filled, never displayed in plain text, and protected by a 5-attempt, 10-minute brute-force lockout).
- **Confirmed Decision 3 — Multi-Device + Local Loopback Simulator**: **Real Multi-Device Firestore WebRTC + Built-In Local Loopback Mode**. Full cross-device Firestore SDP/ICE signaling is paired with a 1-click Local Loopback Agent simulator so you can test pre-warmed data channels, camera/screen multiplexing, WebP fallback, laser pointer coordinates, and motion detection within a single browser tab or across separate devices.

---

## 1. Overview & Core Concept

- **What It Does**: Transforms any smartphone, tablet, or desktop browser into either a remotely managed **Device Agent** (streaming multi-lens camera video, screen share, and live hardware telemetry) or a **Web Controller Dashboard** (orchestrating streams, optical zoom, motion detection, 15-second RAM time-machine replays, and interactive laser guidance).
- **Target Audience / Persona**: Field engineers, remote hardware lab operators, and multi-device administrators who require instant, reliable visual inspection and screen guidance without draining battery or exhausting Firebase free-tier read/write quotas.
- **Key Value**: Eliminates WebRTC cold-start delays via a pre-warmed P2P `RTCDataChannel` and pre-allocated video transceivers (< 250ms stream start), prevents the Android multi-day hardware encoder blank-screen bug via automatic WebP canvas fallback, and strictly protects hardware privacy and battery by releasing camera/screen tracks (`replaceTrack(null)` + `track.stop()`) whenever idle.

---

## 2. User Experience & Visual Design

### Key User Flows

1. **First-Time Mode Selection & PIN Onboarding**:
   - On launch, the user chooses between **Web Controller Dashboard** or **Device Agent Mode** (persisted in `localStorage`, switchable at any time via the workspace bar).
   - Entering the Web Controller for the first time triggers the **Create 4-Digit Master Admin PIN** setup modal. Subsequent visits require entering the masked 4-digit PIN (`type="password"`, never pre-filled), with a 5-attempt 10-minute security lockout.
2. **6-Digit Device Pairing & Pre-Warmed P2P Tunnel**:
   - On the Web Controller, clicking **Generate Pairing Code** creates a 5-minute 6-digit code in Firestore (`/pairings/{code}`).
   - On the target phone/tablet in **Device Agent Mode** (or via the **Launch Loopback Agent** simulator), entering the 6-digit code registers `/devices/{deviceId}` with a permanent `deviceUuid` and shared `deviceSecret`.
   - Immediately upon Web Controller unlock, a lightweight P2P `RTCDataChannel` (`control-plane`) and two pre-allocated video transceivers (`cameraTransceiver`, `screenTransceiver`) connect in the background while keeping camera and screen hardware 100% OFF (`IDLE`).
3. **Sub-250ms Stream Activation & Multiplex Dual-View**:
   - From the Web Controller, the operator selects a lens (Front, Back, or specific hardware lens discovered via `enumerateDevices()`) and quality preset (`Ultra-Lite 360p 15fps`, `Balanced 720p 30fps`, `HD 1080p 60fps`), then clicks **Start Camera**, **Start Screen Share**, or **Multiplex Dual-View**.
   - The command travels over the open `RTCDataChannel` (~20ms), acquires the requested media stream, and attaches tracks via `sender.replaceTrack(track)` in under 250ms.
   - Operators can also trigger an **Instant 0.2s Quick Peek** (wakes camera for 200ms, captures and transmits one compressed WebP frame over the DataChannel, and immediately powers down the camera hardware) or **Warm Pause Stream** (releases hardware lens while keeping the P2P tunnel warm for 0.1s resume).
4. **Live Viewer Tools, Telemetry & OLED Power-Saver**:
   - While viewing, operators can adjust the **Remote Hardware Zoom** slider (`1.0x` to max capability), save the last 15 seconds via the **Time-Machine RAM Replay Buffer**, toggle the **Edge Smart Motion HUD** (real-time bounding-box detection + timestamped event thumbnail strip), or click/drag on the screen share feed to project a glowing **Interactive Laser Guide** onto the Device Agent screen.
   - On the Device Agent, toggling **Wake-Lock & OLED Dimmer** engages `navigator.wakeLock` and switches the phone screen to a pure black OLED power-saver overlay featuring a subtle status indicator and a prominent 1-tap **Stop / Pause Remote Access** button.

### Visual Identity & Theme

- **Aesthetic Direction**: **Clean Industrial Slate** — precision engineering instrumentation inspired by modern hardware telemetry consoles, featuring an adaptive Light and Dark theme toggle.
- **Color Palette & Mood**:
  - **60% Dominant Neutral Canvas**: Crisp Alabaster Slate (`#F8FAFC`) in Light Mode; Deep Carbon Slate (`#0B0F19`) in Dark Mode.
  - **30% Structural Surfaces**: Elevated Slate panels (`#FFFFFF` light / `#111827` dark) with 1px structural borders (`#E2E8F0` light / `#1E293B` dark) and muted technical metadata (`#64748B` / `#94A3B8`).
  - **10% Semantic Accent Budget**:
    - Primary Action Accent: Cobalt Industrial Blue (`#2563EB` light / `#3B82F6` dark).
    - Nominal / Active Stream: Signal Emerald (`#16A34A` / `#22C55E`) — always paired with explicit text labels (`RTP LIVE`, `IDLE`, `WEBP FALLBACK`).
    - Warning / Fallback Engine: Amber Alert (`#D97706` / `#F59E0B`).
    - Critical / Stop / Revoke: Crimson Safety (`#DC2626` / `#EF4444`).
- **Typography & Hierarchy**:
  - *Display & Navigation*: `Plus Jakarta Sans` (SemiBold 600 / Bold 700, tight tracking) for structural headers and control labels.
  - *Body & Controls*: `DM Sans` (Regular 400 / Medium 500) for clean legibility across desktop and 320px mobile screens.
  - *Telemetry & Tabular Data*: `JetBrains Mono` with `font-variant-numeric: tabular-nums` for latency (`ms`), bitrate (`kbps`), FPS counters, packet loss %, battery telemetry, and 6-digit pairing codes.
- **Component Styling & Layout**:
  - Follows the 3-zone Top Bar Contract: Brand wordmark on the left, single-line section navigation links in the center, and primary action + PWA Install prompt on the right.
  - Responsive layout containers (`w-full max-w-full overflow-x-hidden`) with adaptive grids (`grid-cols-1 sm:grid-cols-2 lg:grid-cols-4`) and minimum $44 \times 44\text{px}$ touch targets on mobile so 320px–767px viewports never scroll horizontally.
  - Unboxed metadata separated by typographic mid-dots (`·`) with single-level card elevation (1px hairline borders, no nested card sandwiches).

---

## 3. Key Product Decisions & Trade-Offs

- **Decision 1: Zero-Polling Firestore Presence + P2P Control Plane**
  - *Chosen Approach*: Firestore is used strictly for initial device registration (`/devices/{deviceId}`), 6-digit pairing (`/pairings/{code}`), global security settings (`/settings/global`), and WebRTC SDP/ICE handshakes (`/signals/{signalId}`). Zero 30-second periodic Firestore heartbeat timers are used; `/devices/{deviceId}` updates only on real state transitions or on-demand `PING` requests. Once connected, all live telemetry, lens switching, zoom, laser pointer coordinates, and quick-peek snapshots flow over the P2P `RTCDataChannel`.
  - *Why*: Protects the Firebase Spark/Enterprise free tier from read/write exhaustion while cutting command latency from ~600ms (database roundtrip) to < 20ms (direct P2P).
- **Decision 2: Pre-Allocated Dual Video Transceivers (`sendrecv` / `sendonly`)**
  - *Chosen Approach*: When the P2P control channel initializes on dashboard unlock, two video transceivers (`camera` and `screen`) are pre-allocated with `null` tracks. Starting a camera, screen share, or Multiplex Dual-View simply calls `transceiver.sender.replaceTrack(mediaTrack)` without renegotiating SDP from scratch.
  - *Why*: Achieves sub-250ms stream startup and instant switching between Front/Back lenses, Screen Share, and Side-by-Side/PiP Dual-View.
- **Decision 3: Dual-Engine Anti-Blank-Screen Pipeline (RTP + WebP DataChannel Fallback)**
  - *Chosen Approach*: A 2-second `pc.getStats()` watchdog monitors `framesEncoded`, `bytesSent`, `videoTrack.readyState === "live"`, `!videoTrack.muted`, and `videoEl.videoWidth > 0`. If encoded frames stall at 0 for 3 seconds, Engine A first attempts an in-place track rebirth (`replaceTrack` with VP9/VP8 codec preference). If RTP remains stalled, Engine B automatically activates: the Device Agent renders video to an offscreen `<canvas>`, encodes `image/webp` frames (quality `0.65` at 15 FPS), and streams chunked frames over the `RTCDataChannel` to the Dashboard's fallback canvas renderer.
  - *Why*: Guarantees zero blank screens even when mobile hardware H.264/VP8 encoders lock up after multi-day uptime.

---

## 4. Technical Architecture & Data Strategy

### Architecture & Component Diagram

```
┌───────────────────────────────────────────────────────────────────────────────────┐
│                   OPTICLINK DUAL-MODE PWA (VITE + REACT + TS)                     │
├─────────────────────────────────────────┬─────────────────────────────────────────┤
│         WEB CONTROLLER DASHBOARD        │            DEVICE AGENT MODE            │
│  ┌───────────────────────────────────┐  │  ┌───────────────────────────────────┐  │
│  │ Security Gate & Onboarding        │  │  │ 6-Digit Pairing & Identity Engine │  │
│  │ • First-Launch 4-Digit PIN Setup  │  │  │ • HW Model/OS Parser & Location   │  │
│  │ • Masked PIN Unlock + 5-Try Lock  │  │  │ • Battery/Network Event Listeners │  │
│  │ • Active Sessions & 60 Audit Logs │  │  │ • 24h Idle Standby Clean Reload   │  │
│  └─────────────────┬─────────────────┘  │  └─────────────────┬─────────────────┘  │
│                    ▼                    │                    ▼                    │
│  ┌───────────────────────────────────┐  │  ┌───────────────────────────────────┐  │
│  │ Multiplex Stream Viewport & HUD   │  │  │ Hardware Media & Anti-Blank Engine│  │
│  │ • Side-by-Side & Draggable PiP    │  │  │ • Multi-Lens enumerateDevices()   │  │
│  │ • Engine A (<video>) + B (<canvas>│  │  │ • Pre-Authorized Screen Capture   │  │
│  │ • 15s RAM Time-Machine Recorder   │  │  │ • Zero-Hold Teardown (250ms delay)│  │
│  │ • Smart Motion Bounding-Box HUD   │  │  │ • 2s getStats Watchdog -> WebP    │  │
│  │ • Laser Pointer & URL Push Sender │  │  │ • Laser Ring Overlay & OLED Dimmer│  │
│  └─────────────────┬─────────────────┘  │  └─────────────────┬─────────────────┘  │
└────────────────────┼────────────────────┴────────────────────┼────────────────────┘
                     │                                         │
                     ▼                                         ▼
┌───────────────────────────────────────────────────────────────────────────────────┐
│                PRE-WARMED MULTIPLEX WEBRTC ENGINE + LOCAL LOOPBACK                │
│  • Perfect Negotiation + Trickle ICE (iceCandidatePoolSize: 10, Multi-STUN)       │
│  • Persistent P2P RTCDataChannel ("control-plane") + 2 Pre-Allocated Transceivers │
│  • Auto ICE Restart on Wi-Fi <-> 4G Roaming (navigator.connection)                │
└─────────────────────────────────────────┬─────────────────────────────────────────┘
                                          │ (Signaling & State-Change Only)
                                          ▼
┌───────────────────────────────────────────────────────────────────────────────────┐
│                      FIREBASE CLOUD FIRESTORE (ZERO-POLLING)                      │
│  • /devices/{deviceId}   • /pairings/{code}   • /signals/{id}   • /settings/global│
└───────────────────────────────────────────────────────────────────────────────────┘
```

### Data Model & Firestore Collections

1. **`/devices/{deviceId}`**:
   - Stores `deviceUuid`, `customName`, `locationTag`, `hardwareModel`, `osVersion`, `batteryLevel`, `isCharging`, `networkType` (`Wi-Fi` / `4G` / `Ethernet`), `streamState` (`IDLE` | `STREAMING_CAMERA` | `STREAMING_SCREEN` | `STREAMING_DUAL` | `PAUSED`), `activeEngine` (`RTP` | `WEBP_FALLBACK`), `uptimeStartedAt`, `lastStateChangeAt`, and `deviceSecretHash`.
   - Updated strictly on state changes (launch, network transition, stream state change, or in response to an on-demand `PING` command).
2. **`/pairings/{code}`**:
   - Stores 6-digit pairing document (`code`, `createdAt`, `expiresAt`, `status`: `PENDING` | `CLAIMED`, `claimedByDeviceId`, `deviceSecret`). Valid for 5 minutes.
3. **`/signals/{signalId}`**:
   - Ephemeral WebRTC Perfect Negotiation signaling packets (`fromId`, `toId`, `type`: `OFFER` | `ANSWER` | `ICE` | `PING` | `PONG`, `payload`, `createdAt`). Cleaned up automatically after P2P channel establishment.
4. **`/settings/global`**:
   - Stores `pinHash`, `pinSalt`, `failedAttempts`, `lockoutUntil`, `autoIdleCutoffMinutes` (`10` | `30` | `0`), `activeSessions` (bounded list of logged-in controller sessions with browser/OS label, timestamp, and session token for instant revocation), and `securityLogs` (bounded 60-item ring buffer of security and stream audit events).
5. **Firestore Security Rules (`firestore.rules`)**:
   - Configured to support seamless `onSnapshot` listeners and document operations across `/devices`, `/signals`, `/pairings`, and `/settings` without throwing `Missing or insufficient permissions`.

### Interactive Component & State Mapping

- **Mode Selector & Top Bar**: Switches cleanly between `Web Controller Dashboard`, `Device Agent Mode`, and `Split Loopback Test Bench` while persisting mode in `localStorage`. Includes theme switcher (Light/Dark) and `PWAInstallButton` (`beforeinstallprompt` + iOS Safari install guide).
- **Stream Control Deck (Web Controller)**:
  - **Lens & Preset Selectors**: Populated dynamically from the Device Agent's `enumerateDevices()` list over `RTCDataChannel`; applies `360p@15`, `720p@30`, or `1080p@60` via `track.applyConstraints()` and `RTCRtpSender.setParameters()`.
  - **Lifecycle Buttons**: `Start Camera`, `Start Screen Share`, `Multiplex Dual-View`, `Instant 0.2s Quick Peek`, `Warm Pause`, and `Stop Stream` — each wired to immediate P2P DataChannel commands with visual latency feedback.
  - **Hardware Zoom & Auto-Idle Cutoff**: Range slider (`1.0x`–`8.0x`) applying hardware optical/digital zoom constraints (with canvas crop zoom fallback if hardware zoom capability is unsupported by the desktop webcam), plus configurable `10m / 30m / Never` auto-idle cutoff countdown.
- **Advanced Viewer Suite**:
  - **15s Time-Machine Replay & Capture**: Continuously maintains a rolling 15-second circular `MediaRecorder` chunk ring in browser RAM while streaming; clicking `Save Last 15s Replay` compiles and downloads the `.webm` clip alongside standard `Record Video` and `HD PNG Snapshot`.
  - **Edge Smart Motion HUD**: Computes frame-to-frame luminance delta on an offscreen analysis canvas at 10 Hz, drawing live bounding boxes around motion clusters and appending timestamped thumbnails to the collapsible Event Strip.
  - **Interactive Laser Guide & URL Push**: Pointer events on the Screen Share viewport transmit normalized `(x, y)` coordinates over the P2P DataChannel to render a smooth glowing ring overlay on the Device Agent; URL/Clipboard Push sends links or text snippets with a 1-tap open/copy toast on the Agent.
- **Device Agent Interface**:
  - Displays pairing status, custom device name/location editor, pre-authorize screen share button, live hardware telemetry, Wake-Lock (`navigator.wakeLock`) + full-screen OLED black dimmer overlay, and an always-accessible **Stop / Pause Remote Access** safety override.
