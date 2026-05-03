import { Sensor } from "../sensor/sensor";
import { defaults } from "./potentiometer.schema";
import type { BaseNode } from "../_base/_base";
import type { Data } from "./potentiometer.schema";

type Props = BaseNode<Data>;
export function Potentiometer(props: Props) {
  return <Sensor {...props} />;
}
Potentiometer.defaultProps = { data: defaults };
