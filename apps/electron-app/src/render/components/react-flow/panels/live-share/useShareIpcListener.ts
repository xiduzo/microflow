import { toast } from '@ui/index';
import { SocketStatus, useSocketStore } from '../../../../stores/socket';
import { useEffect } from 'react';
import { toBase64 } from '@microflow/utils/base64';
import { useCopyToClipboard } from 'usehooks-ts';
import { getRandomMessage } from '../../../../../common/messages';

export function useShareIpcListener() {
	const { setStatus } = useSocketStore();
	const [, copy] = useCopyToClipboard();

	useEffect(() => {
		return window.electron.ipcRenderer.on<SocketStatus>('ipc-live-share', async result => {
			if (!result.success) return;

			console.debug('[SharePanel] <ipc-live-share>', result);
			setStatus(result.data);

			switch (result.data.type) {
				case 'initializing':
					if (!result.data.message) return;
					toast.info(result.data.message);
					break;
				case 'shared':
					const tunnelUrl = result.data.tunnelUrl;
					const textToCopy = `Collaborate with me on Microflow Studio: https://microflow.vercel.app/share/${toBase64(tunnelUrl)}\n
   Or enter the tunnel code "${toBase64(tunnelUrl)}" in Microflow Studio to join my collaboration session.`;
					try {
						const copied = await copy(textToCopy);
						if (!copied) throw new Error('Failed to copy');
						toast.success('Live session started', {
							id: 'copy',
							description: 'Invitation details copied to clipboard!',
							duration: Infinity,
							action: {
								label: getRandomMessage('action'),
							},
						});
					} catch {
						toast.warning('Ooops...', {
							id: 'copy',
							description: 'Failed to copy invitation details',
							duration: Infinity,
							action: {
								label: 'Copy details',
								onClick: () => {
									toast.promise(copy(textToCopy), {
										loading: 'Copying invitation details',
										success: 'Invitation details copied to clipboard!',
										error: textToCopy,
									});
								},
							},
						});
					}

					break;
				case 'joined':
					toast.success('Joined collaboration session');
					break;
				case 'disconnected':
					toast.dismiss('copy');
					if (result.data.message) toast.info(result.data.message);
					break;
				default:
					break;
			}
		});
	}, []);
}
