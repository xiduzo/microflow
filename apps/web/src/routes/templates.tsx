import { createFileRoute } from "@tanstack/react-router";

import { FlowCard } from "@/components/home/flow-card";
import { useFlowStore } from "@/stores/flow-store";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { COMPONENT_TYPES } from "@/components/flow/nodes/_TYPES";
import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CheckIcon, ChevronsUpDownIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { TEMPLATES, type Template } from "@/lib/templates";

export const Route = createFileRoute("/templates")({
  component: TemplatesPage,
});

const LOCAL_FLOW_STORAGE_KEY = "microflow-local-flow";

function TemplatesPage() {
  const [selectedComponents, setSelectedComponents] = useState<string[]>([]);
  const [selectedDifficulty, setSelectedDifficulty] = useState<string[]>(["all"]);
  const [componentsOpen, setComponentsOpen] = useState(false);

  const toggleComponent = (component: string) => {
    setSelectedComponents((prev) =>
      prev.includes(component)
        ? prev.filter((c) => c !== component)
        : [...prev, component]
    );
  };

  const removeComponent = (component: string) => {
    setSelectedComponents((prev) => prev.filter((c) => c !== component));
  };

  const clearAllComponents = () => {
    setSelectedComponents([]);
  };

  const setTemplate = async (template: Template) => {
    const { flowDoc, mode, destroy } = useFlowStore.getState();
    // Destroy existing local flow so it will reinitialize from localStorage
    if (flowDoc && mode === "local") destroy();

    // Save template to local storage
    localStorage.setItem(
      LOCAL_FLOW_STORAGE_KEY,
      JSON.stringify({ nodes: template.nodes, edges: template.edges })
    );
  };

  // Filter templates based on selected components and difficulty
  const filteredTemplates = TEMPLATES.filter((template) => {
    // Filter by difficulty
    if (!selectedDifficulty.includes("all") && !selectedDifficulty.includes(template.difficulty)) {
      return false;
    }

    // Filter by components - check actual node types in the template
    if (selectedComponents.length > 0) {
      const templateNodeTypes = template.nodes.map((node) => node.type);
      const hasSelectedComponent = selectedComponents.some((comp) =>
        templateNodeTypes.includes(comp)
      );
      if (!hasSelectedComponent) {
        return false;
      }
    }

    return true;
  });

  return (
     <div className="h-full overflow-auto gap-8 flex flex-col pb-12">
        <header className="flex items-center justify-between sticky top-0 z-10 backdrop-blur-sm bg-background/50 p-8 rounded-t-xl">
       <section className="flex items-start gap-2">
            <span className="text-xs font-medium text-muted-foreground w-16 pt-1.5">Contains</span>
            <div className="flex flex-1 flex-wrap items-center gap-2">
              <Popover open={componentsOpen} onOpenChange={setComponentsOpen}>
                <PopoverTrigger
                  render={
                    <Button variant="outline" size="sm" className="h-7 gap-1 text-xs">
                      <ChevronsUpDownIcon className="size-3.5" />
                      Select components
                    </Button>
                  }
                />
                <PopoverContent className="w-52 p-0" align="start">
                  <Command>
                    <CommandInput placeholder="Search components..." />
                    <CommandList>
                      <CommandEmpty>No component found.</CommandEmpty>
                      <CommandGroup>
                        {COMPONENT_TYPES.map((type) => (
                          <CommandItem
                            key={type}
                            value={type}
                            data-checked={selectedComponents.includes(type)}
                            onSelect={() => toggleComponent(type)}
                          >
                            <span
                              className={cn(
                                "mr-2 flex size-4 items-center justify-center rounded-sm border border-primary",
                                selectedComponents.includes(type)
                                  ? "bg-primary text-primary-foreground"
                                  : "opacity-50 [&_svg]:invisible"
                              )}
                            >
                              <CheckIcon className="size-3" />
                            </span>
                            {type}
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>

              {selectedComponents.length > 0 && (
                <>
                  {selectedComponents.map((component) => (
                    <Badge key={component} variant="secondary" className="gap-1 pr-1">
                      {component}
                      <button
                        type="button"
                        className="rounded-sm hover:bg-muted-foreground/20"
                        onClick={() => removeComponent(component)}
                      >
                        <XIcon className="size-3" />
                      </button>
                    </Badge>
                  ))}
                  <button
                    type="button"
                    className="text-xs text-muted-foreground hover:text-foreground"
                    onClick={clearAllComponents}
                  >
                    Clear all
                  </button>
                </>
              )}
            </div>
          </section>
          <section className="flex items-center gap-2">
            <span className="text-xs font-medium text-muted-foreground w-16">Difficulty</span>
            <ToggleGroup
              variant="outline"
              type="multiple"
              value={selectedDifficulty}
              onValueChange={(value) => setSelectedDifficulty(value.length > 0 ? value : ["all"])}
            >
              <ToggleGroupItem value="all">All</ToggleGroupItem>
              <ToggleGroupItem value="beginner">Beginner</ToggleGroupItem>
              <ToggleGroupItem value="intermediate">Intermediate</ToggleGroupItem>
              <ToggleGroupItem value="advanced">Advanced</ToggleGroupItem>
            </ToggleGroup>
          </section>
        </header>

        <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-8 px-8">
       {filteredTemplates.map((template) => (
            <FlowCard
              key={template.id}
              id={"local"}
              name={template.name}
              description={template.description}
              updatedAt={new Date().toISOString()}
              nodes={template.nodes}
              edges={template.edges}
              beforeNavigate={() => setTemplate(template)}
              badges={
                [
                  {
                    label: template.difficulty,
                    variant: "default" as const,
                  },
                  ...(template.categories ? template.categories.map((category) => ({
                    label: category,
                    variant: "secondary" as const,
                  })) : []),
                ]
              }
            />
          ))}
        </section>
    </div>
  );
}