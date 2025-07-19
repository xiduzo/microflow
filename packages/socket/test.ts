import { initSocketTunnel } from './server';

initSocketTunnel()
	.then(tunnel => {
		console.log('Socket tunnel initialized successfully.', tunnel);
	})
	.catch(error => {
		console.error('Failed to initialize socket tunnel:', error);
	});
