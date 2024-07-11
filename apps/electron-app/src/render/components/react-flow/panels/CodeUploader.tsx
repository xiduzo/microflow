import { Button } from "@fhb/ui";
import { useShallow } from "zustand/react/shallow";
import useNodesEdgesStore, { AppState } from "../../../store";

const selector = (state: AppState) => ({
  nodes: state.nodes,
  edges: state.edges,
});

export function CodeUploader() {
  const { nodes, edges } = useNodesEdgesStore(useShallow(selector));

  function uploadCode() {
    let code = `
      const JohnnyFive = require("johnny-five");
      const log = require("electron-log/node");

      try {
        const board = new JohnnyFive.Board({
          repl: false,
          debug: false,
        });
    `;

    code += `
        board.on("error", (error) => {
          process.parentPort.postMessage({ type: "error", message: error.message });
        });

        board.on("fail", (event) => {
          process.parentPort.postMessage({ type: "fail", message: event.message });
        });

        board.on("warn", (event) => {
          process.parentPort.postMessage({ type: "warn", message: event.message });
        });

        board.on("exit", () => {
          process.parentPort.postMessage({ type: "exit" });
        });

        board.on("close", () => {
          process.parentPort.postMessage({ type: "close" });
        });
    `;

    code += `
        board.on("ready", () => {
          process.parentPort.postMessage({ type: "ready" });
          log.info("board is ready");
    `;

    nodes.forEach((node) => {
      if (node.type !== "Button" && node.type !== "Led") return;

      code += `
          const ${node.type}_${node.id} = new JohnnyFive.${node.type}(${JSON.stringify(node.data)});
      `;
    });

    const startingNodes = nodes.filter((node) => {
      return !edges.some((edge) => edge.target === node.id);
    });

    startingNodes.forEach((node) => {
      const actions = edges.filter((edge) => edge.source === node.id);

      actions.forEach((action) => {
        const targetNodes = nodes.filter((node) => node.id === action.target);

        code += `
          ${node.type}_${node.id}.on("${action.sourceHandle}", () => {
            log.info("${node.type}_${node.id} - ${action.sourceHandle}");
            process.parentPort.postMessage({ id: "${node.id}", action: "${action.sourceHandle}" });
        `;

        targetNodes.forEach((targetNode) => {
          code += `
            ${targetNode.type}_${targetNode.id}.${action.targetHandle}();
          `;
        });

        code += `
          }); // ${node.type}_${node.id} - ${action.sourceHandle}
        `;
      });
    });

    code += `
        }); // board - ready;
      } catch (error) {
        log.error("something went wrong", { error });
      }
    `;

    console.log(code);
    window.electron.ipcRenderer.send("ipc-fhb-upload-code", code);
  }

  return <Button onClick={uploadCode}>Upload code</Button>;
}
