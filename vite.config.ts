import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API_PORT = Number(process.env.BACK_THEN_PORT ?? 4747);

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: '../web-dist', emptyOutDir: true },
  server: {
    port: 5273,
    strictPort: true,
    proxy: { '/api': `http://127.0.0.1:${API_PORT}` },
  },
});
