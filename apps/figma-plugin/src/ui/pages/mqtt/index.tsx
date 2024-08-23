import { MqttConfig } from '@microflow/mqtt-provider/client';
import {
	Button,
	Form,
	FormControl,
	FormDescription,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
	Icons,
	Input,
	useForm,
	Zod,
	zodResolver,
} from '@microflow/ui';
import { useEffect } from 'react';
import {
	adjectives,
	animals,
	uniqueNamesGenerator,
} from 'unique-names-generator';
import { LOCAL_STORAGE_KEYS, ShowToast } from '../../../common/types/Message';
import { PageContent, PageHeader } from '../../components/Page';
import { useLocalStorage } from '../../hooks/useLocalStorage';
import { useSetWindowSize } from '../../hooks/useSetWindowSize';
import { sendMessageToFigma } from '../../utils/sendMessageToFigma';

const schema = Zod.object({
	host: Zod.string().optional(),
	port: Zod.number({ coerce: true }).optional(),
	username: Zod.string().optional(),
	password: Zod.string().optional(),
	uniqueId: Zod.string()
		.min(5, 'Requires minimum of 5 characters')
		.regex(/^[a-zA-Z_]+$/, { message: 'Only letters and underscores allowed' }),
});

type Schema = Zod.infer<typeof schema>;

const defaultValues: Schema = {
	host: 'test.mosquitto.org',
	port: 8081,
	uniqueId: '',
};

export function Mqtt() {
	const [brokerSettings, setBrokerSettings] = useLocalStorage<MqttConfig>(
		LOCAL_STORAGE_KEYS.MQTT_CONNECTION,
	);

	const form = useForm<Schema>({
		resolver: zodResolver(schema),
		defaultValues: {
			...defaultValues,
			...(brokerSettings as Schema),
		},
	});

	useSetWindowSize({
		width: 400,
		height: 700 + Object.keys(form.formState.errors).length * 28,
	});

	function onSubmit(data: Schema) {
		setBrokerSettings(data);
		sendMessageToFigma(ShowToast('Broker settings saved!'));
	}

	function setRandomUniqueName() {
		form.clearErrors('uniqueId');
		form.setValue(
			'uniqueId',
			uniqueNamesGenerator({ dictionaries: [adjectives, animals] }),
		);
	}

	useEffect(() => {
		if (!brokerSettings) return;
		form.reset({
			...defaultValues,
			...(brokerSettings as Schema),
		});
	}, [brokerSettings, form.reset]);

	return (
		<>
			<PageHeader title="MQTT settings" />
			<PageContent>
				<Form {...form}>
					<form
						onSubmit={form.handleSubmit(onSubmit)}
						className="my-4 space-y-4"
					>
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
										<Button
											variant="ghost"
											type="button"
											onClick={setRandomUniqueName}
										>
											<Icons.Dices className="w-4 h-4" />
										</Button>
									</section>
									<FormDescription>
										This identifier allows you to send and receive variable
										values between this plugin and other MQTT clients, like{' '}
										<a
											className="underline"
											href="https://microflow.vercel.app/"
											target="_blank"
										>
											Microflow studio
										</a>
										.
									</FormDescription>
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
										<Input
											placeholder="************"
											type="password"
											{...field}
										/>
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>
						<Button type="submit" className="w-full">
							Save MQTT settings
						</Button>
						<div className="text-orange-500 text-sm">
							<Icons.TriangleAlert className="w-3.5 h-3.5 pb-0.5 inline-block mr-1" />
							This plugin will force a connection over <code>wss://</code>, make
							sure your settings will connect to an encrypted websocket.
						</div>
					</form>
				</Form>
			</PageContent>
		</>
	);
}
