import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Kbd } from "@/components/ui/kbd";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useIsMac } from "@/hooks/is-mac";
import { useEffect, useState } from "react";
import { useHotkeys, useRecordHotkeys } from "react-hotkeys-hook";

export function HotkeySheet() {
  const isMac = useIsMac();
  const [open, setOpen] = useState(false);

  const toggleSheet = () => {
    setOpen(!open);
  };

  useHotkeys("control+shift+slash", toggleSheet, {
    enabled: true,
    enableOnFormTags: false,
    preventDefault: true,
    scopes: ["flow"],
  });
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent side="bottom">
        <SheetHeader>
          <SheetTitle>Hotkeys</SheetTitle>
          <SheetDescription className="flex gap-1">
            Toggle this sheet by pressing{" "}
            <div className="flex items-center gap-0.5">
              <Kbd>{isMac ? "⌃" : "control"}</Kbd>{" "}
              <Kbd>{isMac ? "⇧" : "shift"}</Kbd> <Kbd>/</Kbd>
            </div>
          </SheetDescription>
        </SheetHeader>
        <Tabs defaultValue="essential" className="mb-12 container mx-auto px-4">
          <TabsList>
            <TabsTrigger value="essential">Essential</TabsTrigger>
            <TabsTrigger value="navigation">Navigation</TabsTrigger>
            <TabsTrigger value="edit">Edit</TabsTrigger>
          </TabsList>
          <TabsContent
            value="essential"
            className="grid md:grid-cols-3 grid-cols-1 gap-4"
          >
            <section>
              <Item>
                <ItemContent>
                  <ItemTitle>Pan</ItemTitle>
                </ItemContent>
                <ItemActions>
                  <Kbd>click</Kbd>
                  <Kbd>drag</Kbd>
                </ItemActions>
              </Item>
            </section>
            <Separator className="md:hidden" />
            <section>
              <Item>
                <ItemContent>
                  <ItemTitle>Zoom in</ItemTitle>
                </ItemContent>
                <ItemActions>
                  <Kbd>{isMac ? "⌘" : "ctrl"}</Kbd>
                  <Kbd className="font-mono">+</Kbd>
                </ItemActions>
              </Item>
              <Item>
                <ItemContent>
                  <ItemTitle>Zoom out</ItemTitle>
                </ItemContent>
                <ItemActions>
                  <Kbd>{isMac ? "⌘" : "ctrl"}</Kbd>
                  <Kbd className="font-mono">-</Kbd>
                </ItemActions>
              </Item>
              <Item>
                <ItemContent>
                  <ItemTitle>Zoom to fit</ItemTitle>
                </ItemContent>
                <ItemActions>
                  <Kbd>{isMac ? "⌘" : "ctrl"}</Kbd>
                  <Kbd className="font-mono">0</Kbd>
                </ItemActions>
              </Item>
            </section>
          </TabsContent>
          <TabsContent
            value="navigation"
            className="grid md:grid-cols-3 grid-cols-1 gap-4"
          >
            <section>
              <Item>
                <ItemContent>
                  <ItemTitle>Pan</ItemTitle>
                </ItemContent>
              </Item>
            </section>
            <section></section>
          </TabsContent>
          <TabsContent
            value="edit"
            className="grid md:grid-cols-3 grid-cols-1 gap-4"
          >
            <section>
              <Item>
                <ItemContent>
                  <ItemTitle>Copy</ItemTitle>
                </ItemContent>
                <ItemActions>
                  <Kbd>{isMac ? "⌘" : "ctrl"}</Kbd>
                  <Kbd className="uppercase">c</Kbd>
                </ItemActions>
              </Item>
              <Item>
                <ItemContent>
                  <ItemTitle>Cut</ItemTitle>
                </ItemContent>
                <ItemActions>
                  <Kbd>{isMac ? "⌘" : "ctrl"}</Kbd>
                  <Kbd className="uppercase">x</Kbd>
                </ItemActions>
              </Item>
              <Item>
                <ItemContent>
                  <ItemTitle>Paste</ItemTitle>
                </ItemContent>
                <ItemActions>
                  <Kbd>{isMac ? "⌘" : "ctrl"}</Kbd>
                  <Kbd className="uppercase">v</Kbd>
                </ItemActions>
              </Item>
            </section>
            <Separator className="md:hidden" />
            <section>
              <Item>
                <ItemContent>
                  <ItemTitle>New node</ItemTitle>
                </ItemContent>
                <ItemActions>
                  <Kbd>{isMac ? "⌘" : "ctrl"}</Kbd>
                  <Kbd className="uppercase">k</Kbd>
                </ItemActions>
              </Item>
              <Item>
                <ItemContent>
                  <ItemTitle>Undo</ItemTitle>
                </ItemContent>
                <ItemActions>
                  <Kbd>{isMac ? "⌘" : "ctrl"}</Kbd>
                  <Kbd className="uppercase">z</Kbd>
                </ItemActions>
              </Item>
              <Item>
                <ItemContent>
                  <ItemTitle>Redo</ItemTitle>
                </ItemContent>
                <ItemActions>
                  <Kbd>{isMac ? "⌘" : "ctrl"}</Kbd>
                  <Kbd>{isMac ? "⇧" : "shift"}</Kbd>
                  <Kbd className="uppercase">z</Kbd>
                </ItemActions>
              </Item>
            </section>
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}
