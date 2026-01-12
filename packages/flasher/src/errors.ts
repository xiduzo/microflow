export class UnableToOpenSerialConnection extends Error {}

export class BoardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class BoardNotFoundError extends BoardError {
  constructor(boardName: string) {
    super(`Board ${boardName} is not a know board`);
    this.name = this.constructor.name;
  }
}

export class FlashError extends Error {
  constructor(boardName: string, usbPortPath: string, filePath: string) {
    super(`Unable to flash ${boardName} on ${usbPortPath} using ${filePath}`);
    this.name = this.constructor.name;
  }
}
