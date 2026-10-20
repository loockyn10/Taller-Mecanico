import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: { '@shared': path.resolve(__dirname, 'shared'), '@': path.resolve(__dirname, 'src') },
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'Fierro · Gestión de talleres',
        short_name: 'Fierro',
        description: 'Órdenes de trabajo, presupuestos, agenda, stock y cobros para talleres mecánicos.',
        lang: 'es-AR',
        start_url: '/',
        display: 'standalone',
        background_color: '#f6f7f9',
        theme_color: '#1c3faa',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Solo se cachea la aplicación. Los datos (/api) siempre van a la red: nunca se guardan datos de un taller en caché.
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [],
      },
    }),
  ],
  server: {
    // Puertos configurables (FIERRO_WEB_PORT / FIERRO_API_PORT) para correr una segunda instancia sin pisar la de siempre.
    port: Number(process.env.FIERRO_WEB_PORT ?? 5173),
    proxy: { '/api': { target: `http://127.0.0.1:${process.env.FIERRO_API_PORT ?? 8787}`, changeOrigin: false } },
  },
});
