declare module 'johnny-five' {
  export class Board {
    constructor(options?: any);
    on(event: string, callback: (error?: Error) => void): void;
    close(): void;
  }

  export class Led {
    constructor(pin: number | string);
    blink(interval?: number): void;
    stop(): void;
    off(): void;
    on(): void;
  }
}
