import { BuzzData, SongData, type PiezoData } from '@microflow/components';
import { Label, Select, SelectContent, SelectItem, SelectTrigger, Slider } from '@microflow/ui';
import { MODES } from '../../../../../common/types';
import { MusicSheet } from '../../../MusicSheet';
import { PinSelect } from '../../../PinSelect';
import { useNodeSettings } from '../Node';
import { DEFAULT_SONG, MAX_NOTE_FREQUENCY, MIN_NOTE_FREQUENCY } from './constants';
import { DEFAULT_FREQUENCY } from './Piezo';
import { SongEditor } from './SongEditor';

export function PiezoSettings() {
	const { settings, setSettings } = useNodeSettings<PiezoData>();
	return (
		<>
			<PinSelect
				value={settings.pin}
				onValueChange={pin => setSettings({ pin })}
				filter={pin =>
					pin.supportedModes.includes(MODES.INPUT) && pin.supportedModes.includes(MODES.PWM)
				}
			/>

			<Select
				value={settings.type}
				onValueChange={(value: 'buzz' | 'song') => {
					let update: Partial<typeof settings> = { type: value };
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
					setSettings(update);
				}}
			>
				<SelectTrigger>{settings.type}</SelectTrigger>
				<SelectContent>
					<SelectItem value="buzz">Buzz</SelectItem>
					<SelectItem value="song">Song</SelectItem>
				</SelectContent>
			</Select>

			{settings.type === 'buzz' && (
				<>
					<Label htmlFor="duration" className="flex justify-between">
						Duration
						<span className="opacity-40 font-light">{settings.duration}ms</span>
					</Label>
					<Slider
						id="duration"
						defaultValue={[settings.duration]}
						min={100}
						max={2500}
						step={100}
						onValueChange={value => setSettings({ duration: value[0] })}
					/>
					<Label htmlFor="frequency" className="flex justify-between">
						Frequency
						<span className="opacity-40 font-light">{settings.frequency}Hz</span>
					</Label>
					<Slider
						id="frequency"
						defaultValue={[settings.frequency]}
						min={MIN_NOTE_FREQUENCY}
						max={MAX_NOTE_FREQUENCY}
						step={1}
						onValueChange={value => setSettings({ frequency: value[0] })}
					/>
					<div className="text-sm text-muted-foreground">
						Higher frequencies tend to get stuck longer in the piezo then the requested duration. If
						you experience this, try lowering the frequency or duration.
					</div>
				</>
			)}
			{settings.type === 'song' && (
				<>
					<Label htmlFor="tempo" className="flex justify-between">
						Tempo
						<span className="opacity-40 font-light">{settings.tempo}</span>
					</Label>
					<Slider
						id="tempo"
						defaultValue={[settings.tempo]}
						min={30}
						max={300}
						step={10}
						onValueChange={value => setSettings({ tempo: value[0] })}
					/>
					<MusicSheet song={settings.song} />
					<SongEditor song={settings.song} onSave={setSettings} />
				</>
			)}
		</>
	);
}
