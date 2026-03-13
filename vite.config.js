import { defineConfig } from 'vite'
import { resolve } from 'path'

export default defineConfig({
    // FONDAMENTALE PER ELECTRON: impone a Vite di usare percorsi relativi (es. src="./assets/...") 
    // invece di assoluti, perché Electron carica i file dal disco e non da un web server.
    base: './',
    build: {
        rollupOptions: {
            input: {
                main: resolve(__dirname, 'index.html'),
                about: resolve(__dirname, 'about.html')
            }
        }
    }
})
