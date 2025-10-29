import {
	Badge,
	Button,
	Dock,
	DockIcon,
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuShortcut,
	DropdownMenuTrigger,
	Form,
	FormControl,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
	Icon,
	Icons,
	Input,
	Item,
	ItemActions,
	ItemContent,
	ItemDescription,
	ItemTitle,
	Kbd,
	Popover,
	PopoverContent,
	PopoverTrigger,
	Separator,
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
	SheetTrigger,
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
	useForm,
	Zod,
	zodResolver,
} from '@microflow/ui';
import { useCollaborationActions, useCollaborationState } from '../../../stores/yjs';
import { useReactFlow } from '@xyflow/react';
import { HexColorPicker } from 'react-colorful';
import { getRandomUniqueUserName } from '../../../../common/unique';
import { useAppStore } from '../../../stores/app';
import { KbdAccelerator } from '../../KeyboardShortcut';
import { useShallow } from 'zustand/shallow';
import { useNewNodeStore } from '../../../stores/new-node';
import { useState } from 'react';

export function DockPanel() {
	const { undo, redo, canUndo, canRedo } = useCollaborationActions();
	const { zoomIn, zoomOut, fitView } = useReactFlow();
	const setOpen = useNewNodeStore(useShallow(state => state.setOpen));

	const [settingsOpen, setSettingsOpen] = useState(false);
	const [collaborateOpen, setCollaborateOpen] = useState(false);

	return (
		<Dock>
			<DockIcon>
				<Settings />
			</DockIcon>
			<DockIcon>
				<DropdownMenu onOpenChange={setCollaborateOpen}>
					<DropdownMenuTrigger>
						<Button variant={collaborateOpen ? 'default' : 'ghost'} size='icon'>
							<Icon icon='Share2' />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent>
						<DropdownMenuItem>
							<Icon icon='Microchip' />
							Microcontroller settings
						</DropdownMenuItem>
						<DropdownMenuItem>
							<Icon icon='AArrowDown' />
							MQTT settings
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</DockIcon>
			<Separator orientation='vertical' className='h-full' />
			<DockIcon>
				<Button variant='ghost' size='icon' disabled={!canUndo()} onClick={undo}>
					<Icon icon='Undo' />
				</Button>
			</DockIcon>
			<DockIcon>
				<Button variant='ghost' size='icon' disabled={!canRedo()} onClick={redo}>
					<Icon icon='Redo' />
				</Button>
			</DockIcon>
			<Separator orientation='vertical' className='h-full' />
			<DockIcon>
				<Button variant='ghost' size='icon' onClick={() => setOpen(true)}>
					<Icon icon='Plus' />
				</Button>
			</DockIcon>
			<Separator orientation='vertical' className='h-full' />
			<DockIcon>
				<Button variant='ghost' size='icon' onClick={() => zoomIn({ duration: 150 })}>
					<Icon icon='ZoomIn' />
				</Button>
			</DockIcon>
			<DockIcon>
				<Button variant='ghost' size='icon' onClick={() => zoomOut({ duration: 150 })}>
					<Icon icon='ZoomOut' />
				</Button>
			</DockIcon>
			<DockIcon>
				<Button variant='ghost' size='icon' onClick={() => fitView({ duration: 300 })}>
					<Icon icon='Fullscreen' />
				</Button>
			</DockIcon>
		</Dock>
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
								<Icon icon='UserIcon' />
							</Button>
						</TooltipTrigger>
						<TooltipContent>User settings</TooltipContent>
					</Tooltip>
				</PopoverTrigger>
				<PopoverContent>
					<section className='flex flex-col space-y-2'>
						<h1 className='leading-none font-medium'>Identifier</h1>
						<p className='text-xs text-muted-foreground'>
							This identifier will be used to identify you in shared sessions.
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

function Settings() {
	const [settingsOpen, setSettingsOpen] = useState(false);

	return (
		<DropdownMenu onOpenChange={setSettingsOpen}>
			<DropdownMenuTrigger>
				<Button variant={settingsOpen ? 'default' : 'ghost'} size='icon'>
					<Icon icon='Settings' />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent>
				<DropdownMenuItem>
					<Icon icon='Microchip' />
					Microcontroller settings
				</DropdownMenuItem>
				<DropdownMenuItem>
					<Icon icon='AArrowDown' />
					MQTT settings
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function CollaborateControls() {
	const { status, peers } = useCollaborationState();

	return (
		<DockIcon>
			<DropdownMenu>
				<DropdownMenuTrigger>
					<Tooltip>
						<TooltipTrigger>
							<Button variant='ghost' size='icon'>
								<Icon icon='Share2' />
							</Button>
						</TooltipTrigger>
						<TooltipContent>Collaborate</TooltipContent>
					</Tooltip>
				</DropdownMenuTrigger>
				<DropdownMenuContent>
					{status.type === 'disconnected' && (
						<>
							<DropdownMenuItem>
								<Icon icon='Radio' />
								Start session
							</DropdownMenuItem>
							<DropdownMenuItem>
								<Icon icon='RadioReceiver' />
								Join session
							</DropdownMenuItem>
						</>
					)}
				</DropdownMenuContent>
			</DropdownMenu>
		</DockIcon>
	);
}

function NodeControls() {
	return (
		<>
			<Tooltip>
				<TooltipTrigger>
					<DockIcon>
						<Button variant='ghost' size='icon'>
							<Icon icon='Microchip' />
						</Button>
					</DockIcon>
				</TooltipTrigger>
				<TooltipContent className='flex items-center gap-2'>
					Add a harware node
					<Kbd>
						<KbdAccelerator />K
					</Kbd>
				</TooltipContent>
			</Tooltip>
			<Tooltip>
				<TooltipTrigger>
					<DockIcon>
						<Button variant='ghost' size='icon'>
							<Icon icon='Route' />
						</Button>
					</DockIcon>
				</TooltipTrigger>
				<TooltipContent className='flex items-center gap-2'>
					Add a flow node
					<Kbd>
						<KbdAccelerator />K
					</Kbd>
				</TooltipContent>
			</Tooltip>
			<Tooltip>
				<TooltipTrigger>
					<DockIcon>
						<Button variant='ghost' size='icon'>
							<Icon icon='ExternalLink' />
						</Button>
					</DockIcon>
				</TooltipTrigger>
				<TooltipContent className='flex items-center gap-2'>
					Add an external node
					<Kbd>
						<KbdAccelerator />K
					</Kbd>
				</TooltipContent>
			</Tooltip>
		</>
	);
}
