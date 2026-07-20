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
      // Immutable-by-default: every interface field must be `readonly`. Enforced
      // via core selectors (no type-aware linting / no extra dependency).
      // Element-level array immutability (`readonly readonly T[]`) is not
      // selector-expressible; it is applied by hand and covered by review.
      'no-restricted-syntax': [
        'error',
        {
          selector: 'TSInterfaceBody > TSPropertySignature[readonly!=true]',
          message: 'Interface properties must be readonly (immutable by default).',
        },
        {
          selector: 'TSInterfaceBody > TSIndexSignature[readonly!=true]',
          message: 'Interface index signatures must be readonly (immutable by default).',
        },
      ],
    },
  },
);
