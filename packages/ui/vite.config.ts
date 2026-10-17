import babel from "@rolldown/plugin-babel";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    react(),
    babel({
      presets: [reactCompilerPreset()],
    }),
  ],
  oxc: {
    plugins: {
      styledComponents: { fileName: false },
    },
  },
  // The built UI is loaded from disk (file://), so its asset URLs must be relative.
  base: "./",
  build: {
    // Don't minify the output; it doesn't increase performance and makes
    // debugging harder.
    minify: false,
  },
  clearScreen: false,
});
