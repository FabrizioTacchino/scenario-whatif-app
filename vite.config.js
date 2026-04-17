import { defineConfig } from 'vite'
import { resolve } from 'path'
import { readFileSync } from 'fs'

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));

export default defineConfig({
    define: {
        __APP_VERSION__: JSON.stringify(pkg.version),
    },
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
