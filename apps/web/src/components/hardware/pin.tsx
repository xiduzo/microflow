import type { Pin } from "@/stores/board";
import {
  pinDisplayValue,
  findPin,
  isPwmPin,
  reducePinsToOptions,
} from "@/utils/pin";

// Re-export utilities for backward compatibility
export { pinDisplayValue, reducePinsToOptions };

export function isPmwPin(pin: Pin | string | number, pins: Pin[] = []) {
  const foundPin = findPin(pin, pins);
  return foundPin ? isPwmPin(foundPin) : false;
}

export function Pin(props: Props) {
  console.log(props)
  return <span className="font-extralight">{pinDisplayValue(props.pin, props.pins)}</span>;
}

type Props = {
  pin: Pin;
  pins: Pin[];
};
