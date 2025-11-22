import {
	useForm,
	zodResolver,
	Zod,
	Form,
	Button,
	FormControl,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
	Input,
	Icons,
	toast,
} from '@microflow/ui';
import { useAppStore } from '../../stores/app';
import { getRandomUniqueUserName } from '../../../common/unique';
import { HexColorPicker } from 'react-colorful';

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

type Schema = Zod.infer<typeof schema>;

export function UserSettingsForm() {
	const { user, setUser } = useAppStore();

	const form = useForm({
		resolver: zodResolver(schema),
		mode: 'onChange',
		reValidateMode: 'onChange',
		defaultValues: {
			name: user?.name ?? '',
			color: user?.color ?? '#ffcc00',
		},
	});

	const submit = (data: Schema) => {
		setUser(data);
		form.reset(data);
		toast.success('User settings saved', {
			description: 'Your user settings have been updated successfully.',
		});
	};

	return (
		<Form {...form}>
			<form className='space-y-4' onSubmit={form.handleSubmit(submit)}>
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
								<Button
									variant='ghost'
									type='button'
									onClick={() => {
										form.setValue('name', getRandomUniqueUserName(), {
											shouldDirty: true,
											shouldValidate: true,
											shouldTouch: true,
										});
									}}
								>
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
				<div className='flex justify-end gap-2 pt-2'>
					<Button type='submit' disabled={!form.formState.isDirty || !form.formState.isValid}>
						Save changes
					</Button>
				</div>
			</form>
		</Form>
	);
}
