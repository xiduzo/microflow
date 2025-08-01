class HistoryNode<T> {
	next: HistoryNode<T> | null = null;
	prev: HistoryNode<T> | null = null;

	constructor(public readonly value: T) {}
}

export class HistoryList<T extends Array<unknown>> {
	private current: HistoryNode<T> | null = null;
	private pendingChanges: T[] = [];
	private debounceTimeout: NodeJS.Timeout | null = null;

	constructor(private readonly debounceDelay = 100) {}

	push(value: T): void {
		this.clearDebounceTimeout();

		if (!value.length) return;

		console.log('push', value);

		this.pendingChanges.push(value);

		this.debounceTimeout = setTimeout(() => {
			this.flushPendingChanges();
		}, this.debounceDelay);
	}

	/**
	 * Force flush pending changes immediately
	 */
	flush(): void {
		this.clearDebounceTimeout();
		console.log('flush', this.pendingChanges);
		this.flushPendingChanges();
	}

	back(): T | null {
		if (this.current?.prev) {
			this.current = this.current.prev;
			return this.current.value;
		}
		return null;
	}

	forward(): T | null {
		if (this.current?.next) {
			this.current = this.current.next;
			return this.current.value;
		}
		return null;
	}

	getCurrent(): T | null {
		return this.current ? this.current.value : null;
	}

	private clearDebounceTimeout(): void {
		if (this.debounceTimeout) {
			clearTimeout(this.debounceTimeout);
			this.debounceTimeout = null;
		}
	}

	private flushPendingChanges(): void {
		if (!this.pendingChanges.length) return;

		const flattenedChanges = this.pendingChanges.flat() as T;

		this.pushToHistory(flattenedChanges);

		this.pendingChanges = [];
		this.debounceTimeout = null;
	}

	private pushToHistory(value: T): void {
		const newNode = new HistoryNode(value);

		if (this.current) {
			this.current.next = null; // Clear the next pointer of the current node

			newNode.prev = this.current; // Set the previous pointer of the new node to the current node
			this.current.next = newNode; // Set the next pointer of the current node to the new node
		}

		this.current = newNode;
	}
}
