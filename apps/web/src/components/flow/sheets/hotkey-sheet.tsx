import { Badge } from "@/components/ui/badge";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
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
          <TabsList className="w-full">
            <TabsTrigger value="essential">Essential</TabsTrigger>
            <TabsTrigger value="zoom">Zoom</TabsTrigger>
            <TabsTrigger value="selection">Selection</TabsTrigger>
            <TabsTrigger value="edit">Edit</TabsTrigger>
          </TabsList>
          <TabsContent
            value="essential"
            className="grid lg:grid-cols-3 grid-cols-1 gap-4 min-h-48"
          >
            <section>
              <Item>
                <ItemContent>
                  <ItemTitle>Pan view</ItemTitle>
                  <ItemDescription>
                    Navigate your flow by clicking and dragging on the screen
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Kbd>click</Kbd>
                  <Kbd>drag</Kbd>
                </ItemActions>
              </Item>
            </section>
            <Separator className="lg:hidden" />
            <section>
              <Item>
                <ItemContent>
                  <ItemTitle>New node</ItemTitle>
                  <ItemDescription>
                    Adding new nodes to your flow
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Kbd>{isMac ? "⌘" : "ctrl"}</Kbd>
                  <Kbd className="uppercase">k</Kbd>
                </ItemActions>
              </Item>
            </section>
            <Separator className="lg:hidden" />
            <section>
              <Item>
                <ItemContent>
                  <ItemTitle>Connect nodes</ItemTitle>
                  <ItemDescription>
                    Connecting nodes in your flow
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Kbd>click</Kbd>
                  <Kbd>drag</Kbd>
                </ItemActions>
              </Item>
            </section>
          </TabsContent>
          <TabsContent
            value="zoom"
            className="grid lg:grid-cols-3 grid-cols-1 gap-4 min-h-48"
          >
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
                  <ItemTitle>Zoom to 100%</ItemTitle>
                </ItemContent>
                <ItemActions>
                  <Kbd>{isMac ? "⌘" : "ctrl"}</Kbd>
                  <Kbd className="font-mono">0</Kbd>
                </ItemActions>
              </Item>
            </section>
            <Separator className="lg:hidden" />
            <section>
              <Item>
                <ItemContent>
                  <ItemTitle>Zoom to fit</ItemTitle>
                  <ItemDescription>
                    Zoom into the selected nodes and edges
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Kbd>{isMac ? "⇧" : "shift"}</Kbd>
                  <Kbd className="font-mono">1</Kbd>
                </ItemActions>
              </Item>
            </section>
            <Separator className="lg:hidden" />
            <section></section>
          </TabsContent>
          <TabsContent
            value="selection"
            className="grid lg:grid-cols-3 grid-cols-1 gap-4 min-h-48"
          >
            <section>
              <Item>
                <ItemContent>
                  <ItemTitle>Select node</ItemTitle>
                  <ItemDescription>
                    By selecting a node you can edit its properties
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Kbd>click</Kbd>
                </ItemActions>
              </Item>
              <Item>
                <ItemContent>
                  <ItemTitle>Select edge</ItemTitle>
                </ItemContent>
                <ItemActions>
                  <Kbd>click</Kbd>
                </ItemActions>
              </Item>
            </section>
            <Separator className="lg:hidden" />
            <section>
              <Item>
                <ItemContent>
                  <ItemTitle>Select multiple</ItemTitle>
                  <ItemDescription>
                    Select multiple nodes and edges at once
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Kbd>{isMac ? "⌘" : "shift"}</Kbd>
                  <Kbd>click</Kbd>
                </ItemActions>
              </Item>
              <Item>
                <ItemContent>
                  <ItemTitle>Select area</ItemTitle>
                  <ItemDescription>
                    Selects all nodes and edges within the area
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Kbd>{isMac ? "⇧" : "shift"}</Kbd>
                  <Kbd>click</Kbd>
                  <Kbd>drag</Kbd>
                </ItemActions>
              </Item>
              <Item>
                <ItemContent>
                  <ItemTitle>Select all</ItemTitle>
                </ItemContent>
                <ItemActions>
                  <Kbd>{isMac ? "⌘" : "ctrl"}</Kbd>
                  <Kbd className="uppercase">a</Kbd>
                </ItemActions>
              </Item>
            </section>
            <Separator className="lg:hidden" />
            <section>
              <Item>
                <ItemContent>
                  <ItemTitle>Clear selection</ItemTitle>
                </ItemContent>
                <ItemActions>
                  <Kbd>{isMac ? "⎋" : "esc"}</Kbd>
                </ItemActions>
              </Item>
            </section>
          </TabsContent>
          <TabsContent
            value="edit"
            className="grid lg:grid-cols-3 grid-cols-1 gap-4 min-h-48"
          >
            <section>
              <Item>
                <ItemContent>
                  <ItemTitle>Copy node(s)</ItemTitle>
                  <ItemDescription>Copies all selected nodes</ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Kbd>{isMac ? "⌘" : "ctrl"}</Kbd>
                  <Kbd className="uppercase">c</Kbd>
                </ItemActions>
              </Item>
              <Item>
                <ItemContent>
                  <ItemTitle>Paste node(s)</ItemTitle>
                </ItemContent>
                <ItemActions>
                  <Kbd>{isMac ? "⌘" : "ctrl"}</Kbd>
                  <Kbd className="uppercase">v</Kbd>
                </ItemActions>
              </Item>
            </section>
            <Separator className="lg:hidden" />
            <section>
              <Item>
                <ItemContent>
                  <ItemTitle>Delete node</ItemTitle>
                </ItemContent>
                <ItemActions>
                  <Kbd>{isMac ? "⌫" : "backspace"}</Kbd>
                </ItemActions>
              </Item>
            </section>
            <Separator className="lg:hidden" />
            <section></section>
          </TabsContent>
          {/* <TabsContent
            value="edit"
            className="grid lg:grid-cols-3 grid-cols-1 gap-4"
          >
            <section></section>
            <Separator className="lg:hidden" />
            <section></section>
            <Separator className="lg:hidden" />
            <section></section>
          </TabsContent> */}
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}
