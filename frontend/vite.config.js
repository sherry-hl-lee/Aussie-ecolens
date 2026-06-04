import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Fixed port so the redirect URL stays stable and matches Cognito Hosted UI.
  server: {
    port: 3000,
    strictPort: true,
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        prototype: resolve(__dirname, 'prototype.html'),
      },
    },
  },
})
