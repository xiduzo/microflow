import { Icons } from '@microflow/ui';
import { PageContent, PageHeader } from '../../../components/Page';
import { useSetWindowSize } from '../../../hooks/useSetWindowSize';

export function VariablesHelp() {
	useSetWindowSize({ width: 450, height: 500 });

	return (
		<>
			<PageHeader title="Variables with MQTT" />
			<PageContent>
				<div>
					This plugin uses{' '}
					<a href="https://mqtt.org/" target="_blank" className="underline">
						MQTT
					</a>{' '}
					to expose all variables in the{' '}
					<code className="p-0.5 px-1 bg-yellow-500 rounded-md text-neutral-100">
						MHB
					</code>{' '}
					variable collection.
				</div>
				<div>Variables updates can be published or subscribed to:</div>
				<section className="pt-3">
					<div className="flex items-center space-x-3">
						<Icons.RadioTower className="w-5 h-5" aria-hidden />
						<div className="font-bold">Publishing updates</div>
					</div>
					<div className="mt-1.5">
						You can use any MQTT client to publish updates to a variable. See
						the{' '}
						<a
							href="https://www.figma.com/plugin-docs/api/VariableResolvedDataType"
							className="underline"
						>
							Figma documentation
						</a>{' '}
						for more information on the data format for each variable type.
					</div>
				</section>
				<section className="pt-3">
					<div className="flex items-center space-x-3">
						<Icons.Antenna className="w-5 h-5" aria-hidden />
						<div className="font-bold">Subscribing to updates</div>
					</div>
					<div className="mt-1.5">
						Whenever there is a change in the{' '}
						<code className="p-0.5 px-1 bg-yellow-500 rounded-md text-neutral-100">
							MHB
						</code>{' '}
						collection, this plugin will publish an update on the subscribed
						topic.
					</div>
				</section>
				<section className="mt-2 text-orange-500">
					In order to publish and subscribe make sure your client is connected
					to the same MQTT broker as configured in the plugin.
				</section>
			</PageContent>
		</>
	);
}
