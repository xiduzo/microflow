import { Badge } from '@microflow/ui';
import { PropsWithChildren } from 'react';
import { useDragAndDrop } from '../../../../providers/DragAndDropProvider';

export function DndBadge(props: PropsWithChildren & { id: string }) {
	const { dragging, setDragging, setHover } = useDragAndDrop();

	return (
		<Badge
			style={{ opacity: dragging === props.id ? 0.25 : 1 }}
			draggable
			onDragStart={setDragging(props.id)}
			onDragEnd={setDragging('')}
			onDragExit={setDragging('')}
			onDragEnter={setHover(props.id)}
			onDragLeave={setHover('')}
			onDrop={() => {
				setDragging('');
				setHover('');
			}}
			className="flex justify-between hover:cursor-grab"
			variant="secondary"
		>
			{props.children}
		</Badge>
	);
}
