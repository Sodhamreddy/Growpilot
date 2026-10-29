import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/.next*/**', '**/*.d.ts', 'docs/**', '.sites-runtime/**', '.devlogs/**', '.image-store/**', 'services/**'] },
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true } } },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: { 'constructor-super': 'error', 'no-constant-condition': ['error', { checkLoops: false }], 'no-debugger': 'error', 'no-duplicate-case': 'error', 'no-unreachable': 'error' },
  },
);
