import { createFileRoute } from "@tanstack/react-router";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  type Node,
  type Edge,
} from "@xyflow/react";
import { evictSession } from "@/session";
import { COMPONENT_TYPES } from "@/components/flow/nodes/_TYPES";
import { NODE_TYPES } from "@/components/flow/nodes/_TYPES";
import { useState, useMemo } from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
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
import {
  CheckIcon,
  ChevronsUpDownIcon,
  XIcon,
  DownloadIcon,
  LayoutTemplateIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { TEMPLATES, type Template } from "@/lib/templates";
import { track } from "@/lib/analytics";
import { EmptyState } from "@/components/states/empty-state";
import { useNavigate } from "@tanstack/react-router";
import { FlowCard, FlowThumbnail } from "@/components/home/flow-card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardFooter, CardDescription, CardAction, CardHeader, CardTitle } from "@/components/ui/card";

export const Route = createFileRoute("/templates")({
  component: TemplatesPage,
});

const LOCAL_FLOW_STORAGE_KEY = "microflow-local-flow";

const FEATURED_IDS = ["smart-home-hub", "weather-station", "security-gate"];

const DIFFICULTY_BADGE_LABEL: Record<string, string> = {
  beginner: "BEGINNER",
  intermediate: "INTERMEDIATE",
  advanced: "ADVANCED",
};

function TemplatesPage() {
  const [selectedComponents, setSelectedComponents] = useState<string[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string>("All");
  const navigate = useNavigate();

  const setTemplate = async (template: Template) => {
    // Force-destroy any cached local session so the next /flow/local mount
    // constructs a fresh adapter that loads from the new localStorage payload.
    evictSession("local");
    localStorage.setItem(
      LOCAL_FLOW_STORAGE_KEY,
      JSON.stringify({ nodes: template.nodes, edges: template.edges }),
    );
  };

  const handleImport = async (template: Template) => {
    await setTemplate(template);
    track("template_loaded", {
      template: template.id,
      nodes: template.nodes.length,
      featured: FEATURED_IDS.includes(template.id),
    });
    navigate({ to: "/flow/$flowId/graph", params: { flowId: "local" } });
  };

  // Derive unique categories
  const allCategories = useMemo(() => {
    const cats = new Set<string>();
    TEMPLATES.forEach((t) => t.categories?.forEach((c) => cats.add(c)));
    return ["All", ...Array.from(cats).sort()];
  }, []);

  const featuredTemplates = TEMPLATES.filter((t) =>
    FEATURED_IDS.includes(t.id),
  );

  const filteredTemplates = TEMPLATES.filter((template) => {
    if (selectedCategory !== "All") {
      if (!template.categories?.includes(selectedCategory)) return false;
    }
    if (selectedComponents.length > 0) {
      const templateNodeTypes = template.nodes.map((node) => node.type);
      if (!selectedComponents.some((comp) => templateNodeTypes.includes(comp)))
        return false;
    }
    return true;
  });

  const nonFeaturedFiltered = filteredTemplates.filter(
    (t) => !FEATURED_IDS.includes(t.id),
  );

  return (
    <div className="h-full overflow-auto flex flex-col pb-16">
      <section className="container mx-auto px-4 md:px-8">
        <div className="flex flex-col gap-10 pt-8">
          <section>
            <div className="mb-5">
              <h2 className="text-xl font-semibold">Featured Templates</h2>
              <p className="text-sm text-muted-foreground mt-1">
                Jumpstart your project with our top picks
              </p>
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-5">
              {featuredTemplates.map((template) => (
                <Card className="relative mx-auto w-full pt-0 col-span-1">
                  <section className="relative z-20 aspect-video w-full object-cover bg-background">
                    <ReactFlowProvider>
                      <FlowThumbnail nodes={template.nodes} edges={template.edges} />
                    </ReactFlowProvider>
                  </section>
                  {/* <img
                    src="https://avatar.vercel.sh/shadcn1"
                    alt="Event cover"
                    className="relative z-20 aspect-video w-full object-cover brightness-60 grayscale dark:brightness-40"
                  /> */}
                  <CardHeader>
                    <CardAction>
                      <Badge variant="secondary">Featured</Badge>
                    </CardAction>
                    <CardTitle>{template.name}</CardTitle>
                    <CardDescription>{template.description}</CardDescription>
                  </CardHeader>
                  <CardFooter>
                    <Button className="w-full" onClick={() => handleImport(template)}>Use template</Button>
                  </CardFooter>
                </Card>
              ))}
            </div>
          </section>

          <section>
            <div className="mb-5">
              <h2 className="text-xl font-semibold">All Templates</h2>
              <p className="text-sm text-muted-foreground mt-1">
                Explore all templates
              </p>
            </div>

          <Tabs defaultValue="Basic">
            <TabsList className="w-max min-w-full">
              <TabsTrigger value="Basic" className="flex-1">Basic</TabsTrigger>
              <TabsTrigger value="Digital" className="flex-1">Digital</TabsTrigger>
              <TabsTrigger value="Analog" className="flex-1">Analog</TabsTrigger>
              <TabsTrigger value="Communication" className="flex-1">Communication</TabsTrigger>
              <TabsTrigger value="Control structures" className="flex-1">Control structures</TabsTrigger>
            </TabsList>
            {["Basic", "Digital", "Analog", "Communication", "Control structures"].map((category) => (
              <TabsContent key={category} value={category}>
                <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-5 pt-4">
                  {TEMPLATES.filter((t) => t.categories?.includes(category)).map((template) => (
                    <Card key={template.id} className="relative mx-auto w-full pt-0 col-span-1">
                      <section className="relative z-20 aspect-video w-full object-cover bg-background">
                        <ReactFlowProvider>
                          <FlowThumbnail nodes={template.nodes} edges={template.edges} />
                        </ReactFlowProvider>
                      </section>
                      <CardHeader>
                        <CardAction>
                          <Badge variant="outline">{DIFFICULTY_BADGE_LABEL[template.difficulty]}</Badge>
                        </CardAction>
                        <CardTitle>{template.name}</CardTitle>
                        <CardDescription>{template.description}</CardDescription>
                      </CardHeader>
                      <CardFooter>
                        <Button className="w-full" onClick={() => handleImport(template)}>Use template</Button>
                      </CardFooter>
                    </Card>
                  ))}
                </div>
              </TabsContent>
            ))}
          </Tabs>

          </section>
        </div>
      </section>
    </div>
  );
}
