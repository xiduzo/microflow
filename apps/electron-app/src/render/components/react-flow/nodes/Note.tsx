import { BaseNode, NodeContainer, useNodeData, useNodeSettings } from './Node';
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
	const data = useNodeData<NoteData>();

	return <section className="text-wrap w-64 text-center">{data.note ?? ''}</section>;
}

function Settings() {
	const { pane, settings } = useNodeSettings<NoteData>();

	useEffect(() => {
		if (!pane) return;

		pane.addBinding(settings, 'note', {
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
	note: string;
};
type Props = BaseNode<NoteData>;
Note.defaultProps = {
	data: {
		label: 'Note',
		note: 'New note',
		extraInfo: '',
	} satisfies Props['data'],
};
