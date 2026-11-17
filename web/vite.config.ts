import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { execFileSync } from 'node:child_process'

const proxy = { '/api': { target: process.env.OMP_API_PROXY || 'http://127.0.0.1:8000', ws: true } }
const builtAt = new Date().toISOString()
const build = {
  commit: execFileSync('git', ['rev-parse', '--short=10', 'HEAD'], {encoding: 'utf8'}).trim(),
  built_at: builtAt,
  build_number: new Intl.DateTimeFormat('sv-SE', {timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'}).format(new Date(builtAt)).replace(/[- :]/g, '').replace(/^(\d{8})/, '$1.'),
}
export default defineConfig({
  plugins: [react(), {name: 'omp-build-info', generateBundle() {this.emitFile({type: 'asset', fileName: 'version.json', source: JSON.stringify(build)})}}],
  define: { __OMP_BUILD__: JSON.stringify(build) },
  build: { rollupOptions: { input: { main: 'index.html', scanner: 'scanner.html' } } },
  server: { proxy },
  preview: { proxy },
})
