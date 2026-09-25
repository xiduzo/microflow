import { Sensor } from "../sensor/sensor";
import { defaults } from "./hall-effect.schema";
import type { BaseNode } from "../_base/_base";
import type { Data } from "./hall-effect.schema";

type Props = BaseNode<Data>;
export function HallEffect(props: Props) {
  return <Sensor {...props} />;
}
HallEffect.defaultProps = { data: defaults };
