import { SerialPort } from "serialport";
import { UnableToOpenSerialConnection } from "./errors";

export class SerialConnection {
  serialPort: SerialPort;

  constructor(baudRate: number, path: string) {
    this.serialPort = new SerialPort({ autoOpen: false, path, baudRate });
  }

  async sendResetSignals(value: boolean, delay: number) {
    return new Promise<void>((resolve, reject) => {
      this.serialPort.set({ rts: value, dtr: value }, (error) => {
        if (error) reject(error);

        setTimeout(() => {
          console.debug(`Reset signal sent`, value, delay);
          resolve();
        }, delay);
      });
    });
  }

  async open() {
    return new Promise<void>((resolve, reject) => {
      this.serialPort.open((error) => {
        if (error) reject(new UnableToOpenSerialConnection(error.message));

        console.debug(`Serial port opened on ${this.serialPort.path}`);
        resolve();
      });
    });
  }

  async close() {
    if (!this.serialPort.isOpen) return;

    return new Promise<void>((resolve, reject) => {
      this.serialPort.close((error) => {
        if (error) reject(error);

        console.debug(`Serial port closed on ${this.serialPort.path}`);
        resolve();
      });
    });
  }
}
