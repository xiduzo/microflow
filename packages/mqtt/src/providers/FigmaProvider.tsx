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
  const { status, subscribe, publish, appName } = useMqtt();
  const [variableValues, setVariableValues] = useState<Record<string, unknown>>(
    {},
  );
  const [variableTypes, setVariableTypes] = useState<
    Record<string, FigmaVariable>
  >({});

  useEffect(() => {
    if (status !== "connected") return;

    function handleVariablesUpdate(_topic: string, message: Buffer) {
      const variables = JSON.parse(message.toString()) as Record<
        string,
        FigmaVariable
      >;
      setVariableTypes(variables);
    }

    function handleVariableUpdaet(topic: string, message: Buffer) {
      const [_prefix, _version, _id, _app, _topic, variableId] =
        topic.split("/");
      setVariableValues((prev) => {
        const next = { ...prev };
        next[variableId] = JSON.parse(message.toString());
        return next;
      });
    }

    subscribe("fhb/v1/xiduzo/plugin/variables", handleVariablesUpdate);
    subscribe(
      `fhb/v1/xiduzo/${appName}/variables/response`,
      handleVariablesUpdate,
    );

    subscribe("fhb/v1/xiduzo/plugin/variable/+", handleVariableUpdaet);
    subscribe(`fhb/v1/xiduzo/${appName}/variable/+`, handleVariableUpdaet);
  }, [status, subscribe, appName]);

  useEffect(() => {
    if (
      Object.values(variableValues).length &&
      Object.values(variableTypes).length
    ) {
      return;
    }

    const interval = setInterval(() => {
      console.log("Requesting variables");
      publish(`fhb/v1/xiduzo/${appName}/variables/request`, "");
    }, 1000);

    return () => clearInterval(interval);
  }, [variableValues, variableTypes]);

  return (
    <FigmaContext.Provider value={{ variableValues, variableTypes }}>
      {props.children}
    </FigmaContext.Provider>
  );
}

export const useFigma = () => useContext(FigmaContext);
