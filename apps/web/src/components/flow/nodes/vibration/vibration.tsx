import { Led } from "../led/led";
import { defaults } from "./vibration.schema";
import type { BaseNode } from "../_base/_base";
import type { Data } from "./vibration.schema";

type Props = BaseNode<Data>;
export function Vibration(props: Props) {
  return <Led {...props} />;
}
Vibration.defaultProps = { data: defaults };
