import { Sensor } from "../sensor/sensor";
import { defaults } from "./tilt.schema";
import type { BaseNode } from "../_base/_base";
import type { Data } from "./tilt.schema";

type Props = BaseNode<Data>;
export function Tilt(props: Props) {
  return <Sensor {...props} />;
}
Tilt.defaultProps = { data: defaults };
