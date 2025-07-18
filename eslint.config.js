import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import globals from 'globals';

export default [
    {
        files: ['**/*.ts', '**/*.tsx'],
        languageOptions: {
            parser: tsparser,
            parserOptions: {
                ecmaVersion: 'latest',
                sourceType: 'module',
                project: './tsconfig.json',
            },
            globals: {
                ...globals.browser,
                ...globals.webextensions,
            },
        },
        plugins: {
            '@typescript-eslint': tseslint,
        },
        rules: {
            // Prevent any types
            '@typescript-eslint/no-explicit-any': 'error',

            // Other strict type checking rules
            '@typescript-eslint/prefer-as-const': 'error',

            // Disable conflicting rules
            'no-unused-vars': 'off',
            '@typescript-eslint/no-unused-vars': 'error',
        },
    },
];
