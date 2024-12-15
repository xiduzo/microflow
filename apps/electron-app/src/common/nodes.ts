import { Button } from '../render/components/react-flow/nodes/Button';
import { Counter } from '../render/components/react-flow/nodes/Counter';
import { Compare } from '../render/components/react-flow/nodes/Compare';
import { Figma } from '../render/components/react-flow/nodes/Figma';
import { Interval } from '../render/components/react-flow/nodes/Interval';
import { Led } from '../render/components/react-flow/nodes/Led';
import { Matrix } from '../render/components/react-flow/nodes/matrix/Matrix';
import { Monitor } from '../render/components/react-flow/nodes/Monitor';
import { Motion } from '../render/components/react-flow/nodes/Motion';
import { Mqtt } from '../render/components/react-flow/nodes/Mqtt';
import { Note } from '../render/components/react-flow/nodes/Note';
import { Oscillator } from '../render/components/react-flow/nodes/Oscillator';
import { Piezo } from '../render/components/react-flow/nodes/piezo/Piezo';
import { RangeMap } from '../render/components/react-flow/nodes/RangeMap';
import { Rgb } from '../render/components/react-flow/nodes/RGB';
import { Sensor } from '../render/components/react-flow/nodes/Sensor';
import { Servo } from '../render/components/react-flow/nodes/Servo';
import { Smooth } from '../render/components/react-flow/nodes/Smooth';
import { Trigger } from '../render/components/react-flow/nodes/Trigger';
import { Gate } from '../render/components/react-flow/nodes/Gate';

export const NODE_TYPES = {
	Button: Button,
	Compare: Compare,
	Counter: Counter,
	Figma: Figma,
	Gate: Gate,
	Interval: Interval,
	Led: Led,
	Matrix: Matrix,
	Monitor: Monitor,
	Motion: Motion,
	Mqtt: Mqtt,
	Note: Note,
	Oscillator: Oscillator,
	Piezo: Piezo,
	RangeMap: RangeMap,
	Rgb: Rgb,
	Sensor: Sensor,
	Servo: Servo,
	Smooth: Smooth,
	Trigger: Trigger,
};

export type NodeType = keyof typeof NODE_TYPES;
