import { Message, MESSAGE_TYPE } from "../common/types/Message";
import { getLocalValue, setLocalValue } from "./handlers/clientStorage";
import { setUiOptions } from "./handlers/ui";
import { getLocalVariables, setLocalvariable } from "./handlers/variables";

figma.showUI(__html__, {
  themeColors: true,
  width: 250,
  height: 250
});

figma.ui.onmessage = <T>(message: Message<T>) => {
  const { type, payload } = message;

  switch (type) {
    case MESSAGE_TYPE.SHOW_TOAST: {
      figma.notify(payload.message, payload.options);
      break;
    }
    case MESSAGE_TYPE.SET_LOCAL_STATE_VALUE: {
      void setLocalValue(payload.key, payload.value);
      break;
    }
    case MESSAGE_TYPE.GET_LOCAL_STATE_VALUE: {
      void getLocalValue(payload.key, payload.value);
      break;
    }
    case MESSAGE_TYPE.MQTT_GET_LOCAL_VARIABLES:
    case MESSAGE_TYPE.GET_LOCAL_VARIABLES: {
      void getLocalVariables(type);
      break;
    }
    case MESSAGE_TYPE.CREATE_VARIABLE: {
      // void createVariable(payload.name, payload.resolvedType);
      break;
    }
    case MESSAGE_TYPE.UPDATE_VARIABLE: {
      // TODO: we can not update a variable (name) from the `figma.variables` object 31/05/2024
      break;
    }
    case MESSAGE_TYPE.DELETE_VARIABLE: {
      // void deleteVariable(payload);
      break;
    }
    case MESSAGE_TYPE.SET_LOCAL_VARIABLE: {
      void setLocalvariable(payload.id, payload.value as VariableValue);
      break;
    }
    case MESSAGE_TYPE.SET_UI_OPTIONS: {
      setUiOptions(payload);
      break;
    }
    default: {
      console.info("Unknown message type", { message });
    }
  }
};
