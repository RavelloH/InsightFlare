import config from "../eslint.config.js";

// Keep the full rule set except rules requiring a TypeScript Program.
export default [
  ...config,
  {
    files: ["**/*.{ts,tsx,mts}"],
    languageOptions: { parserOptions: { projectService: false } },
    rules: {
      "@typescript-eslint/consistent-type-exports": "off",
      "@typescript-eslint/await-thenable": "off",
      "@typescript-eslint/no-misused-promises": "off",
    },
  },
];
