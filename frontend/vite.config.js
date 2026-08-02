import { defineConfig } from "vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";

// https://vite.dev/config/
export default defineConfig({
    plugins: [react(), tailwindcss(), babel({ presets: [reactCompilerPreset()] })],
    server: {
        port: 8092,
        host: true,
        allowedHosts: ["localhost", "prombot.net", "shoujo.jio.is"],
        // Same-origin /api keeps CORS out of it entirely — which also means this
        // works unchanged from a phone on the LAN and from shoujo.jio.is, neither
        // of which an origin allowlist would have covered.
        proxy: { "/api": "http://localhost:8090" },
    },
});
