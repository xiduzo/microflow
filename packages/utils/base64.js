/**
 * @param {string} str
 * @returns {string}
 */
export function toBase64(str) {
	const bytes = new TextEncoder().encode(str);
	const binary = Array.from(bytes)
		.map(b => String.fromCharCode(b))
		.join('');
	return btoa(binary);
}

/**
 * @param {string} base64
 * @returns {string}
 */
export function fromBase64(base64) {
	const binary = atob(base64);
	const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
	return new TextDecoder().decode(bytes);
}

/**
 * @param {string} str
 * @returns {boolean}
 */
export function isBase64(str) {
	return /^[A-Za-z0-9+/]+={0,2}$/.test(str) && str.length % 4 === 0;
}
