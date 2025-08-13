import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [vue()],
    server: {
      host: true, // 0.0.0.0，允许局域网访问
      port: Number(env.VITE_PORT || 5173),
      strictPort: true,
      proxy: {
        ...(env.VITE_STIRLING_BASE_URL
          ? {
              '/stirling': {
                target: env.VITE_STIRLING_BASE_URL,
                changeOrigin: true,
                rewrite: (p) => p.replace(/^\/stirling/, ''),
              },
            }
          : {}),
        ...(env.VITE_API_BASE_URL
          ? {
              '/api': {
                target: env.VITE_API_BASE_URL,
                changeOrigin: true,
              },
            }
          : {}),
      },
    },
    preview: {
      host: true,
      port: Number(env.VITE_PREVIEW_PORT || 4173),
      strictPort: true,
    },
  }
})
