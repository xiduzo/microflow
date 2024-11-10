import { ListParamsOptions } from '@tweakpane/core';
import { MODES, Pin } from '../common/types';

export function pinValue(pin: Pin) {
	return !pin.supportedModes.includes(MODES.ANALOG) ? pin.pin : `A${pin.analogChannel}`;
}

export function mapPinToPaneOption(pin: Pin): ListParamsOptions<string | number> {
	return {
		value: pinValue(pin),
		text: `${pinValue(pin)}`,
	};
}
