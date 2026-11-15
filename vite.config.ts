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
        globIgnores: ['**/assets/community-*.js', '**/assets/supabase-*.js', '**/assets/AdminPortal-*.js', '**/assets/AdminPanel-*.js'],
        runtimeCaching: [{
          urlPattern: /\/assets\/(?:community|supabase|AdminPortal|AdminPanel)-[^/]+\.js$/,
          handler: 'CacheFirst',
          options: { cacheName: 'lazy-route-chunks', expiration: { maxEntries: 12, maxAgeSeconds: 30 * 24 * 60 * 60 } }
        }]
      },
      manifest: {
        name: '日常有序',
        short_name: '日常有序',
        description: '把生活小事安排得更从容',
        theme_color: '#fff8ef',
        background_color: '#fff8ef',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: '/icons/app-icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }
        ]
      }
    })
  ]
});
