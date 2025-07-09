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

	return (
		<section className="text-wrap w-64 text-center flex flex-col p-2 gap-1">
			<span>{data.note ?? ''}</span>
			<span className="text-xs text-muted-foreground">{data.extraInfo ?? ''}</span>
		</section>
	);
}

function Settings() {
	const { addBinding } = useNodeSettings<NoteData>();

	useEffect(() => {
		addBinding('note', { index: 0, view: 'textarea', rows: 3 });
		addBinding('extraInfo', { index: 1, label: 'Extra info', view: 'textarea', rows: 3 });
	}, [addBinding]);

	return null;
}

type NoteData = {
	extraInfo?: string;
	note: string;
};
type Props = BaseNode<NoteData>;
Note.defaultProps = {
	data: {
		group: 'flow',
		tags: ['information'],
		label: 'Note',
		note: 'New note',
		extraInfo: '',
		description: 'Leave a note for yourself or others',
	} satisfies Props['data'],
};
