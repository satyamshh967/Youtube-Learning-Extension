import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

export default defineConfig({
  plugins: [
    react({
      include: /\.(jsx|tsx)$/,
    }),
  ],

  build: {
    rollupOptions: {
      input: {
        main: resolve(
          __dirname,
          "index.html",
        ),
        content: resolve(
          __dirname,
          "src/content.ts",
        ),
        background: resolve(
          __dirname,
          "src/background.ts",
        ),
      },

      output: {
        entryFileNames: (chunk) => {
          if (
            chunk.name ===
              "content" ||
            chunk.name ===
              "background"
          ) {
            return "[name].js";
          }

          return "assets/[name]-[hash].js";
        },

        chunkFileNames:
          "assets/[name]-[hash].js",

        assetFileNames:
          "assets/[name]-[hash][extname]",
      },
    },

    emptyOutDir: true,
  },
});