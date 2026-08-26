/**
 * Wallet Service — Firebase Realtime Database (reads) + api-server (writes)
 *
 * Paths (read-only from the client):
 *   wallets/{uid}/balance          → number  (diamonds available to spend)
 *   wallets/{uid}/weeklyEarned     → number  (diamonds earned this week from gifts received)
 *   wallets/{uid}/weekStart        → number  (timestamp of current week start)
 *   wallets/{uid}/transactions/{id} → WalletTransaction
 *
 * SECURITY: balance/weeklyEarned/transactions can no longer be written
 * directly by the client — Firebase rules reject those writes outright.
 * All mutations go through the api-server (/wallet/init, /wallet/send-gift),
 * which verifies the caller's Firebase ID token and uses the Admin SDK to
 * make the change. This prevents a client from ever setting its own balance.
 */

import { ref, get, onValue, query, orderByKey, limitToLast } from 'firebase/database';
import { database, auth } from '@/src/config/firebase';
import { getApiBase } from '@/src/utils/platform';

async function authedFetch(path: string, body?: unknown): Promise<Response> {
  const user = auth.currentUser;
  if (!user) throw new Error('Not authenticated');
  const idToken = await user.getIdToken();
  return fetch(`${getApiBase()}/api${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${idToken}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

/* ─── Types ─────────────────────────────────────────────────────────────── */

export type WalletTransaction = {
  id: string;
  type: 'gift_sent' | 'gift_received';
  /** Negative for sent, positive for received */
  diamonds: number;
  emoji: string;
  giftName: string;
  counterpartUid: string;
  counterpartName: string;
  roomId: string | null;
  ts: number;
};

type SendGiftParams = {
  senderId: string;
  senderName: string;
  recipients: Array<{ uid: string; name: string }>;
  giftEmoji: string;
  giftName: string;
  /** Diamonds cost per recipient */
  diamondsEach: number;
  roomId?: string;
};

/* ─── Public API ─────────────────────────────────────────────────────────── */

/**
 * Initialize a wallet for a new user (500 free diamonds on first signup).
 * Idempotent — the server checks before writing. Must be called while the
 * caller is signed in as `uid` (the server derives uid from the ID token,
 * so this always inits the *caller's own* wallet).
 */
export async function initializeWallet(uid: string): Promise<void> {
  if (auth.currentUser?.uid !== uid) return;
  await authedFetch('/wallet/init');
  // Non-critical: wallet may already be initialized; ignore non-ok responses.
}

/** One-shot read of the current diamond balance. */
export async function getWalletBalance(uid: string): Promise<number> {
  const [walletSnap, adminSnap] = await Promise.all([
    get(ref(database, `wallets/${uid}/balance`)),
    get(ref(database, `users/${uid}/diamonds`)),
  ]);

  // The admin dashboard currently manages users/{uid}/diamonds. Prefer that
  // value whenever it exists, while retaining wallets/{uid}/balance for the
  // server-managed wallet and older accounts.
  const adminBalance = adminSnap.exists() ? adminSnap.val() : null;
  if (typeof adminBalance === 'number' && Number.isFinite(adminBalance) && adminBalance >= 0) {
    return adminBalance;
  }

  return walletSnap.exists() && typeof walletSnap.val() === 'number'
    ? (walletSnap.val() as number)
    : 0;
}

/**
 * Subscribe to real-time wallet balance.
 * Returns an unsubscribe function.
 * Automatically initialises the wallet to 500 diamonds on first subscription
 * if no wallet exists yet.
 */
export function subscribeWalletBalance(
  uid: string,
  callback: (balance: number) => void,
): () => void {
  const balRef = ref(database, `wallets/${uid}/balance`);
  const adminBalRef = ref(database, `users/${uid}/diamonds`);
  let walletBalance: number | null = null;
  let adminBalance: number | null = null;
  let walletLoaded = false;
  let adminLoaded = false;
  let initRequested = false;

  const emitBalance = () => {
    // Wait for both initial snapshots before choosing a source. Otherwise a
    // fast wallets snapshot could briefly show 500/current balance before the
    // admin-managed users/{uid}/diamonds value arrives.
    if (!walletLoaded || !adminLoaded) return;

    if (adminBalance !== null) {
      callback(adminBalance);
      return;
    }
    if (walletBalance !== null) {
      callback(walletBalance);
      return;
    }

    // No record exists in either path. Preserve the existing lazy-init
    // behavior, but never initialise over an admin balance.
    callback(500);
    if (!initRequested) {
      initRequested = true;
      initializeWallet(uid).catch(() => {});
    }
  };

  const unsubWallet = onValue(
    balRef,
    async (snap) => {
      walletLoaded = true;
      const value = snap.val();
      walletBalance = typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? value
        : null;
      emitBalance();
    },
    () => {
      walletLoaded = true;
      walletBalance = null;
      emitBalance();
    },
  );

  const unsubAdmin = onValue(
    adminBalRef,
    (snap) => {
      adminLoaded = true;
      const value = snap.val();
      adminBalance = typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? value
        : null;
      emitBalance();
    },
    () => {
      // A permission/network error on the optional compatibility path must
      // not hide the server-managed wallet balance.
      adminLoaded = true;
      adminBalance = null;
      emitBalance();
    },
  );

  return () => {
    unsubWallet();
    unsubAdmin();
  };
}

/**
 * Send a gift. The sender's balance is deducted and each recipient credited
 * entirely server-side (api-server /wallet/send-gift, using the Admin SDK) —
 * the client never writes balance/weeklyEarned directly.
 *
 * Returns { success: true } or { success: false, error: string }.
 */
export async function sendGift(
  params: SendGiftParams,
): Promise<{ success: boolean; error?: string }> {
  const totalCost = params.diamondsEach * params.recipients.length;
  if (totalCost <= 0) return { success: false, error: 'Invalid cost' };

  try {
    const res = await authedFetch('/wallet/send-gift', {
      recipients: params.recipients,
      giftEmoji: params.giftEmoji,
      giftName: params.giftName,
      diamondsEach: params.diamondsEach,
      roomId: params.roomId ?? null,
    });

    if (res.status === 400) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return { success: false, error: body.error ?? 'Insufficient diamonds' };
    }
    if (!res.ok) {
      return { success: false, error: 'Failed to send gift' };
    }

    return { success: true };
  } catch {
    return { success: false, error: 'Failed to send gift' };
  }
}

/**
 * Subscribe to the 50 most recent wallet transactions, sorted newest-first.
 *
 * RC8-B2: Uses limitToLast(50) query directly in Firebase instead of downloading
 * all transactions and slicing client-side. This reduces data transfer from
 * O(all_transactions) to O(50) regardless of transaction history length.
 */
export function subscribeTransactionHistory(
  uid: string,
  callback: (txs: WalletTransaction[]) => void,
): () => void {
  // orderByKey() returns transactions in push-key order (chronological).
  // limitToLast(50) fetches only the 50 most recent from Firebase itself.
  const txQuery = query(
    ref(database, `wallets/${uid}/transactions`),
    orderByKey(),
    limitToLast(50),
  );
  return onValue(
    txQuery,
    (snap) => {
      const txs: WalletTransaction[] = [];
      if (snap.exists()) {
        snap.forEach((child) => {
          txs.push({ id: child.key!, ...(child.val() as Omit<WalletTransaction, 'id'>) });
        });
        // Sort newest-first (push keys are chronological, so reverse)
        txs.sort((a, b) => b.ts - a.ts);
      }
      callback(txs);
    },
    () => callback([]),
  );
}
