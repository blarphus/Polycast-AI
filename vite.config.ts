import path from 'path';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    return {
      define: {
        'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY),
        'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY)
      },
      server: {
        allowedHosts: ['7e2c-89-187-182-174.ngrok-free.app'],
        proxy: {
          '/openai-proxy': {
            target: 'http://localhost:3001',
            ws: true,
            changeOrigin: true,
            rewrite: (path) => path.replace(/^\/openai-proxy/, ''),
            configure: (proxy, _options) => {
              proxy.on('error', (err, _req, _res) => {
                console.log('openai-proxy error', err);
              });
              proxy.on('proxyReqWs', (proxyReq, req, socket, options, head) => {
                console.log('Proxying WebSocket request for /openai-proxy to:', proxyReq.path);
              });
              proxy.on('proxyRes', (proxyRes, req, _res) => {
                console.log('Received response from /openai-proxy target:', proxyRes.statusCode, req.url);
              });
            }
          },
          '/signaling': {
            target: 'http://localhost:3002',
            ws: true,
            changeOrigin: true,
            rewrite: (path) => path.replace(/^\/signaling/, ''),
            configure: (proxy, _options) => {
              proxy.on('error', (err, _req, _res) => {
                console.log('❌ signaling-proxy error', err);
              });
              proxy.on('proxyReqWs', (proxyReq, req, socket, options, head) => {
                console.log('🔄 Proxying WebSocket for /signaling to:', proxyReq.path);
              });
              proxy.on('proxyRes', (proxyRes, req, _res) => {
                console.log('✅ /signaling proxy response:', proxyRes.statusCode, req.url);
              });
              proxy.on('proxyReq', (proxyReq, req, _res) => {
                console.log('🔄 Proxying HTTP for /signaling:', req.method, req.url, '->', proxyReq.path);
              });
            }
          }
        }
      },
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      }
    };
});
