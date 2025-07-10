import type { ButtonData, ButtonValueType } from '@microflow/components';
import { folder, Icons } from '@microflow/ui';
import { Position } from '@xyflow/react';
import { MODES } from '../../../../common/types';
import { mapPinsToSettings } from '../../../../utils/pin';
import { Handle } from '../Handle';
import { BaseNode, NodeContainer, NodeSettings, useNodeData } from './Node';
import { useNodeValue } from '../../../stores/node-data';
import { usePins } from '../../../stores/board';
import { useUpdateNode } from '../../../hooks/useUpdateNode';

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
	const data = useNodeData<ButtonData>();
	const requiresPullup = data.isPullup || data.isPulldown;
	const pins = usePins(requiresPullup ? [MODES.PULLUP, MODES.INPUT] : [MODES.INPUT]);
	return (
		<NodeSettings
			settings={{
				pin: {
					options: pins.reduce(mapPinsToSettings, {}),
					value: data.pin,
					disabled: !pins.length,
				},
				type: {
					value: data.isPulldown ? PULL_DOWN : data.isPullup ? PULL_UP : DEFAULT,
					options: {
						default: DEFAULT,
						'Pull Up': PULL_UP,
						'Pull Down': PULL_DOWN,
					},
					onChange: value => {
						// TODO: set `isPulldown` or `isPullup` based on value
						// 			return {
						// 				isPullup: value === PULL_UP,
						// 				isPulldown: value === PULL_DOWN,
						// 			};
						console.log(value);
					},
				},
				advanced: folder(
					{
						holdtime: {
							min: 100,
							step: 50,
							value: data.holdtime!,
							label: 'hold time (ms)',
						},
					},
					{ collapsed: true },
				),
			}}
		/>
	);
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
