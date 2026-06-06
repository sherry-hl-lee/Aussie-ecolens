export function isJwtExpired(token, skewSeconds = 60) {
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    if (!payload.exp) return false;
    return Date.now() / 1000 >= payload.exp - skewSeconds;
  } catch {
    return true;
  }
}

export function isValidJwt(token) {
  return (
    typeof token === 'string' &&
    token.split('.').length === 3 &&
    !isJwtExpired(token)
  );
}

export function claimsFromJwt(token) {
  try {
    return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return {};
  }
}

export function emailFromJwt(token) {
  const claims = claimsFromJwt(token);
  return claims.email || claims['cognito:username'] || claims.sub || '';
}

export function uploadedByFromClaims(claims) {
  const raw = claims.email || claims['cognito:username'] || claims.sub || '';
  return String(raw).trim().toLowerCase();
}

export function displayNameFromClaims(claims) {
  const given = String(claims.given_name || '').trim();
  const family = String(claims.family_name || '').trim();
  if (given) {
    return family ? `${given} ${family}` : given;
  }
  const name = String(claims.name || '').trim();
  if (name) return name;
  const email = emailFromJwtClaims(claims);
  if (email.includes('@')) return email.split('@')[0];
  return email || 'Explorer';
}

function emailFromJwtClaims(claims) {
  return claims.email || claims['cognito:username'] || claims.sub || '';
}

export function userFromJwt(token) {
  const claims = claimsFromJwt(token);
  const email = emailFromJwtClaims(claims);
  return {
    email,
    displayName: displayNameFromClaims(claims),
    uploadedBy: uploadedByFromClaims(claims),
    sub: claims.sub || '',
    token,
  };
}

export function isItemOwnedByUser(item, user) {
  if (!item?.uploadedBy || !user?.uploadedBy) return false;
  return String(item.uploadedBy).toLowerCase() === String(user.uploadedBy).toLowerCase();
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
