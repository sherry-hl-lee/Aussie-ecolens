import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './amplifyConfig.js'
import './index.css'
import App from './App.jsx'

// Cognito sometimes returns to / instead of /prototype.html — forward OAuth params.
const oauthRedirect = import.meta.env.VITE_COGNITO_REDIRECT_URI?.trim()
if (
  oauthRedirect &&
  oauthRedirect.includes('prototype.html') &&
  window.location.pathname === '/' &&
  (window.location.search.includes('code=') ||
    window.location.search.includes('error='))
) {
  window.location.replace(oauthRedirect + window.location.search)
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
