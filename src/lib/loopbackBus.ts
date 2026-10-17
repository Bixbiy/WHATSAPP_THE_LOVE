import { P2PControlMessage } from '../types/opticlink';

type ControlListener = (fromId: string, toId: string, msg: P2PControlMessage) => void;
type StreamListener = (
  deviceId: string,
  kind: 'camera' | 'screen',
  stream: MediaStream | null
) => void;

const controlListeners = new Set<ControlListener>();
const streamListeners = new Set<StreamListener>();
const activeLocalStreams = new Map<string, { camera: MediaStream | null; screen: MediaStream | null }>();

const bc =
  typeof BroadcastChannel !== 'undefined'
    ? new BroadcastChannel('opticlink_p2p_bus')
    : null;

if (bc) {
  bc.onmessage = (ev) => {
    const data = ev.data;
    if (data && data.channelType === 'CONTROL') {
      controlListeners.forEach((fn) => fn(data.fromId, data.toId, data.msg));
    }
  };
}

export function emitLocalControlMessage(
  fromId: string,
  toId: string,
  msg: P2PControlMessage
) {
  controlListeners.forEach((fn) => fn(fromId, toId, msg));
  try {
    bc?.postMessage({ channelType: 'CONTROL', fromId, toId, msg });
  } catch {
    // Ignore broadcast errors
  }
}

export function onLocalControlMessage(listener: ControlListener): () => void {
  controlListeners.add(listener);
  return () => {
    controlListeners.delete(listener);
  };
}

export function publishLocalMediaStream(
  deviceId: string,
  kind: 'camera' | 'screen',
  stream: MediaStream | null
) {
  const existing = activeLocalStreams.get(deviceId) || { camera: null, screen: null };
  existing[kind] = stream;
  activeLocalStreams.set(deviceId, existing);
  streamListeners.forEach((fn) => fn(deviceId, kind, stream));
}

export function getLocalMediaStreams(deviceId: string): {
  camera: MediaStream | null;
  screen: MediaStream | null;
} {
  return activeLocalStreams.get(deviceId) || { camera: null, screen: null };
}

export function onLocalMediaStream(listener: StreamListener): () => void {
  streamListeners.add(listener);
  return () => {
    streamListeners.delete(listener);
  };
}
