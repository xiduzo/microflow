import { GetLocalStateValue, SetLocalStateValue } from '../../common/types/Message';

export async function setLocalValue<T>(key: string, value: T) {
	// Get current value to check if we should merge
	const currentValue = await figma.clientStorage.getAsync(key);

	// Deep merge the values
	const valueToStore = deepMergeValues(currentValue, value);

	await figma.clientStorage.setAsync(key, valueToStore);
	figma.ui.postMessage(SetLocalStateValue(key, valueToStore));
}

export async function getLocalValue<T>(key: string, value: T) {
	const localState = (await figma.clientStorage.getAsync(key)) as T;
	if (localState === undefined || localState === null) {
		await figma.clientStorage.setAsync(key, value);
		figma.ui.postMessage(GetLocalStateValue(key, value));
		return;
	}
	figma.ui.postMessage(GetLocalStateValue(key, localState));
}

/**
 * Deep merges two values, handling both strings (JSON) and objects.
 * If both values are objects, recursively merges nested properties.
 * Otherwise, returns the new value.
 */
function deepMergeValues(current: any, incoming: any): any {
	// Helper to safely parse JSON strings
	const tryParse = (val: any): any => {
		if (typeof val === 'string') {
			try {
				return JSON.parse(val);
			} catch {
				return val;
			}
		}
		return val;
	};

	// Check if a value is a plain object (not array, null, etc.)
	const isPlainObject = (val: any): boolean => {
		return val !== null && typeof val === 'object' && !Array.isArray(val);
	};

	// Parse both values if they're JSON strings
	const parsedCurrent = tryParse(current);
	const parsedValue = tryParse(incoming);

	// Track if the original incoming value was a string
	const wasString = typeof incoming === 'string';

	// If both are plain objects, deep merge them
	if (isPlainObject(parsedCurrent) && isPlainObject(parsedValue)) {
		const merged: any = { ...parsedCurrent };

		for (const key in parsedValue) {
			if (Object.prototype.hasOwnProperty.call(parsedValue, key)) {
				const currentVal = merged[key];
				const incomingVal = parsedValue[key];

				// If incoming value is null, preserve the current value
				if (incomingVal === null) {
					// Keep the current value, don't overwrite with null
					continue;
				}

				// If both values are objects, recursively merge them
				if (isPlainObject(currentVal) && isPlainObject(incomingVal)) {
					merged[key] = deepMergeValues(currentVal, incomingVal);
				} else {
					// Otherwise, use the incoming value
					merged[key] = incomingVal;
				}
			}
		}

		// Return in the same format as the input
		return wasString ? JSON.stringify(merged) : merged;
	}

	// If not both objects, return the incoming value as-is
	return incoming;
}
