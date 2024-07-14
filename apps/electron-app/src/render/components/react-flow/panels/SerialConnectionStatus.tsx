import { Badge, Icons } from "@fhb/ui";
import { useBoard } from "../../../providers/BoardProvider";
import { CodeUploader } from "./CodeUploader";
import { FlashFirmata } from "./FlashFirmata";

export function SerialConnectionStatus() {
  const { checkResult } = useBoard();

  if (checkResult.type === "error") {
    return <FlashFirmata message={checkResult.message} />;
  }

  if (checkResult.type === "ready") {
    return (
      <Badge className="bg-green-400 text-green-900 pointer-events-none">
        Connected
        <CodeUploader />
      </Badge>
    );
  }

  if (checkResult.type === "info" && checkResult.class === "Connected") {
    return (
      <Badge className="pointer-events-none">
        Validating firmware
        <Icons.Zap className="ml-2 h-3 w-3 animate-pulse" />
      </Badge>
    );
  }

  if (checkResult.type === "fail") {
    return (
      <Badge variant="destructive" className="pointer-events-none">
        {checkResult.message ?? "Unknown error occurred"}
        <Icons.LoaderCircle className="ml-2 h-3 w-3 animate-spin" />
      </Badge>
    );
  }

  return (
    <Badge className="pointer-events-none">
      {checkResult.message?.split("\n")[0].trim() ??
        "Looking for connected device"}
      <Icons.LoaderCircle className="ml-2 h-3 w-3 animate-spin" />
    </Badge>
  );
}
