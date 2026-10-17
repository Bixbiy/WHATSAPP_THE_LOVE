import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocFromServer,
  getFirestore,
  onSnapshot,
  query,
  setDoc,
  where,
} from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';
import {
  DeviceAgentRecord,
  GlobalSecuritySettings,
  RemoteNodeCommand,
  SignalPacket,
} from '../types/opticlink';

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid ?? null,
      email: auth.currentUser?.email ?? null,
      emailVerified: auth.currentUser?.emailVerified ?? null,
      isAnonymous: auth.currentUser?.isAnonymous ?? null,
      tenantId: auth.currentUser?.tenantId ?? null,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}
testConnection();

export async function sha256Hex(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function generateSafeId(prefix = 'id'): string {
  const rand = Math.random().toString(36).substring(2, 10);
  return `${prefix}-${Date.now()}-${rand}`.replace(/[^a-zA-Z0-9_-]/g, '');
}

// ============================================================================
// ZERO-CLICK AUTOMATIC NODE REGISTRATION, 15s HEARTBEAT & COMMAND LISTENER
// ============================================================================

export async function upsertDeviceStateChange(
  device: DeviceAgentRecord
): Promise<void> {
  const sanitizedId = device.deviceUuid.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 120);
  const path = `devices/${sanitizedId}`;
  const now = Date.now();
  const payload: DeviceAgentRecord = {
    ...device,
    deviceUuid: sanitizedId,
    customName: (device.customName || 'OpticLink Node').slice(0, 80),
    locationTag: (device.locationTag || 'Auto-Discovered Node').slice(0, 80),
    hardwareModel: (device.hardwareModel || 'Android Node').slice(0, 120),
    osVersion: (device.osVersion || 'Android').slice(0, 80),
    networkType: (device.networkType || 'Wi-Fi').slice(0, 40),
    deviceSecretHash: (device.deviceSecretHash || 'auto-registered').slice(0, 128),
    online: device.online ?? true,
    heartbeatAt: now,
    lastStateChangeAt: now,
  };
  try {
    await setDoc(doc(db, 'devices', sanitizedId), payload, { merge: true });
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function sendNodeHeartbeat(
  deviceUuid: string,
  patch: Partial<DeviceAgentRecord>
): Promise<void> {
  const sanitizedId = deviceUuid.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 120);
  const path = `devices/${sanitizedId}`;
  const now = Date.now();
  try {
    await setDoc(
      doc(db, 'devices', sanitizedId),
      {
        ...patch,
        deviceUuid: sanitizedId,
        online: true,
        heartbeatAt: now,
        lastStateChangeAt: now,
      },
      { merge: true }
    );
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function dispatchDirectDeviceCommand(
  device: DeviceAgentRecord,
  command: RemoteNodeCommand
): Promise<void> {
  const sanitizedId = device.deviceUuid.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 120);
  const path = `devices/${sanitizedId}`;
  try {
    await setDoc(
      doc(db, 'devices', sanitizedId),
      {
        deviceUuid: sanitizedId,
        customName: (device.customName || 'OpticLink Node').slice(0, 80),
        streamState: device.streamState || 'IDLE',
        remoteCommand: command,
        lastStateChangeAt: Date.now(),
      },
      { merge: true }
    );
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export function subscribeToSingleDeviceNode(
  deviceUuid: string,
  onUpdate: (device: DeviceAgentRecord) => void
): () => void {
  const sanitizedId = deviceUuid.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 120);
  const path = `devices/${sanitizedId}`;
  return onSnapshot(
    doc(db, 'devices', sanitizedId),
    (snap) => {
      if (snap.exists()) {
        onUpdate(snap.data() as DeviceAgentRecord);
      }
    },
    (error) => {
      handleFirestoreError(error, OperationType.GET, path);
    }
  );
}

export function subscribeToDevices(
  onUpdate: (devices: DeviceAgentRecord[]) => void
): () => void {
  const path = 'devices';
  return onSnapshot(
    collection(db, path),
    (snapshot) => {
      const list: DeviceAgentRecord[] = [];
      snapshot.forEach((docSnap) => {
        list.push(docSnap.data() as DeviceAgentRecord);
      });
      list.sort((a, b) => (b.heartbeatAt || b.lastStateChangeAt) - (a.heartbeatAt || a.lastStateChangeAt));
      onUpdate(list);
    },
    (error) => {
      handleFirestoreError(error, OperationType.LIST, path);
    }
  );
}

export async function deletePairedDevice(deviceUuid: string): Promise<void> {
  const sanitizedId = deviceUuid.replace(/[^a-zA-Z0-9_-]/g, '');
  const path = `devices/${sanitizedId}`;
  try {
    await deleteDoc(doc(db, 'devices', sanitizedId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

// ============================================================================
// WEBRTC SIGNALING & PING (/signals/{signalId})
// ============================================================================

export async function sendSignalPacket(packet: Omit<SignalPacket, 'id'>): Promise<void> {
  const signalId = generateSafeId('sig');
  const path = `signals/${signalId}`;
  try {
    await setDoc(doc(db, 'signals', signalId), {
      fromId: packet.fromId.slice(0, 128),
      toId: packet.toId.slice(0, 128),
      type: packet.type,
      payload: packet.payload.slice(0, 65000),
      createdAt: packet.createdAt || Date.now(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export function subscribeToSignalsForTarget(
  targetId: string,
  onSignal: (packet: SignalPacket) => void
): () => void {
  const path = 'signals';
  const q = query(collection(db, path), where('toId', '==', targetId));
  return onSnapshot(
    q,
    (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === 'added') {
          const data = change.doc.data() as SignalPacket;
          onSignal({ ...data, id: change.doc.id });
        }
      });
    },
    (error) => {
      handleFirestoreError(error, OperationType.LIST, path);
    }
  );
}

export async function consumeSignalPacket(signalId: string): Promise<void> {
  if (!signalId) return;
  const path = `signals/${signalId}`;
  try {
    await deleteDoc(doc(db, 'signals', signalId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

// ============================================================================
// 4-DIGIT PIN SECURITY (/settings/global) — Default "0000", changeable in Settings
// ============================================================================

export async function ensureDefaultPinInitialized(): Promise<GlobalSecuritySettings> {
  const path = 'settings/global';
  try {
    const snap = await getDoc(doc(db, 'settings', 'global'));
    if (snap.exists()) {
      return snap.data() as GlobalSecuritySettings;
    }
    const salt = 'default-salt-0000';
    const pinHash = await sha256Hex(`${salt}:0000`);
    const initial: GlobalSecuritySettings = {
      pinHash,
      pinSalt: salt,
      failedAttempts: 0,
      lockoutUntil: 0,
      autoIdleCutoffMinutes: 10,
      updatedAt: Date.now(),
    };
    await setDoc(doc(db, 'settings', 'global'), initial);
    return initial;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function verifyControllerPin(pin: string): Promise<{
  unlocked: boolean;
  error?: string;
}> {
  const path = 'settings/global';
  try {
    const settings = await ensureDefaultPinInitialized();
    const candidateHash = await sha256Hex(`${settings.pinSalt}:${pin}`);
    if (candidateHash === settings.pinHash) {
      return { unlocked: true };
    }
    return { unlocked: false, error: 'Incorrect 4-digit PIN.' };
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path);
  }
}

export async function changeControllerPin(
  currentPin: string,
  newPin: string
): Promise<{ success: boolean; error?: string }> {
  const path = 'settings/global';
  try {
    const settings = await ensureDefaultPinInitialized();
    const currentHash = await sha256Hex(`${settings.pinSalt}:${currentPin}`);
    if (currentHash !== settings.pinHash) {
      return { success: false, error: 'Current 4-digit PIN is incorrect.' };
    }
    const newSalt = generateSafeId('salt');
    const newHash = await sha256Hex(`${newSalt}:${newPin}`);
    await setDoc(
      doc(db, 'settings', 'global'),
      {
        ...settings,
        pinHash: newHash,
        pinSalt: newSalt,
        failedAttempts: 0,
        lockoutUntil: 0,
        updatedAt: Date.now(),
      },
      { merge: true }
    );
    return { success: true };
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}
