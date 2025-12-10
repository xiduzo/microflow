import {
	type Data,
	type Value,
	dataSchema,
} from '@microflow/runtime/src/audioplayer/audioplayer.types';
import { Position } from '@xyflow/react';
import { useState } from 'react';
import { Handle } from '../../Handle';
import { BaseNode, NodeContainer, useNodeControls, useNodeData, useNodeId } from '../Node';
import { useNodeValue } from '../../../../stores/node-data';
import { button } from 'leva';
import { AudioFileEditor } from './AudioFileEditor';
import { IconWithValue } from '../../IconWithValue';

export function AudioPlayer(props: Props) {
	return (
		<NodeContainer {...props}>
			<Value />
			<Settings />
			<Handle type='target' position={Position.Left} id='play' offset={-0.5} />
			<Handle type='target' position={Position.Left} id='stop' offset={0.5} />
		</NodeContainer>
	);
}

function Value() {
	const data = useNodeData<Data>();
	const isPlaying = useNodeValue<Value>(false);

	return (
		<IconWithValue
			icon={isPlaying ? 'Volume2' : 'VolumeOff'}
			value={data.audioFiles.length}
			suffix=' files'
			iconClassName={isPlaying ? 'text-green-500' : 'text-muted-foreground'}
		/>
	);
}

function Settings() {
	const data = useNodeData<Data>();
	const [editorOpened, setEditorOpened] = useState(false);
	const { render, setNodeData } = useNodeControls<Data>(
		{
			volume: {
				value: data.volume ?? 1,
				min: 0,
				max: 1,
				step: 0.1,
				label: 'volume',
			},
			loop: {
				value: data.loop ?? false,
				label: 'loop',
			},
			'manage files': button(() => {
				setEditorOpened(true);
			}),
		},
		[]
	);

	return (
		<>
			{render()}
			{editorOpened && (
				<AudioFileEditor
					audioFiles={data.audioFiles}
					onClose={() => {
						setEditorOpened(false);
					}}
					onSave={newData => {
						setNodeData({
							...data,
							audioFiles: newData.audioFiles,
						});
						setEditorOpened(false);
					}}
				/>
			)}
		</>
	);
}

type Props = BaseNode<Data>;
AudioPlayer.defaultProps = {
	data: {
		...dataSchema.parse({}),
		group: 'flow',
		tags: ['output', 'event'],
		label: 'Audio Player',
		icon: 'MusicIcon',
		description: 'Select and play audio files from your device',
	} satisfies Props['data'],
};
