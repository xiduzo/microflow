import { Button, DEFAULT_BUTTON_DATA } from '../render/components/react-flow/nodes/Button';
import { Counter, DEFAULT_COUNTER_DATA } from '../render/components/react-flow/nodes/Counter';
import { DEFAULT_FIGMA_DATA, Figma } from '../render/components/react-flow/nodes/Figma';
import { DEFAULT_IF_ELSE_DATA, IfElse } from '../render/components/react-flow/nodes/IfElse';
import { DEFAULT_INTERVAL_DATA, Interval } from '../render/components/react-flow/nodes/Interval';
import { DEFAULT_LED_DATA, Led } from '../render/components/react-flow/nodes/Led';
import { DEFAULT_MATRIX_DATA, Matrix } from '../render/components/react-flow/nodes/matrix/Matrix';
import { DEFAULT_MOTION_DATA, Motion } from '../render/components/react-flow/nodes/Motion';
import { DEFAULT_MQTT_DATA, Mqtt } from '../render/components/react-flow/nodes/Mqtt';
import { DEFAULT_NOTE_DATA, Note } from '../render/components/react-flow/nodes/Note';
import { DEFAULT_DEBUG_DATA, Debug } from '../render/components/react-flow/nodes/Debug';
import { DEFAULT_PIEZO_DATA, Piezo } from '../render/components/react-flow/nodes/piezo/Piezo';
import { DEFAULT_RANGE_MAP_DATA, RangeMap } from '../render/components/react-flow/nodes/RangeMap';
import { DEFAULT_SENSOR_DATA, Sensor } from '../render/components/react-flow/nodes/Sensor';
import { DEFAULT_SERVO_DATA, Servo } from '../render/components/react-flow/nodes/Servo';

export const NODE_TYPES = {
	Button: Button,
	Led: Led,
	Counter: Counter,
	Figma: Figma,
	Interval: Interval,
	IfElse: IfElse,
	RangeMap: RangeMap,
	Mqtt: Mqtt,
	Sensor: Sensor,
	Servo: Servo,
	Piezo: Piezo,
	Motion: Motion,
	Matrix: Matrix,
	Note: Note,
	Debug: Debug,
};

export type NodeType = keyof typeof NODE_TYPES;

export const DEFAULT_NODE_DATA = new Map<NodeType | string, Record<string, any>>();

DEFAULT_NODE_DATA.set('Button', DEFAULT_BUTTON_DATA);
DEFAULT_NODE_DATA.set('Led', DEFAULT_LED_DATA);
DEFAULT_NODE_DATA.set('Counter', DEFAULT_COUNTER_DATA);
DEFAULT_NODE_DATA.set('Figma', DEFAULT_FIGMA_DATA);
DEFAULT_NODE_DATA.set('Interval', DEFAULT_INTERVAL_DATA);
DEFAULT_NODE_DATA.set('IfElse', DEFAULT_IF_ELSE_DATA);
DEFAULT_NODE_DATA.set('RangeMap', DEFAULT_RANGE_MAP_DATA);
DEFAULT_NODE_DATA.set('Mqtt', DEFAULT_MQTT_DATA);
DEFAULT_NODE_DATA.set('Sensor', DEFAULT_SENSOR_DATA);
DEFAULT_NODE_DATA.set('Servo', DEFAULT_SERVO_DATA);
DEFAULT_NODE_DATA.set('Piezo', DEFAULT_PIEZO_DATA);
DEFAULT_NODE_DATA.set('Motion', DEFAULT_MOTION_DATA);
DEFAULT_NODE_DATA.set('Matrix', DEFAULT_MATRIX_DATA);
DEFAULT_NODE_DATA.set('Note', DEFAULT_NOTE_DATA);
DEFAULT_NODE_DATA.set('Debug', DEFAULT_DEBUG_DATA);
