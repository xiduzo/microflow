import { Badge } from '@microflow/ui';

export function Tag(props: { text: string }) {
	return <Badge>{props.text}</Badge>;
}
