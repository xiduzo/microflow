import {
	Sheet,
	SheetContent,
	SheetHeader,
	SheetTitle,
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
	SheetFooter,
	SheetClose,
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

export function UserSettingsForm(props: Props) {
	const { user, setUser, setSettingsOpen } = useAppStore();

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

	const submit = (data: Schema) => {
		setUser(data);
		closeForm();
	};

	function closeForm() {
		setSettingsOpen(undefined);
		props.onClose?.();
	}

	return (
		<Sheet
			open={props.open}
			onOpenChange={opened => {
				closeForm();
			}}
		>
			<SheetContent>
				<SheetHeader>
					<SheetTitle className='flex gap-2 items-center'>
						<Icons.User />
						User settings
					</SheetTitle>
				</SheetHeader>
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
						<SheetFooter>
							<SheetClose asChild>
								<Button variant='secondary'>Cancel</Button>
							</SheetClose>
							<Button type='submit' disabled={!form.formState.isDirty || !form.formState.isValid}>
								Save changes
							</Button>
						</SheetFooter>
					</form>
				</Form>
			</SheetContent>
		</Sheet>
	);
}

type Props = {
	open: boolean;
	onClose?: () => void;
};
