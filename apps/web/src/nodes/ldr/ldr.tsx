import { Sensor } from "../sensor/sensor";
import { defaults } from "./ldr.schema";
import type { BaseNode } from "../_base/_base";
import type { Data } from "./ldr.schema";

type Props = BaseNode<Data>;
export function Ldr(props: Props) {
  return <Sensor {...props} />;
}
Ldr.defaultProps = { data: defaults };
