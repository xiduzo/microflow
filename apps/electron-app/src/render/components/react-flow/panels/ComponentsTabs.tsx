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
      defaultValue="closed"
      className="bg-neutral-950/5 backdrop-blur-sm rounded-md p-2 z-50 w-[320px]"
    >
      <TabsList className="w-full">
        <TabsTrigger value="closed">
          <Icons.Dot />
        </TabsTrigger>
        <TabsTrigger value="flow">Flow</TabsTrigger>
        <TabsTrigger value="hardware">Hardware</TabsTrigger>
        <TabsTrigger value="external">External</TabsTrigger>
      </TabsList>
      <TabsContent value="external" className="space-y-2">
        <Draggable
          title="Figma variable"
          type="Figma"
          description="Interact with Figma variables"
          tags={["Input", "Output"]}
        />
        <Draggable
          title="MQTT"
          type="Mqtt"
          description="Send or receive messages"
          tags={["Input", "Output"]}
        />
      </TabsContent>
      <TabsContent value="hardware" className="space-y-2">
        <Draggable
          title="Button"
          type="Button"
          description="Buttons are the very basic inputs used everywhere."
          tags={["Digital", "Input"]}
        />
        <Draggable
          title="LED"
          type="Led"
          description="LEDs are very tiny light sources"
          tags={["Digital", "Output"]}
        />
        <Draggable
          title="Potentiometer"
          type="Sensor"
          description="A turning knob to control things"
          tags={["Analog", "Input"]}
        />
        <Draggable
          title="Servo motor"
          type="Servo"
          description="Turn things around"
          tags={["Analog", "Output"]}
        />
      </TabsContent>
      <TabsContent value="flow" className="space-y-2">
        {/*
        <Draggable
          title="And"
          type="Button"
          description="Control logic"
          icon={<Icons.Merge />}
        /> */}
        <Draggable
          title="Map"
          type="RangeMap"
          description="Re-maps a number from one range to another"
          tags={["Transformation"]}
        />
        <Draggable
          title="Interval"
          type="Interval"
          description="Do something on a regular interval"
        />
        <Draggable
          title="Counter"
          type="Counter"
          description="You know, to keep count of things..."
        />
        <Draggable
          title="If/Else"
          type="IfElse"
          description="Control the flow of your code"
          tags={["Validation"]}
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
  tags?: string[];
};
