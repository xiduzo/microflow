import { type Data, type Value, dataSchema } from '@microflow/runtime/src/relay/relay.types';
import { BaseNode, NodeContainer, useNodeControls, useNodeData } from './Node';
import { Handle } from '../Handle';
import { Position } from '@xyflow/react';
import { useNodeValue } from '../../../stores/node-data';
import { Icons } from '@microflow/ui';
import { usePins } from '../../../stores/board';
import { MODES } from '../../../../common/types';
import { reducePinsToOptions } from '../../../../common/pin';

export function Relay(props: Props) {
	return (
		<NodeContainer {...props}>
			<Value />
			<Settings />
			<Handle type='target' position={Position.Left} id='open' offset={-1} />
			<Handle type='target' position={Position.Left} id='toggle' />
			<Handle type='target' position={Position.Left} id='close' offset={1} />
		</NodeContainer>
	);
}

function Value() {
	const value = useNodeValue<Value>(false);

	if (!value) return <Icons.ZapOff className='text-muted-foreground' size={48} />;
	return <Icons.Zap className='text-yellow-400' size={48} />;
}

function Settings() {
	const pins = usePins([MODES.OUTPUT]);
	const data = useNodeData<Data>();
	const { render } = useNodeControls(
		{
			pin: { value: data.pin, options: pins.reduce(reducePinsToOptions, {}) },
			type: {
				value: data.type,
				options: {
					'Normally open (NO)': 'NO',
					'Normally closed (NC)': 'NC',
				},
			},
		},
		[pins]
	);

	return <>{render()}</>;
}

type Props = BaseNode<Data>;
Relay.defaultProps = {
	data: {
		...dataSchema.parse({}),
		group: 'hardware',
		label: 'Relay',
		icon: 'ZapIcon',
		tags: ['output', 'analog', 'digital'],
		description:
			'Safely turn on or off devices that need more power, like lights, motors, or appliances',
	} satisfies Props['data'],
};
