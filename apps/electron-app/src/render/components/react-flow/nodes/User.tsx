import { XYPosition } from '@xyflow/react';
import { useNodeValue } from '../../../stores/node-data';
import { BaseNode, BlankNodeContainer } from './Node';
import { Icon } from '@ui/index';

export function User(props: Props) {
	return (
		<BlankNodeContainer {...props} draggable={false} selectable={false}>
			<Value />
		</BlankNodeContainer>
	);
}

function Value() {
	const value = useNodeValue<UserData>({
		position: { x: 0, y: 0 },
		user: { id: '', name: 'foo bar' },
	});

	console.log({ value });
	return (
		<div className="group flex flex-row items-end justify-center">
			<Icon icon="MousePointer2" fill="#ffcc00" stroke="#ffcc00" size={32}></Icon>
			<section className="text-xs translate-y-4 block px-1.5 py-0.5 rounded-md bg-[#ffcc00] group-hover:block">
				{value.user.name}
			</section>
		</div>
	);
}

type UserData = {
	position: XYPosition;
	user: {
		id: string;
		name: string;
	};
};
type Props = BaseNode<UserData>;
User.defaultProps = {
	draggable: false,
	data: {
		position: { x: 0, y: 0 },
		user: {
			id: 'user-id',
			name: 'User Name',
		},
		group: 'internal',
		label: 'User',
		tags: [],
		description: 'Used to display an user cursor position when collaborating on a flow',
	} satisfies Props['data'],
};
