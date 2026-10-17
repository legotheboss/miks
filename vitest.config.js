import { defineConfig } from "vitest/config";

const exclude = ["node_modules/**", ".claude/worktrees/**"];

export default defineConfig({
  // Global Vitest configuration.
  test: {
    coverage: {
      reporter: ["html"],
      reportsDirectory: "./.coverage",
    },
    // Place snapshots right next to the test files (since VSCode Explorer
    // will group them together).
    resolveSnapshotPath: (testPath, snapExtension) => testPath + snapExtension,
    // Define per-project configuration.
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: ["packages/**/*.test.ts"],
          exclude,
        },
      },
    ],
  },
});
