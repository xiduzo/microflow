'use client';

import { useParams } from 'next/navigation';
import { useEffect } from 'react';

export function FigmaDeepLink() {
	const params = useParams<{ variableId: string; value: string }>();
	useEffect(() => {
		const { variableId, value } = params;

		window.open(`microflow-studio://figma?id=${variableId}&value=${value}`);
		window.close();
	}, [params]);

	return null;
}
