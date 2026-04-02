import { useReactFlow } from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useHotkey, useHotkeys } from "@tanstack/react-hotkeys";
import { NODE_TYPES } from "../nodes/_TYPES";
import { useFlowStore } from "@/stores/flow-store";
import { useNewNodeStore } from "@/stores/new-node";
import { groupIndicator, type BaseNode } from "../nodes/_base/_base";
import { uid } from "@/lib/uid";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import {
  SearchIcon,
  BookIcon,
  ChevronUpIcon,
  ChevronDownIcon,
  CornerDownLeftIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Icon } from "@/components/ui/icon";
import { EmptyState } from "@/components/states/empty-state";
import type { FlowNode } from "@microflow/collab";
import { cn } from "@/lib/utils";
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Kbd } from "@/components/ui/kbd";

const NODE_SIZE = {
  width: 208,
  height: 176,
};

const GROUP_ORDER = ["sense", "generate", "shape", "decide", "express"] as const;

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
      const item: FlowNode = {
        data: node.data,
        id: uid(),
        type,
        position,
      };

      addNode(item);
      setNodeToAdd(item.id);
      setFilter("");
      setOpen(false);
    };
  }

  const groups = useMemo(() => {
    const byGroup = Object.entries(NODE_TYPES).reduce(
      (acc, [type, Component]) => {
        const node: BaseNode =
          "defaultProps" in Component
            ? (Component.defaultProps as any)
            : { data: {} };

        if (node.data.group === "internal") return acc;
        const group = node.data.group;
        const list = acc.get(group) ?? [];
        list.push({ node, type });
        acc.set(group, list);
        return acc;
      },
      new Map<string, { node: BaseNode; type: string }[]>()
    );
    return GROUP_ORDER.map((key) => [key, byGroup.get(key) ?? []] as const).filter(
      ([, nodes]) => nodes.length > 0
    );
  }, []);

  const searchTerm = useMemo(() => {
    const terms = [
      "Sense something...",
      "Generate, Shape, Decide...",
      "Button, Motion, Sensor...",
      "Constant, Oscillator, Interval...",
      "Compare, Gate, Trigger...",
      "Led, Monitor, MQTT...",
    ];

    return terms[Math.floor(Math.random() * terms.length)];
  }, [open]);

  useEffect(() => {
    commandListRef.current?.scrollTo({
      top: 0,
      behavior: "smooth",
    });
  }, [filter]);

  const nodeFilter = (value: string, search: string) => {
    const [label, description] = value.split("|");

    // Show all items when no search term
    if (!search || search.trim() === "") return 1;

    const searchLower = search.toLowerCase().trim();

    // Priority 1: Label match (highest priority)
    if (label.toLowerCase().includes(searchLower)) return 1;

    // Priority 2: Description match
    if (description.toLowerCase().includes(searchLower)) return 0.8;

    // No match found
    return 0;
  };

  return (
    <CommandDialog
      className="min-w-10/12 md:min-w-8/12 lg:min-w-6/12 xl:min-w-4/12"
      open={open}
      onOpenChange={(state) => {
        setOpen(state);
        if (!state) setFilter("");
      }}
    >
      <Command
        className="[&_[data-slot=command-input-wrapper]>*]:h-12 **:data-[slot=command-input]:text-base **:data-[slot=command-input]:py-2.5 [&_[data-slot=command-input-wrapper]_svg]:size-5"
        filter={nodeFilter}
      >
        <CommandInput placeholder={searchTerm} onValueChange={setFilter} />
        <CommandList ref={commandListRef} className="mb-2 min-h-[400px]">
          <CommandEmpty className="flex items-center justify-center h-[400px]">
            <EmptyState
              title="Nothing found"
              description="Try searching for a different node type or visit the documentation."
              icon={SearchIcon}
            >
              <a
                href="https://docs.microflow.tech/microflow-studio/nodes"
                target="_blank"
              >
                <Button variant="link">Visit the documentation</Button>
              </a>
            </EmptyState>
          </CommandEmpty>
          {groups.map(([groupKey, nodes], index) => (
            <section key={groupKey}>
              <CommandGroup heading={groupKey.charAt(0).toUpperCase() + groupKey.slice(1)}>
                {nodes.map(({ node, type }) => {
                  return (
                    <CommandItem
                      value={`${node.data.label}|${node.data.description}|${node.data.group}|${node.data.tags.join(",")}`}
                      keywords={node.data.tags}
                      key={node.data.label}
                      onSelect={selectNode(node, type)}
                      className="data-[selected=true]:bg-muted-foreground/5 items-start group"
                    >
                      <Item className="px-0">
                        <ItemMedia variant="image">
                          <Avatar size="lg" className="after:ring-0 after:border-none after:content-['']">
                            <AvatarFallback className={cn(groupIndicator({ group: node.data.group }))}>
                              <Icon
                                icon={node.data.icon}
                                className="group-data-[selected=true]:scale-110 transition-all duration-100 size-4 stroke-1 group-data-[selected=true]:stroke-2"
                              />
                            </AvatarFallback>
                          </Avatar>
                        </ItemMedia>
                        <ItemContent>
                          <ItemTitle>
                            <HighlightedText text={node.data.label} query={filter} />
                          </ItemTitle>
                          <ItemDescription>
                            <HighlightedText text={node.data.description ?? ""} query={filter} />
                          </ItemDescription>
                        </ItemContent>
                      </Item>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
              {index !== groups.length - 1 && <CommandSeparator />}
            </section>
          ))}
        </CommandList>
        <footer className="p-2 bg-muted-foreground/5 flex gap-4 justify-between items-center">
          <section className="flex items-center gap-2">
            <div className="flex items-center gap-1">
              <Kbd>
                <ChevronUpIcon size={12} className="" />
              </Kbd>
              <Kbd>
                <ChevronDownIcon size={12} className="" />
              </Kbd>
            </div>
            <span className="text-xs text-muted-foreground">Navigate</span>
          </section>
          <section className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Select</span>
            <Kbd>
              <CornerDownLeftIcon size={12} className="" />
            </Kbd>
          </section>
        </footer>
      </Command>
    </CommandDialog >
  );
}

function useDraggableNewNode() {
  const { nodeToAdd, setNodeToAdd } = useNewNodeStore();
  const { screenToFlowPosition, getZoom } = useReactFlow();
  const removeNode = useFlowStore((state) => state.removeNode);
  const updateNode = useFlowStore((state) => state.updateNode);

  // Handle Escape/Backspace to cancel node placement
  useHotkeys(
    [
      {
        hotkey: "Escape",
        callback: () => {
          if (!nodeToAdd) return;
          removeNode(nodeToAdd);
          setNodeToAdd(null);
        },
        options: { enabled: !!nodeToAdd, ignoreInputs: true },
      },
      {
        hotkey: "Backspace",
        callback: () => {
          if (!nodeToAdd) return;
          removeNode(nodeToAdd);
          setNodeToAdd(null);
        },
        options: { enabled: !!nodeToAdd, ignoreInputs: true },
      },
    ],
  );

  useHotkey(
    "Enter",
    () => {
      if (!nodeToAdd) return;
      updateNode(nodeToAdd, { selected: false });
      setNodeToAdd(null);
    },
    {
      enabled: !!nodeToAdd,
      ignoreInputs: true,
      preventDefault: false,
    }
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

    // Defer registration so the click that triggered node selection doesn't
    // immediately fire addNode and place the node without allowing dragging.
    let registered = false;
    const timeoutId = setTimeout(() => {
      registered = true;
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mousedown", addNode);
      document.addEventListener("click", addNode);
    }, 0);

    return () => {
      clearTimeout(timeoutId);
      if (registered) {
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mousedown", addNode);
        document.removeEventListener("click", addNode);
      }
    };
  }, [
    nodeToAdd,
    getZoom,
    updateNode,
    screenToFlowPosition,
    setNodeToAdd,
    addNode,
  ]);

  return null;
}

function HighlightedText({ text, query }: { text: string; query: string }) {
  if (!query || !query.trim()) return <span>{text}</span>;

  const queryLower = query.toLowerCase().trim();
  const idx = text.toLowerCase().indexOf(queryLower);
  if (idx === -1) return <span>{text}</span>;

  return <span>{text.slice(0, idx)}<mark className="bg-transparent text-foreground font-semibold underline underline-offset-2 decoration-primary/60">{text.slice(idx, idx + queryLower.length)}</mark>{text.slice(idx + queryLower.length)}</span>;
}