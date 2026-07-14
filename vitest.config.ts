import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Keep vitest's built-in excludes (node_modules, dist, .git, …) and also
    // skip the .tmp scratch dir (external clones used for ad-hoc debugging).
    exclude: [...configDefaults.exclude, "dist/**", ".tmp/**"],
  },
});
