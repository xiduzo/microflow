'use client';

import { useParams } from 'next/navigation';
import { useEffect } from 'react';

export function ShareDeepLink() {
	const params = useParams<{ link: string }>();
	useEffect(() => {
		const { link } = params;

		window.open(`microflow-studio://share?link=${link}`);
		window.close();
	}, [params]);

	return (
		<div>
			Use <code>{params.link}</code> to connect to a live share
		</div>
	);
}
