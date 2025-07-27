import {
	Sheet,
	SheetContent,
	SheetDescription,
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
	SheetClose,
	SheetFooter,
	FormDescription,
	Icons,
} from '@microflow/ui';
import { useLocalStorage } from 'usehooks-ts';
import { useAppStore } from '../../stores/app';

const schema = Zod.object({
	ip: Zod.string()
		.regex(/^(?:\d{1,3}\.){3}\d{1,3}$/)
		.or(Zod.literal(''))
		.optional(),
});

type Schema = Zod.infer<typeof schema>;

export type AdvancedConfig = Schema;

export function AdvancedSettingsForm(props: Props) {
	const [config, setConfig] = useLocalStorage<Schema>('advanced-config', {
		ip: undefined,
	});
	const { setSettingsOpen } = useAppStore();

	const form = useForm<Schema>({
		resolver: zodResolver(schema),
		defaultValues: config,
	});

	function onSubmit(data: Schema) {
		setConfig(data);
		closeForm();
	}

	function closeForm() {
		setSettingsOpen(undefined);
		props.onClose?.();
	}

	return (
		<Sheet
			open={props.open}
			onOpenChange={opened => {
				if (opened) return;
				closeForm();
			}}
		>
			<SheetContent>
				<SheetHeader>
					<SheetTitle className='flex gap-2 items-center'>
						<Icons.Microchip size={16} />
						Microcontroller settings
					</SheetTitle>
					<SheetDescription>
						These settings will apply to any connected microcontroller.
					</SheetDescription>
				</SheetHeader>
				<Form {...form}>
					<form onSubmit={form.handleSubmit(onSubmit, console.log)} className='my-4 space-y-4'>
						<FormField
							control={form.control}
							name='ip'
							render={({ field }) => (
								<FormItem>
									<FormLabel>IP-address</FormLabel>
									<FormControl>
										<Input placeholder='192.168.2.26' {...field} />
									</FormControl>
									<FormMessage />
									<FormDescription>
										The IP-address your of your microcontroller running{' '}
										<a
											className='underline'
											href='https://github.com/firmata/arduino/tree/main/examples/StandardFirmataWiFi'
											target='_blank'
										>
											StandardFirmataWifi
										</a>
										. Leave blank if you want to connect via USB.
									</FormDescription>
								</FormItem>
							)}
						/>
						<SheetFooter>
							<SheetClose asChild>
								<Button variant='secondary'>Cancel</Button>
							</SheetClose>
							<Button type='submit'>Save changes</Button>
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
