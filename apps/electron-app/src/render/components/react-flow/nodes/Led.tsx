import type { LedData, LedValueType } from '@microflow/components';
import { Icons } from '@microflow/ui';
import { Position } from '@xyflow/react';
import { MODES } from '../../../../common/types';
import { Handle } from './Handle';
import { BaseNode, NodeContainer, useNode, useNodeSettingsPane } from './Node';
import { useEffect, useMemo } from 'react';
import { mapPinToPaneOption, pinValue } from '../../../../utils/pin';
import { useNodeValue } from '../../../stores/node-data';
import { usePins } from '../../../stores/board';

export function Led(props: Props) {
	const pins = usePins();

	const isPmwPin = useMemo(() => {
		return pins.find(pin => pinValue(pin) === props.data.pin)?.supportedModes.includes(MODES.PWM);
	}, [pins, props.data.pin]);

	return (
		<NodeContainer {...props}>
			<Value />
			<Settings />
			<Handle type="target" position={Position.Left} id="on" offset={-1.5} />
			<Handle type="target" position={Position.Left} id="toggle" offset={-0.5} />
			<Handle
				type="target"
				position={Position.Left}
				id="brightness"
				offset={0.5}
				hint={`${isPmwPin ? '0-255' : 'requires PWM pin'}`}
				isConnectable={isPmwPin}
			/>
			<Handle type="target" position={Position.Left} id="off" offset={1.5} />
			<Handle type="source" position={Position.Bottom} id="change" />
		</NodeContainer>
	);
}

function Value() {
	const { id } = useNode();
	const value = useNodeValue<LedValueType>(id, 0);

	if (!value) return <Icons.LightbulbOff className="text-muted-foreground" size={48} />;
	return (
		<Icons.Lightbulb
			className="text-yellow-500"
			size={48}
			style={{
				opacity: value > 1 ? value / 255 : 1, // Rhough dimmable LED
			}}
		/>
	);
}

function Settings() {
	const { pane, settings } = useNodeSettingsPane<LedData>();
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

		return () => {
			[pinBinding].forEach(disposable => disposable.dispose());
		};
	}, [pane, settings, pins]);

	return null;
}

type Props = BaseNode<LedData, LedValueType>;
export const DEFAULT_LED_DATA: Props['data'] = {
	label: 'LED',
	pin: 13,
};
