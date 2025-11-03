import { MODES, Pin } from '../common/types';

function pinValue(pin: Pin) {
	return !pin.supportedModes.includes(MODES.ANALOG) ? pin.pin : `A${pin.analogChannel}`;
}

function pinValueWithPMW(pin: Pin) {
	return `${pinValue(pin)}${pin.supportedModes.includes(MODES.PWM) ? ' (~)' : ''}`;
}

function ensurePin(pin: Pin | string | number, pins: Pin[] = []) {
	if (typeof pin !== 'string' && typeof pin !== 'number') return pin;
	if (typeof pin === 'number') return pins.find(p => p.pin === Number(pin));
	return pins.find(p => p.pin === Number(pin));
}

export function isPmwPin(pin: Pin | string | number, pins: Pin[] = []) {
	return ensurePin(pin, pins)?.supportedModes.includes(MODES.PWM) ?? false;
}

export function pinDisplayValue(pin: Pin | string | number, pins: Pin[] = []) {
	const _pin = ensurePin(pin, pins);
	return _pin ? pinValueWithPMW(_pin) : pin.toString();
}

export function reducePinsToOptions(prev: Record<string, string | number>, next: Pin) {
	const key = pinValueWithPMW(next);
	prev[key] = pinValue(next);

	return prev;
}
