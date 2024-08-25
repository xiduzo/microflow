import Link from 'next/link';

import { Button } from '@microflow/ui';

export function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
	return (
		<Button asChild variant="ghost" className="hover:bg-yellow-500 hover:text-neutral-800">
			<Link href={href}>{children}</Link>
		</Button>
	);
}
