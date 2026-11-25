import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'
import { handleReader } from './api/reader.js'

export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'local-reader',
      apply: 'serve',
      configureServer(server) {
        const key = loadEnv(mode, process.cwd(), 'GEMINI_API_KEY').GEMINI_API_KEY || process.env.GEMINI_API_KEY
        server.middlewares.use('/api/reader', async (req, res) => {
          const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress || '')
          if (!loopback || !/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(req.headers.host || '')) {
            res.writeHead(403).end()
            return
          }
          const chunks: Buffer[] = []
          let bytes = 0
          for await (const chunk of req) {
            bytes += chunk.length
            if (bytes > 4400000) { res.writeHead(413).end(); return }
            chunks.push(Buffer.from(chunk))
          }
          let body = {}
          try { if (bytes) body = JSON.parse(Buffer.concat(chunks).toString()) }
          catch { res.writeHead(400).end(); return }
          const response = Object.assign(res, {
            status(code: number) { res.statusCode = code; return response },
            json(data: unknown) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(data)) },
          })
          await handleReader(Object.assign(req, { body }), response, key, undefined, true)
        })
      },
    },
  ],
}))
