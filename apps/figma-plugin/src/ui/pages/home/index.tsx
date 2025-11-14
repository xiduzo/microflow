import { Button, cva, Icons } from '@microflow/ui';
import { PageContent } from '../../components/Page';

import { ConnectionStatus, useMqttStore } from '@microflow/mqtt-provider/client';
import { Link } from 'react-router-dom';
import { useSetWindowSize } from '../../hooks/useSetWindowSize';
import { useMemo } from 'react';
import { useAppStore } from '../../stores/app';

function ConnectionStatusBadge({ title, status }: { title: string; status?: ConnectionStatus }) {
	return (
		<div className='flex items-center'>
			{title}
			<span
				className={connectionStatusBadge({ status })}
				title={status}
				aria-busy={status !== 'connected'}
			/>
		</div>
	);
}

const connectionStatusBadge = cva('ml-2 pointer-events-none w-2 h-2 rounded-full', {
	variants: {
		status: {
			undefined: 'bg-gray-500 text-gray-900',
			connected: 'bg-green-500 text-green-900',
			connecting: 'bg-orange-400 text-orange-800 animate-pulse',
			disconnected: 'bg-red-500 text-red-900 animate-pulse',
		},
	},
});

export function Home() {
	const { status, connectedClients } = useMqttStore();
	const { mqttConfig } = useAppStore();
	useSetWindowSize({ width: 275, height: 190 });

	console.log(connectedClients);
	const appStatus = useMemo(
		() => connectedClients.find(({ appName }) => appName === 'app')?.status,
		[connectedClients]
	);

	return (
		<>
			<PageContent>
				<section className='flex items-center justify-between'>
					<ConnectionStatusBadge title='Mqtt' status={mqttConfig ? status : undefined} />
					<section className='space-x-2'>
						<Button variant='ghost' size='icon' title='Variables and topics' asChild>
							<Link to='/variables'>
								<Icons.Settings2 className='w-4 h-4 rotate-90' opacity='80%' />
							</Link>
						</Button>
						<Button variant='ghost' size='icon' title='Mqtt settings' asChild>
							<Link to='/mqtt'>
								<Icons.RadioTower className='w-4 h-4' opacity='80%' />
							</Link>
						</Button>
					</section>
				</section>
				<section className='flex items-center justify-between'>
					<ConnectionStatusBadge title='Microflow studio' status={appStatus} />
					<div className='space-x-1'>
						<a href='https://microflow.vercel.app/' target='_blank'>
							<Button variant='ghost' size='icon' title='Get Microflow studio'>
								<Icons.ExternalLink className='w-4 h-4' opacity='80%' />
							</Button>
						</a>
					</div>
				</section>
				<a
					href='https://www.sanderboer.nl'
					target='_blank'
					className='py-2 text-center text-muted-foreground transition-all hover:opacity-100 hover:underline'
				>
					Made with ♥ by Xiduzo
				</a>
			</PageContent>
		</>
	);
}
