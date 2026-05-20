import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  root: '.',
  base: mode === 'production' ? '/veeam-repos-simulator/' : '/',
  build: {
    outDir: 'dist',
  },
}));
