import type { ButtonData, ButtonValueType } from '@microflow/components';
import { Icons, TpChangeEvent } from '@microflow/ui';
import { Position } from '@xyflow/react';
import { useEffect } from 'react';
import { MODES } from '../../../../common/types';
import { mapPinToPaneOption } from '../../../../utils/pin';
import { useBoard } from '../../../providers/BoardProvider';
import { Handle } from './Handle';
import { BaseNode, NodeContainer, useNode, useNodeSettingsPane } from './Node';
import { useNodeValue } from '../../../stores/node-data';

export function Button(props: Props) {
	return (
		<NodeContainer {...props}>
			<Value />
			<Settings />
			<Handle type="source" position={Position.Right} id="active" offset={-1} />
			<Handle type="source" position={Position.Right} id="hold" />
			<Handle type="source" position={Position.Right} id="inactive" offset={1} />
			<Handle type="source" position={Position.Bottom} id="change" />
		</NodeContainer>
	);
}

function Value() {
	const { id } = useNode();
	const value = useNodeValue<ButtonValueType>(id, false);

	if (!value) return <Icons.PointerOff className="text-muted-foreground" size={48} />;
	return <Icons.Pointer size={48} />;
}

function Settings() {
	const { pane, settings } = useNodeSettingsPane<ButtonData>();
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

		const advanced = pane.addFolder({
			title: 'advanced',
			expanded: false,
			index: 1,
		});

		advanced.addBinding(settings, 'holdtime', {
			min: 100,
			step: 50,
		});

		advanced
			.addBlade({
				view: 'list',
				label: 'type',
				value: settings.isPulldown ? 2 : settings.isPullup ? 1 : 0,
				options: [
					{ value: 0, text: 'default' },
					{ value: 1, text: 'pull-up' },
					{ value: 2, text: 'pull-down' },
				],
			})
			// @ts-ignore-next-line
			.on('change', (event: TpChangeEvent<number>) => {
				switch (event.value) {
					case 0:
						settings.isPulldown = false;
						settings.isPullup = false;
						break;
					case 1:
						settings.isPulldown = false;
						settings.isPullup = true;
						break;
					case 2:
						settings.isPulldown = true;
						settings.isPullup = false;
						break;
				}
			});

		advanced.addBinding(settings, 'invert');
	}, [pane, settings, pins]);

	return null;
}

type Props = BaseNode<ButtonData, ButtonValueType>;
export const DEFAULT_BUTTON_DATA: Props['data'] = {
	holdtime: 500,
	isPulldown: false,
	isPullup: false,
	invert: false,
	pin: 6,
	label: 'Button',
};
