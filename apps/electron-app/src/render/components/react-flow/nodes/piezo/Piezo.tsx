import type {
	BuzzData,
	PiezoData,
	PiezoValueType,
	SongData,
} from '@microflow/components';
import {
	Icons,
	Label,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	Slider,
} from '@microflow/ui';
import { Position, useUpdateNodeInternals } from '@xyflow/react';
import { useShallow } from 'zustand/react/shallow';
import { BoardCheckResult, MODES } from '../../../../../common/types';
import { useUpdateNodeData } from '../../../../hooks/nodeUpdater';
import { useBoard } from '../../../../providers/BoardProvider';
import { deleteEdgesSelector, useNodesEdgesStore } from '../../../../store';
import { MusicSheet } from '../../../MusicSheet';
import { Handle } from '../Handle';
import {
	BaseNode,
	NodeContainer,
	NodeContent,
	NodeSettings,
	NodeValue,
} from '../Node';
import {
	DEFAULT_NOTE,
	DEFAULT_SONG,
	MAX_NOTE_FREQUENCY,
	MIN_NOTE_FREQUENCY,
	NOTES_AND_FREQUENCIES,
} from './constants';
import { SongEditor } from './SongEditor';

function validatePin(pin: BoardCheckResult['pins'][0]) {
	return (
		pin.supportedModes.includes(MODES.INPUT) &&
		pin.supportedModes.includes(MODES.PWM)
	);
}

export function Piezo(props: Props) {
	const { pins } = useBoard();
	const updateNodeInternals = useUpdateNodeInternals();
	const { deleteEdges } = useNodesEdgesStore(useShallow(deleteEdgesSelector));

	const { updateNodeData } = useUpdateNodeData<PiezoData>(props.id);

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
				<Select
					value={props.data.pin.toString()}
					onValueChange={value => updateNodeData({ pin: Number(value) })}
				>
					<SelectTrigger>Pin {props.data.pin}</SelectTrigger>
					<SelectContent>
						{pins.filter(validatePin).map(pin => (
							<SelectItem key={pin.pin} value={pin.pin.toString()}>
								Pin {pin.pin}
							</SelectItem>
						))}
					</SelectContent>
				</Select>

				<Select
					value={props.data.type}
					onValueChange={(value: 'buzz' | 'song') => {
						updateNodeInternals(props.id);

						let update: Partial<typeof props.data> = { type: value };
						if (value === 'buzz') {
							update = {
								...update,
								duration: 500,
								frequency: DEFAULT_FREQUENCY,
							} as BuzzData;
						} else {
							update = {
								...update,
								tempo: 100,
								song: DEFAULT_SONG,
							} as SongData;
						}
						updateNodeData(update);
						deleteEdges(props.id, ['stop']);
					}}
				>
					<SelectTrigger>{props.data.type}</SelectTrigger>
					<SelectContent>
						<SelectItem value="buzz">Buzz</SelectItem>
						<SelectItem value="song">Song</SelectItem>
					</SelectContent>
				</Select>

				{props.data.type === 'buzz' && (
					<>
						<Label
							htmlFor={`duration-${props.id}`}
							className="flex justify-between"
						>
							Duration
							<span className="opacity-40 font-light">
								{props.data.duration}ms
							</span>
						</Label>
						<Slider
							id={`duration-${props.id}`}
							defaultValue={[props.data.duration]}
							min={100}
							max={2500}
							step={100}
							onValueChange={value => updateNodeData({ duration: value[0] })}
						/>
						<Label
							htmlFor={`frequency-${props.id}`}
							className="flex justify-between"
						>
							Frequency
							<span className="opacity-40 font-light">
								{props.data.frequency}Hz
							</span>
						</Label>
						<Slider
							id={`frequency-${props.id}`}
							defaultValue={[props.data.frequency]}
							min={MIN_NOTE_FREQUENCY}
							max={MAX_NOTE_FREQUENCY}
							step={1}
							onValueChange={value => updateNodeData({ frequency: value[0] })}
						/>
						<div className="text-sm text-muted-foreground">
							Higher frequencies tend to get stuck longer in the piezo then the
							requested duration. If you experience this, try lowering the
							frequency or duration.
						</div>
					</>
				)}
				{props.data.type === 'song' && (
					<>
						<Label
							htmlFor={`tempo-${props.id}`}
							className="flex justify-between"
						>
							Tempo
							<span className="opacity-40 font-light">{props.data.tempo}</span>
						</Label>
						<Slider
							id={`tempo-${props.id}`}
							defaultValue={[props.data.tempo]}
							min={30}
							max={300}
							step={10}
							onValueChange={value => updateNodeData({ tempo: value[0] })}
						/>
						<MusicSheet song={props.data.song} />
						<SongEditor song={props.data.song} onSave={updateNodeData} />
					</>
				)}
			</NodeSettings>
			{props.data.type === 'buzz' && (
				<Handle
					type="target"
					position={Position.Left}
					id="buzz"
					offset={-0.5}
				/>
			)}
			{props.data.type === 'song' && (
				<Handle
					type="target"
					position={Position.Left}
					id="play"
					offset={-0.5}
				/>
			)}
			<Handle type="target" position={Position.Left} id="stop" offset={0.5} />
		</NodeContainer>
	);
}

const DEFAULT_FREQUENCY = NOTES_AND_FREQUENCIES.get(DEFAULT_NOTE);
type Props = BaseNode<PiezoData, PiezoValueType>;
export const DEFAULT_PIEZO_DATA: Props['data'] = {
	label: 'Piezo',
	value: false,
	duration: 500,
	frequency: DEFAULT_FREQUENCY,
	pin: 11,
	type: 'buzz',
};
