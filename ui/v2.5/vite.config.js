import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import legacy from "@vitejs/plugin-legacy";
import tsconfigPaths from "vite-tsconfig-paths";
import viteCompression from "vite-plugin-compression";

const nolegacy = process.env.VITE_APP_NOLEGACY === "true";
const sourcemap = process.env.VITE_APP_SOURCEMAPS === "true";
const isTauri = process.env.TAURI_ENV_PLATFORM !== undefined;

// https://vitejs.dev/config/
export default defineConfig(() => {
  let plugins = [
    react({
      babel: {
        compact: true,
      },
    }),
    tsconfigPaths(),
  ];

  // Tauri 模式下不使用 gzip 压缩（会删除原文件导致 Tauri 无法加载）
  if (!isTauri) {
    plugins.push(
      viteCompression({
        algorithm: "gzip",
        deleteOriginFile: true,
        threshold: 0,
        filter: /\.(js|json|css|svg|md)$/i,
      })
    );
  }

  // Tauri 模式下不需要 legacy 支持
  if (!nolegacy && !isTauri) {
    plugins = [...plugins, legacy()];
  }

  return {
    base: "",
    build: {
      outDir: "build",
      sourcemap: sourcemap,
      reportCompressedSize: false,
    },
    optimizeDeps: {
      entries: "src/index.tsx",
    },
    server: {
      port: 3000,
      cors: false,
      strictPort: true,
      open: true,
    },
    publicDir: "public",
    assetsInclude: ["**/*.md"],
    plugins,
  };
});
