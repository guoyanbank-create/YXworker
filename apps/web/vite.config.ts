import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 本机后端默认 127.0.0.1:8787；可用 YXWORKER_API_TARGET 指向隔离的验证实例
// （例如前端自检时用临时数据目录启动的 8790 实例），不影响默认交付形态。
const apiTarget = process.env.YXWORKER_API_TARGET ?? 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true },
    },
  },
  build: { outDir: 'dist', chunkSizeWarningLimit: 2000 },
});
