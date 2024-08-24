import { Textarea } from '@microflow/ui';
import { useUpdateNodeData } from '../../../hooks/nodeUpdater';
import {
	BaseNode,
	NodeContainer,
	NodeContent,
	NodeSettings,
	NodeValue,
} from './Node';

export function Note(props: Props) {
	const { updateNodeData } = useUpdateNodeData<NoteData>(props.id);

	return (
		<NodeContainer {...props}>
			<NodeContent>
				<NodeValue className="max-w-48 text-wrap">{props.data.value}</NodeValue>
			</NodeContent>
			<NodeSettings>
				<Textarea
					placeholder="Write your note here..."
					value={props.data.value}
					onChange={e => updateNodeData({ value: e.target.value }, false)}
				/>
				<Textarea
					placeholder="You can add extra info here..."
					value={props.data.extraInfo}
					onChange={e => updateNodeData({ extraInfo: e.target.value }, false)}
				/>
			</NodeSettings>
		</NodeContainer>
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
