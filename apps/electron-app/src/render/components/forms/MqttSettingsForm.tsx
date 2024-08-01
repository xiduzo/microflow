import { MqttConfig } from '@fhb/mqtt/client';
import { Button, Form, FormControl, FormField, FormItem, FormLabel, FormMessage, Icons, Input, Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger, useForm, Zod, zodResolver } from '@fhb/ui';
import { useEffect } from 'react';
import { useLocalStorage } from 'usehooks-ts';

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

export function MqttSettingsForm(props: Props) {
  const form = useForm<Schema>({
    resolver: zodResolver(schema),
    defaultValues: defaultValues
  })

  const [mqttConfig, setMqttConfig] = useLocalStorage<MqttConfig | undefined>("mqtt-config", defaultValues)

  function onSubmit(data: Schema) {
    setMqttConfig(data)
    props.onClose?.()
  }

  useEffect(() => {
    if (!mqttConfig) return;
    form.reset({
      ...defaultValues,
      ...mqttConfig as Schema,
    })
  }, [mqttConfig, form.reset])

  return <Sheet onOpenChange={opened => {
    if(opened) return
    props.onClose?.()
  }}>
    <SheetTrigger asChild>
      {props.trigger}
    </SheetTrigger>
    <SheetContent>
      <SheetHeader>
        <SheetTitle>MQTT Settings</SheetTitle>
        <SheetDescription>When using Figma nodes, make sure to configure the same MQTT broker in the <a className='underline' href="https://www.figma.com/community/plugin/1373258770799080545/figma-hardware-bridge" target="_blank">Figma hardware bridge plugin</a>.</SheetDescription>
      </SheetHeader>
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="mt-6 space-y-2">
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
            This app will force a connection over <code>wss://</code>, make sure your settings will connect to an encrypted websocket.
          </div>
        </form>
      </Form>
    </SheetContent>
  </Sheet>
}

type Props = {
  trigger: React.ReactNode
  onClose?: () => void
}
