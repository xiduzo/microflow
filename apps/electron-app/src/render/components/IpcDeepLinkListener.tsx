import { toast } from '@microflow/ui';
import { useEffect } from 'react';
import { useReactFlow } from '@xyflow/react';
import { useSocketStore } from '../stores/socket';
import { useReactFlowStore } from '../stores/react-flow';

export function IpcDeepLinkListener() {
	const { setStatus } = useSocketStore();
	const { getNodes } = useReactFlow();
	const { setNodes, setEdges } = useReactFlowStore();

	useEffect(() => {
		return window.electron.ipcRenderer.on<{ type: string } & Record<string, unknown>>(
			'ipc-deep-link',
			result => {
				if (!result.success) return;

				console.debug('[IpcDeepLinkListener] <ipc-deep-link>', result);

				switch (result.data.type) {
					case 'web':
						toast.success('Microflow studio successfully linked!');
						break;
					case 'share':
						// Clear local nodes and edges when joining via deep link
						console.debug('[DEEP-LINK] Joining session via deep link - clearing local content');
						setNodes([]);
						setEdges([]);
						setStatus({
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
			}
		);
	}, []);

	return null;
}
