// @ts-check

import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

const config = [
  {
    ignores: ['src/**/*.mjs', 'src/**/*.d.*', 'src/**/*.js'],
  },
  ...tseslint.config(
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
  ),
];
export default config;
