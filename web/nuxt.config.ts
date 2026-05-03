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
          // Синхронно применяем тему (light/dark) И палитру (amber/violet) до парсинга
          // CSS — иначе на reload мигает дефолт. Палитра берётся из meowbox-palette-{serverId},
          // serverId — из meowbox-server (fallback 'main').
          // Список палитр должен совпадать с PALETTE_OPTIONS в usePalette.ts
          // и VALID_PALETTES в panel-settings.service.ts.
          innerHTML: `(function(){try{var d=document.documentElement;var t=localStorage.getItem('meowbox-theme');if(t==='light')d.classList.add('theme-light');var s=localStorage.getItem('meowbox-server')||'main';var p=localStorage.getItem('meowbox-palette-'+s);var v=['amber','violet','emerald','sapphire','rose','teal','fuchsia'];if(v.indexOf(p)<0)p='amber';d.classList.add('palette-'+p)}catch(e){}})()`,
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
