import { Button } from "@fhb/ui";
import { useShallow } from "zustand/react/shallow";
import useStore, { AppState } from "../../../store";

const selector = (state: AppState) => ({
  nodes: state.nodes,
  edges: state.edges,
});

export function CodeUploader() {
  const { nodes, edges } = useStore(useShallow(selector));

  function nodeTypeToJohnnyFiveComponent(type: string) {
    switch (type) {
      case "button":
        return "Button";
      case "led":
        return "Led";
      default:
        return null;
    }
  }

  function uploadCode() {
    let code = `
      const JohnnyFive = require("johnny-five");
      const log = require("electron-log/node");

      try {
        const board = new JohnnyFive.Board({
          repl: false,
          debug: true,
        });
    `;

    code += `
        board.on("ready", () => {
          log.info("board is ready");
    `;

    // edge: { source: "node-1", target: "node-2" }
    // node: { id: "node-1" }
    const startingNodes = nodes.filter((node) => {
      return !edges.some((edge) => edge.target === node.id);
    });

    nodes.forEach((node) => {
      const johnnyFiveType = nodeTypeToJohnnyFiveComponent(node.type);
      if (!johnnyFiveType) return;

      code += `
          const ${node.type}_${node.id} = new JohnnyFive.${johnnyFiveType}({
            pin: ${node.data.pin},
          });
      `;
    });

    startingNodes.forEach((node) => {
      const actions = edges.filter((edge) => edge.source === node.id);

      actions.forEach((action) => {
        const targetNodes = nodes.filter((node) => node.id === action.target);

        code += `
          ${node.type}_${node.id}.on("${action.sourceHandle}", () => {
        `;

        targetNodes.forEach((targetNode) => {
          code += `
            ${targetNode.type}_${targetNode.id}.${action.targetHandle}();
          `;
        });

        code += `
          }) // ${node.type}_${node.id} - ${action.sourceHandle};
        `;
      });
    });

    code += `
        }) // board - ready;
      } catch (error) {
        log.error("something went wrong", { error });
      }
    `;

    console.log(code.toString());
    window.electron.ipcRenderer.send("ipc-fhb-upload-code", code.toString());
  }

  return <Button onClick={uploadCode}>Upload code</Button>;
}
