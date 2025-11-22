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
	Switch,
	useForm,
	Zod,
	zodResolver,
	toast,
} from '@microflow/ui';
import { useAppStore } from '../../stores/app';
import { MqttConfig } from '@microflow/mqtt-provider/client';

const schema = Zod.object({
	host: Zod.url().or(Zod.ipv4()),
	port: Zod.number().min(0),
	username: Zod.string().optional(),
	password: Zod.string().optional(),
	protocol: Zod.enum(['ws', 'wss']).default('wss'),
});

type Schema = Zod.infer<typeof schema>;

export function MqttSettingsForm() {
	const { user, mqttConfig, setMqttConfig, setSettingsOpen } = useAppStore();

	const form = useForm({
		resolver: zodResolver(schema),
		mode: 'onChange',
		reValidateMode: 'onChange',
		defaultValues: {
			host: mqttConfig?.host,
			port: mqttConfig?.port,
			username: mqttConfig?.username,
			password: mqttConfig?.password as string,
			protocol: (mqttConfig as MqttConfig & { protocol: 'ws' | 'wss' })?.protocol as 'ws' | 'wss',
		},
	});

	function onSubmit(data: Schema) {
		setMqttConfig(data);
		form.reset(data);
		toast.success('MQTT settings saved', {
			description: 'Your MQTT broker settings have been updated successfully.',
		});
	}

	return (
		<div className='space-y-4'>
			<p className='text-sm text-muted-foreground'>
				When using Figma nodes, make sure to configure the same MQTT broker in the{' '}
				<a
					className='underline'
					href='https://www.figma.com/community/plugin/1373258770799080545/figma-hardware-bridge'
					target='_blank'
				>
					Figma plugin
				</a>
				.
			</p>
			<Form {...form}>
				<form onSubmit={form.handleSubmit(onSubmit)} className='space-y-4'>
					<Field>
						<FieldLabel htmlFor='checkout-7j9-card-name-43j'>Identifier</FieldLabel>
						<Input id='checkout-7j9-card-name-43j' value={user?.name} disabled />
						<FieldDescription>This is configured in your user settings</FieldDescription>
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
					<div className='flex justify-end gap-2 pt-2'>
						<Button type='submit' disabled={!form.formState.dirtyFields || !form.formState.isValid}>
							Save changes
						</Button>
					</div>
				</form>
			</Form>
		</div>
	);
}
