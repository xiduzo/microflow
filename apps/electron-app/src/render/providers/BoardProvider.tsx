import { KnownBoard } from "avrgirl-arduino";
import {
  createContext,
  PropsWithChildren,
  useContext,
  useEffect,
  useState,
} from "react";
import { BoardCheckResult, BoardFlashResult } from "../../common/types";

const BoardContext = createContext({
  checkResult: {} as BoardCheckResult,
  flashResult: {} as BoardFlashResult,
  flashBoard: (board: KnownBoard) => {
    console.log("flashing board", board);
  },
});
export const useBoard = () => useContext(BoardContext);

export function BoardProvider({ children }: PropsWithChildren) {
  const [checkResult, setCheckResult] = useState<BoardCheckResult>({
    type: "exit",
  });
  const [flashResult, setFlashResult] = useState<BoardFlashResult>({
    type: "done",
  });

  function flashBoard(board: KnownBoard) {
    window.electron.ipcRenderer.once(
      "ipc-fhb-flash-firmata",
      (result: BoardFlashResult) => {
        setFlashResult(result);

        switch (result.type) {
          case "done":
            window.electron.ipcRenderer.send("ipc-fhb-check-board");
            break;
        }
      },
    );
    window.electron.ipcRenderer.send("ipc-fhb-flash-firmata", board);
  }

  useEffect(() => {
    window.electron.ipcRenderer.send("ipc-fhb-check-board");

    return window.electron.ipcRenderer.on(
      "ipc-fhb-check-board",
      (result: BoardCheckResult) => {
        setCheckResult(result);

        switch (result.type) {
          case "exit":
          case "fail":
          case "close":
            window.electron.ipcRenderer.send("ipc-fhb-check-board");
            break;
        }
      },
    );
  }, []);

  return (
    <BoardContext.Provider value={{ checkResult, flashResult, flashBoard }}>
      {children}
    </BoardContext.Provider>
  );
}
