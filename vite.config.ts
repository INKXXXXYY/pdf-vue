import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [vue()],
    server: {
      proxy: env.VITE_STIRLING_BASE_URL
        ? {
            '/stirling': {
              target: env.VITE_STIRLING_BASE_URL,
              changeOrigin: true,
              rewrite: (p) => p.replace(/^\/stirling/, ''),
            },
          }
        : undefined,
    },
  }
})
