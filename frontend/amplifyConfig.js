// Load signInWithRedirect first so enableOAuthListener registers BEFORE configure().
// Otherwise the OAuth ?code= callback is never exchanged for tokens.
import { signInWithRedirect } from 'aws-amplify/auth';
void signInWithRedirect;

import { Amplify } from 'aws-amplify';

function redirectUrl() {
  const fromEnv = import.meta.env.VITE_COGNITO_REDIRECT_URI?.trim();
  if (fromEnv) return fromEnv;
  return `${window.location.origin}${window.location.pathname}`;
}

function cognitoDomain() {
  const raw = import.meta.env.VITE_COGNITO_DOMAIN || '';
  return raw.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

const poolId = import.meta.env.VITE_COGNITO_USER_POOL_ID;
const clientId = import.meta.env.VITE_COGNITO_USER_POOL_CLIENT_ID;
const domain = cognitoDomain();

if (!poolId || !clientId || !domain) {
  console.error(
    '[Amplify] Missing Cognito env vars. Check frontend/.env has VITE_COGNITO_USER_POOL_ID, VITE_COGNITO_USER_POOL_CLIENT_ID, VITE_COGNITO_DOMAIN',
  );
}

Amplify.configure({
  Auth: {
    Cognito: {
      userPoolId: poolId,
      userPoolClientId: clientId,
      loginWith: {
        oauth: {
          domain,
          scopes: ['openid', 'email', 'profile'],
          redirectSignIn: [redirectUrl()],
          redirectSignOut: [redirectUrl()],
          responseType: 'code',
        },
      },
    },
  },
});
