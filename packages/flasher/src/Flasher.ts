import { type Board, type BoardName, BOARDS } from "./constants";
import { BoardNotFoundError, FlashError } from "./errors";
import { SerialConnection } from "./SerialConnection";

export class Flasher {
  private readonly connection: SerialConnection;
  private readonly board: Board;

  constructor(boardName: BoardName, usbPortPath: string) {
    const board = BOARDS.find(({ name }) => name === boardName);

    if (!board) throw new BoardNotFoundError(boardName);

    this.board = board;
    this.connection = new SerialConnection(board.baudRate, usbPortPath);

    console.debug(`Created flasher for ${board.name} on ${usbPortPath}`);
  }

  async flash(filePath: string) {
    try {
      const protocol = new this.board.protocol(this.connection, this.board);

      console.debug(`Flashing ${filePath}`);
      await protocol.flash(filePath);
      console.debug(`Flashing succeeded!`);
    } catch (error) {
      console.debug(error);
      throw new FlashError(this.board.name, this.connection.serialPort.path, filePath);
    } finally {
      await this.connection.close(); // Always close the port again
    }
  }
}
