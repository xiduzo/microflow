import { Button } from '@microflow/ui';
import { Undo, Redo } from 'lucide-react';
import { useCollaborationActions } from '../../../stores/yjs';

export function UndoRedoControls() {
	const { undo, redo, canUndo, canRedo } = useCollaborationActions();

	return (
		<div className='flex gap-1'>
			<Button
				variant='outline'
				size='sm'
				onClick={undo}
				disabled={!canUndo()}
				title='Undo my actions (Ctrl+Z)'
			>
				<Undo className='h-4 w-4' />
			</Button>
			<Button
				variant='outline'
				size='sm'
				onClick={redo}
				disabled={!canRedo()}
				title='Redo my actions (Ctrl+Y)'
			>
				<Redo className='h-4 w-4' />
			</Button>
		</div>
	);
}
