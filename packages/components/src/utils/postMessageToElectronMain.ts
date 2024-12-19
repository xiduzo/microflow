import log from 'electron-log/node';

type Message<T> = {
	nodeId: string;
	action: string;
	value: T;
	error?: string;
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

	log.info(message);
}
