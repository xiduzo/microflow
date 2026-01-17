import { type Node, useReactFlow } from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { NODE_TYPES } from "../nodes/_TYPES";
import { useFlowStore } from "@/stores/flow-store";
import { useNewNodeStore } from "@/stores/new-node";
import type { BaseNode } from "../nodes/_base";
import { uid } from "@/lib/uid";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import { DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  SearchIcon,
  BookIcon,
  ChevronUpIcon,
  ChevronDownIcon,
  CornerDownLeftIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";

const NODE_SIZE = {
  width: 208,
  height: 176,
};

export function NewNodeDialog() {
  useDraggableNewNode();

  const { open, setOpen, setNodeToAdd } = useNewNodeStore();
  const { flowToScreenPosition, getZoom } = useReactFlow();
  const addNode = useFlowStore((state) => state.addNode);
  const [filter, setFilter] = useState("");
  const commandListRef = useRef<HTMLDivElement>(null);
  const [windowSize, setWindowSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    function updateSize() {
      setWindowSize({ width: window.innerWidth, height: window.innerHeight });
    }
    updateSize();
    window.addEventListener("resize", updateSize);
    return () => window.removeEventListener("resize", updateSize);
  }, []);

  const position = useMemo(() => {
    if (windowSize.width === 0 || windowSize.height === 0) {
      return { x: 0, y: 0 };
    }
    return flowToScreenPosition({
      x: windowSize.width / 2 - (NODE_SIZE.width / 2) * getZoom(),
      y: windowSize.height / 2 - (NODE_SIZE.height / 2) * getZoom(),
    });
  }, [flowToScreenPosition, windowSize, getZoom]);

  function selectNode(node: BaseNode, type: string) {
    return function () {
      const item: Node = {
        data: node.data,
        id: uid(),
        type,
        position,
      };

      addNode(item);
      setNodeToAdd(item.id);
      setOpen(false);
    };
  }

  const groups = useMemo(() => {
    return Array.from(
      Object.entries(NODE_TYPES).reduce((groups, [type, Component]) => {
        const node: BaseNode =
          "defaultProps" in Component ? (Component.defaultProps as any) : { data: {} };

        if (node.data.group === "internal") return groups; // Skip internal nodes
        const firstTag = node.data.tags.at(0) || "information"; // Use first tag for grouping
        const group = groups.get(firstTag) ?? [];
        group.push({ node, type });
        groups.set(firstTag, group);
        return groups;
      }, new Map<string, { node: BaseNode; type: string }[]>()),
    );
  }, []);

  const searchTerm = useMemo(() => {
    const terms = [
      "Magnetic, Analog, Servo...",
      "Input, Output, Event...",
      "Generator, Transformation, Control...",
      "Figma, Switch, signals...",
      "Compare, Calculate, MQTT...",
      "Delay, Gate, LED",
      "Motion, Vibration, Oscillator",
    ];

    return terms[Math.floor(Math.random() * terms.length)];
  }, [open]);

  useEffect(() => {
    commandListRef.current?.scrollTo({
      top: 0,
      behavior: "smooth",
    });
  }, [filter]);

  return (
    <CommandDialog
      className="min-w-10/12 md:min-w-8/12 lg:min-w-6/12 xl:min-w-4/12"
      open={open}
      onOpenChange={(state) => {
        setOpen(state);
        if (!state) setFilter("");
      }}
      filter={(value: string, search: string, keywords?: string[]) => {
        const [label, description, firstTag] = value.split("|");

        // If no search term, return 0 (not relevant)
        if (!search || search.trim() === "") return 0;

        const searchLower = search.toLowerCase().trim();

        // Priority 1: Label match (highest priority)
        if (label.toLowerCase().includes(searchLower)) return 1;

        // Priority 2: First tag match
        if (firstTag && firstTag.toLowerCase().includes(searchLower)) return 0.9;

        // Priority 3: Description match
        if (description.toLowerCase().includes(searchLower)) return 0.8;

        // Priority 4: Keywords match
        if (keywords?.some((keyword: string) => keyword.toLowerCase().includes(searchLower))) {
          return 0.6;
        }

        // No match found
        return 0;
      }}
    >
      <DialogHeader className="hidden">
        <DialogTitle>Add new node</DialogTitle>
        <DialogDescription>Magnetic sensor...</DialogDescription>
      </DialogHeader>
      <CommandInput placeholder={searchTerm} onValueChange={setFilter} />
      <CommandList ref={commandListRef} className="mb-2 min-h-[400px">
        <CommandEmpty className="flex items-center justify-center h-[400px]">
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <SearchIcon size={24} />
              </EmptyMedia>
              <EmptyTitle>Nothing found</EmptyTitle>
              <EmptyDescription>
                Try searching for a different node type or visit the documentation.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <a href="https://microflow.vercel.app/docs/microflow-studio/nodes" target="_blank">
                <Button variant="link">
                  <BookIcon size={24} />
                  Visit the documentation
                </Button>
              </a>
            </EmptyContent>
          </Empty>
        </CommandEmpty>
        {groups.map(([group, nodes], index) => (
          <section key={group}>
            <CommandGroup heading={group}>
              {nodes.map(({ node, type }) => {
                return (
                  <CommandItem
                    value={`${node.data.label}|${node.data.description}`}
                    keywords={node.data.tags}
                    key={node.data.label}
                    onSelect={selectNode(node, type)}
                    className="data-[selected=true]:bg-muted-foreground/10 gap-3 items-start group"
                  >
                    <Avatar className="rounded-xl">
                      <AvatarFallback className="rounded-xl">
                        <Icon
                          icon={node.data.icon}
                          className="group-data-[selected=true]:scale-110 transition-all duration-100"
                        />
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex flex-col grow gap-3">
                      <div className="flex flex-col gap-1">
                        <div className="font-bold">{node.data.label}</div>
                        <span className="text-muted-foreground">{node.data.description ?? ""}</span>
                      </div>
                      <section className="flex items-center gap-2">
                        {node.data.tags.map((tag) => (
                          <Badge variant="outline" key={tag}>
                            {tag}
                          </Badge>
                        ))}
                      </section>
                    </div>
                    <CommandShortcut>{node.data.group}</CommandShortcut>
                  </CommandItem>
                );
              })}
            </CommandGroup>
            {index !== groups.length - 1 && <CommandSeparator />}
          </section>
        ))}
      </CommandList>
      <footer className="p-2 border-t flex gap-4 justify-between items-center">
        <a
          href="https://microflow.vercel.app/docs/microflow-studio/nodes"
          target="_blank"
          className="text-xs flex gap-2 items-center text-muted-foreground hover:underline"
        >
          <BookIcon size={12} />
          Documentation
        </a>
        <section className="flex items-center gap-3">
          <section className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Close</span>
            <CommandShortcut className="bg-muted-foreground/10 p-1 rounded-md">Esc</CommandShortcut>
          </section>
          <section className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Navigate</span>
            <div className="flex items-center gap-1">
              <CommandShortcut className="bg-muted-foreground/10 p-1 rounded-md">
                <ChevronUpIcon size={12} className="" />
              </CommandShortcut>
              <CommandShortcut className="bg-muted-foreground/10 p-1 rounded-md">
                <ChevronDownIcon size={12} className="" />
              </CommandShortcut>
            </div>
          </section>
          <section className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Select</span>
            <CommandShortcut className="bg-muted-foreground/10 p-1 rounded-md">
              <CornerDownLeftIcon size={12} className="" />
            </CommandShortcut>
          </section>
        </section>
      </footer>
    </CommandDialog>
  );
}

function useDraggableNewNode() {
  const { nodeToAdd, setNodeToAdd } = useNewNodeStore();
  const { screenToFlowPosition, getZoom } = useReactFlow();
  const removeNode = useFlowStore((state) => state.removeNode);
  const updateNode = useFlowStore((state) => state.updateNode);

  // Handle Escape/Backspace to cancel node placement
  useHotkeys(
    ["escape", "backspace"],
    () => {
      if (!nodeToAdd) return;
      removeNode(nodeToAdd);
      setNodeToAdd(null);
    },
    {
      enabled: !!nodeToAdd,
      enableOnFormTags: false,
      preventDefault: true,
      scopes: ["flow"],
    },
    [nodeToAdd, removeNode, setNodeToAdd],
  );

  useHotkeys(
    "enter",
    () => {
      if (!nodeToAdd) return;
      updateNode(nodeToAdd, { selected: false });
      setNodeToAdd(null);
    },
    {
      enabled: !!nodeToAdd,
      enableOnFormTags: false,
      preventDefault: false,
      scopes: ["flow"],
    },
  );

  const addNode = useCallback(() => {
    if (!nodeToAdd) return;
    console.log("addNode", nodeToAdd);
    updateNode(nodeToAdd, { selected: false });
    setNodeToAdd(null);
  }, [nodeToAdd, updateNode, setNodeToAdd]);

  // Handle mouse interactions for dragging and placing
  useEffect(() => {
    if (!nodeToAdd) return;

    function handleMouseMove(event: MouseEvent) {
      if (!nodeToAdd) return;
      const zoom = getZoom();
      updateNode(nodeToAdd, {
        position: screenToFlowPosition({
          x: event.clientX - (NODE_SIZE.width / 2) * zoom,
          y: event.clientY - (NODE_SIZE.height / 2) * zoom,
        }),
      });
    }

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mousedown", addNode);
    document.addEventListener("click", addNode);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mousedown", addNode);
      document.removeEventListener("click", addNode);
    };
  }, [nodeToAdd, getZoom, updateNode, screenToFlowPosition, setNodeToAdd, addNode]);

  return null;
}
