import {
  createContext,
  PropsWithChildren,
  useContext,
  useEffect,
  useState,
} from "react";
import { useMqtt } from "./MqttProvider";

export type FigmaVariable = {
  id: string;
  name: string;
  resolvedType: "FLOAT" | "STRING" | "BOOLEAN" | "COLOR";
};

const FigmaContext = createContext({
  variableValues: {} as Record<string, unknown>,
  variableTypes: {} as Record<string, FigmaVariable>,
});

export function FigmaProvider(props: PropsWithChildren) {
  const { status, subscribe } = useMqtt();
  const [variableValues, setVariableValues] = useState<Record<string, unknown>>(
    {},
  );
  const [variableTypes, setVariableTypes] = useState<
    Record<string, FigmaVariable>
  >({});

  useEffect(() => {
    if (status !== "connected") return;

    subscribe("fhb/v1/xiduzo/variables", (topic, message) => {
      const next = Array.from(
        JSON.parse(message.toString()) as FigmaVariable[],
      ).reduce(
        (acc, curr) => {
          acc[curr.id] = curr;
          return acc;
        },
        {} as Record<string, FigmaVariable>,
      );
      setVariableTypes(next);
    });

    subscribe("fhb/v1/xiduzo/variable/+/figma", (topic, message) => {
      const [_prefix, _version, _id, _topic, variableId] = topic.split("/");
      setVariableValues((prev) => {
        const next = { ...prev };
        next[variableId] = JSON.parse(message.toString());
        return next;
      });
    });
  }, [status, subscribe]);

  return (
    <FigmaContext.Provider value={{ variableValues, variableTypes }}>
      {props.children}
    </FigmaContext.Provider>
  );
}

export const useFigma = () => useContext(FigmaContext);
