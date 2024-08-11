import { Button } from '@fhb/ui';
import Link from 'next/link';
import { PropsWithChildren } from 'react';
import { Container } from './Container';
import { Logo } from './Logo';

export function Header(props: PropsWithChildren) {
	return (
		<header className="fixed top-4 w-full z-50 flex justify-center">
			<Container className="mx-4 max-w-screen-2xl w-full bg-neutral-900/25 rounded-xl backdrop-blur-sm py-2">
				<nav className="relative z-50 flex justify-between">
					<div className="flex grow items-center md:gap-x-12">
						<Link
							href="/"
							aria-label="Home"
							className="flex items-center font-extrabold"
						>
							<Logo className="h-10 w-auto mr-4" />
							Microflow
						</Link>
						{props.children}
					</div>
					<div className="flex items-center gap-x-5 md:gap-x-8">
						<Link href="/docs" aria-label="Documentation">
							<Button variant="link">Documentation</Button>
						</Link>
						<div className="-mr-1 md:hidden">{/* <MobileNavigation /> */}</div>
					</div>
				</nav>
			</Container>
		</header>
	);
}
