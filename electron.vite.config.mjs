import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.js'),
          analysisWorker: resolve('src/main/analysisWorker.js')
        }
      }
    }
  },
  preload: {},
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react()],
    // Multi-page renderer: main window + ROM list window.
    build: {
      rollupOptions: {
        input: {
          main: resolve('src/renderer/index.html'),
          romlist: resolve('src/renderer/romlist.html'),
          labels: resolve('src/renderer/labels.html'),
          tracestreamer: resolve('src/renderer/tracestreamer.html')
        }
      }
    }
  }
})
