import type { ButtonData, ButtonValueType } from '@microflow/components';
import { Icons } from '@microflow/ui';
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

const DEFAULT = 0;
const PULL_UP = 1;
const PULL_DOWN = 2;

function Settings() {
	const { settings, addBinding, addFolder, addBlade } = useNodeSettings<ButtonData>();
	const requiresPullup = settings.isPullup || settings.isPulldown;
	const pins = usePins(requiresPullup ? [MODES.PULLUP, MODES.INPUT] : [MODES.INPUT]);

	useEffect(() => {
		addBinding('pin', {
			index: 0,
			view: 'list',
			disabled: !pins.length,
			label: 'pin',
			options: pins.map(mapPinToPaneOption),
		});

		addFolder({ index: 1, title: 'advanced', expanded: false });
		addBinding('holdtime', { min: 100, step: 50, tag: 'advanced' });

		addBlade({
			view: 'list',
			label: 'type',
			value: settings.isPulldown ? PULL_DOWN : settings.isPullup ? PULL_UP : DEFAULT,
			options: [
				{ value: DEFAULT, text: 'default' },
				{ value: PULL_UP, text: 'pull-up' },
				{ value: PULL_DOWN, text: 'pull-down' },
			],
			tag: 'advanced',
			change: event => {
				const value = Number(event.value);
				return {
					isPullup: value === PULL_UP,
					isPulldown: value === PULL_DOWN,
				};
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
