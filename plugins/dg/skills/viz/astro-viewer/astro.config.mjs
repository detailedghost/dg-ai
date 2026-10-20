import { defineConfig } from 'astro/config'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  output: 'server',
  devToolbar: { enabled: false },
  vite: {
    plugins: [tailwindcss()],
  },
  server: { port: 4321, host: '127.0.0.1' },
})
