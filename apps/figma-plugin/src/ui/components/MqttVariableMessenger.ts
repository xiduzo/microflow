import { useMqtt } from '@microflow/mqtt-provider/client';
import { useEffect, useRef } from 'react';
import { MESSAGE_TYPE, SetLocalValiable } from '../../common/types/Message';
import { useMessageListener } from '../hooks/useMessageListener';
import { sendMessageToFigma } from '../utils/sendMessageToFigma';

type KnownVariable = Pick<Variable, 'name' | 'resolvedType' | 'id'>;

export function MqttVariableMessenger() {
	const { status, publish, subscribe, uniqueId } = useMqtt();
	const publishedVariableValues = useRef<Map<string, any | undefined>>(new Map());
	const knownVariables = useRef<Record<string, KnownVariable>>({}); // <id, name>

	async function publishVariables(variables?: Variable[]) {
		const newVariables =
			variables?.reduce(
				(acc, variable) => {
					acc[variable.id] = {
						id: variable.id,
						name: variable.name,
						resolvedType: variable.resolvedType,
					};
					return acc;
				},
				{} as Record<string, KnownVariable>,
			) ?? {};

		const newVariablesAsJson = JSON.stringify(newVariables);
		if (newVariablesAsJson !== JSON.stringify(knownVariables.current)) {
			await publish(`microflow/v1/${uniqueId}/plugin/variables`, newVariablesAsJson);
		}

		knownVariables.current = newVariables;

		variables?.forEach(async variable => {
			const current = publishedVariableValues.current.get(variable.id);
			const value = Object.values(variable.valuesByMode)[0];
			const valueAsJson = JSON.stringify(value);
			if (current === valueAsJson) {
				return;
			}

			await publish(
				`microflow/v1/${uniqueId}/plugin/variable/${variable.id}`,
				JSON.stringify(value),
			);
			publishedVariableValues.current.set(variable.id, valueAsJson);
		});
	}

	useEffect(() => {
		if (status !== 'connected') return;

		const req = subscribe(`microflow/v1/${uniqueId}/+/variables/request`, topic => {
			const app = topic.split('/')[3];
			publish(
				`microflow/v1/${uniqueId}/${app}/variables/response`,
				JSON.stringify(knownVariables.current),
			);
			publishedVariableValues.current.forEach((value, id) => {
				publish(`microflow/v1/${uniqueId}/${app}/variable/${id}`, value);
			});
		}).catch(console.error);

		const set = subscribe(`microflow/v1/${uniqueId}/+/variable/+/set`, async (topic, message) => {
			const [, , , app, , variableId] = topic.split('/');

			let value = null;
			try {
				value = JSON.parse(message.toString());
			} catch (e) {
				value = message.toString();
			}

			console.debug('[SET] <<<<', value);

			// Make sure we don't send the same value back to the app
			publishedVariableValues.current.set(variableId, JSON.stringify(value));
			sendMessageToFigma(SetLocalValiable(variableId, value as VariableValue));
		}).catch(console.error);

		return () => {
			req.then(unsub => unsub?.()).catch(console.error);
			set.then(unsub => unsub?.()).catch(console.error);
		};
	}, [status, subscribe, publish, uniqueId]);

	useMessageListener<Variable[] | undefined>(MESSAGE_TYPE.GET_LOCAL_VARIABLES, publishVariables, {
		intervalInMs: 100,
		shouldSendInitialMessage: true,
	});

	return null;
}
