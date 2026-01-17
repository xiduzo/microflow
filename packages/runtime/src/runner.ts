import { Board } from "johnny-five";
import {
  AudioPlayer,
  Button,
  Calculate,
  Compare,
  Constant,
  Counter,
  Delay,
  Figma,
  Gate,
  Hotkey,
  Interval,
  Led,
  Llm,
  Matrix,
  Monitor,
  Motion,
  Mqtt,
  Oscillator,
  Piezo,
  Pixel,
  Proximity,
  RangeMap,
  Relay,
  Rgb,
  Sensor,
  Servo,
  Smooth,
  Switch,
  TcpSerial,
  Trigger,
} from "./index";

type ComponentConstructor = new (data: any) => Node;

const ComponentMap: Record<string, ComponentConstructor> = {
  AudioPlayer,
  Button,
  Calculate,
  Compare,
  Constant,
  Counter,
  Delay,
  Figma,
  Gate,
  Hotkey,
  Interval,
  Led,
  Llm,
  Matrix,
  Monitor,
  Motion,
  Mqtt,
  Oscillator,
  Piezo,
  Pixel,
  Proximity,
  RangeMap,
  Relay,
  Rgb,
  Sensor,
  Servo,
  Smooth,
  Switch,
  Trigger,
};

type BoardWithOverrides = Board & {
  register: Node[];
  io: {
    removeAllListeners: () => void;
  };
};
let board: BoardWithOverrides | null = null;

type Node =
  | AudioPlayer
  | Button
  | Calculate
  | Compare
  | Constant
  | Counter
  | Delay
  | Figma
  | Gate
  | Hotkey
  | Interval
  | Led
  | Llm
  | Matrix
  | Monitor
  | Motion
  | Mqtt
  | Oscillator
  | Piezo
  | Pixel
  | Proximity
  | RangeMap
  | Relay
  | Rgb
  | Sensor
  | Servo
  | Smooth
  | Switch
  | Trigger;

type Edge = {
  source: string;
  target: string;
  sourceHandle: string;
  targetHandle: string;
  id?: string;
};

type FlowChangeMessage = {
  type: "flow";
  nodes: Node[];
  edges: Edge[];
};

type SetExternalMessage = {
  type: "setExternal";
  nodeId: string;
  value: unknown;
};

type CreateBoardMessage = {
  type: "createBoard";
  port: string;
  overTcp?: boolean;
};

type WorkerMessage = SetExternalMessage | FlowChangeMessage | CreateBoardMessage;

const components = new Map<string, Node>();

process.on("message", (message: WorkerMessage) => {
  console.log("message", message);
  switch (message.type) {
    case "setExternal":
      const node = components.get(message.nodeId);
      if (!node) return;
      if ("setExternal" in node) {
        node.setExternal(message.value as string);
      }
      break;
    case "flow":
      board!.io.removeAllListeners();
      board!.register = []; // Remove references to old components

      // Step 1; remove compoments
      Array.from(components.entries()).forEach(([nodeId, nodeInstance]) => {
        nodeInstance.destroy();
        components.delete(nodeId);
      });

      // Step 2; add new components
      message.nodes.forEach((node) => {
        try {
          const instance = node.data.instance;
          if (!instance) return;
          const Component = ComponentMap[instance];
          if (!Component) {
            console.error(`Unknown component type: ${instance}`);
            return;
          }
          const nodeInstance = new Component({
            ...node.data,
            id: node.id,
            board: board,
          });
          components.set(node.id, nodeInstance);
        } catch {
          // stdout({
          //     type: 'error',
          //     message: `Error creating component ${node.data.instance}`,
          //     ...error,
          //     node: node,
          // });
        }
      });

      // Step 3; add handlers
      message.edges.forEach((edge) => {
        const sourceNode = components.get(edge.source);
        if (!sourceNode) return;
        const targetNode = components.get(edge.target);
        if (!targetNode) return;
        const eventHandler = handler(sourceNode, targetNode, edge, message.edges);
        sourceNode.on(edge.sourceHandle, eventHandler);
        // unsubscribers.set(edge.id, () => sourceNode.off(edge.sourceHandle, eventHandler));
      });
      break;
    case "createBoard":
      board = createBoard(message.port, message.overTcp ?? false);
      break;
    default:
      console.error("Unknown message type", message);
      break;
  }
});

const handler =
  (sourceNode: Node, targetNode: Node, edge: Edge, edges: Edge[]) => (value: unknown) => {
    try {
      sourceNode.postMessage(edge.sourceHandle, edge.id);

      // check if sourceNode is a Button
      if (targetNode instanceof Gate) {
        targetNode.check(getInputValues(targetNode, edges));
        return;
      }

      if (targetNode instanceof Calculate) {
        targetNode.check(getInputValues(targetNode, edges));
        return;
      }

      if (targetNode instanceof Llm && edge.targetHandle === "invoke") {
        targetNode.invoke(getInputValueAsKeyValuePairs(targetNode, edges));
        return;
      }

      const method = (targetNode as any)[edge.targetHandle];
      if (typeof method === "function") {
        method.call(targetNode, value);
      }
    } catch (error) {
      console.error(error);
    }
  };

function getInputValues(targetNode: Node, edges: Edge[]) {
  return edges
    .filter(({ target }) => target === targetNode.id)
    .map(({ source }) => components.get(source)?.value);
}

function getInputValueAsKeyValuePairs(targetNode: Node, edges: Edge[]) {
  return edges
    .filter(({ target }) => target === targetNode.id)
    .reduce(
      (acc, { targetHandle, source }) => {
        if (acc[targetHandle]) {
          acc[targetHandle] = [acc[targetHandle], components.get(source)?.value].join(", ");
        } else {
          acc[targetHandle] = components.get(source)?.value;
        }
        return acc;
      },
      {} as Record<string, unknown>,
    );
}

function getPins(board: Board) {
  return Object.entries(board.pins as Record<string, { mode: number; type: string }>).reduce(
    (acc, [key, value]) => {
      acc.push({ pin: Number(key), ...value });
      return acc;
    },
    [] as { pin: number; mode: number; type: string }[],
  );
}

function createBoard(port: string, overTcp: boolean) {
  let connection: TcpSerial | string = port;
  if (overTcp) connection = new TcpSerial({ host: port, port: 3030 });

  const board = new Board({
    port: connection,
    repl: false,
    debug: true,
  }) as BoardWithOverrides;

  // This event will emit after the connect event and only when the Board instance object has completed
  // any hardware initialization that must take place before the program can operate.
  // This process is asynchronous, and completion is signified to the program via a "ready" event
  // For on-board execution, ready should emit after connect.
  board.on("ready", () => process.send?.({ type: "ready", pins: getPins(board) }));
  // When board is found but no Firmata is flashed
  board.on("error", (error) => process.send?.({ type: "error", message: error.message }));
  // This event is emitted synchronously on SIGINT.
  // Use this handler to do any necessary cleanup before your program is "disconnected" from the board.
  board.on("exit", () => process.send?.({ type: "exit" }));
  // This event is emmited when the device does not respond.
  // Can be used to detect if board gets disconnected.
  board.on("close", () => process.send?.({ type: "close" }));
  // This event will emit once the program has "connected" to the board.
  // This may be immediate, or after some amount of time, but is always asynchronous.
  // For on-board execution, connect should emit as soon as possible, but asynchronously.
  board.on("connect", () => process.send?.({ type: "connect" }));
  // This event will emit for any logging message: info, warn or fail.
  board.on("message", (message) => process.send?.(message));

  return board;
}
