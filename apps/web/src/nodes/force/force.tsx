import { Sensor } from "../sensor/sensor";
import { defaults } from "./force.schema";
import type { BaseNode } from "../_base/_base";
import type { Data } from "./force.schema";

type Props = BaseNode<Data>;
export function Force(props: Props) {
  return <Sensor {...props} />;
}
Force.defaultProps = { data: defaults };
