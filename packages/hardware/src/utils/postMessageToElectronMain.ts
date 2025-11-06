import log from 'electron-log/node';

export type Message<T> = {
	/** The id of the source component */
	source: string;
	/**
	 * The id of the target component
	 * */
	target: string;
	/** The action to perform */
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
