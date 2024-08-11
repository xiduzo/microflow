import BaseConfig from '@fhb/ui/tailwind.config';
import type { Config } from 'tailwindcss';
const typographyPlugin = require('@tailwindcss/typography');

const config: Config = {
	...BaseConfig,
	content: [
		'../../packages/ui/**/*.{ts,tsx}',
		'./pages/**/*.{js,ts,jsx,tsx,mdx}',
		'./components/**/*.{js,ts,jsx,tsx,mdx}',
		'./app/**/*.{js,ts,jsx,tsx,md,mdx}',
	],
	theme: {
		...BaseConfig.theme,
		fontSize: {
			...BaseConfig.theme?.fontSize,
			xs: ['0.75rem', { lineHeight: '1rem' }],
			sm: ['0.875rem', { lineHeight: '1.5rem' }],
			base: ['1rem', { lineHeight: '2rem' }],
			lg: ['1.125rem', { lineHeight: '1.75rem' }],
			xl: ['1.25rem', { lineHeight: '2rem' }],
			'2xl': ['1.5rem', { lineHeight: '2.5rem' }],
			'3xl': ['2rem', { lineHeight: '2.5rem' }],
			'4xl': ['2.5rem', { lineHeight: '3rem' }],
			'5xl': ['3rem', { lineHeight: '3.5rem' }],
			'6xl': ['3.75rem', { lineHeight: '1' }],
			'7xl': ['4.5rem', { lineHeight: '1' }],
			'8xl': ['6rem', { lineHeight: '1' }],
			'9xl': ['8rem', { lineHeight: '1' }],
		},
	},
	plugins: [...(BaseConfig.plugins ?? []), typographyPlugin],
};
export default config;
