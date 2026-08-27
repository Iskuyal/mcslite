import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';

// base 用相对路径：面板既可能挂在 Nginx 根，也可能挂在 /panel/ 之类前缀下，
// 相对 base + 后端对 /panel/ 前缀的归一化，两者都能直接跑，不用重新构建。
export default defineConfig({
  base: './',
  plugins: [vue(), tailwindcss()],
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    target: 'es2020',
    cssCodeSplit: false,
    // 面板是内网工具，不拆 chunk 反而更省：一次缓存全部到位，避免运行时二次请求
    rollupOptions: { output: { manualChunks: undefined, inlineDynamicImports: false } },
    reportCompressedSize: false,
    chunkSizeWarningLimit: 400,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true },
      '/ws': { target: 'ws://127.0.0.1:8787', ws: true },
    },
  },
});
