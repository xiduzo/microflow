export function uuid() {
	return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
		const r = (Math.random() * 16) | 0;
		const v = c === 'x' ? r : (r & 0x3) | 0x8;
		return v.toString(16);
	});
}

/**
 * Generates a unique identifier string only using the characters a-z of 12 long.
 */
export function uid(length = 12) {
	const CHARACTERS = 'abcdefghijklmnopqrstuvwxyz';

	return Array.from({ length }, () =>
		CHARACTERS.charAt(Math.floor(Math.random() * CHARACTERS.length))
	).join('');
}
