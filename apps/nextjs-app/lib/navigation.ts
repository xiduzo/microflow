export const navigation = [
	{
		title: 'Introduction',
		links: [{ title: 'Microflow', href: '/docs' }],
	},
	{
		title: 'Microflow studio',
		links: [
			{ title: 'Getting started', href: '/docs/microflow-studio' },
			{ title: 'Nodes', href: '/docs/microflow-studio/nodes' },
			// Input
			{
				title: 'Input',
				href: '/docs/microflow-studio/nodes/input',
				parent: '/docs/microflow-studio/nodes',
			},
			{
				title: 'Button',
				href: '/docs/microflow-studio/nodes/input/button',
				parent: '/docs/microflow-studio/nodes/input',
			},
			{
				title: 'Force',
				href: '/docs/microflow-studio/nodes/input/force',
				parent: '/docs/microflow-studio/nodes/input',
			},
			{
				title: 'Generic sensor',
				href: '/docs/microflow-studio/nodes/input/sensor',
				parent: '/docs/microflow-studio/nodes/input',
			},
			{
				title: 'Hall effect',
				href: '/docs/microflow-studio/nodes/input/hall-effect',
				parent: '/docs/microflow-studio/nodes/input',
			},
			{
				title: 'LDR',
				href: '/docs/microflow-studio/nodes/input/ldr',
				parent: '/docs/microflow-studio/nodes/input',
			},
			{
				title: 'Motion',
				href: '/docs/microflow-studio/nodes/input/motion',
				parent: '/docs/microflow-studio/nodes/input',
			},
			{
				title: 'Potentiometer',
				href: '/docs/microflow-studio/nodes/input/potentiometer',
				parent: '/docs/microflow-studio/nodes/input',
			},
			{
				title: 'Proximity',
				href: '/docs/microflow-studio/nodes/input/proximity',
				parent: '/docs/microflow-studio/nodes/input',
			},
			{
				title: 'Switch',
				href: '/docs/microflow-studio/nodes/input/switch',
				parent: '/docs/microflow-studio/nodes/input',
			},
			{
				title: 'Tilt',
				href: '/docs/microflow-studio/nodes/input/tilt',
				parent: '/docs/microflow-studio/nodes/input',
			},
			{
				title: 'MQTT',
				href: '/docs/microflow-studio/nodes/input/mqtt',
				parent: '/docs/microflow-studio/nodes/input',
			},
			// Output
			{
				title: 'Output',
				href: '/docs/microflow-studio/nodes/output',
				parent: '/docs/microflow-studio/nodes',
			},
			{
				title: 'LED',
				href: '/docs/microflow-studio/nodes/output/led',
				parent: '/docs/microflow-studio/nodes/output',
			},
			{
				title: 'Piezo',
				href: '/docs/microflow-studio/nodes/output/piezo',
				parent: '/docs/microflow-studio/nodes/output',
			},
			{
				title: 'Relay',
				href: '/docs/microflow-studio/nodes/output/relay',
				parent: '/docs/microflow-studio/nodes/output',
			},
			{
				title: 'Servo',
				href: '/docs/microflow-studio/nodes/output/servo',
				parent: '/docs/microflow-studio/nodes/output',
			},
			{
				title: 'Vibration',
				href: '/docs/microflow-studio/nodes/output/vibration',
				parent: '/docs/microflow-studio/nodes/output',
			},
			{
				title: 'Figma',
				href: '/docs/microflow-studio/nodes/output/figma',
				parent: '/docs/microflow-studio/nodes/output',
			},
			// Event
			{
				title: 'Event',
				href: '/docs/microflow-studio/nodes/event',
				parent: '/docs/microflow-studio/nodes',
			},
			{
				title: 'Interval',
				href: '/docs/microflow-studio/nodes/event/interval',
				parent: '/docs/microflow-studio/nodes/event',
			},
			{
				title: 'Trigger',
				href: '/docs/microflow-studio/nodes/event/trigger',
				parent: '/docs/microflow-studio/nodes/event',
			},
			// Generator
			{
				title: 'Generator',
				href: '/docs/microflow-studio/nodes/generator',
				parent: '/docs/microflow-studio/nodes',
			},
			{
				title: 'Constant',
				href: '/docs/microflow-studio/nodes/generator/constant',
				parent: '/docs/microflow-studio/nodes/generator',
			},
			{
				title: 'Oscillator',
				href: '/docs/microflow-studio/nodes/generator/oscillator',
				parent: '/docs/microflow-studio/nodes/generator',
			},
			// Transformation
			{
				title: 'Transformation',
				href: '/docs/microflow-studio/nodes/transformation',
				parent: '/docs/microflow-studio/nodes',
			},
			{
				title: 'Calculate',
				href: '/docs/microflow-studio/nodes/transformation/calculate',
				parent: '/docs/microflow-studio/nodes/transformation',
			},
			{
				title: 'Map',
				href: '/docs/microflow-studio/nodes/transformation/map',
				parent: '/docs/microflow-studio/nodes/transformation',
			},
			{
				title: 'Smooth',
				href: '/docs/microflow-studio/nodes/transformation/smooth',
				parent: '/docs/microflow-studio/nodes/transformation',
			},
			// Control
			{
				title: 'Control',
				href: '/docs/microflow-studio/nodes/control',
				parent: '/docs/microflow-studio/nodes',
			},
			{
				title: 'Compare',
				href: '/docs/microflow-studio/nodes/control/compare',
				parent: '/docs/microflow-studio/nodes/control',
			},
			{
				title: 'Counter',
				href: '/docs/microflow-studio/nodes/control/counter',
				parent: '/docs/microflow-studio/nodes/control',
			},
			{
				title: 'Delay',
				href: '/docs/microflow-studio/nodes/control/delay',
				parent: '/docs/microflow-studio/nodes/control',
			},
			{
				title: 'Gate',
				href: '/docs/microflow-studio/nodes/control/gate',
				parent: '/docs/microflow-studio/nodes/control',
			},
			// Information
			{
				title: 'Information',
				href: '/docs/microflow-studio/nodes/information',
				parent: '/docs/microflow-studio/nodes',
			},
			{
				title: 'Monitor',
				href: '/docs/microflow-studio/nodes/information/monitor',
				parent: '/docs/microflow-studio/nodes/information',
			},
			{
				title: 'Note',
				href: '/docs/microflow-studio/nodes/information/note',
				parent: '/docs/microflow-studio/nodes/information',
			},
			{ title: 'Edges', href: '/docs/microflow-studio/edges' },
		],
	},
	{
		title: 'Microflow hardware bridge',
		links: [
			{ title: 'Getting started', href: '/docs/microflow-hardware-bridge' },
			{ title: 'Variables', href: '/docs/microflow-hardware-bridge/variables' },
			{
				title: 'Connecting',
				href: '/docs/microflow-hardware-bridge/variables/connecting',
				parent: '/docs/microflow-hardware-bridge/variables',
			},
			{
				title: 'Manipulating',
				href: '/docs/microflow-hardware-bridge/variables/manipulating',
				parent: '/docs/microflow-hardware-bridge/variables',
			},
			{ title: 'MQTT', href: '/docs/microflow-hardware-bridge/mqtt' },
		],
	},
	{
		title: 'Community',
		links: [
			{ title: 'How to contribute', href: '/docs/contributing/how-to' },
			{ title: 'Add your own node', href: '/docs/contributing/nodes' },
		],
	},
];
