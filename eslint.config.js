import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/release/**",
      "**/node_modules/**",
      "**/fixtures/**",
      "fixtures-large/**",
      "apps/desktop/build/**",
      "assets/**",
      "spikes/**",
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      // Unused arguments and caught errors are often deliberate (callbacks, "ignore this failure").
      // A leading underscore marks an argument as unused on purpose.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { args: "after-used", argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
    },
  },
  {
    // Node code: the companion, the geo-core library, build tools, tests and config files.
    files: ["**/*.{js,mjs,cjs,ts,tsx}"],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // The desktop UI runs in Electron's renderer.
    files: ["apps/desktop/src/ui/**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { "react-hooks": reactHooks },
    // The two classic hooks rules. The newer React Compiler rules in the plugin's
    // "recommended" set are left out because the app doesn't use the React Compiler.
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
    },
  },
  {
    // Scripts that run inside Affinity: CommonJS, loaded by Affinity's own runtime.
    files: ["packages/affinity-scripts/**/*.{js,cjs}"],
    languageOptions: {
      sourceType: "commonjs",
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      // CommonJS is the point here, and Affinity's script runtime loads modules with require().
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    // Test files run under Vitest with browser-like globals from jsdom.
    files: ["**/test/**/*.{ts,tsx,js,cjs}"],
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      // Test doubles and parsed JSON are loosely typed on purpose.
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
