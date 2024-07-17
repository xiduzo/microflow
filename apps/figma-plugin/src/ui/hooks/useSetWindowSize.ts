import { useEffect } from "react";
import { SetUiOptions } from "../../common/types/Message";
import { sendMessageToFigma } from "../utils/sendMessageToFigma";

export function useSetWindowSize(
  options: Pick<ShowUIOptions, "height" | "width">,
) {
  useEffect(() => {
    sendMessageToFigma(SetUiOptions(options));
  }, [options]);
}
