import { Amplify } from 'aws-amplify';

// Match the current page (e.g. /prototype.html or /) for Cognito callback/sign-out URLs.
const redirectUrl = `${window.location.origin}${window.location.pathname}`;

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
          redirectSignIn: [redirectUrl],
          redirectSignOut: [redirectUrl],
          responseType: 'code',
        },
      },
    },
  },
});
