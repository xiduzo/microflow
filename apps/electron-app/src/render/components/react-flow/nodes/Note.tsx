import { Textarea } from '@microflow/ui';
import {
	BaseNode,
	NodeContainer,
	NodeContent,
	NodeSettings,
	NodeValue,
	useNodeSettings,
} from './Node';

export function Note(props: Props) {
	return (
		<NodeContainer {...props}>
			<NodeContent>
				<NodeValue className="max-w-48 text-wrap">{props.data.value}</NodeValue>
			</NodeContent>
			<NodeSettings>
				<NoteSettings />
			</NodeSettings>
		</NodeContainer>
	);
}

function NoteSettings() {
	const { settings, setSettings } = useNodeSettings<NoteData>();

	return (
		<>
			<Textarea
				placeholder="Write your note here..."
				value={settings.value}
				onChange={e => setSettings({ value: e.target.value })}
			/>
			<Textarea
				placeholder="You can add extra info here..."
				value={settings.extraInfo}
				onChange={e => setSettings({ extraInfo: e.target.value })}
			/>
		</>
	);
}

type NoteData = {
	extraInfo?: string;
	value: string;
};
type Props = BaseNode<NoteData, string>;
export const DEFAULT_NOTE_DATA: Props['data'] = {
	label: 'Note',
	value: 'New note',
};
