class Link<T> {
	value: T;
	next: Link<T> | null = null;
	prev: Link<T> | null = null;

	constructor(value: T) {
		this.value = value;
	}
}

export class LinkedList<T> {
	private head: Link<T> | null = null;
	private tail: Link<T> | null = null;

	constructor(readonly init: T) {
		this.append(init);
	}

	append(value: T): LinkedList<T> {
		const newNode = new Link(value);
		if (!this.head) {
			this.head = newNode;
			this.tail = newNode;
		} else if (this.tail) {
			this.tail.next = newNode;
			newNode.prev = this.tail;
			this.tail = newNode;
		}

		return this;
	}

	forward(): T | null {
		if (!this.tail?.next) return null;

		this.tail = this.tail.next;

		return this.tail.value;
	}

	backward(): T | null {
		if (!this.tail?.prev) return null;

		this.tail = this.tail.prev;

		return this.tail.value;
	}
}
