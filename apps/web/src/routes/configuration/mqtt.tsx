import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { useForm } from "@tanstack/react-form";
import { toast } from "sonner";
import {
  PlusIcon,
  TrashIcon,
  StarIcon,
  SendIcon,
  CheckCircleIcon,
  XCircleIcon,
  Loader2Icon,
  PencilIcon,
  CircleIcon,
} from "lucide-react";

import { useMqttBrokerStore, type MqttBrokerConfig, type ConnectionStatus } from "@/stores/mqtt-broker";
import { useBrokerStatus } from "@/hooks/use-mqtt-sync";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { InputGroup, InputGroupInput } from "@/components/ui/input-group";
import { EmptyState } from "@/components/states/empty-state";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";

export const Route = createFileRoute("/configuration/mqtt")({
  component: MqttConfigPage,
  beforeLoad: async () => {
    if (!isDesktop()) {
      toast.warning("MQTT configuration is only available on desktop");
      return redirect({ to: "/" });
    }
  },
});

function MqttConfigPage() {
  const brokers = useMqttBrokerStore((s) => s.brokers);

  return (
    <div className="h-full overflow-auto">
      <div className="container max-w-4xl mx-auto py-8 px-4 space-y-6">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold">MQTT Configuration</h1>
            <p className="text-muted-foreground text-sm">
              Configure MQTT brokers for IoT connectivity
            </p>
          </div>
          <AddBrokerDialog />
        </header>

        {brokers.length === 0 ? (
          <EmptyState
            title="No brokers configured"
            description="Add an MQTT broker to enable IoT connectivity in your flows"
            icon={PlusIcon}
          >
            <AddBrokerDialog />
          </EmptyState>
        ) : (
          <div className="space-y-2">
            {brokers.map((broker) => (
              <BrokerCard key={broker.id} broker={broker} />
            ))}
          </div>
        )}

        <Separator />

        {brokers.length > 0 && <TestClientCard />}
      </div>
    </div>
  );
}

function StatusIndicator({ status }: { status: ConnectionStatus }) {
  switch (status) {
    case "connected":
      return (
        <CheckCircleIcon className="text-green-500 size-5" />
      );
    case "connecting":
      return (
        <Loader2Icon className="animate-spin text-blue-500 size-5" />
      );
    case "error":
      return (
        <XCircleIcon className="text-red-500 size-5" />
      );
    default:
      return (
        <CircleIcon className="text-gray-500 size-5" />
      );
  }
}

function BrokerCard({ broker }: { broker: MqttBrokerConfig }) {
  const { deleteBroker, setDefaultBroker } = useMqttBrokerStore();
  const [editOpen, setEditOpen] = useState(false);
  const status = useBrokerStatus(broker.id);

  return (
    <Item variant="outline">
      <ItemMedia>
        <StatusIndicator status={status} />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{broker.name}</ItemTitle>
        <ItemDescription>
          {broker.url}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        {!broker.isDefault && (
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setDefaultBroker(broker.id)}
          >
            <StarIcon />
          </Button>
        )}
        {broker.isDefault && (
          <Button
            variant="ghost"
            size="icon"
            disabled
          >
            <StarIcon className="text-yellow-900 fill-yellow-500" />
          </Button>
        )}
        <Dialog open={editOpen} onOpenChange={setEditOpen}>
          <DialogTrigger render={<Button variant="ghost" size="sm"><PencilIcon /></Button>} />
          <EditBrokerDialogContent broker={broker} onClose={() => setEditOpen(false)} />
        </Dialog>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => {
            deleteBroker(broker.id);
            toast.success("Broker deleted");
          }}
        >
          <TrashIcon />
        </Button>
      </ItemActions>
    </Item>
  );
}

function AddBrokerDialog() {
  const [open, setOpen] = useState(false);
  const addBroker = useMqttBrokerStore((s) => s.addBroker);

  const form = useForm({
    defaultValues: {
      name: "",
      url: "",
      username: "",
      password: "",
    },
    onSubmit: ({ value }) => {
      addBroker({
        name: value.name,
        url: value.url,
        username: value.username || undefined,
        password: value.password || undefined,
        isDefault: false,
      });
      toast.success("Broker added");
      setOpen(false);
      form.reset();
    },
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button>
            <PlusIcon className="h-4 w-4 mr-2" />
            Add Broker
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add MQTT Broker</DialogTitle>
          <DialogDescription>
            Configure a new MQTT broker connection
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            form.handleSubmit();
          }}
        >
          <FieldGroup>
            <form.Field name="name">
              {(field) => (
                <Field>
                  <FieldLabel htmlFor={field.name}>Name</FieldLabel>
                  <InputGroup>
                    <InputGroupInput
                      id={field.name}
                      placeholder="My Broker"
                      value={field.state.value}
                      onChange={(e) => field.handleChange(e.target.value)}
                    />
                  </InputGroup>
                </Field>
              )}
            </form.Field>
            <form.Field name="url">
              {(field) => (
                <Field>
                  <FieldLabel htmlFor={field.name}>URL</FieldLabel>
                  <InputGroup>
                    <InputGroupInput
                      id={field.name}
                      placeholder="wss://broker.example.com:8883/mqtt"
                      value={field.state.value}
                      onChange={(e) => field.handleChange(e.target.value)}
                    />
                  </InputGroup>
                </Field>
              )}
            </form.Field>
            <form.Field name="username">
              {(field) => (
                <Field>
                  <FieldLabel htmlFor={field.name}>Username (optional)</FieldLabel>
                  <InputGroup>
                    <InputGroupInput
                      id={field.name}
                      value={field.state.value}
                      onChange={(e) => field.handleChange(e.target.value)}
                    />
                  </InputGroup>
                </Field>
              )}
            </form.Field>
            <form.Field name="password">
              {(field) => (
                <Field>
                  <FieldLabel htmlFor={field.name}>Password (optional)</FieldLabel>
                  <InputGroup>
                    <InputGroupInput
                      id={field.name}
                      type="password"
                      value={field.state.value}
                      onChange={(e) => field.handleChange(e.target.value)}
                    />
                  </InputGroup>
                </Field>
              )}
            </form.Field>
          </FieldGroup>
          <DialogFooter className="mt-4">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit">Add Broker</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditBrokerDialogContent({
  broker,
  onClose,
}: {
  broker: MqttBrokerConfig;
  onClose: () => void;
}) {
  const updateBroker = useMqttBrokerStore((s) => s.updateBroker);

  const form = useForm({
    defaultValues: {
      name: broker.name,
      url: broker.url,
      username: broker.username ?? "",
      password: broker.password ?? "",
    },
    onSubmit: ({ value }) => {
      updateBroker(broker.id, {
        name: value.name,
        url: value.url,
        username: value.username || undefined,
        password: value.password || undefined,
      });
      toast.success("Broker updated");
      onClose();
    },
  });

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Edit Broker</DialogTitle>
        <DialogDescription>Update broker configuration</DialogDescription>
      </DialogHeader>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          form.handleSubmit();
        }}
      >
        <FieldGroup>
          <form.Field name="name">
            {(field) => (
              <Field>
                <FieldLabel htmlFor={field.name}>Name</FieldLabel>
                <InputGroup>
                  <InputGroupInput
                    id={field.name}
                    value={field.state.value}
                    onChange={(e) => field.handleChange(e.target.value)}
                  />
                </InputGroup>
              </Field>
            )}
          </form.Field>
          <form.Field name="url">
            {(field) => (
              <Field>
                <FieldLabel htmlFor={field.name}>URL</FieldLabel>
                <InputGroup>
                  <InputGroupInput
                    id={field.name}
                    value={field.state.value}
                    onChange={(e) => field.handleChange(e.target.value)}
                  />
                </InputGroup>
              </Field>
            )}
          </form.Field>
          <form.Field name="username">
            {(field) => (
              <Field>
                <FieldLabel htmlFor={field.name}>Username (optional)</FieldLabel>
                <InputGroup>
                  <InputGroupInput
                    id={field.name}
                    value={field.state.value}
                    onChange={(e) => field.handleChange(e.target.value)}
                  />
                </InputGroup>
              </Field>
            )}
          </form.Field>
          <form.Field name="password">
            {(field) => (
              <Field>
                <FieldLabel htmlFor={field.name}>Password (optional)</FieldLabel>
                <InputGroup>
                  <InputGroupInput
                    id={field.name}
                    type="password"
                    value={field.state.value}
                    onChange={(e) => field.handleChange(e.target.value)}
                  />
                </InputGroup>
              </Field>
            )}
          </form.Field>
        </FieldGroup>
        <DialogFooter className="mt-4">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit">Save</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

import { invokeCommand, useListen, type MqttMessagePayload } from "@/lib/ipc";
import { isDesktop } from "@/lib/platform";
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";

function TestClientCard() {
  const brokers = useMqttBrokerStore((s) => s.brokers);
  const [selectedBrokerId, setSelectedBrokerId] = useState<string>(
    brokers.find((b) => b.isDefault)?.id ?? brokers[0]?.id ?? ""
  );
  const status = useBrokerStatus(selectedBrokerId);
  const [subscribeTopic, setSubscribeTopic] = useState("test/#");
  const [publishTopic, setPublishTopic] = useState("test/message");
  const [publishPayload, setPublishPayload] = useState("Hello from Microflow!");
  const [messages, setMessages] = useState<Array<{ topic: string; payload: string; timestamp: Date }>>([]);
  const [subscriptions, setSubscriptions] = useState<Set<string>>(new Set());

  const selectedBroker = brokers.find((b) => b.id === selectedBrokerId);

  const handleSubscribe = async () => {
    if (status !== "connected" || !selectedBroker) return;

    const result = await invokeCommand({
      type: "mqtt_subscribe",
      brokerId: selectedBrokerId,
      topic: subscribeTopic,
    });

    if (result.success) {
      setSubscriptions((prev) => new Set([...prev, subscribeTopic]));
      toast.success(`Subscribed to ${subscribeTopic}`);
    } else {
      toast.error("Failed to subscribe");
    }
  };

  const handleUnsubscribe = async (topic: string) => {
    if (status !== "connected") return;

    const result = await invokeCommand({
      type: "mqtt_unsubscribe",
      brokerId: selectedBrokerId,
      topic,
    });

    if (result.success) {
      setSubscriptions((prev) => {
        const next = new Set(prev);
        next.delete(topic);
        return next;
      });
      toast.success(`Unsubscribed from ${topic}`);
    } else {
      toast.error("Failed to unsubscribe");
    }
  };

  const handlePublish = async () => {
    if (status !== "connected") return;

    const result = await invokeCommand({
      type: "mqtt_publish",
      brokerId: selectedBrokerId,
      topic: publishTopic,
      payload: publishPayload,
    });

    if (result.success) {
      toast.success("Message published");
    } else {
      toast.error("Failed to publish");
    }
  };

  // Listen for incoming messages
  useListen<MqttMessagePayload>({
    type: "mqtt-message",
    handler: (event) => {
      if (status !== "connected") return;
      setMessages((prev) => [
        { topic: event.payload.topic, payload: event.payload.payload, timestamp: new Date() },
        ...prev.slice(0, 49),
      ]);
    },
  });

  // Clear messages and subscriptions when broker changes
  const handleBrokerChange = (newBrokerId: string) => {
    setSelectedBrokerId(newBrokerId);
    setMessages([]);
    setSubscriptions(new Set());
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Test Client</CardTitle>
        <CardDescription>
          Test your broker connection by subscribing and publishing messages.
          Brokers auto-connect on startup.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-4">
          <select
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
            value={selectedBrokerId}
            onChange={(e) => handleBrokerChange(e.target.value)}
          >
            {brokers.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name} {b.isDefault ? "(default)" : ""}
              </option>
            ))}
          </select>
          <StatusIndicator status={status} />
        </div>

        {status === "connected" && (
          <Tabs defaultValue="subscribe">
            <TabsList>
              <TabsTrigger value="subscribe">Subscribe</TabsTrigger>
              <TabsTrigger value="publish">Publish</TabsTrigger>
            </TabsList>
            <TabsContent value="subscribe" className="space-y-4">
              <div className="flex gap-2">
                <InputGroup className="flex-1">
                  <InputGroupInput
                    placeholder="Topic (e.g., test/#)"
                    value={subscribeTopic}
                    onChange={(e) => setSubscribeTopic(e.target.value)}
                  />
                </InputGroup>
                <Button onClick={handleSubscribe}>Subscribe</Button>
              </div>
              {subscriptions.size > 0 && (
                <div className="flex flex-wrap gap-2">
                  {[...subscriptions].map((topic) => (
                    <Badge key={topic} variant="secondary" className="gap-1">
                      {topic}
                      <button
                        type="button"
                        onClick={() => handleUnsubscribe(topic)}
                        className="ml-1 hover:text-destructive"
                      >
                        <XCircleIcon className="h-3 w-3" />
                      </button>
                    </Badge>
                  ))}
                </div>
              )}
              <div className="border rounded-md p-4 h-48 overflow-auto bg-muted/50">
                {messages.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center">
                    No messages received yet
                  </p>
                ) : (
                  <div className="space-y-2">
                    {messages.map((msg, i) => (
                      <div key={i} className="text-sm font-mono">
                        <span className="text-muted-foreground">
                          [{msg.timestamp.toLocaleTimeString()}]
                        </span>{" "}
                        <span className="text-blue-500">{msg.topic}</span>:{" "}
                        {msg.payload}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </TabsContent>
            <TabsContent value="publish" className="space-y-4">
              <InputGroup>
                <InputGroupInput
                  placeholder="Topic (e.g., test/message)"
                  value={publishTopic}
                  onChange={(e) => setPublishTopic(e.target.value)}
                />
              </InputGroup>
              <Textarea
                placeholder="Message payload"
                value={publishPayload}
                onChange={(e) => setPublishPayload(e.target.value)}
                rows={3}
              />
              <Button onClick={handlePublish}>
                <SendIcon className="h-4 w-4 mr-2" />
                Publish
              </Button>
            </TabsContent>
          </Tabs>
        )}

        {status !== "connected" && (
          <p className="text-sm text-muted-foreground">
            {status === "connecting"
              ? "Connecting to broker..."
              : status === "error"
                ? "Failed to connect. Check broker configuration."
                : "Broker will auto-connect when configured."}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
