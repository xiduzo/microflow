import Avrgirl, { type KnownBoard, type Port } from 'avrgirl-arduino';
import { ipcMain, IpcMainEvent, utilityProcess, UtilityProcess } from 'electron';
import log from 'electron-log/node';
import { readdir, writeFile } from 'fs';
import { dirname, join, resolve } from 'path';

let childProcess: UtilityProcess | null = null
let portSniffer: NodeJS.Timeout | null = null
const PORT_SNIFFER_INTERVAL_IN_MS = 250

// https://github.com/noopkat/avrgirl-arduino/blob/master/boards.js
const KNOWN_BOARD_PRODUCT_IDS: [KnownBoard, string[]][] = [
  ['uno', ['0x0043', '0x7523', '0x0001', '0xea60', '0x6015']],
  ['mega', ['0x0042', '0x6001', '0x0010', '0x7523'],],
  ["leonardo", ['0x0036', '0x8036', '0x800c']],
  ['micro', ['0x0037', '0x8037', '0x0036', '0x0237']],
  ["nano", ['0x6001', '0x7523']],
  ["yun", ['0x0041', '0x8041']],
]

// ipcMain.on("shell:open", () => {
//   const pageDirectory = __dirname.replace('app.asar', 'app.asar.unpacked')
//   const pagePath = path.join('file://', pageDirectory, 'index.html')
//   shell.openExternal(pagePath)
// })

ipcMain.on('ipc-fhb-check-board', (event) => {
  childProcess?.kill()

  const code = `
const JohnnyFive = require("johnny-five");
const log = require('electron-log/node');

try {
  const board = new JohnnyFive.Board({
    repl: false,
    debug: true,
  });
  log.debug("Board is being checked", board.port);

  board.on("info", (event) => {
    process.parentPort.postMessage({type: "info", message: event.message, class: event.class });
  });

  board.on("ready", () => { // When board is connected and Firmata is flashed
    process.parentPort.postMessage({ type: "ready", port: board.port });
  });

  board.on("error", (error) => { // When board is found but no Firmata is flashed
    process.parentPort.postMessage({ type: "error", message: error.message, port: board.port });
  });

  board.on("fail", (event) => { // When board is not found
    process.parentPort.postMessage({type: "fail", message: event.message, class: event.class });
  })

  board.on("warn", (event) => { // TODO: find out when this fires
    process.parentPort.postMessage({type: "warn", message: event.message, class: event.class });
  });

  board.on("exit", () => { // TODO: find out when this fires
    process.parentPort.postMessage({ type: "exit" });
  });

  board.on("close", () => { // TODO: find out when this fires
    process.parentPort.postMessage({ type: "close" });
  });
} catch (error) {
  log.error("something went wrong", { error });
  process.parentPort.postMessage({ type: "error", message: error.message, port: board.port });
}
  `

  const fileName = "board-check.js"
  const filePath = join(__dirname, fileName)

  writeFile(filePath, code, { encoding: 'utf-8' }, (error) => {
    if (error) {
      log.warn({ error })
      event.reply('ipc-fhb-check-board', { type: "fail", message: error.message } satisfies BoardCheckResult)
      return
    }

    childProcess = utilityProcess.fork(filePath)
    childProcess.on('message', async (message: BoardCheckResult) => {
      log.log({ message })

      if (message.type !== 'info') {
        childProcess?.kill() // Free up the port again
      }

      if (message.type !== 'error') {
        event.reply('ipc-fhb-check-board', message satisfies BoardCheckResult)
      } else {
        try {
          await forceFlashBoard()
          event.reply('ipc-fhb-check-board', { type: "ready" } satisfies BoardCheckResult) // We know the board can run Firmata now
        } catch (error) {
          log.warn({ error })
          event.reply('ipc-fhb-check-board', message satisfies BoardCheckResult)
        }
      }

      message.port && sniffPorts(message.port, event)
    })
  })
});

ipcMain.on('ipc-fhb-flash-firmata', async (event, board: KnownBoard) => {
  childProcess?.kill()
  event.reply('ipc-fhb-flash-firmata', { type: 'flashing' } satisfies BoardFlashResult)

  try {
    await flashBoard(board)
    event.reply('ipc-fhb-flash-firmata', { type: 'done' } satisfies BoardFlashResult)
  } catch (error) {
    log.warn({ error })
    event.reply('ipc-fhb-flash-firmata', { type: "error", message: error.message } satisfies BoardFlashResult)
  }
})

async function forceFlashBoard(): Promise<void> {
  return new Promise(async (resolve, reject) => {
    try {
      const ports = await getConnectedDevices()
      const potentialBoardsToFlash = KNOWN_BOARD_PRODUCT_IDS.filter(([, productIds]) => {
        for (const port of ports) {
          if (!port._standardPid) continue
          if (productIds.includes("0x" + port._standardPid)) {
            return true
          }
        }

        return false
      })

      flashing: for (const [board] of potentialBoardsToFlash) {
        try {
          await flashBoard(board)
          resolve()
          break flashing // We have successfully flashed the board and can stop trying the other boards
        } catch (flashError) {
          log.warn({ flashError })
        }
      }
    } catch (error) {
      log.warn({ error })
    }

    reject() // Should fire if we didn't flash any board
  })
}

async function flashBoard(board: KnownBoard): Promise<void> {
  log.debug("Try flashing firmata", { board })
  const avrgirlDir = dirname(require.resolve('avrgirl-arduino'));
  const firmataDir = resolve(avrgirlDir, 'junk', 'hex', board);
  let firmataPath: string | undefined;

  return new Promise((resolve, reject) => {
    readdir(firmataDir, function (readdirError, files) {
      if (readdirError) {
        log.warn({ readdirError });
        reject(readdirError)
        return
      }

      for (const file of files) {
        if (file.indexOf('StandardFirmata') < 0) continue;

        firmataPath = join(firmataDir, file);
        break;
      }

      if (typeof firmataPath === 'undefined') {
        const noFirmataPathError = new Error("oops! Couldn't find Standard Firmata file for " + board + " board.");
        log.warn({ noFirmataPathError });
        reject(noFirmataPathError)
        return
      }

      const avrgirl = new Avrgirl({ board })

      avrgirl.flash(firmataPath, (flashError?: unknown) => {
        const flashErrorResponse = new Error("oops! Unable to flash device. Make sure the correct board is selected and no other program is using the device.")
        if (flashError) {
          log.warn({ flashError })
          reject(flashErrorResponse)
          return
        }

        log.debug("Firmata flashed successfully", { board });
        resolve()
      });
    })
  })
}

function sniffPorts(connectedPort: string, event: IpcMainEvent) {
  portSniffer && clearTimeout(portSniffer);

  getConnectedDevices()
    .then(ports => {
      if (!ports.find(port => port.path === connectedPort)) {
        event.reply('ipc-fhb-check-board', { type: "exit" } satisfies BoardCheckResult)
        return
      }

      portSniffer = setTimeout(() => {
        sniffPorts(connectedPort, event)
      }, PORT_SNIFFER_INTERVAL_IN_MS)
    })
    .catch(log.warn)
}

async function getConnectedDevices(): Promise<Port[]> {
  return new Promise((resolve, reject) => {
    Avrgirl.list((error: unknown, ports: Port[]) => {
      if (error) {
        reject(error)
        return
      }

      resolve(ports)
    })
  })
}

export type BoardCheckResult = {
  type: "info" | "ready" | "fail" | "warn" | "exit" | "close" | "error",
  port?: string,
  message?: string,
  class?: "Available" | "Connected" | "Board"
}

export type BoardFlashResult = {
  type: "done" | "error" | "flashing"
  message?: string
}
