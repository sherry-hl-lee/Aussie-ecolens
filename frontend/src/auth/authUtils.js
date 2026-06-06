export function isValidJwt(token) {
  return typeof token === 'string' && token.split('.').length === 3;
}

export function emailFromJwt(token) {
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload.email || payload['cognito:username'] || payload.sub || '';
  } catch {
    return '';
  }
}

export function userFromJwt(token) {
  return {
    email: emailFromJwt(token),
    token,
  };
}

/** Parse Cognito implicit-grant callback (#id_token=...) from the URL hash. */
export function absorbTokensFromHash(onToken) {
  const hash = window.location.hash || '';
  if (!hash.startsWith('#')) return { ok: false };

  const params = new URLSearchParams(hash.slice(1));
  const oauthError = params.get('error');
  if (oauthError) {
    window.history.replaceState({}, document.title, window.location.pathname);
    return {
      ok: false,
      error: params.get('error_description') || oauthError,
    };
  }

  const idToken = params.get('id_token') || params.get('access_token');
  if (!idToken) return { ok: false };

  onToken(idToken);
  window.history.replaceState({}, document.title, window.location.pathname);
  return { ok: true };
}

export function hasOAuthCallbackParams() {
  const params = new URLSearchParams(window.location.search);
  return params.has('code') || params.has('error');
}

export function clearOAuthParamsFromUrl() {
  if (!hasOAuthCallbackParams()) return;
  window.history.replaceState({}, document.title, window.location.pathname);
}

/** Wait for Amplify session after OAuth redirect (do not forceRefresh — avoids invalid_grant). */
export async function waitForAmplifySession(fetchSession, maxAttempts = 25) {
  for (let i = 0; i < maxAttempts; i += 1) {
    try {
      const session = await fetchSession();
      const idToken = session.tokens?.idToken?.toString();
      if (idToken) return idToken;
    } catch {
      /* Amplify may still be exchanging the code */
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return null;
}
