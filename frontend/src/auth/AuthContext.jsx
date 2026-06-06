import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { fetchAuthSession, signOut as amplifySignOut } from 'aws-amplify/auth';
import { Hub } from 'aws-amplify/utils';
import { getAuthConfig } from '../api/client.js';
import {
  absorbTokensFromHash,
  clearOAuthParamsFromUrl,
  hasOAuthCallbackParams,
  isValidJwt,
  userFromJwt,
} from './authUtils.js';
import {
  postLoginRedirectTarget,
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

    // 1) Implicit flow: #id_token=... in URL hash
    const hashResult = absorbTokensFromHash((token) => applyUserFromToken(token));
    if (hashResult.error) {
      setError(hashResult.error);
      setUser(null);
      return false;
    }
    if (hashResult.ok) {
      return true;
    }

    // 2) Stale authorization-code callback (?code=...) — Cognito pool uses implicit grant.
    if (hasOAuthCallbackParams()) {
      clearOAuthParamsFromUrl();
    }

    // 3) Existing Amplify session
    try {
      const session = await fetchAuthSession();
      const idToken = session.tokens?.idToken?.toString();
      if (idToken) {
        applyUserFromToken(idToken);
        return true;
      }
    } catch {
      /* fall through */
    }

    // 4) Stored token from a previous login
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
      if (payload.event === 'signedIn' || payload.event === 'tokenRefresh') {
        syncSession().then(() => {
          if (!cancelled) setLoading(false);
        });
      }
      if (payload.event === 'signOut' || payload.event === 'signedOut') {
        localStorage.removeItem('token');
        sessionStorage.removeItem('ecolens_oauth_processing');
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
      // Implicit grant (#id_token in URL) — matches Cognito Hosted UI config (no oauth2/token call).
      startCognitoHostedUiSignIn({ postLoginPath: '/dashboard' });
    } catch (err) {
      setError(err.message || String(err));
    }
  }, []);

  const signOut = useCallback(async () => {
    setError(null);
    localStorage.removeItem('token');
    sessionStorage.removeItem('ecolens_post_login');
    setUser(null);
    try {
      await amplifySignOut();
    } catch {
      /* ok */
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
