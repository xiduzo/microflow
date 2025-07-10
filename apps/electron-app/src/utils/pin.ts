import { ListParamsOptions } from '@tweakpane/core';
import { MODES, Pin } from '../common/types';

export function pinValue(pin: Pin) {
	return !pin.supportedModes.includes(MODES.ANALOG) ? pin.pin : `A${pin.analogChannel}`;
}

export function mapPinToPaneOption(pin: Pin): ListParamsOptions<string | number> {
	return {
		value: pinValue(pin),
		text: `${pinValue(pin)}${pin.supportedModes.includes(MODES.PWM) ? ' (~)' : ''}`,
	};
}

export function mapPinsToSettings(prev: Record<string, string | number>, next: Pin) {
	const key = `${pinValue(next)}${next.supportedModes.includes(MODES.PWM) ? ' (~)' : ''}`;
	prev[key] = next.pin;

	return prev;
}
