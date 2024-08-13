'use client';

import mermaid from 'mermaid';
import { Highlight } from 'prism-react-renderer';
import { Fragment, useEffect, useRef } from 'react';

export function Fence({
	children,
	language,
}: {
	children: string;
	language: string;
}) {
	const mermaidElement = useRef<HTMLPreElement>(null);

	useEffect(() => {
		if (!mermaidElement.current) return;

		mermaid.initialize({
			theme: 'dark',
		});
		mermaid.run({
			nodes: [mermaidElement.current],
		});
	}, []);

	if (language === 'mermaid') {
		return (
			<pre className="mermaid language-mermaid" ref={mermaidElement}>
				{children}
			</pre>
		);
	}

	return (
		<Highlight
			code={children.trimEnd()}
			language={language}
			theme={{ plain: {}, styles: [] }}
		>
			{({ className, style, tokens, getTokenProps }) => (
				<pre className={className} style={style}>
					<code>
						{tokens.map((line, lineIndex) => (
							<Fragment key={lineIndex}>
								{line
									.filter(token => !token.empty)
									.map((token, tokenIndex) => (
										<span key={tokenIndex} {...getTokenProps({ token })} />
									))}
								{'\n'}
							</Fragment>
						))}
					</code>
				</pre>
			)}
		</Highlight>
	);
}
