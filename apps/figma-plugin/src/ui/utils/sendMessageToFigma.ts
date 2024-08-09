import { Message } from '../../common/types/Message';

export function sendMessageToFigma<T>(
	message: Message<T>,
	targetOrigin = '*',
	transfer?: Transferable[],
) {
	parent.postMessage({ pluginMessage: message }, targetOrigin, transfer);
}
