import { type ElectronHandler } from './src/preload';

declare global {
  interface Window {
    electron: ElectronHandler;
  }
}
