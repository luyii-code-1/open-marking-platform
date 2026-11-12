import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const proxy = { '/api': { target: process.env.OMP_API_PROXY || 'http://127.0.0.1:8000', ws: true } }
export default defineConfig({
  plugins: [react()],
  build: { rollupOptions: { input: { main: 'index.html', scanner: 'scanner.html' } } },
  server: { proxy },
  preview: { proxy },
})
