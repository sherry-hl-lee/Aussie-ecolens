import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './amplifyConfig.js'
import './index.css'
import App from './App.jsx'
import { absorbTokensFromHash } from './auth/authUtils.js'

// Cognito implicit grant returns #id_token on the redirect URI. React Router would
// strip the hash if we navigate to /dashboard first — persist the token early.
absorbTokensFromHash((token) => {
  localStorage.setItem('token', token);
});

// Legacy: forward OAuth params from / to prototype.html when that is the registered callback.
const oauthRedirect = import.meta.env.VITE_COGNITO_REDIRECT_URI?.trim()
if (oauthRedirect && oauthRedirect.includes('prototype.html') && window.location.pathname === '/') {
  const search = window.location.search
  const hash = window.location.hash
  if (
    search.includes('code=') ||
    search.includes('error=') ||
    hash.includes('id_token=') ||
    hash.includes('access_token=')
  ) {
    window.location.replace(oauthRedirect + search + hash)
  }
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
