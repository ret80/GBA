import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  server: {
    // Preview hostnames differ per VM and are supplied per process through
    // __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS (read only when this is an array).
    // Keep the list empty: no blanket wildcard, localhost and IPs still work.
    allowedHosts: [],
  },
})
