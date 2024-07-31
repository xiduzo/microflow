import { MqttConfig } from "@fhb/mqtt/client";
import { Button, Form, FormControl, FormField, FormItem, FormLabel, FormMessage, Icons, Input, useForm, Zod, zodResolver } from "@fhb/ui";
import { useEffect } from "react";
import { LOCAL_STORAGE_KEYS, ShowToast } from "../../../common/types/Message";
import { PageContent, PageHeader } from "../../components/Page";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useSetWindowSize } from "../../hooks/useSetWindowSize";
import { sendMessageToFigma } from "../../utils/sendMessageToFigma";

const schema = Zod.object({
  host: Zod.string().optional(),
  port: Zod.number({ coerce: true }).optional(),
  username: Zod.string().optional(),
  password: Zod.string().optional(),
});

type Schema = Zod.infer<typeof schema>;

const defaultValues: Schema = {
  host: "test.mosquitto.org",
  port: 8081,
}

export function Mqtt() {
  const form = useForm<Schema>({
    resolver: zodResolver(schema),
    defaultValues: defaultValues
  })

  const [mqttConfig, setMqttConfig] = useLocalStorage<MqttConfig | undefined>(LOCAL_STORAGE_KEYS.MQTT_CONNECTION)

  useSetWindowSize({ width: 400, height: 450 + Object.keys(form.formState.errors).length * 28 });

  function onSubmit(data: Schema) {
    setMqttConfig(data)
    sendMessageToFigma(ShowToast("Broker settings saved!"))
  }

  useEffect(() => {
    if (!mqttConfig) return;
    form.reset({
      ...defaultValues,
      ...mqttConfig as Schema,
    })
  }, [mqttConfig, form.reset])

  return (
    <>
      <PageHeader title="MQTT settings" />
      <PageContent className="px-2">
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-2">
            <FormField control={form.control} name="host" render={({ field }) => (
              <FormItem>
                <FormLabel>Host</FormLabel>
                <FormControl>
                  <Input placeholder="test.mosquitto.org" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>)} />
            <FormField control={form.control} name="port" render={({ field }) => (
              <FormItem>
                <FormLabel>Port</FormLabel>
                <FormControl>
                  <Input placeholder="8081" type="number" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>)} />
            <FormField control={form.control} name="username" render={({ field }) => (
              <FormItem>
                <FormLabel>Username</FormLabel>
                <FormControl>
                  <Input placeholder="xiduzo" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>)} />
            <FormField control={form.control} name="password" render={({ field }) => (
              <FormItem>
                <FormLabel>Password</FormLabel>
                <FormControl>
                  <Input placeholder="************" type="password" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>)} />
            <Button type="submit" className="w-full">Save broker settings</Button>
            <div className="text-orange-500 text-sm">
              <Icons.TriangleAlert className="w-3.5 h-3.5 pb-0.5 inline-block mr-1" />
              This plugin will force a connection over <code>wss://</code>, make sure your settings will connect to an encrypted websocket.
            </div>
          </form>
        </Form>
      </PageContent>
    </>
  )
}
