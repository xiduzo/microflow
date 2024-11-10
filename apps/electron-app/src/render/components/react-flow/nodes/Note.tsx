import { BaseNode, NodeContainer, useNode, useNodeSettingsPane } from './Node';
import { useEffect } from 'react';

export function Note(props: Props) {
	return (
		<NodeContainer {...props}>
			<Value />
			<Settings />
		</NodeContainer>
	);
}

function Value() {
	const { data } = useNode<NoteData>();

	return <section className="text-wrap w-64 text-center">{data.value ?? ''}</section>;
}

function Settings() {
	const { pane, settings } = useNodeSettingsPane<NoteData>();

	useEffect(() => {
		if (!pane) return;

		pane.addBinding(settings, 'value', {
			index: 0,
			view: 'textarea',
			rows: 3,
		});
		pane.addBinding(settings, 'extraInfo', {
			index: 1,
			label: 'Extra info',
			view: 'textarea',
			rows: 3,
		});
	}, [pane, settings]);

	return null;
}

type NoteData = {
	extraInfo?: string;
	value: string;
};
type Props = BaseNode<NoteData, string>;
export const DEFAULT_NOTE_DATA: Props['data'] = {
	label: 'Note',
	value: 'New note',
	extraInfo: '',
};
