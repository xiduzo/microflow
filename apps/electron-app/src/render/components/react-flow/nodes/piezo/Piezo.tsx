import type { PiezoData, PiezoValueType } from '@microflow/components';
import { Icons } from '@microflow/ui';
import { Position, useUpdateNodeInternals } from '@xyflow/react';
import { useShallow } from 'zustand/react/shallow';
import { deleteEdgesSelector, useNodesEdgesStore } from '../../../../stores/react-flow';
import { Handle } from '../Handle';
import { BaseNode, NodeContainer, NodeContent, NodeSettings, NodeValue } from '../Node';
import { DEFAULT_NOTE, NOTES_AND_FREQUENCIES } from './constants';
import { PiezoSettings } from './PiezoSettings';

export function Piezo(props: Props) {
	const updateNodeInternals = useUpdateNodeInternals();
	const { deleteEdges } = useNodesEdgesStore(useShallow(deleteEdgesSelector));

	return (
		<NodeContainer {...props}>
			<NodeContent>
				<NodeValue className="tabular-nums">
					{props.data.type === 'song' &&
						(Boolean(props.data.value) ? (
							<Icons.Disc3 className="animate-spin w-14 h-14" />
						) : (
							<Icons.Disc className="w-14 h-14 text-muted-foreground" />
						))}
					{props.data.type === 'buzz' &&
						(Boolean(props.data.value) ? (
							<Icons.BellRing className="animate-wiggle w-10 h-10" />
						) : (
							<Icons.Bell className="w-10 h-10" />
						))}
				</NodeValue>
			</NodeContent>
			<NodeSettings>
				<PiezoSettings />
			</NodeSettings>
			{props.data.type === 'buzz' && (
				<Handle type="target" position={Position.Left} id="buzz" offset={-0.5} />
			)}
			{props.data.type === 'song' && (
				<Handle type="target" position={Position.Left} id="play" offset={-0.5} />
			)}
			<Handle type="target" position={Position.Left} id="stop" offset={0.5} />
		</NodeContainer>
	);
}

export const DEFAULT_FREQUENCY = NOTES_AND_FREQUENCIES.get(DEFAULT_NOTE);
type Props = BaseNode<PiezoData, PiezoValueType>;
export const DEFAULT_PIEZO_DATA: Props['data'] = {
	label: 'Piezo',
	value: false,
	duration: 500,
	frequency: DEFAULT_FREQUENCY,
	pin: 11,
	type: 'buzz',
};
