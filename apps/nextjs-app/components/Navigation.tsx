'use client';

import clsx from 'clsx';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { navigation } from '@/lib/navigation';
import { Icons } from '@microflow/ui';

export function Navigation({
	className,
	onLinkClick,
}: {
	className?: string;
	onLinkClick?: React.MouseEventHandler<HTMLAnchorElement>;
}) {
	let pathname = usePathname();

	function getChildLinks(href: string) {
		return navigation.reduce(
			(acc, { links }) => acc + links.filter(({ parent }) => parent === href).length,
			0,
		);
	}

	function isActive(href: string) {
		return pathname === href || pathname.startsWith(href);
	}

	function getIdentation(link: { parent?: string; href: string }, identation = 14) {
		if (link.parent) identation += 14;

		const allLinks = navigation.reduce(
			(acc, curr) => acc.concat(curr.links),
			[] as { parent?: string; href: string }[],
		);
		const parentLink = allLinks.find(({ href }) => href === link.parent);
		if (parentLink) return getIdentation(parentLink, identation);

		return identation;
	}

	return (
		<nav className={clsx('text-base lg:text-sm', className)}>
			<ul role="list" className="space-y-9">
				{navigation.map(section => (
					<li key={section.title}>
						<h2 className="font-display font-medium text-slate-900 dark:text-white">
							{section.title}
						</h2>
						<ul
							role="list"
							className="mt-2 space-y-2 border-l-2 border-slate-100 lg:mt-4 lg:space-y-4 lg:border-slate-200 dark:border-slate-800"
						>
							{section.links
								.filter(({ parent }) => {
									if (!parent) return true;
									if (parent === pathname) return true;
									if (pathname.startsWith(parent)) return true;
									return false;
								})
								.map(link => (
									<li key={link.href} className="relative">
										<Link
											href={link.href}
											onClick={onLinkClick}
											className={clsx(
												'flex group justify-between items-center w-full pl-3.5 before:pointer-events-none before:absolute before:-left-1 before:top-1/2 before:h-1.5 before:w-1.5 before:-translate-y-1/2 before:rounded-full',
												link.href === pathname
													? 'font-semibold text-sky-500 before:bg-sky-500'
													: 'text-slate-500 before:hidden before:bg-slate-300 hover:text-slate-600 hover:before:block dark:text-slate-400 dark:before:bg-slate-700 dark:hover:text-slate-300',
												link.parent ? `text-xs` : '',
											)}
											style={{ paddingLeft: getIdentation(link) }}
										>
											{link.title}
											{getChildLinks(link.href) > 0 &&
												(isActive(link.href) ? (
													<Icons.ChevronDown className="text-muted-foreground w-4 h-4" />
												) : (
													<Icons.ChevronRight className="text-muted-foreground w-4 h-4 group-hover:rotate-90 transition-all" />
												))}
										</Link>
									</li>
								))}
						</ul>
					</li>
				))}
			</ul>
		</nav>
	);
}
