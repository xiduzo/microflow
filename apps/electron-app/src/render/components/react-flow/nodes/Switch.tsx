import { SwitchData, SwitchValueType } from '@microflow/hardware';
import { BaseNode, NodeContainer, useNodeControls, useNodeData } from './Node';
import { Handle } from '../Handle';
import { Position } from '@xyflow/react';
import { useNodeValue } from '../../../stores/node-data';
import { Icons, Switch as UiSwitch } from '@microflow/ui';
import { usePins } from '../../../stores/board';
import { MODES } from '../../../../common/types';
import { reducePinsToOptions } from '../../../../common/pin';

export function Switch(props: Props) {
	return (
		<NodeContainer {...props}>
			<Value />
			<Settings />
			<Handle type='source' position={Position.Right} id='open' title='active' offset={-1} />
			<Handle type='source' position={Position.Right} id='change' />
			<Handle type='source' position={Position.Right} id='close' title='inactive' offset={1} />
		</NodeContainer>
	);
}

function Value() {
	const value = useNodeValue<SwitchValueType>(false);

	if (!value) return <Icons.ToggleLeftIcon size={48} className='text-muted-foreground' />;
	return <Icons.ToggleRightIcon size={48} className='text-green-500' />;
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
		[pins]
	);

	return <>{render()}</>;
}

type Props = BaseNode<SwitchData>;
Switch.defaultProps = {
	data: {
		pin: 2,
		group: 'hardware',
		icon: 'ToggleLeftIcon',
		label: 'Switch',
		tags: ['input', 'digital'],
		type: 'NC',
		description: 'Detect when a physical switch is turned on or off',
	} satisfies Props['data'],
};
