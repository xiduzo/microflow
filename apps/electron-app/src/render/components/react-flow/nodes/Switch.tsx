import { SwitchData, SwitchValueType } from '@microflow/components';
import { BaseNode, NodeContainer, useNodeControls, useNodeData } from './Node';
import { Handle } from '../Handle';
import { Position } from '@xyflow/react';
import { useNodeValue } from '../../../stores/node-data';
import { Switch as UiSwitch } from '@microflow/ui';
import { usePins } from '../../../stores/board';
import { MODES } from '../../../../common/types';
import { reducePinsToOptions } from '../../../../utils/pin';

export function Switch(props: Props) {
	return (
		<NodeContainer {...props}>
			<Value />
			<Settings />
			<Handle type="source" position={Position.Right} id="open" title="active" offset={-1} />
			<Handle type="source" position={Position.Right} id="change" />
			<Handle type="source" position={Position.Right} id="close" title="inactive" offset={1} />
		</NodeContainer>
	);
}

function Value() {
	const value = useNodeValue<SwitchValueType>(false);

	return <UiSwitch checked={value} className="scale-150" />;
}

function Settings() {
	const data = useNodeData<SwitchData>();
	const pins = usePins([MODES.INPUT]);
	const { render } = useNodeControls(
		{
			pin: { value: data.pin, options: pins.reduce(reducePinsToOptions, {}) },
			type: {
				value: data.type,
				options: [
					{ value: 'NC', text: 'normally closed (NC)' },
					{ value: 'NO', text: 'normally open (NO)' },
				],
			},
		},
		[pins],
	);

	return <>{render()}</>;
}

type Props = BaseNode<SwitchData>;
Switch.defaultProps = {
	data: {
		pin: 2,
		group: 'hardware',
		label: 'Switch',
		tags: ['input', 'digital'],
		type: 'NC',
		description: 'Control a switch to toggle between on and off states',
	} satisfies Props['data'],
};
