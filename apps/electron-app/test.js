const { SerialPort } = require('serialport');

const KNOWN_BOARD_PRODUCT_IDS = [
	['uno', ['0043', '7523', '0001', 'ea60', '6015']],
	['mega', ['0042', '6001', '0010', '7523']],
	['leonardo', ['0036', '8036', '800c']],
	['micro', ['0037', '8037', '0036', '0237']],
	['nano', ['6001', '7523']],
	['yun', ['0041', '8041']],
];

async function getDevices() {
	// const usbDevices = usb.getDeviceList();
	// const webUsbDevices = await new WebUSB({
	// 	allowAllDevices: true,
	// }).getDevices();
	const serialPortDevices = await SerialPort.list();

	serialPortDevices.forEach(device => {
		const productId = device.productId || device.pnpId;
		if (productId) {
			KNOWN_BOARD_PRODUCT_IDS.forEach(([board, productIds]) => {
				if (productIds.includes(productId)) {
					console.log('SerialPort', board, device);
				}
			});
		}
	});
}

getDevices();
