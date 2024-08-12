import {
	Button,
	Icons,
	Label,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	Sheet,
	SheetContent,
	SheetHeader,
	SheetTitle,
	SheetTrigger,
	Slider,
} from '@microflow/ui';
import { Position, useUpdateNodeInternals } from '@xyflow/react';
import { PiezoOption, PiezoTune } from 'johnny-five';
import { useState } from 'react';
import { BoardCheckResult, MODES } from '../../../../../common/types';
import { useUpdateNodeData } from '../../../../hooks/nodeUpdater';
import { useBoard } from '../../../../providers/BoardProvider';
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
	const { updateNodeData } = useUpdateNodeData<PiezoData>(props.id);

	const [tempSong, setTempSong] = useState<[string | null, number][] | null>(
		null,
	);
	const [tempTempo, setTempTempo] = useState<number | null>(null);

	return (
		<NodeContainer {...props}>
			<NodeContent>
				<NodeValue className="tabular-nums">
					{props.data.type === 'song' &&
						(Boolean(props.data.value) ? (
							<Icons.Disc3 className="animate-spin w-14 h-14" />
						) : (
							<Icons.Disc className="w-14 h-14" />
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

						let update = { type: value } as BuzzData | SongData;
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
						<Sheet
							onOpenChange={value => {
								if (props.data.type !== 'song') {
									return;
								}

								setTempSong(value ? props.data.song : null);
								setTempTempo(value ? props.data.tempo : null);
							}}
						>
							<SheetTrigger asChild>
								<Button variant="secondary">Edit song</Button>
							</SheetTrigger>
							<SheetContent>
								<SheetHeader>
									<SheetTitle>Edit song</SheetTitle>
								</SheetHeader>
								{tempSong && tempTempo && (
									<SongEditor
										song={tempSong}
										tempo={tempTempo}
										onSave={(song, tempo) => {
											updateNodeData({ song, tempo });
											setTempSong(null);
											setTempTempo(null);
										}}
									/>
								)}
							</SheetContent>
						</Sheet>
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

type BuzzData = { type: 'buzz'; duration: number; frequency: number };
type SongData = { type: 'song' } & PiezoTune & {
		song: [string | null, number][];
	};
type BaseData = Omit<PiezoOption, 'type'>;

const DEFAULT_FREQUENCY = NOTES_AND_FREQUENCIES.get('C4');
export type PiezoData = BaseData & (BuzzData | SongData);
type Props = BaseNode<PiezoData, boolean>;
export const DEFAULT_PIEZO_DATA: Props['data'] = {
	label: 'Piezo',
	value: false,
	duration: 500,
	frequency: DEFAULT_FREQUENCY,
	pin: 11,
	type: 'buzz',
};
