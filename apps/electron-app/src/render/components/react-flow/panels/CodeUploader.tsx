import { Button } from "@fhb/ui";
import { Node } from "@xyflow/react";
import { useShallow } from "zustand/react/shallow";
import { AppState, useNodesEdgesStore } from "../../../store";
import { NodeType } from "../ReactFlowCanvas";

const selector = (state: AppState) => ({
  nodes: state.nodes,
  edges: state.edges,
});

export function CodeUploader() {
  const { nodes, edges } = useNodesEdgesStore(useShallow(selector));

  function createNode(node: Node) {
    switch (node.type as NodeType) {
      case "Button":
      case "Led":
        node.data.id = node.id;
        return `
          const ${node.type}_${node.id} = new CustomJohnnyFive${node.type}(${JSON.stringify(node.data)})`;
      case "Counter":
        return `
          const ${node.type}_${node.id} = new Counter("${node.id}");`;
      default:
        console.warn(`Unknown node type: ${node.type}`);
        return ``;
    }
  }

  function uploadCode() {
    let code = `
      const EventEmitter = require("events");
      const JohnnyFive = require("johnny-five");
      const log = require("electron-log/node");

      try {
        const board = new JohnnyFive.Board({
          repl: false,
          debug: false,
        });
    `;

    code += `
        board.on("ready", () => {
          log.info("board is ready");
          process.parentPort.postMessage({ type: "ready" });
    `;

    code += `
          /*
           * Create nodes
           */`;
    nodes.forEach((node) => {
      code += createNode(node);
    });

    code += `

          /*
           * Node handlers
           */`;

    const nodeWithChildren = nodes.filter((node) => {
      return edges.some((edge) => edge.source === node.id);
    });

    nodeWithChildren.forEach((node) => {
      const actions = edges.filter((edge) => edge.source === node.id);

      const actionsGroupedByHandle = actions.reduce(
        (acc, action) => {
          if (!acc[action.sourceHandle]) {
            acc[action.sourceHandle] = [];
          }

          acc[action.sourceHandle].push(action);

          return acc;
        },
        {} as Record<string, typeof actions>,
      );

      Object.entries(actionsGroupedByHandle).forEach(([action, edges]) => {
        code += `
          ${node.type}_${node.id}.on("${action}", () => {
        `;

        edges.forEach((edge) => {
          const target = nodes.find((node) => node.id === edge.target);
          code += `
            ${target.type}_${target.id}.${edge.targetHandle}(${edge.data ? JSON.stringify(edge.data) : ""});`;
        });

        code += `
          }); // ${node.type}_${node.id} - ${action}
        `;
      });
    });

    code += `
        }); // board - ready;
    `;
    code += createBoardHandlers();
    code += `
      } catch (error) {
        log.error("something went wrong", { error });
      }
    `;

    if (nodes.find((node) => node.type === "Counter")) {
      code += createCounterClass();
    }

    code += customJohnnyFiveButton();
    code += customJohnnyFiveLed();

    console.log(code);
    window.electron.ipcRenderer.send("ipc-fhb-upload-code", code);
  }

  return <Button onClick={uploadCode}>Upload code</Button>;
}
function createBoardHandlers() {
  return `
        /*
         * Board events in order to communicate with the main process
         */
        board.on("error", (error) => {
          log.error("board error", { error });
          process.parentPort.postMessage({ type: "error", message: error.message });
        }); // board - error

        board.on("fail", (event) => {
          log.warn("board fail", { event });
          process.parentPort.postMessage({ type: "fail", message: event.message });
        }); // board - fail

        board.on("warn", (event) => {
          log.warn("board warn", { event });
          process.parentPort.postMessage({ type: "warn", message: event.message });
        }); // board - warn

        board.on("exit", () => {
          log.info("board exit");
          process.parentPort.postMessage({ type: "exit" });
        }); // board - exit

        board.on("close", () => {
          log.info("board close");
          process.parentPort.postMessage({ type: "close" });
        }); // board - close
  `;
}

function createCounterClass() {
  return `
      class Counter extends EventEmitter {
        #count = 0;
        id = null;

        constructor(id) {
          super();

          this.id = id;
        }

        set count(value) {
          this.#count = value;
          this.emit("change", value);
          process.parentPort.postMessage({ nodeId: this.id, action: "change", value });
        }

        get count() {
          return this.#count;
        }

        increment(amount = 1) {
          this.count += parseInt(amount);
          process.parentPort.postMessage({ nodeId: this.id, action: "increment" });
        }

        decrement(amount = 1) {
          this.count -= parseInt(amount);
          process.parentPort.postMessage({ nodeId: this.id, action: "decrement" });
        }

        reset() {
          this.count = 0;
          process.parentPort.postMessage({ nodeId: this.id, action: "reset" });
        }

        set(value) {
          this.count = parseInt(value);
          process.parentPort.postMessage({ nodeId: this.id, action: "set" });
        }
      }
  `;
}

function customJohnnyFiveButton() {
  return `
      class CustomJohnnyFiveButton extends JohnnyFive.Button {
        constructor(options) {
          super(options)

          this.on("up", () => {
            process.parentPort.postMessage({ nodeId: this.id, action: "up" });
            this.emit("change", false);
          })

          this.on("down", () => {
            process.parentPort.postMessage({ nodeId: this.id, action: "down" });
            this.emit("change", true);
          })

          this.on("hold", () => {
            process.parentPort.postMessage({ nodeId: this.id, action: "hold" });
            this.emit("change", true);
          })

          this.on("change", (value) => {
            process.parentPort.postMessage({ nodeId: this.id, action: "change", value });
          })
        }
      }
  `;
}

function customJohnnyFiveLed() {
  return `
      class CustomJohnnyFiveLed extends JohnnyFive.Led {
        #previousIsOn = false;
        #eventEmitter = new EventEmitter();

        constructor(options) {
          super(options);
          this.#interval();
        }

        #interval() {
          setInterval(() => {
            if (this.#previousIsOn !== this.isOn) {
              this.#eventEmitter.emit("change");
              process.parentPort.postMessage({ nodeId: this.id, action: "change", value: this.isOn });
            }

            this.#previousIsOn = this.isOn;
          }, 25);
        }

        on(event, callback) {
          if (!event) {
            super.on();
            process.parentPort.postMessage({ nodeId: this.id, action: "on" });
            return;
          }

          this.#eventEmitter.on(event, callback);
        }

        off() {
          super.off();
          process.parentPort.postMessage({ nodeId: this.id, action: "off" });
        }

        toggle() {
          super.toggle();
          process.parentPort.postMessage({ nodeId: this.id, action: "toggle" });
        }
      }
  `;
}
