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
	FormDescription,
	Icons,
	Alert,
	AlertTitle,
	AlertDescription,
	TooltipTrigger,
	TooltipContent,
	Tooltip,
	toast,
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

export function AdvancedSettingsForm() {
	const [config, setConfig] = useLocalStorage<Schema>('advanced-config', {
		ip: undefined,
	});

	const form = useForm<Schema>({
		resolver: zodResolver(schema),
		defaultValues: config,
	});

	function onSubmit(data: Schema) {
		setConfig(data);
		form.reset(data);
		toast.success('Microcontroller settings saved', {
			description: 'Your microcontroller settings have been updated successfully.',
		});
	}

	function openUrl(url: string) {
		window.open(url, '_blank');
	}

	return (
		<div className='space-y-8'>
			<Alert
				className='cursor-pointer hover:bg-muted-foreground/5 transition-all'
				onClick={() =>
					openUrl('https://github.com/firmata/arduino/tree/main/examples/StandardFirmataWiFi')
				}
			>
				<AlertTitle className='flex items-center justify-between gap-2'>
					StandardFirmataWifi
					<Icons.ExternalLink size={16} />
				</AlertTitle>
				<AlertDescription className='text-muted-foreground'>
					When connecting over WiFi, you will need to flash and configure this library on your
					microcontroller.
				</AlertDescription>
			</Alert>
			<Alert
				variant='destructive'
				className='cursor-pointer hover:bg-red-500/20 transition-all bg-red-500/10 text-red-500'
				onClick={() => openUrl('https://github.com/ajfisher/node-pixel/tree/master/firmware')}
			>
				<AlertTitle className='flex items-center justify-between gap-2'>
					LED strip control
					<Icons.ExternalLink size={16} />
				</AlertTitle>
				<AlertDescription>
					If you need to control a LED strip over WiFi, add the <code>node-pixel firmare</code> to{' '}
					<code>StandardFirmataWifi</code>
				</AlertDescription>
			</Alert>
			<Form {...form}>
				<form onSubmit={form.handleSubmit(onSubmit, console.log)} className='space-y-4'>
					<FormField
						control={form.control}
						name='ip'
						render={({ field }) => (
							<FormItem>
								<FormLabel className='flex items-center gap-2 justify-between'>
									IP-address
									<Tooltip>
										<TooltipTrigger className='cursor-help'>
											<Icons.CircleQuestionMark />
										</TooltipTrigger>
										<TooltipContent>
											The IP-address of your microcontroller running StandardFirmataWifi.
										</TooltipContent>
									</Tooltip>
								</FormLabel>
								<FormControl>
									<Input placeholder='192.168.2.26' {...field} />
								</FormControl>
								<FormMessage />
								<FormDescription>Leave blank if you want to connect via USB.</FormDescription>
							</FormItem>
						)}
					/>
					<div className='flex justify-end gap-2 pt-2'>
						<Button type='submit'>Save changes</Button>
					</div>
				</form>
			</Form>
		</div>
	);
}
