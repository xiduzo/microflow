import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { useForm } from "@tanstack/react-form";
import { toast } from "sonner";
import {
  PlusIcon,
  TrashIcon,
  StarIcon,
  PlayIcon,
  SendIcon,
  CheckCircleIcon,
  XCircleIcon,
  Loader2Icon,
  PencilIcon,
} from "lucide-react";

import { useMqttBrokerStore, type MqttBrokerConfig } from "@/stores/mqtt-broker";
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
          <div className="space-y-4">
            {brokers.map((broker) => (
              <BrokerCard key={broker.id} broker={broker} />
            ))}
          </div>
        )}

        {brokers.length > 0 && <TestClientCard />}
      </div>
    </div>
  );
}

function BrokerCard({ broker }: { broker: MqttBrokerConfig }) {
  const { deleteBroker, setDefaultBroker } = useMqttBrokerStore();
  const [editOpen, setEditOpen] = useState(false);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CardTitle>{broker.name}</CardTitle>
            {broker.isDefault && <Badge variant="secondary">Default</Badge>}
          </div>
          <div className="flex gap-2">
            {!broker.isDefault && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setDefaultBroker(broker.id)}
              >
                <StarIcon className="h-4 w-4" />
                Set Default
              </Button>
            )}
            <Dialog open={editOpen} onOpenChange={setEditOpen}>
              <DialogTrigger render={<Button variant="ghost" size="sm"><PencilIcon className="h-4 w-4" /></Button>} />
              <EditBrokerDialogContent broker={broker} onClose={() => setEditOpen(false)} />
            </Dialog>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                deleteBroker(broker.id);
                toast.success("Broker deleted");
              }}
            >
              <TrashIcon className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <CardDescription className="font-mono text-xs">{broker.url}</CardDescription>
      </CardHeader>
      {broker.username && (
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Username: {broker.username}
          </p>
        </CardContent>
      )}
    </Card>
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

type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

import { invokeCommand, useListen, type MqttMessagePayload } from "@/lib/ipc";
import { isDesktop } from "@/lib/platform";

function TestClientCard() {
  const brokers = useMqttBrokerStore((s) => s.brokers);
  const [selectedBrokerId, setSelectedBrokerId] = useState<string>(
    brokers.find((b) => b.isDefault)?.id ?? brokers[0]?.id ?? ""
  );
  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const [error, setError] = useState<string | null>(null);
  const [subscribeTopic, setSubscribeTopic] = useState("test/#");
  const [publishTopic, setPublishTopic] = useState("test/message");
  const [publishPayload, setPublishPayload] = useState("Hello from Microflow!");
  const [messages, setMessages] = useState<Array<{ topic: string; payload: string; timestamp: Date }>>([]);

  const selectedBroker = brokers.find((b) => b.id === selectedBrokerId);

  const handleConnect = async () => {
    if (!selectedBroker) return;
    setStatus("connecting");
    setError(null);

    const result = await invokeCommand({
      type: "mqtt_connect",
      brokerId: selectedBroker.id,
      url: selectedBroker.url,
      username: selectedBroker.username,
      password: selectedBroker.password,
    });

    if (result.success) {
      setStatus("connected");
      toast.success("Connected to broker");
    } else {
      setStatus("error");
      setError(result.error);
      toast.error("Failed to connect");
    }
  };

  const handleDisconnect = async () => {
    const result = await invokeCommand({
      type: "mqtt_disconnect",
      brokerId: selectedBrokerId,
    });

    if (result.success) {
      setStatus("disconnected");
      setMessages([]);
      toast.success("Disconnected");
    } else {
      toast.error("Failed to disconnect");
    }
  };

  const handleSubscribe = async () => {
    if (status !== "connected") return;

    const result = await invokeCommand({
      type: "mqtt_subscribe",
      brokerId: selectedBrokerId,
      topic: subscribeTopic,
    });

    if (result.success) {
      toast.success(`Subscribed to ${subscribeTopic}`);
    } else {
      toast.error("Failed to subscribe");
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

  return (
    <Card>
      <CardHeader>
        <CardTitle>Test Client</CardTitle>
        <CardDescription>
          Test your broker connection by subscribing and publishing messages
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-4">
          <select
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
            value={selectedBrokerId}
            onChange={(e) => setSelectedBrokerId(e.target.value)}
            disabled={status === "connected"}
          >
            {brokers.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name} {b.isDefault ? "(default)" : ""}
              </option>
            ))}
          </select>
          <div className="flex items-center gap-2">
            {status === "disconnected" && (
              <Button onClick={handleConnect}>
                <PlayIcon className="h-4 w-4 mr-2" />
                Connect
              </Button>
            )}
            {status === "connecting" && (
              <Button disabled>
                <Loader2Icon className="h-4 w-4 mr-2 animate-spin" />
                Connecting...
              </Button>
            )}
            {status === "connected" && (
              <>
                <Badge variant="default" className="bg-green-500">
                  <CheckCircleIcon className="h-3 w-3 mr-1" />
                  Connected
                </Badge>
                <Button variant="outline" onClick={handleDisconnect}>
                  Disconnect
                </Button>
              </>
            )}
            {status === "error" && (
              <Badge variant="destructive">
                <XCircleIcon className="h-3 w-3 mr-1" />
                Error
              </Badge>
            )}
          </div>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

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
      </CardContent>
    </Card>
  );
}
