import { NodeContainer } from "../_base/_base";
import { Handle } from "../../handle";
import { Position } from "@xyflow/react";
import { button, folder } from "leva";
import { useNodeData } from "../_base/_base";
import { useNodeValue } from "@/stores/node-data";
import { MatrixDisplay } from "./matrix-display";
import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselPrevious,
  CarouselNext,
} from "@/components/ui/carousel";
import { MatrixEditor } from "./matrix-editor";
import { Button } from "@/components/ui/button";
import { type Data, type Value, dataSchema } from "./matrix.schema";
import { type BaseNode } from "../_base/_base";
import {
  DEFAULT_MATRIX_START_SHAPE,
  type MatrixShape,
} from "./matrix.constants";
import { DEFAULT_MATRIX_SHAPE } from "./matrix.constants";
import { usePins } from "@/stores/board";
import { MODES } from "@/stores/board";
import { reducePinsToOptions } from "@/components/hardware/pin";
import { useNodeControls } from "../_base/_base";
import { ArrowLeftRightIcon, ArrowRightLeftIcon } from "lucide-react";

export function Matrix(props: Props) {
  return (
    <NodeContainer {...props}>
      <Value />
      <Settings />
      <Handle
        type="target"
        position={Position.Left}
        id="show"
        hint="shows shape #"
        offset={-0.5}
      />
      <Handle type="target" position={Position.Left} id="hide" offset={0.5} />
      <Handle type="source" position={Position.Right} id="change" />
    </NodeContainer>
  );
}

function getShape(dimensions: string, devices: number): [number, number] {
  switch (dimensions) {
    case "8x8":
      return [8, 8 * devices];
    case "16x8":
      return [16, 8 * devices];
    case "8x16":
      return [8, 16 * devices];
    default:
      return [8, 8];
  }
}

function Value() {
  const data = useNodeData<Data>();
  const value = useNodeValue<Value>(DEFAULT_MATRIX_START_SHAPE);

  return (
    <section className="flex items-center justify-center m-4">
      <MatrixDisplay
        dimensions={getShape(data.dims, data.devices)}
        shape={value}
      />
    </section>
  );
}

function Settings() {
  const data = useNodeData<Data>();
  const [editorOpened, setEditorOpened] = useState(false);
  const [shapes, setShapes] = useState(
    data.shapes ?? data.shapes ?? [DEFAULT_MATRIX_SHAPE]
  );

  const pins = usePins([MODES.INPUT], [MODES.ANALOG]);
  const { render, setNodeData } = useNodeControls(
    {
      dims: {
        value: data.dims,
        label: "dimensions",
        options: ["8x8", "16x8", "8x16"],
      },
      devices: { value: data.devices, min: 1, max: 8, step: 1 },
      pins: folder({
        data: {
          value: data.pins.data,
          options: pins.reduce(reducePinsToOptions, {}),
          label: "data (DIN)",
          onChange: (value) => {
            setNodeData({
              ...data,
              pins: { ...data.pins, data: value },
            });
          },
        },
        clock: {
          value: data.pins.clock,
          options: pins
            .filter((pin) => pin.supportedModes.includes(MODES.PWM))
            .reduce(reducePinsToOptions, {}),
          label: "clock (CLK)",
          onChange: (value) => {
            setNodeData({
              ...data,
              pins: { ...data.pins, clock: value },
            });
          },
        },
        cs: {
          value: data.pins.cs,
          options: pins.reduce(reducePinsToOptions, {}),
          label: "chip select (CS)",
          onChange: (value) => {
            setNodeData({
              ...data,
              pins: { ...data.pins, cs: value },
            });
          },
        },
      }),
      "edit shapes": button(() => setEditorOpened(true)),
    },
    [pins]
  );

  function updateShapes(newShapes: MatrixShape[]) {
    setShapes(newShapes);
    data.shapes = newShapes;
    setNodeData(data);
  }

  function swapShapes(left: number, right: number) {
    const nextShapes = [...shapes];
    nextShapes[left] = shapes[right];
    nextShapes[right] = shapes[left];
    updateShapes(nextShapes);
  }

  return (
    <>
      {render()}
      {editorOpened && (
        <Dialog defaultOpen onOpenChange={setEditorOpened}>
          <DialogContent className="max-w-3xl">
            <DialogHeader>
              <DialogTitle>Shapes</DialogTitle>
              <DialogDescription>
                When showing a shape the input handle will round to the closest
                shape number
              </DialogDescription>
            </DialogHeader>
            <section className="flex items-center justify-center">
              <Carousel className="w-full max-w-xl">
                <CarouselContent>
                  {shapes.map((shape, index) => {
                    return (
                      <CarouselItem
                        key={index}
                        className="flex flex-col items-center gap-3 cursor-grab active:cursor-grabbing"
                      >
                        <MatrixEditor
                          dimensions={getShape(data.dims, data.devices)}
                          onSave={(newShape) => {
                            const nextShapes = [...shapes];
                            nextShapes[index] = newShape;
                            updateShapes(nextShapes);
                          }}
                          onDelete={() => {
                            const nextShapes = [...shapes];
                            nextShapes.splice(index, 1);
                            updateShapes(nextShapes);
                          }}
                          shape={shape}
                        >
                          <section className="flex-col flex items-center justify-center">
                            <section className="max-w-xl overflow-x-scroll pb-8">
                              <MatrixDisplay
                                dimensions={getShape(data.dims, data.devices)}
                                shape={shape}
                                className="hover:cursor-zoom-in"
                              />
                            </section>
                          </section>
                        </MatrixEditor>
                        <section className="text-muted-foreground flex gap-20 items-center">
                          <Button
                            variant="outline"
                            disabled={index === 0 || index - 1 < 0}
                            onClick={() => swapShapes(index - 1, index)}
                          >
                            <ArrowLeftRightIcon /> Swap
                          </Button>
                          <div>
                            Shape #{index + 1} of {shapes.length}
                          </div>
                          <Button
                            variant="outline"
                            disabled={
                              index === shapes.length - 1 ||
                              index + 1 >= shapes.length
                            }
                            onClick={() => swapShapes(index, index + 1)}
                          >
                            Swap
                            <ArrowRightLeftIcon />
                          </Button>
                        </section>
                      </CarouselItem>
                    );
                  })}
                </CarouselContent>
                <CarouselPrevious />
                <CarouselNext />
              </Carousel>
            </section>
            <MatrixEditor
              key={shapes.length}
              onSave={(newShape) => updateShapes([...shapes, newShape])}
              dimensions={getShape(data.dims, data.devices)}
              shape={[]}
            >
              <Button variant="outline">Add new shape</Button>
            </MatrixEditor>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

type Props = BaseNode<Data>;
Matrix.defaultProps = {
  data: {
    ...dataSchema.parse({}),
    group: "hardware",
    tags: ["output", "analog", "digital"],
    label: "LED Matrix",
    icon: "GridIcon",
    description: "Display patterns, shapes, or images on a grid of LED lights",
  } satisfies Props["data"],
};
