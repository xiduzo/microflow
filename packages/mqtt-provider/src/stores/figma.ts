import { create } from 'zustand';
import { useMemo } from 'react';

export type FigmaVariable = {
	id: string;
	name: string;
	resolvedType: 'FLOAT' | 'STRING' | 'BOOLEAN' | 'COLOR';
};

type FigmaStore = {
	// State
	variableValues: Record<string, unknown>;
	variableTypes: Record<string, FigmaVariable>;

	// Actions
	updateVariableValue: (variableId: string, value: unknown) => void;
	updateVariableTypes: (types: Record<string, FigmaVariable>) => void;
};

export const useFigmaStore = create<FigmaStore>((set, get) => {
	const updateVariableValue = (variableId: string, value: unknown) => {
		const variableValues = get().variableValues;

		const current = JSON.stringify(variableValues[variableId]);
		console.log({ current, value });
		if (JSON.stringify(value) === current) return;

		set({
			variableValues: {
				...variableValues,
				[variableId]: value,
			},
		});
	};

	const updateVariableTypes = (variableTypes: Record<string, FigmaVariable>) => {
		const current = JSON.stringify(get().variableTypes);
		if (JSON.stringify(variableTypes) === current) return;

		set({ variableTypes });
	};

	return {
		// Initial state
		variableValues: {},
		variableTypes: {},

		// Actions
		updateVariableValue,
		updateVariableTypes,
	};
});

// Hook to get a specific variable
export const useFigmaVariable = (variableId?: string) => {
	const { variableTypes, variableValues } = useFigmaStore();

	const variable = useMemo(() => {
		if (!variableId) return;
		return variableTypes[variableId];
	}, [variableTypes, variableId]);

	const value = useMemo(() => {
		if (!variableId) return;
		return variableValues[variableId];
	}, [variableValues, variableId]);

	return {
		variable,
		value,
		variables: variableTypes,
	};
};
