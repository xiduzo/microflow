import { RelayData, RelayValueType } from '@microflow/components';
import { BaseNode, NodeContainer, useNodeSettings } from './Node';
import { Handle } from './Handle';
import { Position } from '@xyflow/react';
import { useNodeValue } from '../../../stores/node-data';
import { Icons } from '@ui/index';
import { useEffect } from 'react';
import { usePins } from '../../../stores/board';
import { MODES } from '../../../../common/types';
import { mapPinToPaneOption } from '../../../../utils/pin';

export function Relay(props: Props) {
	return (
		<NodeContainer {...props}>
			<Value />
			<Settings />
			<Handle type="target" position={Position.Left} id="open" offset={-1} />
			<Handle type="target" position={Position.Left} id="close" />
			<Handle type="target" position={Position.Left} id="toggle" offset={1} />
		</NodeContainer>
	);
}

function Value() {
	const value = useNodeValue<RelayValueType>(false);

	if (!value) return <Icons.ZapOff className="text-muted-foreground" size={48} />;
	return <Icons.Zap className="text-yellow-400" size={48} />;
}

function Settings() {
	const { pane, settings } = useNodeSettings<RelayData>();
	const pins = usePins();

	useEffect(() => {
		if (!pane) return;

		const pinBinding = pane.addBinding(settings, 'pin', {
			view: 'list',
			disabled: !pins.length,
			label: 'pin',
			index: 0,
			options: pins
				.filter(pin => pin.supportedModes.includes(MODES.OUTPUT))
				.map(mapPinToPaneOption),
		});

		const typeBinding = pane.addBinding(settings, 'type', {
			view: 'list',
			disabled: !pins.length,
			label: 'mode',
			index: 1,
			options: [
				{ value: 'NO', text: 'Normally open' },
				{ value: 'NC', text: 'Normally closed' },
			],
		});

		return () => {
			pinBinding.dispose();
			typeBinding.dispose();
		};
	}, [settings, pane, pins]);

	return null;
}

type Props = BaseNode<RelayData>;
Relay.defaultProps = {
	data: {
		group: 'hardware',
		label: 'Relay',
		pin: 10,
		tags: ['analog', 'digital', 'output'],
		type: 'NO',
	} satisfies Props['data'],
};
