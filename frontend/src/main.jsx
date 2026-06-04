import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './amplifyConfig.js'
import './index.css'
import App from './App.jsx'

// Cognito may return to / instead of /prototype.html — forward OAuth params to callback URL.
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
