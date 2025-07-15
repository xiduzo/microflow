export function toBase64(str: string) {
	const bytes = new TextEncoder().encode(str);
	const binary = Array.from(bytes)
		.map(b => String.fromCharCode(b))
		.join('');
	return btoa(binary);
}
export function fromBase64(base64: string) {
	const binary = atob(base64);
	const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
	return new TextDecoder().decode(bytes);
}
