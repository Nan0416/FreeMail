import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/build/**', '**/cdk.out/**', '**/coverage/**', '**/*.d.ts'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
  {
    files: ['packages/web/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },
  prettier,
  // Placed after eslint-config-prettier, which disables `curly`; re-enable it so
  // every control statement requires a block. `curly` is a style rule, not a
  // formatting one, so it does not conflict with Prettier.
  {
    rules: {
      curly: ['error', 'all'],
    },
  },
);
