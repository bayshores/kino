import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Both ports can be changed so several copies of kino can run side by side.
const appPort = Number(process.env.KINO_DEV_PORT || 4173);
const apiPort = Number(process.env.MOTION_API_PORT || 4781);

export default defineConfig({
  build: {
    outDir: "dist/client",
  },
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    host: "127.0.0.1",
    port: appPort,
    strictPort: true,
    proxy: {
      // A request the page drops (a stage frame it no longer wants) is dropped on to the server
      // too, which then stops drawing it. The proxy does that by itself only for a request with
      // a body still coming, never for a GET.
      "/api": {
        target: `http://127.0.0.1:${apiPort}`,
        configure: (proxy) => proxy.on("proxyReq", (proxyReq, req, res) => {
          res.on("close", () => { if (!res.writableEnded) proxyReq.destroy(); });
        }),
      },
      "/collaboration": { target: `ws://127.0.0.1:${apiPort}`, ws: true },
    },
    warmup: {
      clientFiles: ["./frontend/main.jsx"],
    },
    // Agent worktrees and private work folders are not part of the app. Watching them reloads
    // the page on every file an agent writes and can crash the watcher (ELOOP on symlink loops).
    watch: {
      ignored: ["**/.claude/**", "**/.local/**", "**/.scratch/**", "**/.playwright-mcp/**"],
    },
  },
  plugins: [react()],
});
