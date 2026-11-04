import tseslint from 'typescript-eslint';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import importX from 'eslint-plugin-import-x';
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';
import reactHooks from 'eslint-plugin-react-hooks';
import nextPlugin from '@next/eslint-plugin-next';
import globals from 'globals';

const root = import.meta.dirname;

/** Test code may build fixtures with casts; the cast rule targets production code. */
const TEST_FILES = [
  '**/*.test.{ts,tsx}',
  '**/*.spec.{ts,tsx}',
  '**/__tests__/**',
  '**/testing.ts',
  '**/testing/**',
  '**/test-setup.ts',
  '**/test-utils.tsx',
  '**/e2e/**',
];

/** Turns every rule of a shared config into a warning, for the lint ratchet. */
function asWarnings(rules) {
  return Object.fromEntries(Object.keys(rules).map((name) => [name, 'warn']));
}

export default tseslint.config(
  // Global ignores
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/*.tsbuildinfo',
      '**/pnpm-lock.yaml',
      '**/coverage/**',
    ],
  },

  // Base TS rules for all packages
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.es2022,
      },
    },
    plugins: {
      'import-x': importX,
    },
    settings: {
      // Use import-x's modern resolver (interfaceVersion 3) instead of the
      // legacy default. Without this, import-x falls back to loading a legacy
      // 'node' resolver, whose loader throws "node with invalid interface" in
      // this toolchain and crashes `import-x/no-cycle`. The TypeScript resolver
      // handles workspace path aliases (@/*) and node_modules alike. Project
      // paths are absolute so turbo's per-package lint resolves them too.
      'import-x/resolver-next': [
        createTypeScriptImportResolver({
          alwaysTryTypes: true,
          noWarnOnMultipleProjects: true,
          project: [`${root}/apps/*/tsconfig.json`, `${root}/packages/*/tsconfig.json`],
        }),
      ],
      // import-x parses a dependency only when its extension and parser are
      // listed here. Without them `import-x/no-cycle` never sees a .ts import.
      'import-x/extensions': ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'],
      'import-x/parsers': { '@typescript-eslint/parser': ['.ts', '.tsx', '.mts', '.cts'] },
    },
    rules: {
      // Disallow unused vars except those prefixed with _
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Enforce consistent type imports
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      // No barrel re-exports of everything
      'import-x/no-cycle': 'error',
      // Lint ratchet: warn now, error once each block is clean.
      eqeqeq: ['warn', 'always', { null: 'ignore' }],
      '@typescript-eslint/consistent-type-assertions': ['warn', { assertionStyle: 'never' }],
    },
  },

  {
    files: TEST_FILES,
    rules: {
      '@typescript-eslint/consistent-type-assertions': 'off',
    },
  },

  // Extra a11y rules for the web app only
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: {
      'jsx-a11y': jsxA11y,
    },
    rules: {
      ...jsxA11y.configs.recommended.rules,
    },
  },

  // React hooks and Next.js rules for the web app
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
      '@next/next': nextPlugin,
    },
    settings: {
      next: { rootDir: `${root}/apps/web/` },
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      ...asWarnings(nextPlugin.flatConfig.coreWebVitals.rules),
    },
  },

  // Web imports go through the @/ alias, not long relative paths
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'warn',
        {
          patterns: [
            { group: ['../../*'], message: 'Import through the @/ alias instead of ../../.' },
          ],
        },
      ],
    },
  },

  // Looser rules for config / script files
  {
    files: ['**/*.config.{js,mjs,cjs}', '**/scripts/**/*.{js,mjs}'],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);
