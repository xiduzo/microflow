import { MODES, type Pin } from "@/stores/board";

/**
 * Get the lowest analog channel from a list of pins to use as the base (A0)
 * This handles boards where analogChannel values are the digital pin numbers (e.g., 14-21)
 */
export function getAnalogChannelBase(pins: Pin[]): number {
  const analogPins = pins.filter(
    (p) => p.supportedModes.includes(MODES.ANALOG) && p.analogChannel >= 0,
  );
  if (analogPins.length === 0) return 0;
  return Math.min(...analogPins.map((p) => p.analogChannel));
}

/**
 * Convert an analog channel to a display index (A0, A1, etc.)
 */
export function getAnalogDisplayIndex(analogChannel: number, base: number): number {
  return analogChannel - base;
}

/**
 * Check if a pin supports analog mode
 */
export function isAnalogPin(pin: Pin): boolean {
  return pin.supportedModes.includes(MODES.ANALOG) && pin.analogChannel >= 0;
}

/**
 * Check if a pin supports PWM mode
 */
export function isPwmPin(pin: Pin): boolean {
  return pin.supportedModes.includes(MODES.PWM);
}

/**
 * Get the base pin value (without PWM indicator)
 * - Analog pins: A0, A1, etc.
 * - Digital pins: 2, 4, etc.
 */
export function formatPinValue(pin: Pin, allPins: Pin[] = []): string {
  if (isAnalogPin(pin)) {
    const base = getAnalogChannelBase(allPins.length > 0 ? allPins : [pin]);
    const displayIndex = getAnalogDisplayIndex(pin.analogChannel, base);
    return `A${displayIndex}`;
  }
  return `${pin.pin}`;
}

/**
 * Get the pin value with PWM indicator
 * - PWM pins: "~3", "A0 (~)"
 * - Non-PWM pins: "2", "A0"
 */
export function formatPinValueWithPwm(pin: Pin, allPins: Pin[] = []): string {
  const value = formatPinValue(pin, allPins);
  if (isPwmPin(pin)) {
    // For analog pins, append (~), for digital pins, prefix with ~
    return isAnalogPin(pin) ? `${value} (~)` : `~${value}`;
  }
  return value;
}

/**
 * Find a Pin object from a pin number, string number, or analog pin string (e.g., "A0", "A6")
 */
export function findPin(pin: Pin | string | number, pins: Pin[]): Pin | undefined {
  if (typeof pin !== "string" && typeof pin !== "number") return pin;
  
  // Handle analog pin strings like "A0", "A6"
  if (typeof pin === "string") {
    const match = pin.match(/^A(\d+)$/i);
    if (match) {
      const analogIndex = parseInt(match[1], 10);
      const base = getAnalogChannelBase(pins);
      const targetChannel = base + analogIndex;
      return pins.find((p) => p.analogChannel === targetChannel);
    }
  }
  
  // Handle numeric pins (as number or string)
  const pinNumber = Number(pin);
  if (!isNaN(pinNumber)) {
    return pins.find((p) => p.pin === pinNumber);
  }
  
  return undefined;
}

/**
 * Get display value for a pin (handles Pin objects, numbers, and strings)
 * If pins array is empty or pin not found, returns the raw pin value as string
 */
export function pinDisplayValue(pin: Pin | string | number, pins: Pin[] = []): string {
  // If pin is already a Pin object, format it directly
  if (typeof pin !== "string" && typeof pin !== "number") {
    return formatPinValueWithPwm(pin, pins);
  }
  
  // If pins array is empty, just return the raw value
  // This handles the case before board is connected
  if (pins.length === 0) {
    return String(pin);
  }
  
  const foundPin = findPin(pin, pins);
  return foundPin ? formatPinValueWithPwm(foundPin, pins) : String(pin);
}

/**
 * Reducer to convert pins array to options object for select inputs
 */
export function reducePinsToOptions(
  prev: Record<string, string | number>,
  next: Pin,
  _index: number,
  allPins: Pin[],
): Record<string, string | number> {
  const key = formatPinValueWithPwm(next, allPins);
  prev[key] = next.pin;
  return prev;
}
