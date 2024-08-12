import BaseConfig from '@microflow/ui/tailwind.config';

/** @type {import('tailwindcss').Config} */
module.exports = {
	...BaseConfig,
	content: [
		'../../packages/ui/**/*.{ts,tsx}',
		'index.html',
		'src/**/*.{ts,tsx}',
	],
};
