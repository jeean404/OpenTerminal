import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 卡片层 React island：lib 模式单文件产出，供 app.js 动态 import("/static/ui/ui.js")。
// 产物落在 ../static/ui/，由 server.py 现有的 /static 挂载直接伺服（no-cache 头已覆盖）。
export default defineConfig({
  plugins: [react()],
  // lib 模式不会自动替换 React CJS shim 里的裸 process.env.NODE_ENV
  //（浏览器报 process is not defined），显式按生产环境替换
  define: {"process.env.NODE_ENV": JSON.stringify("production")},
  build: {
    outDir: "../static/ui",
    emptyOutDir: true,
    lib: {
      entry: "src/main.jsx",
      formats: ["es"],
      fileName: () => "ui.js",
      cssFileName: "ui",
    },
    cssCodeSplit: false,
    // md_lite.js 是仓库共享的 CJS 模块（module.exports 守卫 + index.html
    // 全局装载 + node --test），默认 commonjs 转换只认 node_modules，这里
    // 显式纳入以获得命名导出 interop
    commonjsOptions: { include: [/md_lite/, /node_modules/] },
  },
});
