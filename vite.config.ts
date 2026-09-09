import { defineConfig } from 'vite'

export default defineConfig({
  // Relative base so the same build works both on the GitHub Pages subpath
  // (Safari auth) and inside an .ehpk plugin served from the package root.
  base: './',
})
