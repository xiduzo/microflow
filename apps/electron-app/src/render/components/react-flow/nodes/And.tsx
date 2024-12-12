import { Position } from '@xyflow/react';
import { Handle } from './Handle';
import { BaseNode, NodeContainer, useNode, useNodeSettingsPane } from './Node';
import { type AndData, type AndValueType } from '@microflow/components';
import { useNodeValue } from '../../../stores/node-data';
import { useEffect, useMemo } from 'react';
import { Icons } from '@ui/index';
import { uuid } from '../../../../utils/uuid';

export function And(props: Props) {
	console.log(props.data);
	function getOffset(index: number) {
		return index - (props.data.checks - 1) / 2;
	}

	return (
		<NodeContainer {...props}>
			<Value />
			<Settings />
			{Array.from({ length: props.data.checks }).map((_item, index) => {
				return (
					<Handle
						key={uuid()}
						type="target"
						title={`Check ${index + 1}`}
						position={Position.Left}
						id={String(index)}
						offset={getOffset(index)}
					/>
				);
			})}
			<Handle type="source" position={Position.Right} id="true" offset={-0.5} />
			<Handle type="source" position={Position.Right} id="false" offset={0.5} />
			<Handle type="source" position={Position.Bottom} id="change" />
		</NodeContainer>
	);
}

function Value() {
	const { id, data } = useNode<AndData>();
	const value = useNodeValue<AndValueType>(id, []);

	const allTrue = value.length === data.checks && value.every(Boolean);

	if (allTrue) return <Icons.ShieldCheck className="text-green-500" size={48} />;
	return <Icons.ShieldX className="text-red-500" size={48} />;
}

function Settings() {
	const { pane, settings, setHandlesToDelete } = useNodeSettingsPane<AndData>();

	useEffect(() => {
		if (!pane) return;

		const initialAmount = Number(settings.checks);

		pane
			.addBinding(settings, 'checks', {
				index: 0,
				min: 2,
				step: 1,
				max: 4,
			})
			.on('change', ({ value }) => {
				if (value === initialAmount) {
					setHandlesToDelete([]);
					return;
				}

				setHandlesToDelete(Array.from({ length: value }).map((_, index) => String(index)));
			});
	}, [pane, settings]);

	return null;
}

type Props = BaseNode<AndData, AndValueType>;
export const DEFAULT_AND_DATA: Props['data'] = {
	label: 'and',
	checks: 4,
};
