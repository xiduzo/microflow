import '@microflow/ui/global.css';
import { Analytics } from '@vercel/analytics/react';
import type { Metadata } from 'next';
import { PropsWithChildren } from 'react';
import './globals.css';

export const metadata: Metadata = {
	title: 'Microflow',
	description: 'Flow based microcontroller logic',
};

export default function RootLayout(props: PropsWithChildren) {
	return (
		<html lang="en" className="h-full scroll-smooth antialiased">
			<Analytics />
			<body className="dark flex h-full flex-col">{props.children}</body>
		</html>
	);
}
