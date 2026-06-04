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

Amplify.configure({
  Auth: {
    Cognito: {
      userPoolId: import.meta.env.VITE_COGNITO_USER_POOL_ID,
      userPoolClientId: import.meta.env.VITE_COGNITO_USER_POOL_CLIENT_ID,
      loginWith: {
        oauth: {
          domain: cognitoDomain(),
          scopes: ['openid', 'email', 'profile'],
          redirectSignIn: [redirectUrl()],
          redirectSignOut: [redirectUrl()],
          // Authorization Code grant (required for a public SPA, no client secret).
          responseType: 'code',
        },
      },
    },
  },
});
