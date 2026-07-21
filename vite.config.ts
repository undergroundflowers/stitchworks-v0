import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: process.env.GITHUB_PAGES_BASE ?? '/',
  server: {
    // Honor a harness-assigned port (Vite ignores PORT by default); fall back
    // to Vite's default when unset.
    port: process.env.PORT ? Number(process.env.PORT) : undefined,
    // Allow any tunnel/proxy host to reach the dev server (dev only — Vite
    // otherwise blocks unrecognized Host headers per CVE-2025-30208).
    allowedHosts: true,
  },
})
