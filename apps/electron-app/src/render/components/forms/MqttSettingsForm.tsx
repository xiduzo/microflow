import {
	Button,
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
import { adjectives, animals, uniqueNamesGenerator } from 'unique-names-generator';
import { useLocalStorage } from 'usehooks-ts';
import { useAppStore } from '../../stores/app';

const schema = Zod.object({
	host: Zod.string().optional(),
	port: Zod.number({ coerce: true }).optional(),
	username: Zod.string().optional(),
	password: Zod.string().optional(),
	uniqueId: Zod.string()
		.min(5, 'Requires minimum of 5 characters')
		.regex(/^[a-zA-Z_]+$/, { message: 'Only letters and underscores allowed' }),
	protocol: Zod.enum(['ws', 'wss']).default('wss'),
});

type Schema = Zod.infer<typeof schema>;

export function MqttSettingsForm(props: Props) {
	const [mqttConfig, setMqttConfig] = useLocalStorage<Schema | undefined>('mqtt-config', {
		uniqueId: uniqueNamesGenerator({ dictionaries: [adjectives, animals] }),
		host: 'test.mosquitto.org',
		port: 8081,
		protocol: 'wss',
	});

	const form = useForm<Schema>({
		resolver: zodResolver(schema),
		defaultValues: mqttConfig,
	});

	const { setSettingsOpen } = useAppStore();

	function setRandomUniqueName() {
		form.clearErrors('uniqueId');
		form.setValue('uniqueId', uniqueNamesGenerator({ dictionaries: [adjectives, animals] }));
	}

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
					<SheetTitle className="flex gap-2 items-center">
						<Icons.Globe size={16} />
						Broker settings
					</SheetTitle>
					<SheetDescription>
						When using Figma nodes, make sure to configure the same MQTT broker in the{' '}
						<a
							className="underline"
							href="https://www.figma.com/community/plugin/1373258770799080545/figma-hardware-bridge"
							target="_blank"
						>
							Figma plugin
						</a>
						.
					</SheetDescription>
				</SheetHeader>
				<Form {...form}>
					<form onSubmit={form.handleSubmit(onSubmit)} className="my-4 space-y-4">
						<FormField
							control={form.control}
							name="uniqueId"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Identifier</FormLabel>
									<section className="flex items-center space-x-2">
										<FormControl>
											<Input placeholder="Your unique identifier" {...field} />
										</FormControl>
										<Button variant="ghost" type="button" onClick={setRandomUniqueName}>
											<Icons.Dices className="w-4 h-4" />
										</Button>
									</section>
									<FormMessage />
								</FormItem>
							)}
						/>
						<FormField
							control={form.control}
							name="host"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Host</FormLabel>
									<FormControl>
										<Input placeholder="test.mosquitto.org" {...field} />
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>
						<FormField
							control={form.control}
							name="port"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Port</FormLabel>
									<FormControl>
										<Input placeholder="8081" type="number" {...field} />
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>
						<FormField
							control={form.control}
							name="username"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Username</FormLabel>
									<FormControl>
										<Input placeholder="xiduzo" {...field} />
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>
						<FormField
							control={form.control}
							name="password"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Password</FormLabel>
									<FormControl>
										<Input placeholder="************" type="password" {...field} />
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>
						<FormField
							control={form.control}
							name="protocol"
							render={({ field }) => (
								<FormItem className="flex justify-between items-center space-y-0">
									<FormLabel className="grow">Encrypted (wss)</FormLabel>
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
								<Button variant="secondary">Cancel</Button>
							</SheetClose>
							<Button type="submit">Save changes</Button>
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
