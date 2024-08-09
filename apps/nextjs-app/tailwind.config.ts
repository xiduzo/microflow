import BaseConfig from '@fhb/ui/tailwind.config';
import type { Config } from 'tailwindcss';

const config: Config = {
	...BaseConfig,
	content: [
		'../../packages/ui/**/*.{ts,tsx}',
		'./pages/**/*.{js,ts,jsx,tsx,mdx}',
		'./components/**/*.{js,ts,jsx,tsx,mdx}',
		'./app/**/*.{js,ts,jsx,tsx,mdx}',
	],
};
export default config;
