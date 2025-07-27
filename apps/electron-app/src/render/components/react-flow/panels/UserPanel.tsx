import {
	Button,
	Form,
	FormControl,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
	Icon,
	Icons,
	Input,
	Popover,
	PopoverContent,
	PopoverTrigger,
	useForm,
	zodResolver,
} from '@microflow/ui';
import { useAppStore } from '../../../stores/app';
import { Zod } from '@microflow/ui';
import { getRandomUniqueUserName } from '../../../../common/unique';
import { useEffect } from 'react';

const schema = Zod.object({
	uniqueId: Zod.string()
		.min(3, 'Requires minimum of 3 characters')
		.regex(/^[a-zA-Z0-9_]+$/, {
			message: 'Only letters, numbers and underscores allowed (no spaces)',
		}),
});

type Schema = Zod.infer<typeof schema>;

export function UserPanel() {
	const { user, setUser } = useAppStore();

	const form = useForm<Schema>({
		resolver: zodResolver(schema),
		defaultValues: {
			uniqueId: user?.name ?? '',
		},
		mode: 'onChange',
	});

	const userName = form.watch('uniqueId');

	function setRandomUniqueName() {
		const newName = getRandomUniqueUserName();
		form.clearErrors('uniqueId');
		form.setValue('uniqueId', newName);
		setUser({ name: newName });
	}

	useEffect(() => {
		if (userName && userName !== user?.name) {
			setUser({ name: userName });
		}
	}, [userName, setUser, user?.name]);

	return (
		<Popover>
			<PopoverTrigger asChild>
				<Button size='icon' variant='ghost'>
					<Icon icon='User' />
				</Button>
			</PopoverTrigger>
			<PopoverContent align='end'>
				<section className='flex flex-col space-y-2'>
					<h1 className='leading-none font-medium'>Identifier</h1>
					<p className='text-xs text-muted-foreground'>
						This identifier will be used to identify you in the live share and MQTT sessions.
					</p>
				</section>
				<Form {...form}>
					<form
						className='mt-4'
						onSubmit={form.handleSubmit(data => {
							setUser({ name: data.uniqueId });
						})}
					>
						<FormField
							control={form.control}
							name='uniqueId'
							render={({ field }) => (
								<FormItem>
									<FormLabel>Your identifier</FormLabel>
									<section className='flex items-center space-x-2'>
										<FormControl>
											<Input placeholder='Your unique identifier' {...field} />
										</FormControl>
										<Button variant='ghost' type='button' onClick={setRandomUniqueName}>
											<Icons.Dices className='w-4 h-4' />
										</Button>
									</section>
									<FormMessage />
								</FormItem>
							)}
						/>
					</form>
				</Form>
			</PopoverContent>
		</Popover>
	);
}
