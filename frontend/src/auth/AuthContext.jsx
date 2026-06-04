import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { fetchAuthSession, signOut as amplifySignOut } from 'aws-amplify/auth';
import { Hub } from 'aws-amplify/utils';
import { getAuthConfig } from '../api/client.js';
import { isValidJwt, userFromJwt } from './authUtils.js';
import {
  completePostLoginRedirect,
  startCognitoHostedUiSignIn,
  startCognitoHostedUiSignOut,
} from './cognitoHostedUi.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const applyUserFromToken = useCallback((token) => {
    if (!isValidJwt(token)) {
      setUser(null);
      return false;
    }
    localStorage.setItem('token', token);
    setUser(userFromJwt(token));
    return true;
  }, []);

  const syncSession = useCallback(async () => {
    setError(null);
    try {
      const session = await fetchAuthSession();
      const idToken = session.tokens?.idToken?.toString();
      if (idToken) {
        applyUserFromToken(idToken);
        return true;
      }
    } catch {
      /* fall through to stored token */
    }

    const stored = localStorage.getItem('token');
    if (isValidJwt(stored)) {
      applyUserFromToken(stored);
      return true;
    }

    setUser(null);
    return false;
  }, [applyUserFromToken]);

  useEffect(() => {
    let cancelled = false;

    const boot = async () => {
      await syncSession();
      if (!cancelled) setLoading(false);
    };

    boot();

    const unsubscribe = Hub.listen('auth', ({ payload }) => {
      if (
        payload.event === 'signedIn' ||
        payload.event === 'tokenRefresh' ||
        payload.event === 'signInWithRedirect'
      ) {
        syncSession();
      }
      if (payload.event === 'signedOut') {
        localStorage.removeItem('token');
        setUser(null);
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [syncSession]);

  const signIn = useCallback(async () => {
    setError(null);
    try {
      // Same implicit Hosted UI flow as prototype.html (callback: prototype.html#id_token=...).
      startCognitoHostedUiSignIn({ postLoginPath: '/dashboard' });
    } catch (err) {
      setError(err.message || String(err));
    }
  }, []);

  const signOut = useCallback(async () => {
    setError(null);
    localStorage.removeItem('token');
    setUser(null);
    try {
      await amplifySignOut();
    } catch {
      /* implicit flow may have no Amplify session */
    }
    startCognitoHostedUiSignOut();
  }, []);

  const getToken = useCallback(async () => {
    try {
      const session = await fetchAuthSession();
      const idToken = session.tokens?.idToken?.toString();
      if (idToken) return idToken;
    } catch {
      /* use stored token */
    }

    const stored = localStorage.getItem('token');
    if (isValidJwt(stored)) return stored;

    try {
      const cfg = await getAuthConfig();
      if (!cfg.authRequired) return 'dev';
    } catch {
      /* backend unreachable */
    }

    return null;
  }, []);

  const value = useMemo(
    () => ({
      user,
      loading,
      error,
      isAuthenticated: Boolean(user),
      signIn,
      signOut,
      getToken,
      refresh: syncSession,
      setError,
    }),
    [user, loading, error, signIn, signOut, getToken, syncSession],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return ctx;
}
