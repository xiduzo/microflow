import { createContext, PropsWithChildren, useContext, useEffect, useMemo, useState } from 'react';
import { useMqtt } from './MqttProvider';

export type FigmaVariable = {
	id: string;
	name: string;
	resolvedType: 'FLOAT' | 'STRING' | 'BOOLEAN' | 'COLOR';
};

const FigmaContext = createContext({
	variableValues: {} as Record<string, unknown>,
	variableTypes: {} as Record<string, FigmaVariable>,
});

export function FigmaProvider(props: PropsWithChildren) {
	const { status, subscribe, publish, appName, uniqueId, connectedClients } = useMqtt();
	const [variableValues, setVariableValues] = useState<Record<string, unknown>>({});
	const [variableTypes, setVariableTypes] = useState<Record<string, FigmaVariable>>({});

	useEffect(() => {
		if (status !== 'connected') return;

		function handleVariablesUpdate(_topic: string, message: Buffer) {
			setVariableTypes(prev => {
				const current = JSON.stringify(prev);
				if (message.toString() === current) return prev;

				return JSON.parse(message.toString()) as Record<string, FigmaVariable>;
			});
		}

		function handleVariableUpdate(topic: string, message: Buffer) {
			console.log('[VARIABLE]', message.toString());
			const [_prefix, _version, _id, _app, _topic, variableId] = topic.split('/');
			setVariableValues(prev => {
				const next = { ...prev };
				const prevValue = next[variableId];
				if (prevValue && JSON.stringify(prevValue) === message.toString()) return prev;
				next[variableId] = JSON.parse(message.toString());
				return next;
			});
		}

		const variablesSub = subscribe(
			`microflow/v1/${uniqueId}/plugin/variables`,
			handleVariablesUpdate,
		);

		const variableSub = subscribe(
			`microflow/v1/${uniqueId}/plugin/variable/+`,
			handleVariableUpdate,
		);

		const responseSub = subscribe(
			`microflow/v1/${uniqueId}/${appName}/variables/response`,
			handleVariablesUpdate,
		);

		return () => {
			variablesSub.then(unsubscribe => unsubscribe?.());
			variableSub.then(unsubscribe => unsubscribe?.());
			responseSub.then(unsubscribe => unsubscribe?.());
		};
	}, [status, appName, uniqueId]);

	const pluginConnected = useMemo(
		() => connectedClients.get('plugin') === 'connected',
		[connectedClients],
	);

	useEffect(() => {
		if (status !== 'connected') return;
		if (!pluginConnected) return;

		publish(`microflow/v1/${uniqueId}/${appName}/variables/request`, '');
	}, [status, uniqueId, appName, pluginConnected]);

	return (
		<FigmaContext.Provider value={{ variableValues, variableTypes }}>
			{props.children}
		</FigmaContext.Provider>
	);
}

export const useFigma = () => useContext(FigmaContext);

export function useFigmaVariable(variableId?: string) {
	const { variableTypes, variableValues } = useFigma();

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
}
