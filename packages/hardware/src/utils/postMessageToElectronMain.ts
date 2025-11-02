import log from 'electron-log/node';

type Message<T> = {
	nodeId: string;
	action: string | symbol;
	value: T;
	error?: string;
};

// Poor mans electron parent port
type ParentPort = {
	postMessage: (message: unknown) => void;
};

export function postMessageToElectronMain<T>(message: Message<T>) {
	if ('parentPort' in process) {
		const parentPort = process.parentPort as ParentPort;
		parentPort.postMessage({ type: 'message', ...message });
		return;
	}

	process.send?.({ type: 'message', ...message });
}
