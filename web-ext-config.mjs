export default {
  ignoreFiles: [
    "package.json",
    "package-lock.json",
    "web-ext-config.mjs",
    "test",
    "scripts",
    "chrome",
    "dist",
    // Chrome only: Firefox has menus.getTargetElement.
    "src/content/context-target.js",
    "node_modules",
    "README.md",
    "PRIVACY.md",
    "CONTRIBUTING.md",
    "docs",
    "test-results",
    "web-ext-artifacts",
  ],
};
