import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function installScriptPlugin() {
  const installDir = path.join(__dirname, "public", "install");

  const serveInstallScript = (req, res, next) => {
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    if (!requestUrl.pathname.startsWith("/install/")) {
      next();
      return;
    }

    const scriptName = decodeURIComponent(requestUrl.pathname.slice("/install/".length));
    const filePath = path.resolve(installDir, scriptName);
    const relativePath = path.relative(installDir, filePath);
    if (!scriptName || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      res.statusCode = 403;
      res.end("Forbidden");
      return;
    }

    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      next();
      return;
    }

    res.setHeader("Cache-Control", "no-cache");
    res.setHeader(
      "Content-Type",
      filePath.endsWith(".ps1") ? "text/plain; charset=utf-8" : "text/x-shellscript; charset=utf-8"
    );
    fs.createReadStream(filePath).pipe(res);
  };

  return {
    name: "pocodex-install-scripts",
    configureServer(server) {
      server.middlewares.use(serveInstallScript);
    },
    configurePreviewServer(server) {
      server.middlewares.use(serveInstallScript);
    }
  };
}

export default defineConfig({
  plugins: [installScriptPlugin(), react()],
  server: {
    port: 5173,
    strictPort: false
  },
  preview: {
    port: 4173,
    strictPort: false
  }
});
