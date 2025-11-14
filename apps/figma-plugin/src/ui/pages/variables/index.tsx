import { Button, cva, Icon, IconName, Icons } from '@microflow/ui';
import { useState } from 'react';
import { MESSAGE_TYPE, OpenLink } from '../../../common/types/Message';
import { PageContent, PageHeader } from '../../components/Page';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import { useMessageListener } from '../../hooks/useMessageListener';
import { useSetWindowSize } from '../../hooks/useSetWindowSize';
import { sendMessageToFigma } from '../../utils/sendMessageToFigma';
import { useAppStore } from '../../stores/app';

export function Variables() {
	const { mqttConfig } = useAppStore();

	const [variables, setVariables] = useState<Variable[] | undefined>([]);

	useSetWindowSize({ width: 420, height: variables?.length ? 550 : 300 });

	useMessageListener<Variable[] | undefined>(MESSAGE_TYPE.GET_LOCAL_VARIABLES, setVariables);

	return (
		<>
			<PageHeader
				title='Variables'
				end={
					<Button
						variant='ghost'
						size='icon'
						title='How to use'
						onClick={() =>
							sendMessageToFigma(
								OpenLink(
									'https://microflow.vercel.app/docs/microflow-hardware-bridge/variables/manipulating#updating-variables-from-within-a-prototype'
								)
							)
						}
					>
						<Icons.BadgeHelp className='w-4 h-4' opacity='80%' />
					</Button>
				}
			/>
			<PageContent>
				{!variables?.length && (
					<section className='flex flex-col items-center space-y-7 w-full h-full'>
						<Icons.BookDashed className='w-16 h-16' opacity='40%' />
						<div className='text-xl'>No variables found</div>
						<div className='text-neutral-400 text-center'>
							All variables created in the{' '}
							<code className='p-0.5 px-1 bg-yellow-500 rounded-md text-neutral-100'>MHB</code>{' '}
							collection will be linked automatically with this plugin.
						</div>
					</section>
				)}
				{variables?.map(variable => {
					return (
						<section key={variable.id} className='flex justify-between py-1 group pr-2'>
							<div className='flex space-x-4 items-center'>
								<VariableIcon type={variable.resolvedType} />
								<span>{variable.name}</span>
							</div>
							<div className='flex space-x-2 items-center opacity-10 group-hover:opacity-100 transition-all duration-300'>
								<CopyButton
									title='Copy publish topic'
									icon='RadioTower'
									textToCopy={`microflow/v1/${mqttConfig?.uniqueId}/YOUR_APP_NAME/variable/${variable.id}/set`}
								/>
								<CopyButton
									title='Copy subscribe topic'
									icon='Antenna'
									textToCopy={`microflow/v1/${mqttConfig?.uniqueId}/plugin/variable/${variable.id}`}
								/>
								<CopyButton
									title='Copy prototype link'
									icon='Link'
									textToCopy={`https://microflow.vercel.app/set/${variable.id}/YOUR_VALUE`}
								/>
							</div>
						</section>
					);
				})}
			</PageContent>
		</>
	);
}

function CopyButton(props: { textToCopy: string; icon: IconName; title: string }) {
	const [copiedValue, copy] = useCopyToClipboard();

	return (
		<Button
			variant='ghost'
			size='icon'
			title={props.title}
			className='hover:cursor-copy'
			onClick={() => {
				copy(props.textToCopy);
			}}
		>
			<Icon
				icon={props.icon}
				opacity='80%'
				className={copyButtonIcon({
					hasCopiedValue: copiedValue === props.textToCopy,
				})}
			/>
		</Button>
	);
}

function VariableIcon(props: { type: Variable['resolvedType'] }) {
	switch (props.type) {
		case 'BOOLEAN':
			return <Icons.ToggleLeft className='text-muted-foreground' size={18} />;
		case 'STRING':
			return (
				<div className='border p-[2px] border-muted-foreground rounded-sm'>
					<Icons.Type className='text-muted-foreground' size={12} />
				</div>
			);
		case 'COLOR':
			return <Icons.Palette className='text-muted-foreground mr-1' size={16} />;
		case 'FLOAT':
			return (
				<div className='border p-[2px] border-muted-foreground rounded-sm'>
					<Icons.Hash className='text-muted-foreground' size={12} />
				</div>
			);
		default:
			return null;
	}
}

const copyButtonIcon = cva('w-4 h-4', {
	variants: {
		hasCopiedValue: {
			true: 'text-green-500',
			false: '',
		},
	},
	defaultVariants: {
		hasCopiedValue: false,
	},
});
