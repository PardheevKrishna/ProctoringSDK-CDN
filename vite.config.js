import { defineConfig } from "vite";

export default defineConfig({
  build: {
    lib: {
      entry: "index.js",
      name: "proctorignSDK-CDN",
      fileName: (format) => `proctorignSDK-CDN.${format}.js`,
    },
    rollupOptions: {
      output: {
        globals: {
          "face-api.js": "faceapi",
        },
      },
    },
  },
});
