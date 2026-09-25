import type { Pin } from "@/board/board-store";
import {
  pinDisplayValue,
  findPin,
  isPwmPin,
  pinsToOptions,
  reducePinsToOptions,
} from "@/board/pin";

// Re-export utilities for backward compatibility
export { pinDisplayValue, pinsToOptions, reducePinsToOptions };

export function isPmwPin(pin: Pin | string | number, pins: Pin[] = []) {
  const foundPin = findPin(pin, pins);
  return foundPin ? isPwmPin(foundPin) : false;
}

export function Pin(props: Props) {
  return <span className="font-extralight">{pinDisplayValue(props.pin, props.pins)}</span>;
}

type Props = {
  pin: Pin;
  pins: Pin[];
};
