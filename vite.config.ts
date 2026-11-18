import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/app-icon.svg'],
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,webp,woff2}'],
        globIgnores: ['**/assets/account-*.js', '**/assets/supabase-*.js', '**/assets/AdminPortal-*.js', '**/assets/AdminPanel-*.js'],
        runtimeCaching: [{
          urlPattern: /\/assets\/(?:account|supabase|AdminPortal|AdminPanel)-[^/]+\.js$/,
          handler: 'CacheFirst',
          options: { cacheName: 'lazy-route-chunks', expiration: { maxEntries: 12, maxAgeSeconds: 30 * 24 * 60 * 60 } }
        }]
      },
      manifest: {
        name: 'Renewly',
        short_name: 'Renewly',
        description: 'Cloud-synced subscription manager & renewal alerts',
        theme_color: '#5B5BF0',
        background_color: '#F7F7FB',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: '/icons/app-icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }
        ]
      }
    })
  ]
});
