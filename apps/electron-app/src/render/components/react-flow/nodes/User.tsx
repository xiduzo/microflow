import { useNodeValue } from '../../../stores/node-data';
import { BaseNode, BlankNodeContainer, useNodeData } from './Node';
import { Icon } from '@microflow/ui';
import { Connection } from '@microflow/socket/client';

export function User(props: Props) {
	return (
		<BlankNodeContainer {...props} draggable={false} selectable={false}>
			<Value />
		</BlankNodeContainer>
	);
}

function Value() {
	const { user } = useNodeData<UserData>();

	return (
		<div className='group flex flex-row items-end justify-center'>
			<Icon icon='MousePointer2' fill='#ffcc00' stroke='#ffcc00' size={32}></Icon>
			<section className='text-xs translate-y-4 block px-1.5 py-0.5 rounded-md bg-[#ffcc00] group-hover:block'>
				{user.name}
			</section>
		</div>
	);
}

type UserData = {
	user: Connection;
};
type Props = BaseNode<UserData>;
User.defaultProps = {
	draggable: false,
	selectable: false,
	type: 'User',
	data: {
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

export type UserProps = Props;
