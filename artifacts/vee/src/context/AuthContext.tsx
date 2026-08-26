/**
 * Auth Context — provides authenticated user to the entire app.
 * Uses Firebase onAuthStateChanged with AsyncStorage persistence.
 *
 * BUG 12 fix: Add a 10-second timeout fallback so the loading state can
 * never stay true forever (e.g. if Firebase auth takes too long on a slow
 * network after a crash or profile update).
 * BUG 17 fix: Every async path now has a maximum wait time so the app
 * never becomes permanently stuck on the loading screen.
 */

import React, {
  createContext, useContext, useEffect, useRef, useState, useCallback,
} from 'react';
import { Alert } from 'react-native';
import { User } from 'firebase/auth';
import { onUserStateChanged, logout as firebaseLogout } from '../services/authService';
import {
  setupPresence, setUserOffline, getUser, subscribeUser, setUserVId,
  generateAndReserveVId,
} from '../services/userService';
import generateVId from '../utils/generateVId';

/** Maximum ms to wait for the first Firebase auth-state callback. */
const AUTH_LOADING_TIMEOUT_MS = 10_000;

/**
 * Ensure the given user has a permanent Vee ID. Accounts created before the
 * Vee ID system existed (or created through a flow that skipped reservation)
 * are backfilled here exactly once, since this runs on every auth-state
 * change. The ID is never re-generated or edited if one already exists.
 */
async function backfillVIdIfMissing(uid: string): Promise<void> {
  try {
    const existing = await getUser(uid);
    if (!existing || existing.vId) return; // already has a permanent vId — never touch it

    const vId = await generateAndReserveVId(uid, generateVId);
    await setUserVId(uid, vId);
  } catch {
    // non-critical — silently ignore
  }
}

type AuthContextValue = {
  user: User | null;
  loading: boolean;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue>({
  user: null,
  loading: true,
  logout: async () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const loadingDoneRef = useRef(false);

  useEffect(() => {
    // BUG 12/17 fix: Safety timeout — if Firebase never fires onAuthStateChanged
    // (offline start, corrupted token, etc.) force-unblock the loading screen
    // after AUTH_LOADING_TIMEOUT_MS so the app never stays permanently stuck.
    const timeoutId = setTimeout(() => {
      if (!loadingDoneRef.current) {
        loadingDoneRef.current = true;
        setLoading(false);
      }
    }, AUTH_LOADING_TIMEOUT_MS);

    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = onUserStateChanged((firebaseUser) => {
        setUser(firebaseUser);

        // Clear loading on the first callback (and any subsequent ones)
        if (!loadingDoneRef.current) {
          loadingDoneRef.current = true;
          clearTimeout(timeoutId);
        }
        setLoading(false);

        // Set up real-time presence when user logs in. These are deliberately
        // non-blocking: presence/profile repair must never gate navigation.
        if (firebaseUser) {
          try {
            setupPresence(firebaseUser.uid);
          } catch {
            // Presence is optional during startup; auth/navigation must continue.
          }
          backfillVIdIfMissing(firebaseUser.uid).catch(() => {});
        }
      });
    } catch {
      // A malformed/corrupt persisted auth state must fail closed and send the
      // user to login, not leave the provider rendering an endless spinner.
      loadingDoneRef.current = true;
      clearTimeout(timeoutId);
      setUser(null);
      setLoading(false);
    }

    return () => {
      clearTimeout(timeoutId);
      unsubscribe?.();
    };
  }, []);

  /**
   * Admin dashboard account-status listener.
   *
   * The dashboard writes users/{uid}/banned. Previously the app never read
   * that field, so a ban looked successful in RTDB but had no effect on a
   * signed-in device. Keep this listener at the auth root so it remains
   * active regardless of which screen is open.
   */
  const handledBanUidRef = useRef<string | null>(null);
  useEffect(() => {
    const uid = user?.uid;
    if (!uid) {
      handledBanUidRef.current = null;
      return;
    }

    return subscribeUser(uid, (profile) => {
      if (!profile?.banned) {
        if (handledBanUidRef.current === uid) {
          handledBanUidRef.current = null;
        }
        return;
      }

      // RTDB can replay the current value and emit multiple updates. Only
      // show one blocking notice for this ban event.
      if (handledBanUidRef.current === uid) return;
      handledBanUidRef.current = uid;

      const reason = profile.banReason?.trim();
      Alert.alert(
        'Account suspended',
        reason
          ? `Your Vee account has been suspended.\n\nReason: ${reason}`
          : 'Your Vee account has been suspended by an administrator.',
        [{
          text: 'OK',
          onPress: () => {
            firebaseLogout().catch(() => {});
          },
        }],
        { cancelable: false },
      );
    });
  }, [user?.uid]);

  const logout = useCallback(async () => {
    if (user) {
      // Mark offline before signing out
      await setUserOffline(user.uid).catch(() => {});
    }
    await firebaseLogout();
  }, [user]);

  return (
    <AuthContext.Provider value={{ user, loading, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

/** Access auth state anywhere in the app */
export function useAuth() {
  return useContext(AuthContext);
}
