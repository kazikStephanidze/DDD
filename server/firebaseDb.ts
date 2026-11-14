import { FirebaseApp, getApps, initializeApp } from 'firebase/app';

export const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY || 'AIzaSyBSaKYUaY-UAqeTitZ3Kjpyu21Wee_iby0',
  authDomain: process.env.FIREBASE_AUTH_DOMAIN || 'dyadyadep-4ead0.firebaseapp.com',
  databaseURL:
    process.env.FIREBASE_DATABASE_URL ||
    'https://dyadyadep-4ead0-default-rtdb.europe-west1.firebasedatabase.app',
  projectId: process.env.FIREBASE_PROJECT_ID || 'dyadyadep-4ead0',
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET || 'dyadyadep-4ead0.firebasestorage.app',
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || '1037176210513',
  appId: process.env.FIREBASE_APP_ID || '1:1037176210513:web:f4c32303ae93a06517a470',
  measurementId: process.env.FIREBASE_MEASUREMENT_ID || 'G-8PM94CFB7H'
};

export function getFirebaseClientApp(): FirebaseApp {
  const existing = getApps();
  if (existing.length > 0) return existing[0];
  return initializeApp(firebaseConfig);
}

function getBaseDbUrl(): string {
  return (firebaseConfig.databaseURL || '').replace(/\/+$/, '');
}

function buildRtdbUrl(path: string): string {
  const cleanPath = path.replace(/^\/+/, '').replace(/\.json$/, '');
  const secret = (process.env.FIREBASE_DATABASE_SECRET || '').trim();
  const base = `${getBaseDbUrl()}/${cleanPath}.json`;
  return secret ? `${base}?auth=${encodeURIComponent(secret)}` : base;
}

export function isFirebaseConfigured(): boolean {
  return Boolean(getBaseDbUrl());
}

/**
 * Uses Firebase Realtime Database REST API so serverless functions (Vercel)
 * never keep persistent WebSocket handles open after HTTP response completion.
 */
export async function rtdbGet<T = unknown>(path: string): Promise<T | null> {
  if (!isFirebaseConfigured()) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(buildRtdbUrl(path), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`RTDB GET ${path} failed (${res.status}): ${txt.slice(0, 200)}`);
    }
    const data = (await res.json()) as T | null;
    return data;
  } finally {
    clearTimeout(timer);
  }
}

export async function rtdbPut(path: string, value: unknown): Promise<void> {
  if (!isFirebaseConfigured()) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    // Strip undefined values cleanly (Firebase RTDB rejects undefined)
    const serialized = JSON.stringify(value === undefined ? null : value);
    const res = await fetch(buildRtdbUrl(path), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: serialized,
      signal: controller.signal
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`RTDB PUT ${path} failed (${res.status}): ${txt.slice(0, 200)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

export async function rtdbPatch(path: string, patchObj: Record<string, unknown>): Promise<void> {
  if (!isFirebaseConfigured()) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const serialized = JSON.stringify(patchObj);
    const res = await fetch(buildRtdbUrl(path), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: serialized,
      signal: controller.signal
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`RTDB PATCH ${path} failed (${res.status}): ${txt.slice(0, 200)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}
