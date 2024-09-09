import { Button, cva, Icon, IconName, Icons } from '@microflow/ui';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { LOCAL_STORAGE_KEYS, MESSAGE_TYPE } from '../../../common/types/Message';
import { PageContent, PageHeader } from '../../components/Page';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import { useLocalStorage } from '../../hooks/useLocalStorage';
import { useMessageListener } from '../../hooks/useMessageListener';
import { useSetWindowSize } from '../../hooks/useSetWindowSize';

export function Variables() {
	const [uniqueId] = useLocalStorage<string>(LOCAL_STORAGE_KEYS.TOPIC_UID);

	const [variables, setVariables] = useState<Variable[] | undefined>([]);
	const [copiedValue, copy] = useCopyToClipboard();

	useSetWindowSize({ width: 450, height: variables?.length ? 550 : 300 });

	useMessageListener<Variable[] | undefined>(MESSAGE_TYPE.GET_LOCAL_VARIABLES, setVariables);

	return (
		<>
			<PageHeader
				title="Variables"
				end={
					<Button variant="ghost" size="icon" title="How to use" asChild>
						<Link to="/variables/help">
							<Icons.BadgeHelp className="w-4 h-4" opacity="80%" />
						</Link>
					</Button>
				}
			/>
			<PageContent className="divide-y divide-neutral-700 space-y-0">
				{!variables?.length && (
					<section className="flex flex-col items-center space-y-7 w-full h-full">
						<Icons.BookDashed className="w-16 h-16" opacity="40%" />
						<div className="text-xl">No variables found</div>
						<div className="text-neutral-400 text-center">
							All variables created in the{' '}
							<code className="p-0.5 px-1 bg-yellow-500 rounded-md text-neutral-100">MHB</code>{' '}
							collection will be linked automatically with this plugin.
						</div>
					</section>
				)}
				{variables?.map(variable => {
					return (
						<section key={variable.id} className="flex justify-between py-1 group">
							<div className="flex space-x-2 items-center">
								<VariableIcon type={variable.resolvedType} />
								<span>{variable.name}</span>
							</div>
							<div className="flex space-x-2 items-center opacity-10 group-hover:opacity-100 transition-all duration-300">
								<CopyButton
									title="Copy publish topic"
									icon="RadioTower"
									textToCopy={`microflow/v1/${uniqueId}/YOUR_APP_NAME/variable/${variable.id}/set`}
								/>
								<CopyButton
									title="Copy subscribe topic"
									icon="Antenna"
									textToCopy={`microflow/v1/${uniqueId}/plugin/variable/${variable.id}`}
								/>
								<CopyButton
									title="Copy prototype link"
									icon="Link"
									textToCopy={`http://localhost:3000/set/${variable.id}/YOUR_VALUE`}
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
			variant="ghost"
			size="icon"
			title={props.title}
			className="hover:cursor-copy"
			onClick={() => {
				copy(props.textToCopy);
			}}
		>
			<Icon
				icon={props.icon}
				opacity="80%"
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
			return <Icons.Hash className="w-3 h-3 opacity-40" />;
		case 'STRING':
			return <Icons.Type className="w-3 h-3 opacity-40" />;
		case 'COLOR':
			return <Icons.Palette className="w-3 h-3 opacity-40" />;
		case 'FLOAT':
			return <Icons.DiscAlbum className="w-3 h-3 opacity-40" />;
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
