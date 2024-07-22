import { Button, Form, FormControl, FormField, FormItem, FormLabel, FormMessage, Icons, Input, Label, useForm, Zod, zodResolver } from "@fhb/ui";
import { PageContent, PageHeader } from "../../components/Page";
import { useSetWindowSize } from "../../hooks/useSetWindowSize";

const schema = Zod.object({
  host: Zod.string(),
  port: Zod.number(),
  username: Zod.string().optional(),
  password: Zod.string().optional(),
});

type Schema = Zod.infer<typeof schema>;

export function Mqtt() {
  const form = useForm<Schema>({
    resolver: zodResolver(schema),
  })

  useSetWindowSize({ width: 400, height: 530 + Object.keys(form.formState.errors).length * 20 });

  function onSubmit(data: Schema) {
    console.log(data);
  }

  return (
    <>
      <PageHeader title="MQTT settings" />
      <PageContent>
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
        <section className="flex flex-col space-y-2">
          <Label htmlFor="name">Your unique name</Label>
          <div className="flex space-x-2">
            <Input id="name" placeholder="xiduzo-the-labrador" className="grow" />
            <Button variant="ghost">
              <Icons.Dices className="w-4 h-4" />
            </Button>
          </div>
        </section>
      </PageContent>
    </>
  )
}
