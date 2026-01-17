import { MODES, type Pin } from "@/stores/board";

/**
 * Get the lowest analog channel from a list of pins to use as the base (A0)
 * This handles boards where analogChannel values are the digital pin numbers (e.g., 14-21)
 */
function getAnalogChannelBase(pins: Pin[]): number {
  const analogPins = pins.filter(
    (p) => p.supportedModes.includes(MODES.ANALOG) && p.analogChannel >= 0,
  );
  if (analogPins.length === 0) return 0;
  return Math.min(...analogPins.map((p) => p.analogChannel));
}

/**
 * Convert an analog channel to a display index (A0, A1, etc.)
 */
function getAnalogDisplayIndex(analogChannel: number, base: number): number {
  return analogChannel - base;
}

function pinValue(pin: Pin, pins: Pin[] = []) {
  if (!pin.supportedModes.includes(MODES.ANALOG)) {
    return pin.pin;
  }
  const base = getAnalogChannelBase(pins);
  const displayIndex = getAnalogDisplayIndex(pin.analogChannel, base);
  return `A${displayIndex}`;
}

function pinValueWithPMW(pin: Pin, pins: Pin[] = []) {
  return `${pinValue(pin, pins)}${pin.supportedModes.includes(MODES.PWM) ? " (~)" : ""}`;
}

function ensurePin(pin: Pin | string | number, pins: Pin[] = []) {
  if (typeof pin !== "string" && typeof pin !== "number") return pin;
  if (typeof pin === "number") return pins.find((p) => p.pin === Number(pin));
  return pins.find((p) => p.pin === Number(pin));
}

export function isPmwPin(pin: Pin | string | number, pins: Pin[] = []) {
  return ensurePin(pin, pins)?.supportedModes.includes(MODES.PWM) ?? false;
}

export function pinDisplayValue(pin: Pin | string | number, pins: Pin[] = []) {
  const _pin = ensurePin(pin, pins);
  return _pin ? pinValueWithPMW(_pin, pins) : pin.toString();
}

export function reducePinsToOptions(
  prev: Record<string, string | number>,
  next: Pin,
  _index: number,
  allPins: Pin[],
) {
  const key = pinValueWithPMW(next, allPins);
  // Always store the actual pin number as the value
  prev[key] = next.pin;

  return prev;
}

export function Pin(props: Props) {
  return <span className="font-extralight">{pinDisplayValue(props.pin, props.pins)}</span>;
}

type Props = {
  pin: Pin;
  pins: Pin[];
};
