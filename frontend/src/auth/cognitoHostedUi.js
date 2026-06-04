/** Cognito Hosted UI — implicit grant (matches prototype.html callback). */

export function cognitoDomain() {
  return (import.meta.env.VITE_COGNITO_DOMAIN || '')
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '');
}

export function cognitoRedirectUri() {
  const fromEnv = import.meta.env.VITE_COGNITO_REDIRECT_URI?.trim();
  if (fromEnv) return fromEnv;
  return `${window.location.origin}${window.location.pathname}`;
}

/**
 * Redirect to Cognito login. Callback must be registered in the User Pool app client.
 * @param {{ postLoginPath?: string }} [options]
 */
export function startCognitoHostedUiSignIn(options = {}) {
  const domain = cognitoDomain();
  const clientId = import.meta.env.VITE_COGNITO_USER_POOL_CLIENT_ID;
  const redirectUri = cognitoRedirectUri();

  if (!domain || !clientId) {
    throw new Error('Missing Cognito settings in frontend/.env');
  }

  if (options.postLoginPath) {
    sessionStorage.setItem('ecolens_post_login', options.postLoginPath);
  }

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'token',
    scope: 'openid email profile',
    redirect_uri: redirectUri,
  });

  window.location.href = `https://${domain}/login?${params.toString()}`;
}

export function startCognitoHostedUiSignOut() {
  const domain = cognitoDomain();
  const clientId = import.meta.env.VITE_COGNITO_USER_POOL_CLIENT_ID;
  const redirectUri = cognitoRedirectUri();
  if (!domain || !clientId) return;

  const params = new URLSearchParams({
    client_id: clientId,
    logout_uri: redirectUri,
  });
  window.location.href = `https://${domain}/logout?${params.toString()}`;
}

export function postLoginRedirectTarget() {
  return sessionStorage.getItem('ecolens_post_login');
}

export function clearPostLoginRedirect() {
  sessionStorage.removeItem('ecolens_post_login');
}

export function completePostLoginRedirect() {
  const target = postLoginRedirectTarget();
  if (!target) return false;
  clearPostLoginRedirect();
  const url = target.startsWith('http')
    ? target
    : `${window.location.origin}${target.startsWith('/') ? target : `/${target}`}`;
  window.location.replace(url);
  return true;
}
