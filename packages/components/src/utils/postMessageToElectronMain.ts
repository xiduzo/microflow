import log from 'electron-log/node';

type Message<T> = {
	nodeId: string;
	action: string;
	value: T;
};

// Poor mans electron parent port
type ParentPort = {
	postMessage: (message: any) => void;
};

export function postMessageToElectronMain<T>(message: Message<T>) {
	if ('parentPort' in process) {
		const parentPort = process.parentPort as ParentPort;
		parentPort.postMessage(message);
		return;
	}

	log.warn(
		'postMessageToElectronMain: process.parentPort is not available. Are you running in a node process?',
	);
}
