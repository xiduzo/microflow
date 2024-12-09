import type { ButtonData, ButtonValueType } from '@microflow/components';
import { Icons, ListBladeApi } from '@microflow/ui';
import { Position } from '@xyflow/react';
import { useEffect } from 'react';
import { MODES } from '../../../../common/types';
import { mapPinToPaneOption } from '../../../../utils/pin';
import { Handle } from './Handle';
import { BaseNode, NodeContainer, useNode, useNodeSettingsPane } from './Node';
import { useNodeValue } from '../../../stores/node-data';
import { usePins } from '../../../stores/board';

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
	return <Icons.Pointer className="text-green-500" size={48} />;
}

function Settings() {
	const { pane, settings } = useNodeSettingsPane<ButtonData>();
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

		const advancedFolder = pane.addFolder({
			title: 'advanced',
			expanded: false,
			index: 1,
		});

		advancedFolder.addBinding(settings, 'holdtime', {
			min: 100,
			step: 50,
		});

		const typeBlade = advancedFolder.addBlade({
			view: 'list',
			label: 'type',
			value: settings.isPulldown ? 2 : settings.isPullup ? 1 : 0,
			options: [
				{ value: 0, text: 'default' },
				{ value: 1, text: 'pull-up' },
				{ value: 2, text: 'pull-down' },
			],
		});

		(typeBlade as ListBladeApi<number>).on('change', event => {
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

		advancedFolder.addBinding(settings, 'invert');

		return () => {
			[pinBinding, advancedFolder].forEach(disposable => disposable.dispose());
		};
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
