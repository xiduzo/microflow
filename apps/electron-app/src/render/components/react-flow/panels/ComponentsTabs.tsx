import {
  Badge,
  Icons,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@fhb/ui";
import { NodeType } from "../ReactFlowCanvas";

export function ComponentTabs() {
  return (
    <Tabs
      defaultValue="figma"
      className="bg-neutral-950/5 backdrop-blur-sm rounded-md p-2 z-50 w-[280px]"
    >
      <TabsList>
        <TabsTrigger value="closed">
          <Icons.Dot />
        </TabsTrigger>
        <TabsTrigger value="figma">Figma</TabsTrigger>
        <TabsTrigger value="hardware">Hardware</TabsTrigger>
        <TabsTrigger value="flow">Flow</TabsTrigger>
      </TabsList>
      <TabsContent value="figma" className="space-y-2">
        <Draggable
          title="Variable"
          type="Button"
          description="Interact with figma variables"
          icon={<Icons.Variable />}
          tags={["Input", "Output"]}
        />
      </TabsContent>
      <TabsContent value="hardware" className="space-y-2">
        <Draggable
          title="button"
          type="Button"
          description="Buttons are the very basic inputs used everywhere."
          icon={<Icons.SquarePower />}
          tags={["Analog", "Input"]}
        />
        <Draggable
          title="LED"
          type="Led"
          description="LEDs are very tiny light sources"
          icon={<Icons.Lightbulb />}
          tags={["Digital", "Output"]}
        />
      </TabsContent>
      <TabsContent value="flow" className="space-y-2">
        <Draggable
          title="Map"
          type="Button"
          description="Map a value from one range to another"
          icon={<Icons.Sigma />}
        />
        <Draggable
          title="If/else"
          type="Button"
          description="Control logic"
          icon={<Icons.Split />}
        />
        <Draggable
          title="And"
          type="Button"
          description="Control logic"
          icon={<Icons.Merge />}
        />
        <Draggable
          title="Interval"
          type="Button"
          description="Do something on a regular interval"
          icon={<Icons.Clock />}
        />
        <Draggable
          title="Counter"
          type="Button"
          description="Keep count of things"
          icon={<Icons.Hash />}
        />
      </TabsContent>
    </Tabs>
  );
}

function Draggable(props: DraggableProps) {
  const onDragStart = (nodeType: string) => (event: React.DragEvent) => {
    event.dataTransfer.setData("application/reactflow", nodeType);
    event.dataTransfer.effectAllowed = "move";
  };

  return (
    <article
      className="hover:cursor-grab active:cursor-grabbing p-4 border rounded-md"
      draggable
      onDragStart={onDragStart(props.type)}
    >
      <section className="flex space-x-2 items-center">
        {props.icon}
        <h1 className="font-bold text-lg">{props.title}</h1>
      </section>
      <p className="font-light mt-2">{props.description}</p>
      {props.tags?.length && (
        <section className="mt-3 flex space-x-2 text-xs">
          {props.tags.map((tag) => (
            <Badge variant="secondary" key={tag}>
              {tag}
            </Badge>
          ))}
        </section>
      )}
    </article>
  );
}

type DraggableProps = {
  type: NodeType;
  title: string;
  description: string;
  icon: JSX.Element;
  tags?: string[];
};
