import type { PiezoData, PiezoValueType } from '@microflow/components';
import { Icons } from '@microflow/ui';
import { Position } from '@xyflow/react';
import { Handle } from '../Handle';
import { BaseNode, NodeContainer, useNodeData, useNodeSettings } from '../Node';
import { DEFAULT_NOTE, DEFAULT_SONG, NOTES_AND_FREQUENCIES } from './constants';
import { useNodeValue } from '../../../../stores/node-data';
import { useEffect, useState } from 'react';
import { MODES } from '../../../../../common/types';
import { mapPinToPaneOption } from '../../../../../utils/pin';
import { FolderApi } from '@tweakpane/core';
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
	// @ts-expect-error PiezoData is not of type `Record<string, unknown>`
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
	// @ts-expect-error PiezoData is not of type `Record<string, unknown>`
	const { pane, settings, setHandlesToDelete } = useNodeSettings<PiezoData>();
	const pins = usePins();
	const [editorOpened, setEditorOpened] = useState(false);

	useEffect(() => {
		if (!pane) return;
		const initialType = settings.type;

		let settingsFolder: FolderApi | undefined;

		function addTypeBindings() {
			if (!pane) return;
			settingsFolder?.dispose();
			settingsFolder = pane.addFolder({
				title: 'settings',
				expanded: true,
				index: 2,
			});
			if (settings.type === 'buzz') {
				settingsFolder.addBinding(settings, 'duration', {
					min: 100,
					max: 2500,
					step: 100,
				});

				settingsFolder.addBinding(settings, 'frequency', {
					view: 'list',
					options: Array.from(NOTES_AND_FREQUENCIES.entries()).map(([note, frequency]) => ({
						text: note,
						value: frequency,
					})),
				});

				return;
			}

			settings.tempo = settings.tempo || 120;
			settings.song = settings.song || DEFAULT_SONG;
			settingsFolder.addBinding(settings, 'tempo', {
				min: 40,
				max: 240,
				step: 10,
			});
			settingsFolder
				.addButton({
					label: 'song',
					title: 'edit song',
				})
				.on('click', () => {
					setEditorOpened(true);
				});
		}

		const pinBinding = pane.addBinding(settings, 'pin', {
			view: 'list',
			disabled: !pins.length,
			label: 'pin',
			index: 0,
			options: pins
				.filter(
					pin => pin.supportedModes.includes(MODES.INPUT) && pin.supportedModes.includes(MODES.PWM),
				)
				.map(mapPinToPaneOption),
		});

		const typeBinding = pane.addBinding(settings, 'type', {
			view: 'list',
			index: 1,
			options: [
				{ text: 'buzz', value: 'buzz' },
				{ text: 'song', value: 'song' },
			],
		});

		typeBinding.on('change', ({ value }) => {
			addTypeBindings();

			if (value === initialType) setHandlesToDelete([]);
			else setHandlesToDelete(value === 'song' ? ['buzz'] : ['play']);
		});

		addTypeBindings();

		return () => {
			[settingsFolder, pinBinding, typeBinding].forEach(disposable => disposable?.dispose());
		};
	}, [pane, settings, pins, setHandlesToDelete]);

	if (!editorOpened) return null;
	if (settings.type === 'buzz') return null;

	return (
		<SongEditor
			song={settings.song}
			onClose={() => {
				setEditorOpened(false);
			}}
			onSave={data => {
				data.song = data.song;
				setEditorOpened(false);
			}}
		/>
	);
}

export const DEFAULT_FREQUENCY = NOTES_AND_FREQUENCIES.get(DEFAULT_NOTE);

// @ts-expect-error PiezoData is not of type `Record<string, unknown>`
type Props = BaseNode<PiezoData>;
Piezo.defaultProps = {
	data: {
		label: 'Piezo',
		duration: 500,
		frequency: DEFAULT_FREQUENCY!,
		pin: 11,
		type: 'buzz',
	} satisfies Props['data'],
};
