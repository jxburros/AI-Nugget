import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// Flat config. Lints the library source and its test suite only — generated
// output (dist/, nugget/), examples, and Node build scripts are excluded. Rules
// are the non-type-checked recommended set (fast, no project service needed)
// plus a few that guard the nugget's invariants (no stray console/debugger in
// shipped code).
export default tseslint.config(
  { ignores: ['dist/**', 'nugget/**', 'examples/**', 'scripts/**', 'node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // A leading underscore marks a deliberately-unused binding (e.g. omitting a
      // field via destructuring).
      '@typescript-eslint/no-unused-vars': ['error', { varsIgnorePattern: '^_', argsIgnorePattern: '^_' }],
      // Allow `let` for a binding read by a closure defined before its assignment.
      'prefer-const': ['error', { ignoreReadBeforeAssign: true }],
    },
  },
  {
    files: ['src/**/*.ts'],
    rules: {
      'no-console': 'error',
      'no-debugger': 'error',
    },
  },
  {
    // Tests exercise malformed/edge inputs and mocks, so relax the strictest
    // any/assertion rules there without turning them off in library code.
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
