// https://www.figma.com/plugin-docs/manifest/
export default {
	name: 'Microflow hardware bridge',
	id: '1373258770799080545',
	api: '1.0.0',
	main: 'plugin.js',
	ui: 'index.html',
	capabilities: [],
	enableProposedApi: false,
	editorType: ['figma'],
	documentAccess: 'dynamic-page',
	networkAccess: {
		allowedDomains: ['*'],
		reasoning:
			'This plugin could connect to any MQTT broker of your liking to send and receive messages.',
	},
};
