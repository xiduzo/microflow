import { toast } from '@microflow/ui';
import { useEffect } from 'react';
import { useReactFlow } from '@xyflow/react';
import { useCollaborationActions } from '../stores/yjs';
import logger from 'electron-log/node';

export function IpcDeepLinkListener() {
	const { getNodes } = useReactFlow();
	const { connect } = useCollaborationActions();

	useEffect(() => {
		return window.electron.ipcRenderer.on<{ type: string } & Record<string, unknown>>(
			'ipc-deep-link',
			result => {
				if (!result.success) return;

				logger.debug('[DEEP-LINK] <ipc-deep-link>', result);

				switch (result.data.type) {
					case 'web':
						toast.success('Microflow studio successfully linked!');
						break;
					case 'share':
						logger.debug('[DEEP-LINK] Joining session via deep link - clearing local content');
						connect(String(result.data.tunnelUrl), { isJoining: true });
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
						logger.debug('[DEEP-LINK] no know deeplink action for', result.data.type);
						break;
				}
			}
		);
	}, []);

	return null;
}
