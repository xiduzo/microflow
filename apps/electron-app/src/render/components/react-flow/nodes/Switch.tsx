import { SwitchData, SwitchValueType } from '@microflow/components';
import { BaseNode, NodeContainer, useNodeSettings } from './Node';
import { Handle } from './Handle';
import { Position } from '@xyflow/react';
import { useNodeValue } from '../../../stores/node-data';
import { Switch as UiSwitch } from '@ui/index';
import { useEffect } from 'react';
import { usePins } from '../../../stores/board';
import { MODES } from '../../../../common/types';
import { mapPinToPaneOption } from '../../../../utils/pin';

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
	const { pane, settings } = useNodeSettings<SwitchData>();
	const pins = usePins();

	useEffect(() => {
		if (!pane) return;

		const pinBinding = pane.addBinding(settings, 'pin', {
			view: 'list',
			disabled: !pins.length,
			label: 'pin',
			index: 0,
			options: pins.filter(pin => pin.supportedModes.includes(MODES.INPUT)).map(mapPinToPaneOption),
		});

		const typeBinding = pane.addBinding(settings, 'type', {
			view: 'list',
			label: 'type',
			index: 1,
			options: [
				{ value: 'NC', text: 'normally closed' },
				{ value: 'NO', text: 'normally open' },
			],
		});

		return () => {
			pinBinding.dispose();
			typeBinding.dispose();
		};
	}, [pins, pane, settings]);
	return null;
}

type Props = BaseNode<SwitchData>;
Switch.defaultProps = {
	data: {
		pin: 2,
		group: 'hardware',
		label: 'Switch',
		tags: ['digital', 'input'],
		type: 'NC',
		description: 'Control a switch to toggle between on and off states',
	} satisfies Props['data'],
};
