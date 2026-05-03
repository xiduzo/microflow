import { Handle } from "../../handle";
import {
  NodeContainer,
  useNodeControls,
  useNodeData,
  type BaseNode,
} from "../_base/_base";
import { useNodeValue } from "@/stores/node-data";
import { dataSchema, defaults, type Data, type Value } from "./pixel.schema";
import { COLORS, DEFAULT_OFF_PIXEL_COLOR } from "./pixel.constants";
import { PixelDisplay } from "./pixel-display";
import { useState } from "react";
import { MODES } from "@/stores/board";
import { usePins } from "@/stores/board";
import { pinsToOptions } from "@/components/hardware/pin";
import { button, folder } from "leva";
import { PixelEditor } from "./pixel-editor";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from "@/components/ui/carousel";
import { Button } from "@/components/ui/button";
import { ArrowLeftRightIcon, ArrowRightLeftIcon } from "lucide-react";

// Create a simple hash for the preset to use as a key
function presetKey(preset: Value, index: number): string {
  return `preset-${index}-${JSON.stringify(preset)}`;
}

export function Pixel(props: Props) {
  return (
    <NodeContainer {...props}>
      <Value />
      <Settings />
      <Handle
        type="target"
        position="left"
        id="value"
        handleType="value"
        hint="preset #"
        offset={-1.5}
      />
      <Handle
        type="target"
        position="left"
        id="color"
        handleType="value"
        hint="hex colors"
        offset={-0.5}
      />
      <Handle
        type="target"
        position="left"
        id="set"
        handleType="command"
        hint="shift pixels"
        offset={0.5}
      />
      <Handle
        type="target"
        position="left"
        id="reset"
        handleType="command"
        offset={1.5}
      />
      <Handle type="source" position="right" id="event" handleType="event" />
    </NodeContainer>
  );
}

function Value() {
  const data = useNodeData<Data>();
  const value = useNodeValue<Value>(
    Array(data.length).fill(DEFAULT_OFF_PIXEL_COLOR)
  );

  return <PixelDisplay value={value} length={data.length} showLabel />;
}

function Settings() {
  const data = useNodeData<Data>();
  const pins = usePins([MODES.OUTPUT], [MODES.ANALOG]);
  const [editorOpened, setEditorOpened] = useState(false);
  const [presets, setPresets] = useState<Value[]>(data.presets ?? [[]]);

  const { render, setNodeData } = useNodeControls({
    pin: {
      value: data.pin,
      options: pinsToOptions(pins),
      label: "pin",
    },
    length: {
      value: data.length,
      min: 1,
      max: 144,
      step: 1,
    },
    "edit presets": button(() => setEditorOpened(true)),
    advanced: folder(
      {
        gamma: {
          value: data.gamma,
          min: 0,
          max: 10,
          step: 0.1,
        },
        color_order: {
          value: data.color_order,
          label: "color order",
          hint: "The order of the colors in the pixel strip",
          options: COLORS,
        },
      },
      { collapsed: true }
    ),
  });

  function updatePresets(newPresets: Value[]) {
    setPresets(newPresets);
    data.presets = newPresets;
    setNodeData(data);
  }

  function swapPresets(left: number, right: number) {
    const nextPresets = [...presets];
    nextPresets[left] = presets[right];
    nextPresets[right] = presets[left];
    updatePresets(nextPresets);
  }

  return (
    <>
      {render()}
      {editorOpened && (
        <Dialog defaultOpen onOpenChange={setEditorOpened}>
          <DialogContent className="max-w-3xl overflow-hidden">
            <DialogHeader>
              <DialogTitle>Presets</DialogTitle>
              <DialogDescription>
                When showing a preset the input handle will round to the closest
                preset number
              </DialogDescription>
            </DialogHeader>
            <section className="flex items-center justify-center min-w-0 w-full">
              <Carousel className="w-full max-w-xl min-w-0">
                <CarouselContent>
                  {presets.map((preset, index) => {
                    return (
                      <CarouselItem
                        key={index}
                        className="flex flex-col items-center gap-3 cursor-grab active:cursor-grabbing"
                      >
                        <PixelEditor
                          key={presetKey(preset, index)}
                          length={data.length}
                          preset={preset}
                          onSave={(newPreset) => {
                            const nextPresets = [...presets];
                            nextPresets[index] = newPreset;
                            updatePresets(nextPresets);
                          }}
                          onDelete={() => {
                            const nextPresets = [...presets];
                            nextPresets.splice(index, 1);
                            updatePresets(nextPresets);
                          }}
                        >
                          <section className="flex-col flex items-center justify-center">
                            <section className="max-w-xl overflow-x-auto pb-8">
                              <PixelDisplay
                                value={preset}
                                length={data.length}
                              />
                            </section>
                          </section>
                        </PixelEditor>
                        <section className="text-muted-foreground flex gap-20 items-center">
                          <Button
                            variant="outline"
                            disabled={index === 0 || index - 1 < 0}
                            onClick={() => swapPresets(index - 1, index)}
                          >
                            <ArrowLeftRightIcon /> Swap
                          </Button>
                          <div>
                            {index + 1}/{presets.length}
                          </div>
                          <Button
                            variant="outline"
                            disabled={
                              index === presets.length - 1 ||
                              index + 1 >= presets.length
                            }
                            onClick={() => swapPresets(index, index + 1)}
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
            <PixelEditor
              key={presets.length}
              onSave={(newPreset) => updatePresets([...presets, newPreset])}
              length={data.length}
              preset={[]}
            >
              <Button variant="outline">Add new preset</Button>
            </PixelEditor>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

type Props = BaseNode<Data>;
Pixel.defaultProps = { data: defaults };
