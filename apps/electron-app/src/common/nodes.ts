import { Button } from '../render/components/react-flow/nodes/Button';
import { Counter } from '../render/components/react-flow/nodes/Counter';
import { Compare } from '../render/components/react-flow/nodes/Compare';
import { Figma } from '../render/components/react-flow/nodes/Figma';
import { Interval } from '../render/components/react-flow/nodes/Interval';
import { Led, Vibration } from '../render/components/react-flow/nodes/Led';
import { Matrix } from '../render/components/react-flow/nodes/matrix/Matrix';
import { Monitor } from '../render/components/react-flow/nodes/Monitor';
import { Motion } from '../render/components/react-flow/nodes/Motion';
import { Mqtt } from '../render/components/react-flow/nodes/Mqtt';
import { Note } from '../render/components/react-flow/nodes/Note';
import { Oscillator } from '../render/components/react-flow/nodes/Oscillator';
import { Pixel } from '../render/components/react-flow/nodes/pixel/Pixel';
import { Piezo } from '../render/components/react-flow/nodes/piezo/Piezo';
import { RangeMap } from '../render/components/react-flow/nodes/RangeMap';
import { Rgb } from '../render/components/react-flow/nodes/RGB';
import {
	Force,
	HallEffect,
	Ldr,
	Potentiometer,
	Sensor,
	Tilt,
} from '../render/components/react-flow/nodes/Sensor';
import { Servo } from '../render/components/react-flow/nodes/Servo';
import { Smooth } from '../render/components/react-flow/nodes/Smooth';
import { Trigger } from '../render/components/react-flow/nodes/Trigger';
import { Gate } from '../render/components/react-flow/nodes/Gate';
import { Delay } from '../render/components/react-flow/nodes/Delay';
import { Calculate } from '../render/components/react-flow/nodes/Calculate';
import { Constant } from '../render/components/react-flow/nodes/Constant';
import { Relay } from '../render/components/react-flow/nodes/Relay';
import { Switch } from '../render/components/react-flow/nodes/Switch';
import { Proximity } from '../render/components/react-flow/nodes/Proximity';
import { Llm } from '../render/components/react-flow/nodes/Llm';
import { Hotkey } from '../render/components/react-flow/nodes/Hotkey';
import { AudioPlayer } from '../render/components/react-flow/nodes/AudioPlayer/AudioPlayer';
import { Node } from '@xyflow/react';

export function isNodeTypeACodeType(node?: Node) {
	if (!node?.type) return false;
	const { group } = node.data;
	if (group === 'internal') return false;
	return !['note'].includes(node.type.toLowerCase());
}

export const NODE_TYPES: Record<string, (props: any) => JSX.Element> = {
	Sensor: Sensor,
	Button: Button,
	Calculate: Calculate,
	Compare: Compare,
	Constant: Constant,
	Counter: Counter,
	// DigitalSensor: DigitalSensor,
	Delay: Delay,
	Figma: Figma,
	Force: Force,
	Gate: Gate,
	HallEffect: HallEffect,
	Interval: Interval,
	Ldr: Ldr,
	Led: Led,
	Llm: Llm,
	Matrix: Matrix,
	Monitor: Monitor,
	Motion: Motion,
	Mqtt: Mqtt,
	Note: Note,
	Oscillator: Oscillator,
	Pixel: Pixel,
	Proximity: Proximity,
	Piezo: Piezo,
	Potentiometer: Potentiometer,
	RangeMap: RangeMap,
	Relay: Relay,
	Rgb: Rgb,
	Servo: Servo,
	Smooth: Smooth,
	Switch: Switch,
	Tilt: Tilt,
	Trigger: Trigger,
	Vibration: Vibration,
	Hotkey: Hotkey,
	AudioPlayer: AudioPlayer,
} as const;

export type NodeType = keyof typeof NODE_TYPES;
