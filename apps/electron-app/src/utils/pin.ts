import { MODES, Pin } from "../common/types";

export function pinValue(pin: Pin) {
	return !pin.supportedModes.includes(MODES.ANALOG) ? pin.pin : `A${pin.analogChannel}`;
}
