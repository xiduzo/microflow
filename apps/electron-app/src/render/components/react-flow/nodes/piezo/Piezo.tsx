import type { BuzzData, PiezoData, PiezoValueType, SongData } from '@microflow/components';
import { button, folder, Icons } from '@microflow/ui';
import { Position } from '@xyflow/react';
import { Handle } from '../../Handle';
import { BaseNode, NodeContainer, useDeleteHandles, useNodeControls, useNodeData } from '../Node';
import { DEFAULT_NOTE, DEFAULT_SONG, NOTES_AND_FREQUENCIES } from './constants';
import { useNodeValue } from '../../../../stores/node-data';
import { useState } from 'react';
import { MODES } from '../../../../../common/types';
import { reducePinsToOptions } from '../../../../../utils/pin';
import { SongEditor } from './SongEditor';
import { usePins } from '../../../../stores/board';

export function Piezo(props: Props) {
	return (
		<NodeContainer {...props}>
			<Value />
			<Settings />
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

function Value() {
	const data = useNodeData<PiezoData>();
	const value = useNodeValue<PiezoValueType>(false);

	if (!value) {
		if (data.type === 'song') return <Icons.Disc className="text-muted-foreground" size={48} />;
		return <Icons.Bell className="text-muted-foreground" size={48} />;
	}

	if (data.type === 'song') return <Icons.Disc3 className="animate-spin" size={48} />;
	return <Icons.BellRing className="animate-wiggle" size={48} />;
}

function Settings() {
	const data = useNodeData<PiezoData>();
	const pins = usePins([MODES.INPUT, MODES.PWM]);
	const [editorOpened, setEditorOpened] = useState(false);
	const deleteHandles = useDeleteHandles();

	const { render, setNodeData } = useNodeControls<PiezoData>(
		{
			pin: { options: pins.reduce(reducePinsToOptions, {}), value: data.pin },
			type: {
				options: ['buzz', 'song'],
				value: data.type,
				transient: false,
				onChange: event => deleteHandles(event === 'song' ? ['buzz'] : ['play']),
			},
			buzz: folder(
				{
					duration: {
						min: 100,
						max: 2500,
						step: 100,
						value: (data as BuzzData).duration!,
						render: get => get('type') === 'buzz',
					},
					frequency: {
						options: Object.fromEntries(NOTES_AND_FREQUENCIES.entries()),
						value: (data as BuzzData).frequency!,
						render: get => get('type') === 'buzz',
					},
					tempo: {
						min: 40,
						max: 240,
						step: 10,
						value: (data as SongData).tempo!,
						render: get => get('type') === 'song',
					},
				},
				{
					render: get => get('type') === 'buzz',
				},
			),
			song: folder(
				{
					'edit song': button(e => {
						console.log(e);
						setEditorOpened(true);
					}),
				},
				{
					render: get => get('type') === 'song',
				},
			),
		},
		[pins],
	);

	return (
		<>
			{render()}
			{editorOpened && (
				<SongEditor
					song={(data as SongData).song ?? DEFAULT_SONG}
					onClose={() => {
						setEditorOpened(false);
					}}
					onSave={data => {
						data.song = data.song;
						setNodeData(data);
						setEditorOpened(false);
					}}
				/>
			)}
		</>
	);
}

export const DEFAULT_FREQUENCY = NOTES_AND_FREQUENCIES.get(DEFAULT_NOTE);

type Props = BaseNode<PiezoData>;
Piezo.defaultProps = {
	data: {
		group: 'hardware',
		tags: ['output', 'analog', 'digital'],
		label: 'Piezo',
		duration: 500,
		frequency: DEFAULT_FREQUENCY!,
		pin: 11,
		type: 'buzz',
		description: 'Play a tone or song',
	} satisfies Props['data'],
};
