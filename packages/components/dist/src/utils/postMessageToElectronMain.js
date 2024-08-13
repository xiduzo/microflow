"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.postMessageToElectronMain = postMessageToElectronMain;
const node_1 = __importDefault(require("electron-log/node"));
function postMessageToElectronMain(message) {
    if ('parentPort' in process) {
        const parentPort = process.parentPort;
        parentPort.postMessage(message);
        return;
    }
    node_1.default.warn('postMessageToElectronMain: process.parentPort is not available. Are you running in a node process?');
}
