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
import { HexColorPicker } from 'react-colorful';
import { useAppStore } from '../../../stores/app';
import { Zod } from '@microflow/ui';
import { getRandomUniqueUserName } from '../../../../common/unique';

const schema = Zod.object({
	name: Zod.string()
		.min(3, 'Requires minimum of 3 characters')
		.regex(/^[a-zA-Z0-9_]+$/, {
			message: 'Only letters, numbers and underscores allowed (no spaces)',
		}),
	color: Zod.string()
		.min(1, 'Color is required')
		.min(7, 'Color must be 7 characters')
		.max(7, 'Color must be 7 characters'),
});

type UserForm = Zod.infer<typeof schema>;

export function UserPanel() {
	const { user, setUser } = useAppStore();

	const form = useForm({
		resolver: zodResolver(schema),
		defaultValues: {
			name: user?.name ?? '',
			color: user?.color ?? '#ffcc00',
		},
		mode: 'onChange',
	});

	function setRandomUniqueName() {
		const newName = getRandomUniqueUserName();
		form.clearErrors('name');
		form.setValue('name', newName);
	}

	const submit = (data: UserForm) => {
		setUser(data);
	};

	return (
		<Popover
			onOpenChange={isOpen => {
				if (isOpen) return;
				if (!form.formState.isValid) return form.reset();
				if (!form.formState.isDirty) return;
				const values = form.getValues();
				submit(values);
			}}
		>
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
					<form className='mt-4 space-y-2' onSubmit={form.handleSubmit(submit)}>
						<FormField
							control={form.control}
							name='name'
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
						<FormField
							control={form.control}
							name='color'
							render={({ field }) => (
								<FormItem>
									<FormLabel>Your cursor color</FormLabel>
									<HexColorPicker
										className='w-full'
										color={field.value}
										onChange={color => field.onChange(color)}
									/>
								</FormItem>
							)}
						/>
					</form>
				</Form>
			</PopoverContent>
		</Popover>
	);
}
