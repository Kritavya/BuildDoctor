import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // API_TARGET lets a second checkout run beside the default one (e.g. API_TARGET=http://localhost:4100)
      '/api': { target: process.env.API_TARGET ?? 'http://localhost:4000', changeOrigin: true },
    },
  },
})
