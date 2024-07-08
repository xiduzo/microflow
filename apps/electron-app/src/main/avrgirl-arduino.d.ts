declare module 'avrgirl-arduino' {
  type KnownBoard =
    'adk'
    | 'arduboy'
    | 'blend-micro'
    | 'bqZum'
    | 'circuit-playground-classic'
    | 'duemilanove168'
    | 'duemilanove328'
    | 'esplora'
    | 'feather'
    | 'imuduino'
    | 'leonardo'
    | 'lilypad-usb'
    | 'little-bits'
    | 'mega'
    | 'micro'
    | 'nano (new bootloader)'
    | 'nano'
    | 'pinoccio'
    | 'pro-mini'
    | 'qduino'
    | 'sf-pro-micro'
    | 'tinyduino'
    | 'uno'
    | 'xprov4'
    | 'yun'
    | 'zumcore2'
    | 'zumjunior';

  type Port = {
    path: string;
    manufacturer?: string;
    serialNumber?: string;
    pnpId?: string;
    locationId?: string;
    vendorId?: string;
    productId?: string;
    _standardPid: string;
  }

  type ListCallback = (error: unknown, ports: Port[]) => void;

  type ClassOptions = {
    board: KnownBoard;
  }

  // https://github.com/noopkat/avrgirl-arduino/blob/master/avrgirl-arduino.js
  export default class AvrGirl {
    constructor(options: ClassOptions);
    static listKnownBoards(): KnownBoard[];
    static list(callback: ListCallback): void
    flash(firmware: string, callback: (error: unknown) => void): void;
  }
}
