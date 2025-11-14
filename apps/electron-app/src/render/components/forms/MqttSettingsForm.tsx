import {
	Button,
	Field,
	FieldDescription,
	FieldLabel,
	Form,
	FormControl,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
	Icons,
	Input,
	Sheet,
	SheetClose,
	SheetContent,
	SheetDescription,
	SheetFooter,
	SheetHeader,
	SheetTitle,
	Switch,
	useForm,
	Zod,
	zodResolver,
} from '@microflow/ui';
import { useAppStore } from '../../stores/app';
import { MqttConfig } from '@microflow/mqtt-provider/client';

const schema = Zod.object({
	host: Zod.string().optional(),
	port: Zod.number().optional(),
	username: Zod.string().optional(),
	password: Zod.string().optional(),
	protocol: Zod.enum(['ws', 'wss']).default('wss'),
});

type Schema = Zod.infer<typeof schema>;

export function MqttSettingsForm(props: Props) {
	const { user, mqttConfig, setMqttConfig } = useAppStore();

	const form = useForm({
		resolver: zodResolver(schema),
		defaultValues: {
			host: mqttConfig?.host,
			port: mqttConfig?.port,
			username: mqttConfig?.username,
			password: mqttConfig?.password as string,
			protocol: (mqttConfig as MqttConfig & { protocol: 'ws' | 'wss' })?.protocol as 'ws' | 'wss',
		},
	});

	const { setSettingsOpen } = useAppStore();

	function onSubmit(data: Schema) {
		setMqttConfig(data);
		setSettingsOpen(undefined);
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
						<Icons.Globe size={16} />
						Broker settings
					</SheetTitle>
					<SheetDescription>
						When using Figma nodes, make sure to configure the same MQTT broker in the{' '}
						<a
							className='underline'
							href='https://www.figma.com/community/plugin/1373258770799080545/figma-hardware-bridge'
							target='_blank'
						>
							Figma plugin
						</a>
						.
					</SheetDescription>
				</SheetHeader>
				<Form {...form}>
					<form onSubmit={form.handleSubmit(onSubmit)} className='my-4 space-y-4'>
						<Field>
							<FieldLabel htmlFor='checkout-7j9-card-name-43j'>Identifier</FieldLabel>
							<Input id='checkout-7j9-card-name-43j' value={user?.name} disabled />
							<FieldDescription>
								This is configured in your{' '}
								<span
									className='underline cursor-pointer'
									onClick={event => {
										event.preventDefault();
										setSettingsOpen('user-settings');
									}}
								>
									user settings
								</span>
							</FieldDescription>
						</Field>
						<FormField
							control={form.control}
							name='host'
							render={({ field }) => (
								<FormItem>
									<FormLabel>Host</FormLabel>
									<FormControl>
										<Input placeholder='test.mosquitto.org' {...field} />
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>
						<FormField
							control={form.control}
							name='port'
							render={({ field }) => (
								<FormItem>
									<FormLabel>Port</FormLabel>
									<FormControl>
										<Input
											placeholder='8081'
											type='number'
											{...field}
											onChange={e => {
												const value = e.target.value;
												field.onChange(value === '' ? undefined : Number(value));
											}}
										/>
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>
						<FormField
							control={form.control}
							name='username'
							render={({ field }) => (
								<FormItem>
									<FormLabel>Username</FormLabel>
									<FormControl>
										<Input placeholder='xiduzo' {...field} />
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>
						<FormField
							control={form.control}
							name='password'
							render={({ field }) => (
								<FormItem>
									<FormLabel>Password</FormLabel>
									<FormControl>
										<Input placeholder='************' type='password' {...field} />
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>
						<FormField
							control={form.control}
							name='protocol'
							render={({ field }) => (
								<FormItem className='flex justify-between items-center space-y-0'>
									<FormLabel className='grow'>Encrypted (wss)</FormLabel>
									<FormControl>
										<Switch
											{...field}
											onCheckedChange={checked => {
												form.setValue('protocol', checked ? 'wss' : 'ws');
											}}
											defaultChecked={form.getValues('protocol') === 'wss'}
										/>
									</FormControl>
									<FormMessage />
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
