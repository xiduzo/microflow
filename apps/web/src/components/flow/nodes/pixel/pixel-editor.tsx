import { DEFAULT_OFF_PIXEL_COLOR } from "@microflow/runtime/pixel/pixel.constants";
import { type Value } from "@microflow/runtime/pixel/pixel.types";
import { useState, useEffect, type PropsWithChildren } from "react";
import { PixelDisplay } from "./pixel-display";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogClose,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { HexColorPicker } from "react-colorful";

function newPreset(options: {
  length: number;
  preset?: Value;
  fill?: string;
}): Value {
  const preset = Array.from({ length: options.length }, (_, i) => {
    if (options.preset && options.preset[i]) {
      return options.preset[i];
    }
    return options.fill ?? DEFAULT_OFF_PIXEL_COLOR;
  });

  return preset;
}

export function PixelEditor(props: Props) {
  const [preset, setPreset] = useState<Value>(() =>
    newPreset({
      length: props.length,
      preset: props.preset,
    })
  );
  const [selectedPixel, setSelectedPixel] = useState<number | null>(null);
  const [colorPickerOpen, setColorPickerOpen] = useState(false);

  // Sync preset state when props.preset changes
  useEffect(() => {
    setPreset(
      newPreset({
        length: props.length,
        preset: props.preset,
      })
    );
    setSelectedPixel(null); // Reset selection when preset changes
    setColorPickerOpen(false);
  }, [props.preset, props.length]);

  const handlePixelClick = (index: number) => {
    setSelectedPixel(index);
    setColorPickerOpen(true);
  };

  return (
    <Dialog>
      <DialogTrigger>{props.children}</DialogTrigger>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {!!props.onDelete ? "Edit" : "Add new"} preset
          </DialogTitle>
        </DialogHeader>
        <div className="p-4 overflow-x-scroll flex flex-col items-center justify-center gap-4">
          <PixelDisplay
            value={preset}
            length={props.length}
            onPixelClick={handlePixelClick}
            selectedPixel={selectedPixel}
          />
        </div>
        {selectedPixel !== null && (
          <Dialog open={colorPickerOpen} onOpenChange={setColorPickerOpen}>
            <DialogContent className="max-w-sm">
              <DialogHeader>
                <DialogTitle>Pixel {selectedPixel + 1} color</DialogTitle>
              </DialogHeader>
              <div className="flex flex-col items-center gap-4 py-4">
                <HexColorPicker
                  color={preset[selectedPixel] || DEFAULT_OFF_PIXEL_COLOR}
                  onChange={(color) => {
                    setPreset((prev) => {
                      const newPreset = [...prev];
                      newPreset[selectedPixel] = color;
                      return newPreset;
                    });
                  }}
                />
                <Button
                  variant="outline"
                  onClick={() => {
                    setPreset((prev) => {
                      const newPreset = [...prev];
                      newPreset[selectedPixel] = DEFAULT_OFF_PIXEL_COLOR;
                      return newPreset;
                    });
                  }}
                >
                  Clear pixel
                </Button>
              </div>
              <DialogFooter>
                <DialogClose>
                  <Button onClick={() => setColorPickerOpen(false)}>
                    Done
                  </Button>
                </DialogClose>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
        <section className="flex space-x-2">
          <Button
            className="grow"
            variant="outline"
            onClick={() => {
              setPreset(
                newPreset({
                  length: props.length,
                  fill: DEFAULT_OFF_PIXEL_COLOR,
                })
              );
              setSelectedPixel(null);
            }}
          >
            Fill all white
          </Button>
          <Button
            variant="outline"
            className="grow"
            onClick={() => {
              setPreset(
                newPreset({
                  length: props.length,
                  fill: DEFAULT_OFF_PIXEL_COLOR,
                })
              );
              setSelectedPixel(null);
            }}
          >
            Clear all
          </Button>
        </section>
        <DialogFooter className="gap-2 sm:gap-0">
          {props.onDelete && (
            <DialogClose>
              <Button onClick={props.onDelete} variant="destructive">
                Delete preset
              </Button>
            </DialogClose>
          )}
          <DialogClose>
            <Button onClick={() => props.onSave(preset)}>Save preset</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type Props = PropsWithChildren & {
  length: number;
  preset?: Value;
  onSave: (preset: Value) => void;
  onDelete?: () => void;
};
