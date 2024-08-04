import { KnownBoard } from "avrgirl-arduino";
import {
    createContext,
    PropsWithChildren,
    useCallback,
    useContext,
    useEffect,
    useState,
} from "react";
import {
    BoardCheckResult,
    BoardFlashResult,
    UploadCodeResult,
} from "../../common/types";

const BoardContext = createContext({
  checkResult: {} as BoardCheckResult,
  flashResult: {} as BoardFlashResult,
  uploadResult: {} as UploadCodeResult,
  uploadCode: (code: string) => {
    console.log("uploading code", code);
  },
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
  const [uploadResult, setUploadResult] = useState<UploadCodeResult>({
    type: "close",
  });

  function flashBoard(board: KnownBoard) {
    window.electron.ipcRenderer.once(
      "ipc-fhb-flash-firmata",
      (result: BoardFlashResult) => {
        console.log("flash result", result)
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

  const uploadCode = useCallback((code: string) => {
    setUploadResult({ type: "info" });

    const off = window.electron.ipcRenderer.on(
      "ipc-fhb-upload-code",
      (message: UploadCodeResult) => {
        console.log("upload result", message)
        setUploadResult(message);

        if (message.type === "ready") {
          off();
        }
      },
    );

    window.electron.ipcRenderer.send("ipc-fhb-upload-code", code);
  }, []);

  useEffect(() => {
    window.electron.ipcRenderer.send("ipc-fhb-check-board");

    return window.electron.ipcRenderer.on(
      "ipc-fhb-check-board",
      (result: BoardCheckResult) => {
        console.log("check result", result)
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
    <BoardContext.Provider
      value={{ checkResult, flashResult, uploadResult, flashBoard, uploadCode }}
    >
      {children}
    </BoardContext.Provider>
  );
}
