import {
	Badge,
	Button,
	Dock,
	DockIcon,
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
	Separator,
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
	useForm,
	Zod,
	zodResolver,
} from '@microflow/ui';
import { useCollaborationActions } from '../../../stores/yjs';
import { useReactFlow } from '@xyflow/react';
import { HexColorPicker } from 'react-colorful';
import { getRandomUniqueUserName } from '../../../../common/unique';
import { useAppStore } from '../../../stores/app';

export function DockPanel() {
	return (
		<TooltipProvider>
			<Dock direction='middle'>
				<AccountControls />
				<DockIcon className='relative'>
					<Button variant='ghost' size='icon'>
						<Icon icon='Share2' className='h-4 w-4' />
					</Button>
				</DockIcon>
				<DockIcon className='relative'>
					<Button variant='ghost' size='icon'>
						<Icon icon='Microchip' className='h-4 w-4' />
					</Button>
				</DockIcon>
				<Separator orientation='vertical' className='h-full' />
				<UndoRedoControls />
				<DockIcon>
					<Button variant='ghost' size='icon'>
						<Icon icon='PackagePlus' className='h-4 w-4' />
					</Button>
				</DockIcon>
				<Separator orientation='vertical' className='h-full' />
				<ZoomControls />
			</Dock>
		</TooltipProvider>
	);
}

function UndoRedoControls() {
	const { undo, redo, canUndo, canRedo } = useCollaborationActions();

	return (
		<>
			<Tooltip>
				<TooltipTrigger>
					<DockIcon>
						<Button variant='ghost' size='icon' disabled={!canUndo()} onClick={undo}>
							<Icon icon='Undo' className='h-4 w-4' />
						</Button>
					</DockIcon>
				</TooltipTrigger>
				<TooltipContent>Undo</TooltipContent>
			</Tooltip>
			<Tooltip>
				<TooltipTrigger>
					<DockIcon>
						<Button variant='ghost' size='icon' disabled={!canRedo()} onClick={redo}>
							<Icon icon='Redo' className='h-4 w-4' />
						</Button>
					</DockIcon>
				</TooltipTrigger>
				<TooltipContent>Redo</TooltipContent>
			</Tooltip>
		</>
	);
}

function ZoomControls() {
	const { zoomIn, zoomOut, fitView } = useReactFlow();
	return (
		<>
			<Tooltip>
				<TooltipTrigger>
					<DockIcon>
						<Button variant='ghost' size='icon' onClick={() => zoomIn({ duration: 150 })}>
							<Icon icon='ZoomIn' className='h-4 w-4' />
						</Button>
					</DockIcon>
				</TooltipTrigger>
				<TooltipContent>Zoom in</TooltipContent>
			</Tooltip>
			<Tooltip>
				<TooltipTrigger>
					<DockIcon>
						<Button variant='ghost' size='icon' onClick={() => zoomOut({ duration: 150 })}>
							<Icon icon='ZoomOut' className='h-4 w-4' />
						</Button>
					</DockIcon>
				</TooltipTrigger>
				<TooltipContent>Zoom out</TooltipContent>
			</Tooltip>
			<Tooltip>
				<TooltipTrigger>
					<DockIcon>
						<Button variant='ghost' size='icon' onClick={() => fitView({ duration: 300 })}>
							<Icon icon='Fullscreen' className='h-4 w-4' />
						</Button>
					</DockIcon>
				</TooltipTrigger>
				<TooltipContent>Fit view</TooltipContent>
			</Tooltip>
		</>
	);
}

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

function AccountControls() {
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
		<DockIcon>
			<Popover
				onOpenChange={isOpen => {
					if (isOpen) return;
					if (!form.formState.isValid) return form.reset();
					if (!form.formState.isDirty) return;
					const values = form.getValues();
					submit(values);
				}}
			>
				<PopoverTrigger>
					<Tooltip>
						<TooltipTrigger>
							<Button variant='ghost' size='icon'>
								<Icon icon='UserIcon' className='h-4 w-4' />
							</Button>
						</TooltipTrigger>
						<TooltipContent>User settings</TooltipContent>
					</Tooltip>
				</PopoverTrigger>
				<PopoverContent>
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
		</DockIcon>
	);
}
