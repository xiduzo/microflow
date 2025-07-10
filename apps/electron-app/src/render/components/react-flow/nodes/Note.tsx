import { BaseNode, NodeContainer, NodeSettings, useNodeData } from './Node';

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
	const data = useNodeData<NoteData>();

	return (
		<NodeSettings
			settings={{
				note: { value: data.note!, label: 'Note', rows: 3 },
				extraInfo: { value: data.extraInfo!, label: 'Extra info', rows: 3 },
			}}
		/>
	);
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
