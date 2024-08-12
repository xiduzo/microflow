import Config from '@microflow/ui/tailwind.config';

/** @type {import('tailwindcss').Config} */
module.exports = {
	...Config,
	content: [
		...Config.content,
		'index.html',
		'../../packages/ui/**/*.{ts,tsx}',
		'src/**/*.{ts,tsx}',
	],
};
