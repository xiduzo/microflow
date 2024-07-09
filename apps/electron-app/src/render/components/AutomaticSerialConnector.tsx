import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Icons,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@fhb/ui";
import { type KnownBoard } from "avrgirl-arduino";
import { useEffect, useState } from "react";
import { type BoardCheckResult, type BoardFlashResult } from "../../main/ipc";

const SUPPORTED_BOARDS: [KnownBoard, string][] = [
  ["uno", "Arduino uno"],
  ["mega", "Arduino mega"],
  ["leonardo", "Arduino leonardo"],
  ["micro", "Arduino micro"],
  ["nano", "Arduino nano"],
  ["yun", "Arduino yun"],
];

export function AutomaticSerialConnector() {
  const [boardToFlash, setBoardToFlash] = useState<string>();
  const [checkResult, setCheckResult] = useState<BoardCheckResult>({
    type: "exit",
  });
  const [flashResult, setFlashResult] = useState<BoardFlashResult>({
    type: "done",
  });

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
            console.log("try again");
            window.electron.ipcRenderer.send("ipc-fhb-check-board");
            break;
        }
      },
    );
  }, []);

  function flashFirmata() {
    window.electron.ipcRenderer.once(
      "ipc-fhb-flash-firmata",
      (result: BoardFlashResult) => {
        console.log(result);
        setFlashResult(result);

        switch (result.type) {
          case "done":
            setBoardToFlash(undefined);
            window.electron.ipcRenderer.send("ipc-fhb-check-board");
            break;
        }
      },
    );
    window.electron.ipcRenderer.send("ipc-fhb-flash-firmata", boardToFlash);
  }

  if (checkResult.type === "ready") {
    return (
      <Badge
        className="bg-green-400 text-green-900 hover:bg-green-400 hover:text-green-900"
        aria-label="connected"
      >
        Connected
      </Badge>
    );
  }

  if (checkResult.type === "info" && checkResult.class === "Connected") {
    return (
      <Badge className="flex items-center justify-center">
        Validating firmware
        <Icons.Zap className="ml-2 h-3 w-3 animate-pulse" />
      </Badge>
    );
  }

  if (checkResult.type === "fail") {
    return (
      <Badge variant="destructive" className="flex items-center justify-center">
        {checkResult.message ?? "Unknown error occurred"}
        <Icons.LoaderCircle className="ml-2 h-3 w-3 animate-spin" />
      </Badge>
    );
  }

  if (checkResult.type === "error") {
    return (
      <section className="flex items-center space-x-2">
        <Badge variant={checkResult.message ? "destructive" : "secondary"}>
          {checkResult.message?.split("\n")[0].trim() ??
            "Unknown error occurred"}
        </Badge>
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="ghost" size="icon">
              <Icons.ArrowBigRight className="h-4 w-4" />
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Upload</DialogTitle>
              <DialogDescription>
                This action will remove any existing code on your device.
              </DialogDescription>
            </DialogHeader>
            <section className="flex flex-col space-y-4 justify-end">
              {flashResult.message && (
                <Alert variant="destructive" className="bg-red-100">
                  <Icons.TerminalIcon className="h-4 w-4" />
                  <AlertTitle>Flashing failed</AlertTitle>
                  <AlertDescription>{flashResult.message}</AlertDescription>
                </Alert>
              )}
              <Select value={boardToFlash} onValueChange={setBoardToFlash}>
                <SelectTrigger>
                  <SelectValue placeholder="Select your board" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectLabel>Compatible boards</SelectLabel>
                    {SUPPORTED_BOARDS.map(([key, value]) => (
                      <SelectItem key={key} value={key}>
                        {value}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <Button
                disabled={flashResult.type === "flashing" || !boardToFlash}
                onClick={flashFirmata}
              >
                Upload firmware
                {flashResult.type === "flashing" && (
                  <Icons.LoaderCircle className="ml-2 h-4 w-4 animate-spin" />
                )}
              </Button>
            </section>
          </DialogContent>
        </Dialog>
      </section>
    );
  }

  return (
    <Badge>
      {checkResult.message?.split("\n")[0].trim() ??
        "Looking for connected device"}
      <Icons.LoaderCircle className="ml-2 h-3 w-3 animate-spin" />
    </Badge>
  );
}
