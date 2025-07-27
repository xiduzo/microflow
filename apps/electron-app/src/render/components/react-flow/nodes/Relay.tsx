import { RelayData, RelayValueType } from '@microflow/components';
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
			<Handle type='target' position={Position.Left} id='close' />
			<Handle type='target' position={Position.Left} id='toggle' offset={1} />
		</NodeContainer>
	);
}

function Value() {
	const value = useNodeValue<RelayValueType>(false);

	if (!value) return <Icons.ZapOff className='text-muted-foreground' size={48} />;
	return <Icons.Zap className='text-yellow-400' size={48} />;
}

function Settings() {
	const pins = usePins([MODES.OUTPUT]);
	const data = useNodeData<RelayData>();
	const { render } = useNodeControls(
		{
			pin: { value: data.pin, options: pins.reduce(reducePinsToOptions, {}) },
			type: {
				value: data.type,
				options: [
					{ value: 'NO', text: 'Normally open (NO)' },
					{ value: 'NC', text: 'Normally closed (NC)' },
				],
			},
		},
		[pins]
	);

	return <>{render()}</>;
}

type Props = BaseNode<RelayData>;
Relay.defaultProps = {
	data: {
		group: 'hardware',
		label: 'Relay',
		pin: 10,
		tags: ['output', 'analog', 'digital'],
		type: 'NO',
		description: 'Switch on or off high-power devices',
	} satisfies Props['data'],
};
