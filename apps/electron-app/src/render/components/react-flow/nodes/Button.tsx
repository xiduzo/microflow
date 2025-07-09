import type { ButtonData, ButtonValueType } from '@microflow/components';
import { Icons, ListBladeApi } from '@microflow/ui';
import { Position } from '@xyflow/react';
import { useEffect } from 'react';
import { MODES } from '../../../../common/types';
import { mapPinToPaneOption } from '../../../../utils/pin';
import { Handle } from '../Handle';
import { BaseNode, NodeContainer, useNodeSettings } from './Node';
import { useNodeValue } from '../../../stores/node-data';
import { usePins } from '../../../stores/board';

export function Button(props: Props) {
	return (
		<NodeContainer {...props}>
			<Value />
			<Settings />
			<Handle type="source" position={Position.Right} id="active" offset={-1.5} />
			<Handle type="source" position={Position.Right} id="change" offset={-0.5} />
			<Handle type="source" position={Position.Right} id="inactive" offset={0.5} />
			<Handle type="source" position={Position.Right} id="hold" offset={1.5} />
		</NodeContainer>
	);
}

function Value() {
	const value = useNodeValue<ButtonValueType>(false);

	if (!value) return <Icons.PointerOff className="text-muted-foreground" size={48} />;
	return <Icons.Pointer className="text-green-500" size={48} />;
}

function Settings() {
	const { settings, addBinding, addFolder, addBlade } = useNodeSettings<ButtonData>();
	const requiresPullup = settings.isPullup || settings.isPulldown;
	const pins = usePins(requiresPullup ? [MODES.PULLUP, MODES.INPUT] : [MODES.INPUT]);

	useEffect(() => {
		addBinding('pin', {
			view: 'list',
			disabled: !pins.length,
			label: 'pin',
			index: 0,
			options: pins.map(mapPinToPaneOption),
		});

		addFolder({
			title: 'advanced',
			expanded: false,
			index: 1,
		});

		addBinding('holdtime', {
			min: 100,
			step: 50,
			tag: 'advanced',
		});

		addBlade({
			view: 'list',
			label: 'type',
			value: settings.isPulldown ? 2 : settings.isPullup ? 1 : 0,
			options: [
				{ value: 0, text: 'default' },
				{ value: 1, text: 'pull-up' },
				{ value: 2, text: 'pull-down' },
			],
			tag: 'advanced',
			change: event => {
				switch (Number(event.value)) {
					case 0:
						return {
							isPulldown: false,
							isPullup: false,
						};
					case 1:
						return {
							isPulldown: false,
							isPullup: true,
						};
					case 2:
						return {
							isPulldown: true,
							isPullup: false,
						};
				}
			},
		});

		addBinding('invert', {});
	}, [settings, pins, addBinding, addFolder, addBlade]);

	return null;
}

type Props = BaseNode<ButtonData>;
Button.defaultProps = {
	data: {
		group: 'hardware',
		tags: ['input', 'digital'],
		holdtime: 500,
		isPulldown: false,
		isPullup: false,
		invert: false,
		pin: 6,
		label: 'Button',
		description: 'Simple user input control',
	} satisfies Props['data'],
};
