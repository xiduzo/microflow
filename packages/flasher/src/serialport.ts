import { SerialPort } from 'serialport';

export async function getConnectedPorts() {
	return SerialPort.list();
}

export type PortInfo = Awaited<ReturnType<typeof getConnectedPorts>>[number];
