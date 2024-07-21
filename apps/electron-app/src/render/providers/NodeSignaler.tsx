import { useReactFlow } from "@xyflow/react";
import {
  createContext,
  PropsWithChildren,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { UploadedCodeMessage } from "../../common/types";

const Signaler = createContext({});

export function SignalerProvider({ children }: PropsWithChildren) {
  const [signaler, setSignaler] = useState(false);
  const { updateNodeData, getEdges, updateEdge } = useReactFlow();
  const timeouts = useRef<Map<string, NodeJS.Timeout>>(new Map());

  useEffect(() => {
    return window.electron.ipcRenderer.on(
      "ipc-fhb-uploaded-code",
      (message: UploadedCodeMessage) => {
        if (timeouts.current.get(message.nodeId)) {
          clearTimeout(timeouts.current.get(message.nodeId));
        }

        const update: { animated: string; value?: unknown } = {
          animated: message.action,
          value: message.value,
        };

        updateNodeData(message.nodeId, update);

        getEdges()
          .filter(
            (edge) =>
              edge.source === message.nodeId &&
              edge.sourceHandle === message.action,
          )
          .map((edge) => {
            const timeout = timeouts.current.get(edge.id);
            if (timeout) clearTimeout(timeout);

            updateEdge(edge.id, { animated: true });

            timeouts.current.set(
              edge.id,
              setTimeout(() => {
                updateEdge(edge.id, { animated: false });
              }, 150),
            );
          });

        timeouts.current.set(
          message.nodeId,
          setTimeout(() => {
            updateNodeData(message.nodeId, { animated: undefined });
          }, 150),
        );
      },
    );
  }, [updateNodeData, getEdges, updateEdge]);

  return (
    <Signaler.Provider value={{ signaler, setSignaler }}>
      {children}
    </Signaler.Provider>
  );
}

export const useSignaler = () => useContext(Signaler);
