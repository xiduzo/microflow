import {
	Button,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogClose,
	Form,
	FormControl,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
	Input,
	toast,
} from '@microflow/ui';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as Zod from 'zod';
import { useCollaborationActions } from '../../../stores/yjs';

const schema = Zod.object({
	roomName: Zod.string().min(1, 'Room name is required'),
});

type Schema = Zod.infer<typeof schema>;

type Props = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
};

export function JoinCollaborationDialog(props: Props) {
	const { connect } = useCollaborationActions();
	const form = useForm({
		resolver: zodResolver(schema),
		defaultValues: {
			roomName: '',
		},
	});

	function onSubmit(data: Schema) {
		connect(data.roomName, { isJoining: true }); // Pass options to indicate this is a join operation
		toast.success('Joining collaboration session...');
		form.reset();
		props.onOpenChange(false);
	}

	return (
		<Dialog open={props.open} onOpenChange={props.onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Join a collaboration session</DialogTitle>
					<DialogDescription>
						Enter the room name to join a collaboration session.
					</DialogDescription>
				</DialogHeader>
				<Form {...form}>
					<form onSubmit={form.handleSubmit(onSubmit)}>
						<fieldset className='mb-6'>
							<FormField
								control={form.control}
								name='roomName'
								render={({ field }) => (
									<FormItem>
										<FormLabel>Room name</FormLabel>
										<FormControl>
											<Input placeholder='Enter room name' {...field} />
										</FormControl>
										<FormMessage />
									</FormItem>
								)}
							/>
						</fieldset>
						<DialogFooter>
							<DialogClose asChild>
								<Button type='button' variant='secondary'>
									Cancel
								</Button>
							</DialogClose>
							<Button type='submit'>Join session</Button>
						</DialogFooter>
					</form>
				</Form>
			</DialogContent>
		</Dialog>
	);
}
