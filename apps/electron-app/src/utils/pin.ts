import { MODES, Pin } from '../common/types';

export function pinValue(pin: Pin) {
	return !pin.supportedModes.includes(MODES.ANALOG) ? pin.pin : `A${pin.analogChannel}`;
}

export function reducePinsToOptions(prev: Record<string, string | number>, next: Pin) {
	const key = `${pinValue(next)}${next.supportedModes.includes(MODES.PWM) ? ' (~)' : ''}`;
	prev[key] = next.pin;

	return prev;
}
