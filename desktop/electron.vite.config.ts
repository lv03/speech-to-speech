import { defineConfig } from 'electron-vite'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const manifestPublicKeyPath = process.env.RUNTIME_MANIFEST_PUBLIC_KEY_FILE
const manifestPublicKey = manifestPublicKeyPath
  ? readFileSync(resolve(manifestPublicKeyPath), 'utf8')
  : ''
if (process.env.RUNTIME_MANIFEST_REQUIRE_SIGNATURE === '1' && !manifestPublicKey.trim()) {
  throw new Error('RUNTIME_MANIFEST_PUBLIC_KEY_FILE is required for a signed runtime build')
}

export default defineConfig({
  main: {
    define: {
      __RUNTIME_MANIFEST_PUBLIC_KEY_PEM__: JSON.stringify(manifestPublicKey),
    },
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          packageVerify: resolve(__dirname, 'src/main/package-verify.ts'),
        },
      },
    },
  },
  preload: {
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
        },
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          settings: resolve(__dirname, 'src/renderer/settings.html'),
        },
      },
    },
  },
})
