import { useCallback, useMemo, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ReactFlowProvider } from "@xyflow/react";
import { SparklesIcon } from "lucide-react";

import { saveLocalFlow } from "@/session";
import { FlowThumbnail } from "@/components/home/flow-thumbnail";
import { Badge } from "@/components/ui/badge";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { TEMPLATES, type Template } from "@/lib/templates";
import { track } from "@/lib/analytics";

export const Route = createFileRoute("/templates")({
  component: TemplatesPage,
});

const BUILT_TEMPLATES_STORAGE_KEY = "microflow-built-templates";

const DIFFICULTIES = ["beginner", "intermediate", "advanced"] as const;

const DIFFICULTY_BLURB: Record<(typeof DIFFICULTIES)[number], string> = {
  beginner: "One input, one output. Get something running in two minutes.",
  intermediate: "Combine signals, map ranges and react to sensors.",
  advanced: "Multi-device flows, networking and stateful control.",
};

/** Templates in the order the path walks them: easiest first. */
const PATH: Template[] = DIFFICULTIES.flatMap((difficulty) =>
  TEMPLATES.filter((template) => template.difficulty === difficulty),
);

function readBuiltTemplates(): string[] {
  try {
    const stored = localStorage.getItem(BUILT_TEMPLATES_STORAGE_KEY);
    const parsed = stored ? JSON.parse(stored) : [];
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function TemplatesPage() {
  const navigate = useNavigate();
  const [built, setBuilt] = useState<string[]>(readBuiltTemplates);

  const useTemplate = useCallback(
    async (template: Template) => {
      await saveLocalFlow(template.nodes, template.edges);

      const next = [...new Set([...readBuiltTemplates(), template.id])];
      localStorage.setItem(BUILT_TEMPLATES_STORAGE_KEY, JSON.stringify(next));
      setBuilt(next);

      track("template_loaded", {
        template: template.id,
        nodes: template.nodes.length,
        difficulty: template.difficulty,
      });
      navigate({ to: "/flow/$flowId/graph", params: { flowId: "local" } });
    },
    [navigate],
  );

  const builtIds = useMemo(() => new Set(built), [built]);
  const next = PATH.find((template) => !builtIds.has(template.id)) ?? PATH[0];

  return (
    <div className="h-full overflow-auto flex flex-col pb-16">
      <section className="container mx-auto px-4 md:px-8 pt-8">
        {next && (
          <PathHeader
            template={next}
            builtCount={builtIds.size}
            total={PATH.length}
            onUse={() => useTemplate(next)}
          />
        )}

        <div className="relative pl-8 border-l-2 border-dashed flex flex-col gap-12">
          {DIFFICULTIES.map((difficulty, index) => (
            <section key={difficulty} className="relative">
              <div className="absolute -left-[47px] size-7 rounded-full bg-primary text-primary-foreground text-xs font-semibold flex items-center justify-center">
                {index + 1}
              </div>
              <h3 className="text-lg font-semibold capitalize">{difficulty}</h3>
              <p className="text-sm text-muted-foreground mb-4">
                {DIFFICULTY_BLURB[difficulty]}
              </p>
              <div className="grid gap-4 grid-cols-[repeat(auto-fill,minmax(16rem,1fr))]">
                {TEMPLATES.filter((template) => template.difficulty === difficulty).map(
                  (template) => (
                    <TemplateCard
                      key={template.id}
                      template={template}
                      built={builtIds.has(template.id)}
                      isNext={next?.id === template.id}
                      onUse={() => useTemplate(template)}
                    />
                  ),
                )}
              </div>
            </section>
          ))}
        </div>
      </section>
    </div>
  );
}

function PathHeader(props: {
  template: Template;
  builtCount: number;
  total: number;
  onUse: () => void;
}) {
  const started = props.builtCount > 0;

  return (
    <section className="grid md:grid-cols-2 gap-6 items-center mb-12">
      <div className="aspect-video rounded-xl border overflow-hidden bg-background shadow-sm">
        <ReactFlowProvider>
          <FlowThumbnail nodes={props.template.nodes} edges={props.template.edges} />
        </ReactFlowProvider>
      </div>
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
          <SparklesIcon className="size-3.5" />
          {started ? "Continue your path" : "Start here"}
        </div>
        <h2 className="text-3xl font-semibold">{props.template.name}</h2>
        <p className="text-muted-foreground">{props.template.description}</p>
        <div className="flex items-center gap-3">
          <div className="h-1.5 flex-1 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full bg-primary transition-all"
              style={{ width: `${(props.builtCount / props.total) * 100}%` }}
            />
          </div>
          <span className="text-xs text-muted-foreground tabular-nums whitespace-nowrap">
            {props.builtCount} of {props.total} built
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button size="lg" onClick={props.onUse}>
            {started ? "Continue" : "Build it"}
          </Button>
          <Badge variant="outline" className="capitalize">
            {props.template.difficulty}
          </Badge>
        </div>
      </div>
    </section>
  );
}

function TemplateCard(props: {
  template: Template;
  built: boolean;
  isNext: boolean;
  onUse: () => void;
}) {
  return (
    <Card
      onClick={props.onUse}
      className={cn(
        "pt-0 cursor-pointer hover:bg-muted/40 transition",
        props.isNext && "ring-2 ring-primary",
      )}
    >
      <div className="aspect-video border-b bg-background">
        <ReactFlowProvider>
          <FlowThumbnail nodes={props.template.nodes} edges={props.template.edges} />
        </ReactFlowProvider>
      </div>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <span
            title={props.built ? "Built" : "Not built yet"}
            className={cn(
              "size-2.5 shrink-0 rounded-full",
              props.built ? "bg-primary" : "border border-muted-foreground/40",
            )}
          />
          <span className="truncate">{props.template.name}</span>
        </CardTitle>
        <CardDescription className="line-clamp-2">
          {props.template.description}
        </CardDescription>
      </CardHeader>
    </Card>
  );
}
