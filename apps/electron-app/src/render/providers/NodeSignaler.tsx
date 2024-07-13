import { useReactFlow } from "@xyflow/react";
import {
  createContext,
  PropsWithChildren,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { UploadedCodeMessage } from "../../main/ipc";

const Signaler = createContext({});

export function SignalerProvider({ children }: PropsWithChildren) {
  const [signaler, setSignaler] = useState(false);
  const { updateNodeData } = useReactFlow();
  const timeouts = useRef<Map<string, NodeJS.Timeout>>(new Map());

  useEffect(() => {
    console.log("registering ipc");
    return window.electron.ipcRenderer.on(
      "ipc-fhb-uploaded-code",
      (message: UploadedCodeMessage) => {
        console.log(message);
        if (timeouts.current.get(message.nodeId)) {
          clearTimeout(timeouts.current.get(message.nodeId));
        }

        const update: { animated: string; value?: unknown } = {
          animated: message.action,
        };

        if (message.action === "change" && message.value !== undefined) {
          update.value = message.value;
        }

        updateNodeData(message.nodeId, update);

        timeouts.current.set(
          message.nodeId,
          setTimeout(() => {
            updateNodeData(message.nodeId, { animated: undefined });
          }, 150),
        );
      },
    );
  }, [updateNodeData]);

  return (
    <Signaler.Provider value={{ signaler, setSignaler }}>
      {children}
    </Signaler.Provider>
  );
}

export const useSignaler = () => useContext(Signaler);
