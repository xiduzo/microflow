import {
	Sheet,
	SheetContent,
	SheetHeader,
	SheetTitle,
	Accordion,
	AccordionContent,
	AccordionItem,
	AccordionTrigger,
	Icons,
} from '@microflow/ui';
import { useAppStore } from '../stores/app';
import { UserSettingsForm } from './forms/UserSettingsForm';
import { MqttSettingsForm } from './forms/MqttSettingsForm';
import { AdvancedSettingsForm } from './forms/AdvancedSettingsForm';
import { useEffect, useState } from 'react';

export function Settings() {
	const { settingsOpen, setSettingsOpen } = useAppStore();
	const [accordionValue, setAccordionValue] = useState<string>('');

	// Map settingsOpen to accordion value
	useEffect(() => {
		if (settingsOpen === 'user-settings') {
			setAccordionValue('user-settings');
		} else if (settingsOpen === 'mqtt-settings') {
			setAccordionValue('mqtt-settings');
		} else if (settingsOpen === 'board-settings') {
			setAccordionValue('board-settings');
		}
	}, [settingsOpen]);

	const isOpen = !!settingsOpen;

	function handleOpenChange(open: boolean) {
		if (!open) {
			setSettingsOpen(undefined);
			setAccordionValue('');
		}
	}

	return (
		<Sheet open={isOpen} onOpenChange={handleOpenChange}>
			<SheetContent className='overflow-y-hidden'>
				<SheetHeader>
					<SheetTitle className='flex gap-2 items-center'>
						<Icons.Settings />
						Settings
					</SheetTitle>
				</SheetHeader>
				<div className='mt-6'>
					<Accordion
						type='single'
						collapsible
						value={accordionValue}
						onValueChange={setAccordionValue}
					>
						<AccordionItem value='user-settings'>
							<AccordionTrigger>
								<div className='flex gap-2 items-center'>
									<Icons.User size={16} />
									User settings
								</div>
							</AccordionTrigger>
							<AccordionContent className='px-1'>
								<UserSettingsForm />
							</AccordionContent>
						</AccordionItem>
						<AccordionItem value='mqtt-settings'>
							<AccordionTrigger>
								<div className='flex gap-2 items-center'>
									<Icons.RadioTower size={16} />
									MQTT settings
								</div>
							</AccordionTrigger>
							<AccordionContent className='px-1'>
								<MqttSettingsForm />
							</AccordionContent>
						</AccordionItem>
						<AccordionItem value='board-settings'>
							<AccordionTrigger>
								<div className='flex gap-2 items-center'>
									<Icons.Microchip size={16} />
									Microcontroller settings
								</div>
							</AccordionTrigger>
							<AccordionContent>
								<AdvancedSettingsForm />
							</AccordionContent>
						</AccordionItem>
					</Accordion>
				</div>
			</SheetContent>
		</Sheet>
	);
}
