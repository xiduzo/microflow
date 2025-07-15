import { toast } from '@microflow/ui';
import { useEffect } from 'react';
import { useSharing } from '../stores/app';
import { useReactFlow } from '@xyflow/react';

export function IpcDeepLinkListener() {
	const { setSharing } = useSharing();
	const { getNodes } = useReactFlow();

	useEffect(() => {
		return window.electron.ipcRenderer.on<{ type: string } & Record<string, unknown>>(
			'ipc-deep-link',
			result => {
				if (!result.success) return;

				console.debug('<<< ipc-deep-link', result);

				switch (result.data.type) {
					case 'web':
						toast.success('Microflow studio successfully linked!');
						break;
					case 'share':
						setSharing({
							type: 'joined',
							tunnelUrl: String(result.data.tunnelUrl),
						});
						break;
					case 'figma':
						const nodes = getNodes();
						const node = nodes.find(n => n.data?.variableId === result.data.variableId);
						if (!node) return;
						window.electron.ipcRenderer.send('ipc-external-value', {
							nodeId: node.id,
							value: result.data.value,
						});
						break;
					default:
						console.debug('no know deeplink action for', result.data.type);
						break;
				}
			},
		);
	}, []);

	return null;
}
