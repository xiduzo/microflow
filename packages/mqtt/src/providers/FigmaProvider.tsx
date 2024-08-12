import {
	createContext,
	PropsWithChildren,
	useContext,
	useEffect,
	useMemo,
	useState,
} from 'react';
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
	const { status, subscribe, publish, appName, uniqueId } = useMqtt();
	const [variableValues, setVariableValues] = useState<Record<string, unknown>>(
		{},
	);
	const [variableTypes, setVariableTypes] = useState<
		Record<string, FigmaVariable>
	>({});

	useEffect(() => {
		if (status !== 'connected') return;

		function handleVariablesUpdate(_topic: string, message: Buffer) {
			const variables = JSON.parse(message.toString()) as Record<
				string,
				FigmaVariable
			>;
			setVariableTypes(variables);
		}

		function handleVariableUpdate(topic: string, message: Buffer) {
			const [_prefix, _version, _id, _app, _topic, variableId] =
				topic.split('/');
			setVariableValues(prev => {
				const next = { ...prev };
				next[variableId] = JSON.parse(message.toString());
				return next;
			});
		}

		subscribe(
			`microflow/v1/${uniqueId}/plugin/variables`,
			handleVariablesUpdate,
		);
		subscribe(
			`microflow/v1/${uniqueId}/${appName}/variables/response`,
			handleVariablesUpdate,
		);

		subscribe(
			`microflow/v1/${uniqueId}/plugin/variable/+`,
			handleVariableUpdate,
		);
		subscribe(
			`microflow/v1/${uniqueId}/${appName}/variable/+`,
			handleVariableUpdate,
		);
	}, [status, appName, uniqueId]);

	useEffect(() => {
		if (status !== 'connected') return;

		publish(`microflow/v1/${uniqueId}/${appName}/variables/request`, '');

		const interval = setInterval(() => {
			publish(`microflow/v1/${uniqueId}/${appName}/variables/request`, '');
		}, 1000 * 60);

		return () => {
			clearInterval(interval);
		};
	}, [status]);

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
