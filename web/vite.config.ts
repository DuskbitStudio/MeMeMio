import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const shared = fileURLToPath(new URL('../shared', import.meta.url))
const src = fileURLToPath(new URL('./src', import.meta.url))

export default defineConfig({
  // Tailwind v4 走 vite 插件，没有 postcss.config.js、也没有 tailwind.config.js：
  // 主题整块在 src/index.css 的 @theme 里。见 web/agents/rules/styling.md
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // 词表主源在仓库根的 shared/，web 在**编译期**把它打进产物。
      // 不维护第二份标签列表 —— 见 web/agents/rules/project-structure.md
      '@shared': shared,
      // shadcn/ui 的 `@/*` 别名（components.json）
      '@': src,
    },
  },
  server: {
    port: 5173,
    fs: {
      // shared/ 在项目根之外，dev server 要显式放行
      allow: ['..'],
    },
    proxy: {
      // 本地前后端不同域（5173 vs 3000），靠这条把 /api 转过去，
      // 这样 cookie 仍然是同域的 —— 生产是真同域，不需要任何 CORS 配置。
      // 见 docs/environments.md §3、SPEC §0.1
      //
      // MEMEMIO_API_PROXY 只用于临时指向替身服务（列 in_progress 的接口联调），
      // 默认值就是 api 的 dev 端口，正常开发不用设。
      '/api': {
        target: process.env.MEMEMIO_API_PROXY ?? 'http://localhost:3000',
        changeOrigin: false,
      },
      '/auth': {
        target: process.env.MEMEMIO_API_PROXY ?? 'http://localhost:3000',
        changeOrigin: false,
      },
      // OAuth 2.1 授权服务器（SPEC §10.10）。生产上这些路径由 api 在同一 origin 提供，
      // 本地不代理的话整条授权流程（发现 → 注册 → 授权 → 换令牌）只能在生产上试。
      //
      // 三份发现文档：客户端在 401 之后按 `resource_metadata` 自己去取，缺一份就有一部分
      // 客户端发现失败（§10.10.7）。
      '/.well-known': {
        target: process.env.MEMEMIO_API_PROXY ?? 'http://localhost:3000',
        changeOrigin: false,
      },
      // ⚠️ **不能写成一条 `/oauth` 前缀**：SPA 自己的同意页就是 `/oauth/consent`
      // （§10.10.3 里 302 的目标），前缀代理会把它也转给 api，本地打开同意页直接
      // 落到 api 的 404，而且报错离根因很远。这里只列协议端点，逐个写死。
      // 同意页背后的管理端点（`/api/v1/oauth/*`）由上面那条 `/api` 覆盖。
      '/oauth/authorize': {
        target: process.env.MEMEMIO_API_PROXY ?? 'http://localhost:3000',
        changeOrigin: false,
      },
      '/oauth/token': {
        target: process.env.MEMEMIO_API_PROXY ?? 'http://localhost:3000',
        changeOrigin: false,
      },
      '/oauth/register': {
        target: process.env.MEMEMIO_API_PROXY ?? 'http://localhost:3000',
        changeOrigin: false,
      },
      '/oauth/revoke': {
        target: process.env.MEMEMIO_API_PROXY ?? 'http://localhost:3000',
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
})
