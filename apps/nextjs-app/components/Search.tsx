'use client';

import {
	type AutocompleteApi,
	type AutocompleteCollection,
	type AutocompleteState,
	createAutocomplete,
} from '@algolia/autocomplete-core';
import clsx from 'clsx';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
	forwardRef,
	Fragment,
	Suspense,
	useCallback,
	useEffect,
	useId,
	useRef,
	useState,
} from 'react';
import Highlighter from 'react-highlight-words';

import { navigation } from '@/lib/navigation';
import { type Result } from '@/markdoc/search.mjs';
import { Dialog, DialogContent, Icons } from '@microflow/ui';

type EmptyObject = Record<string, never>;

type Autocomplete = AutocompleteApi<
	Result,
	React.SyntheticEvent,
	React.MouseEvent,
	React.KeyboardEvent
>;

function SearchIcon(props: { className?: string }) {
	return <Icons.Search className={`"w-5 h-5 ${props.className}`} />;
}

function useAutocomplete({ close }: { close: (autocomplete: Autocomplete) => void }) {
	let id = useId();
	let router = useRouter();
	let [autocompleteState, setAutocompleteState] = useState<AutocompleteState<Result> | EmptyObject>(
		{},
	);

	function navigate({ itemUrl }: { itemUrl?: string }) {
		if (!itemUrl) {
			return;
		}

		router.push(itemUrl);

		if (itemUrl === window.location.pathname + window.location.search + window.location.hash) {
			close(autocomplete);
		}
	}

	let [autocomplete] = useState(() =>
		createAutocomplete<Result, React.SyntheticEvent, React.MouseEvent, React.KeyboardEvent>({
			id,
			placeholder: 'Find something...',
			defaultActiveItemId: 0,
			onStateChange({ state }) {
				setAutocompleteState(state);
			},
			shouldPanelOpen({ state }) {
				return state.query !== '';
			},
			navigator: {
				navigate,
			},
			getSources({ query }) {
				return import('@/markdoc/search.mjs').then(({ search }) => {
					return [
						{
							sourceId: 'documentation',
							getItems() {
								return search(query, { limit: 5 });
							},
							getItemUrl({ item }) {
								return item.url;
							},
							onSelect: navigate,
						},
					];
				});
			},
		}),
	);

	return { autocomplete, autocompleteState };
}

function LoadingIcon(props: React.ComponentPropsWithoutRef<'svg'>) {
	let id = useId();

	return (
		<svg viewBox="0 0 20 20" fill="none" aria-hidden="true" {...props}>
			<circle cx="10" cy="10" r="5.5" strokeLinejoin="round" />
			<path
				stroke={`url(#${id})`}
				strokeLinecap="round"
				strokeLinejoin="round"
				d="M15.5 10a5.5 5.5 0 1 0-5.5 5.5"
			/>
			<defs>
				<linearGradient id={id} x1="13" x2="9.5" y1="9" y2="15" gradientUnits="userSpaceOnUse">
					<stop stopColor="currentColor" />
					<stop offset="1" stopColor="currentColor" stopOpacity="0" />
				</linearGradient>
			</defs>
		</svg>
	);
}

function HighlightQuery({ text, query }: { text: string; query: string }) {
	return (
		// @ts-expect-error highlighter is not properly typed
		<Highlighter
			highlightClassName="group-aria-selected:underline bg-transparent text-sky-600 dark:text-sky-400"
			searchWords={[query]}
			autoEscape={true}
			textToHighlight={text}
		/>
	);
}

function SearchResult({
	result,
	autocomplete,
	collection,
	query,
}: {
	result: Result;
	autocomplete: Autocomplete;
	collection: AutocompleteCollection<Result>;
	query: string;
}) {
	let id = useId();

	let sectionTitle = navigation.find(section =>
		section.links.find(link => link.href === result.url.split('#')[0]),
	)?.title;
	let hierarchy = [sectionTitle, result.pageTitle].filter(
		(x): x is string => typeof x === 'string',
	);

	return (
		<li
			className="group block cursor-default rounded-lg px-3 py-2 aria-selected:bg-slate-100 dark:aria-selected:bg-slate-700/30"
			aria-labelledby={`${id}-hierarchy ${id}-title`}
			{...autocomplete.getItemProps({
				item: result,
				source: collection.source,
			})}
		>
			<div
				id={`${id}-title`}
				aria-hidden="true"
				className="text-sm text-slate-700 group-aria-selected:text-sky-600 dark:text-slate-300 dark:group-aria-selected:text-sky-400"
			>
				<HighlightQuery text={result.title} query={query} />
			</div>
			{hierarchy.length > 0 && (
				<div
					id={`${id}-hierarchy`}
					aria-hidden="true"
					className="mt-0.5 truncate whitespace-nowrap text-xs text-slate-500 dark:text-slate-400"
				>
					{hierarchy.map((item, itemIndex, items) => (
						<Fragment key={itemIndex}>
							<HighlightQuery text={item} query={query} />
							<span
								className={
									itemIndex === items.length - 1
										? 'sr-only'
										: 'mx-2 text-slate-300 dark:text-slate-700'
								}
							>
								/
							</span>
						</Fragment>
					))}
				</div>
			)}
		</li>
	);
}

function SearchResults({
	autocomplete,
	query,
	collection,
}: {
	autocomplete: Autocomplete;
	query: string;
	collection: AutocompleteCollection<Result>;
}) {
	if (collection.items.length === 0) {
		return (
			<p className="px-4 py-8 text-center text-sm text-slate-700 dark:text-slate-400">
				No results for &ldquo;
				<span className="break-words text-slate-900 dark:text-white">{query}</span>
				&rdquo;
			</p>
		);
	}

	return (
		<ul {...autocomplete.getListProps()}>
			{collection.items.map(result => (
				<SearchResult
					key={result.url}
					result={result}
					autocomplete={autocomplete}
					collection={collection}
					query={query}
				/>
			))}
		</ul>
	);
}

const SearchInput = forwardRef<
	React.ElementRef<'input'>,
	{
		autocomplete: Autocomplete;
		autocompleteState: AutocompleteState<Result> | EmptyObject;
		onClose: () => void;
	}
>(function SearchInput({ autocomplete, autocompleteState, onClose }, inputRef) {
	let inputProps = autocomplete.getInputProps({ inputElement: null });

	return (
		<div className="group relative flex h-12">
			<SearchIcon className="pointer-events-none absolute left-4 top-0 h-full w-5 text-slate-400 dark:text-slate-500" />
			<input
				ref={inputRef}
				data-autofocus
				className={clsx(
					'flex-auto appearance-none bg-transparent pl-12 text-slate-900 outline-none placeholder:text-slate-400 focus:w-full focus:flex-none sm:text-sm dark:text-white [&::-webkit-search-cancel-button]:hidden [&::-webkit-search-decoration]:hidden [&::-webkit-search-results-button]:hidden [&::-webkit-search-results-decoration]:hidden',
					autocompleteState.status === 'stalled' ? 'pr-11' : 'pr-4',
				)}
				{...inputProps}
				onKeyDown={event => {
					if (
						event.key === 'Escape' &&
						!autocompleteState.isOpen &&
						autocompleteState.query === ''
					) {
						// In Safari, closing the dialog with the escape key can sometimes cause the scroll position to jump to the
						// bottom of the page. This is a workaround for that until we can figure out a proper fix in Headless UI.
						if (document.activeElement instanceof HTMLElement) {
							document.activeElement.blur();
						}

						onClose();
					} else {
						inputProps.onKeyDown(event);
					}
				}}
			/>
			{autocompleteState.status === 'stalled' && (
				<div className="absolute inset-y-0 right-3 flex items-center">
					<LoadingIcon className="h-6 w-6 animate-spin stroke-slate-200 text-slate-400 dark:stroke-slate-700 dark:text-slate-500" />
				</div>
			)}
		</div>
	);
});

function CloseOnNavigation({
	close,
	autocomplete,
}: {
	close: (autocomplete: Autocomplete) => void;
	autocomplete: Autocomplete;
}) {
	let pathname = usePathname();
	let searchParams = useSearchParams();

	useEffect(() => {
		close(autocomplete);
	}, [pathname, searchParams, close, autocomplete]);

	return null;
}

function SearchDialog({ open, setOpen }: { open: boolean; setOpen: (open: boolean) => void }) {
	let formRef = useRef<React.ElementRef<'form'>>(null);
	let panelRef = useRef<React.ElementRef<'div'>>(null);
	let inputRef = useRef<React.ElementRef<typeof SearchInput>>(null);

	let close = useCallback(
		(autocomplete: Autocomplete) => {
			setOpen(false);
			autocomplete.setQuery('');
		},
		[setOpen],
	);

	let { autocomplete, autocompleteState } = useAutocomplete({
		close() {
			close(autocomplete);
		},
	});

	useEffect(() => {
		if (open) {
			return;
		}

		function onKeyDown(event: KeyboardEvent) {
			if (event.key === 'k' && (event.metaKey || event.ctrlKey)) {
				event.preventDefault();
				setOpen(true);
			}
		}

		window.addEventListener('keydown', onKeyDown);

		return () => {
			window.removeEventListener('keydown', onKeyDown);
		};
	}, [open, setOpen]);

	return (
		<>
			<Suspense fallback={null}>
				<CloseOnNavigation close={close} autocomplete={autocomplete} />
			</Suspense>
			<Dialog open={open} onOpenChange={() => close(autocomplete)}>
				<DialogContent className="p-0 overflow-hidden">
					<div {...autocomplete.getRootProps({})}>
						<form
							ref={formRef}
							{...autocomplete.getFormProps({
								inputElement: inputRef.current,
							})}
						>
							<SearchInput
								ref={inputRef}
								autocomplete={autocomplete}
								autocompleteState={autocompleteState}
								onClose={() => setOpen(false)}
							/>
							<div
								ref={panelRef}
								className="border-t px-2 py-3 empty:hidden"
								{...autocomplete.getPanelProps({})}
							>
								{autocompleteState.isOpen && (
									<SearchResults
										autocomplete={autocomplete}
										query={autocompleteState.query}
										collection={autocompleteState.collections[0]}
									/>
								)}
							</div>
						</form>
					</div>
				</DialogContent>
			</Dialog>
		</>
	);
}

function useSearchProps() {
	let buttonRef = useRef<React.ElementRef<'button'>>(null);
	let [open, setOpen] = useState(false);

	return {
		buttonProps: {
			ref: buttonRef,
			onClick() {
				setOpen(true);
			},
		},
		dialogProps: {
			open,
			setOpen: useCallback((open: boolean) => {
				let { width = 0, height = 0 } = buttonRef.current?.getBoundingClientRect() ?? {};
				if (!open || (width !== 0 && height !== 0)) {
					setOpen(open);
				}
			}, []),
		},
	};
}

export function Search() {
	let [modifierKey, setModifierKey] = useState<string>();
	let { buttonProps, dialogProps } = useSearchProps();

	useEffect(() => {
		setModifierKey(/(Mac|iPhone|iPod|iPad)/i.test(navigator.userAgent) ? '⌘' : 'Ctrl ');
	}, []);

	return (
		<>
			<button
				type="button"
				className="group flex h-6 w-6 items-center justify-center sm:justify-start md:h-auto md:w-80 md:flex-none md:rounded-lg md:py-2.5 md:pl-4 md:pr-3.5 md:text-sm md:ring-1 md:ring-slate-200 md:hover:ring-slate-300 lg:w-96 dark:md:bg-slate-800/75 dark:md:ring-inset dark:md:ring-white/5 dark:md:hover:bg-slate-700/40 dark:md:hover:ring-slate-500"
				{...buttonProps}
			>
				<SearchIcon className="h-5 w-5 flex-none text-slate-400 group-hover:text-slate-500 md:group-hover:text-slate-400 dark:text-slate-500" />
				<span className="sr-only md:not-sr-only md:ml-2 md:text-slate-500 md:dark:text-slate-400">
					Quick search...
				</span>
				{modifierKey && (
					<kbd className="ml-auto hidden font-medium text-slate-400 md:block dark:text-slate-500 space-x-1">
						<kbd className="font-sans">{modifierKey}</kbd>
						<kbd className="font-sans">K</kbd>
					</kbd>
				)}
			</button>
			<SearchDialog {...dialogProps} />
		</>
	);
}
