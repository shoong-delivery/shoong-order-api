import eslintConfigPrettier from "eslint-config-prettier";
import typescriptParser from "@typescript-eslint/parser";

export default [
  {
    ignores: ["src/generated/**"],
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: typescriptParser,
    },
    rules: {
      "no-unused-vars": "warn",
      "no-console": "warn",
    },
  },
  eslintConfigPrettier,
];
