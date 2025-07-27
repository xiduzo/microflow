import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogDescription,
	Form,
	FormField,
	FormItem,
	FormLabel,
	FormControl,
	Input,
	FormMessage,
	DialogFooter,
	DialogClose,
	zodResolver,
	useForm,
	toast,
	Button,
} from '@microflow/ui';
import * as Zod from 'zod';

const schema = Zod.object({
	code: Zod.string().min(1, 'Tunnel code is required'),
});

type Schema = Zod.infer<typeof schema>;

export function JoinSessionDialog(props: Props) {
	const form = useForm({
		resolver: zodResolver(schema),
		defaultValues: {
			code: '',
		},
	});

	function onSubmit(data: Schema) {
		window.electron.ipcRenderer.send('ipc-live-share', {
			type: 'join',
			code: data.code,
		});
		toast.info('Joining live share...');
		form.reset();
		props.onOpenChange(false);
	}

	return (
		<Dialog open={props.open} onOpenChange={props.onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Join a collaboration session</DialogTitle>
					<DialogDescription>
						Enter the session code to join a collaboration session.
					</DialogDescription>
				</DialogHeader>
				<Form {...form}>
					<form onSubmit={form.handleSubmit(onSubmit)}>
						<fieldset className='mb-6'>
							<FormField
								control={form.control}
								name='code'
								render={({ field }) => (
									<FormItem>
										<FormLabel>Session code</FormLabel>
										<FormControl>
											<Input placeholder='Enter session code or URL' {...field} />
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

type Props = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
};
