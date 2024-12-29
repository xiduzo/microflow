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
			// Hardware
			{
				title: 'Hardware',
				href: '/docs/microflow-studio/nodes/hardware',
				parent: '/docs/microflow-studio/nodes',
			},
			{
				title: 'Button',
				href: '/docs/microflow-studio/nodes/hardware/button',
				parent: '/docs/microflow-studio/nodes/hardware',
			},
			{
				title: 'Force',
				href: '/docs/microflow-studio/nodes/hardware/force',
				parent: '/docs/microflow-studio/nodes/hardware',
			},
			{
				title: 'LDR',
				href: '/docs/microflow-studio/nodes/hardware/ldr',
				parent: '/docs/microflow-studio/nodes/hardware',
			},
			{
				title: 'LED',
				href: '/docs/microflow-studio/nodes/hardware/led',
				parent: '/docs/microflow-studio/nodes/hardware',
			},
			{
				title: 'Motion',
				href: '/docs/microflow-studio/nodes/hardware/motion',
				parent: '/docs/microflow-studio/nodes/hardware',
			},
			{
				title: 'Piezo',
				href: '/docs/microflow-studio/nodes/hardware/piezo',
				parent: '/docs/microflow-studio/nodes/hardware',
			},
			{
				title: 'Potentiometer',
				href: '/docs/microflow-studio/nodes/hardware/potentiometer',
				parent: '/docs/microflow-studio/nodes/hardware',
			},
			{
				title: 'Relay',
				href: '/docs/microflow-studio/nodes/hardware/relay',
				parent: '/docs/microflow-studio/nodes/hardware',
			},
			{
				title: 'Servo',
				href: '/docs/microflow-studio/nodes/hardware/servo',
				parent: '/docs/microflow-studio/nodes/hardware',
			},
			{
				title: 'Vibration',
				href: '/docs/microflow-studio/nodes/hardware/vibration',
				parent: '/docs/microflow-studio/nodes/hardware',
			},
			// Flow
			{
				title: 'Flow',
				href: '/docs/microflow-studio/nodes/flow',
				parent: '/docs/microflow-studio/nodes',
			},
			{
				title: 'Calculate',
				href: '/docs/microflow-studio/nodes/flow/calculate',
				parent: '/docs/microflow-studio/nodes/flow',
			},
			{
				title: 'Compare',
				href: '/docs/microflow-studio/nodes/flow/compare',
				parent: '/docs/microflow-studio/nodes/flow',
			},
			{
				title: 'Constant',
				href: '/docs/microflow-studio/nodes/flow/constant',
				parent: '/docs/microflow-studio/nodes/flow',
			},
			{
				title: 'Counter',
				href: '/docs/microflow-studio/nodes/flow/counter',
				parent: '/docs/microflow-studio/nodes/flow',
			},
			{
				title: 'Delay',
				href: '/docs/microflow-studio/nodes/flow/delay',
				parent: '/docs/microflow-studio/nodes/flow',
			},
			{
				title: 'Gate',
				href: '/docs/microflow-studio/nodes/flow/gate',
				parent: '/docs/microflow-studio/nodes/flow',
			},
			{
				title: 'Interval',
				href: '/docs/microflow-studio/nodes/flow/interval',
				parent: '/docs/microflow-studio/nodes/flow',
			},
			{
				title: 'Map',
				href: '/docs/microflow-studio/nodes/flow/map',
				parent: '/docs/microflow-studio/nodes/flow',
			},
			{
				title: 'Monitor',
				href: '/docs/microflow-studio/nodes/flow/monitor',
				parent: '/docs/microflow-studio/nodes/flow',
			},
			{
				title: 'Note',
				href: '/docs/microflow-studio/nodes/flow/note',
				parent: '/docs/microflow-studio/nodes/flow',
			},
			{
				title: 'Oscillator',
				href: '/docs/microflow-studio/nodes/flow/oscillator',
				parent: '/docs/microflow-studio/nodes/flow',
			},
			{
				title: 'Smooth',
				href: '/docs/microflow-studio/nodes/flow/smooth',
				parent: '/docs/microflow-studio/nodes/flow',
			},
			{
				title: 'Trigger',
				href: '/docs/microflow-studio/nodes/flow/trigger',
				parent: '/docs/microflow-studio/nodes/flow',
			},
			// External
			{
				title: 'External',
				href: '/docs/microflow-studio/nodes/external',
				parent: '/docs/microflow-studio/nodes',
			},
			{
				title: 'Figma',
				href: '/docs/microflow-studio/nodes/external/figma',
				parent: '/docs/microflow-studio/nodes/external',
			},
			{
				title: 'MQTT',
				href: '/docs/microflow-studio/nodes/external/mqtt',
				parent: '/docs/microflow-studio/nodes/external',
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
