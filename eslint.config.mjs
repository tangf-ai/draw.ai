import js from '@eslint/js';
import globals from 'globals';

const sharedRules = {
	'no-unused-vars': ['error', {args: 'none', caughtErrors: 'none'}],
	'no-empty': ['error', {allowEmptyCatch: true}],
	// Rules below are noisy on the upstream-derived editor code and do not
	// indicate bugs, so they stay off for this repository.
	'no-useless-assignment': 'off',
	'no-useless-escape': 'off',
	'preserve-caught-error': 'off'
};

export default [
	{
		// preload.js is an upstream draw.io debugging stub, not draw.ai code.
		ignores: ['node_modules/**', 'dist/**', 'drawio/**', 'build/**', 'docs/**', 'preload.js']
	},
	js.configs.recommended,
	{
		files: ['src/main/**/*.js', 'src/test/**/*.js'],
		languageOptions: {
			ecmaVersion: 2023,
			sourceType: 'module',
			globals: {...globals.node}
		},
		rules: sharedRules
	},
	{
		files: ['src/main/electron-preload.js', 'src/workspace/**/*.js'],
		languageOptions: {
			ecmaVersion: 2023,
			sourceType: 'script',
			globals: {...globals.browser, ...globals.node}
		},
		rules: sharedRules
	},
	{
		files: ['*.cjs'],
		languageOptions: {
			ecmaVersion: 2023,
			sourceType: 'commonjs',
			globals: {...globals.node}
		},
		rules: sharedRules
	},
	{
		// The draw.io desktop main process is largely upstream code; report its
		// legacy issues as warnings instead of failing the build.
		files: ['src/main/electron.js'],
		rules: {
			'no-unused-vars': 'warn',
			'no-redeclare': 'off'
		}
	}
];
