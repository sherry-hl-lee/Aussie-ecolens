import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Fixed port so the redirect URL stays stable and matches the
  // "http://localhost:3000/" you register in Cognito's Hosted UI settings.
  server: {
    port: 3000,
    strictPort: true,
  },
})
