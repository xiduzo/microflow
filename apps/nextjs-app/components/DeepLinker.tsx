'use client';

import { useParams } from 'next/navigation';
import { useEffect } from 'react';

export function DeepLinker() {
	const params = useParams<{ variableId: string; value: string }>();
	useEffect(() => {
		const { variableId, value } = params;

		window.open(`microflow-studio://${variableId}/${value}`);
		window.close();
	}, [params]);

	return null;
}
