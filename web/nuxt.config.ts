export default defineNuxtConfig({
  modules: ['@nuxt/ui', '@pinia/nuxt'],

  css: ['~/assets/global.css'],

  devtools: { enabled: false },

  app: {
    head: {
      meta: [
        { name: 'viewport', content: 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no' },
      ],
      script: [
        {
          innerHTML: `(function(){try{var t=localStorage.getItem('meowbox-theme');if(t==='light')document.documentElement.classList.add('theme-light')}catch(e){}})()`,
          type: 'text/javascript',
        },
      ],
    },
  },

  // Runtime config for API URL
  runtimeConfig: {
    public: {
      apiBase: process.env.API_URL || '/api',
    },
  },

  // Security headers
  routeRules: {
    '/**': {
      headers: {
        'X-Frame-Options': 'DENY',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
      },
    },
  },

  // Vite HMR through Nginx reverse proxy (только в dev; в prod Nuxt пересобран).
  // Порт берётся из env, чтоб совпадал с тем, что проксирует nginx.
  vite: {
    server: {
      hmr: {
        protocol: 'ws',
        host: '0.0.0.0',
        port: Number(process.env.PANEL_PORT || 11862),
        clientPort: Number(process.env.PANEL_PORT || 11862),
      },
    },
  },

  // Minimal build output
  nitro: {
    compressPublicAssets: true,
    minify: true,
  },

  typescript: {
    strict: true,
  },

  compatibilityDate: '2024-09-01',
});
