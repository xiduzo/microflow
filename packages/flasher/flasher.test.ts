import { expect, test } from "bun:test";

import path from "path";
import { Flasher } from "./src/Flasher";
import { getConnectedPorts } from "./src/serialport";

async function flash() {
  const ports = await getConnectedPorts();
  console.log(ports);
  const board = "leonardo";
  const __dirname = path.resolve(path.dirname(""));
  const filePath = path.resolve(
    __dirname,
    `./hex/${board}/StandardFirmata.ino.hex`
  );
  await new Flasher(board, "/dev/tty.usbmodem1401").flash(filePath);
  console.log("done");
}

test("flash", async () => {
  await flash();
});
