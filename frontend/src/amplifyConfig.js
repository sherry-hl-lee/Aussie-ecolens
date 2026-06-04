import { Amplify } from 'aws-amplify';

// Hosted UI redirects back to the page the app is served from, so the same
// build works on localhost and on the deployed URL. The exact value(s) here
// must also be registered in Cognito (App integration > App client > Hosted UI):
//   Allowed callback URLs  and  Allowed sign-out URLs.
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
          // Authorization Code grant (required for a public SPA, no client secret).
          responseType: 'code',
        },
      },
    },
  },
});
