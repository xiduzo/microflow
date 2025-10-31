export function getLocalItem<T>(item: string, fallback: T) {
	return JSON.parse(localStorage.getItem(item) ?? JSON.stringify(fallback)) as T;
}

export function setLocalItem<T>(item: string, value: T) {
	localStorage.setItem(item, JSON.stringify(value));
}
