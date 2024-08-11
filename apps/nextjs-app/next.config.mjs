import withMarkdoc from '@markdoc/next.js';

import withSearch from './markdoc/search.mjs';

/** @type {import('next').NextConfig} */
const nextConfig = {
	pageExtensions: ['js', 'jsx', 'md', 'ts', 'tsx'],
};

export default withSearch(withMarkdoc({ schemaPath: './markdoc' })(nextConfig));
