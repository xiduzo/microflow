import type { LedData, LedValueType } from '@microflow/components';
import { Icons } from '@microflow/ui';
import { Position } from '@xyflow/react';
import { MODES } from '../../../../common/types';
import { Handle } from './Handle';
import { BaseNode, NodeContainer, useNode, useNodeSettingsPane } from './Node';
import { useEffect } from 'react';
import { useBoard } from '../../../providers/BoardProvider';
import { mapPinToPaneOption } from '../../../../utils/pin';
import { useNodeValue } from '../../../stores/node-data';

export function Led(props: Props) {
	return (
		<NodeContainer {...props}>
			<Value />
			<Settings />
			<Handle type="target" position={Position.Left} id="on" offset={-1} />
			<Handle type="target" position={Position.Left} id="toggle" />
			<Handle type="target" position={Position.Left} id="off" offset={1} />
			<Handle type="source" position={Position.Bottom} id="change" />
		</NodeContainer>
	);
}

function Value() {
	const { id } = useNode();
	const value = useNodeValue<LedValueType>(id, 0);

	if (!value) return <Icons.LightbulbOff className="text-muted-foreground" size={48} />;
	return <Icons.Lightbulb size={48} />;
}

function Settings() {
	const { pane, settings } = useNodeSettingsPane<LedData>();
	const { pins } = useBoard();

	useEffect(() => {
		if (!pane) return;

		pane.addBinding(settings, 'pin', {
			view: 'list',
			disabled: !pins.length,
			label: 'pin',
			index: 0,
			options: pins.filter(pin => pin.supportedModes.includes(MODES.INPUT)).map(mapPinToPaneOption),
		});
	}, [pane, settings, pins]);

	return null;
}

type Props = BaseNode<LedData, LedValueType>;
export const DEFAULT_LED_DATA: Props['data'] = {
	label: 'LED',
	pin: 13,
	value: 0,
};
