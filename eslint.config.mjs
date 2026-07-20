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
        // Object-literal type aliases (DTO shapes declared with `type X = { ... }`)
        // are held to the same bar. Scoped under TSTypeAliasDeclaration so it does
        // NOT flag inline object types in function params / locals / SDK options,
        // which are implementation detail, not interface fields.
        {
          selector: 'TSTypeAliasDeclaration TSTypeLiteral > TSPropertySignature[readonly!=true]',
          message: 'Type-alias object properties must be readonly (immutable by default).',
        },
        {
          selector: 'TSTypeAliasDeclaration TSTypeLiteral > TSIndexSignature[readonly!=true]',
          message: 'Type-alias object index signatures must be readonly (immutable by default).',
        },
        // packages/infra imports the AWS CDK: require its service modules via their deep
        // subpaths (`import { Table } from 'aws-cdk-lib/aws-dynamodb'`) rather than the
        // `aws-cdk-lib` namespace barrel (`import { aws_dynamodb as dynamodb } from
        // 'aws-cdk-lib'`), so the dependency surface is explicit. Core exports (Duration,
        // Stack, Fn, …) have no subpath and stay imported from 'aws-cdk-lib'.
        {
          selector:
            "ImportDeclaration[source.value='aws-cdk-lib'] > ImportSpecifier[imported.name=/^aws_|^custom_resources$/]",
          message:
            "Import CDK service modules from their deep subpath (e.g. `import { Table } from 'aws-cdk-lib/aws-dynamodb'`), not the `aws-cdk-lib` namespace barrel.",
        },
      ],
    },
  },
);
