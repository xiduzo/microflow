import { Button, Form, FormControl, FormField, FormItem, FormLabel, FormMessage, Icons, Input, Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger, useForm, Zod, zodResolver } from '@fhb/ui';
import { useEffect } from 'react';
import { adjectives, animals, uniqueNamesGenerator } from 'unique-names-generator';
import { useLocalStorage } from 'usehooks-ts';

const schema = Zod.object({
  identifier: Zod.string().min(5, "Requires minimum of 5 characters").regex(/^[a-zA-Z_]+$/, { message: 'Only letters and underscores allowed' })
});

type Schema = Zod.infer<typeof schema>;

export function FigmaSettingsForm(props: Props) {
  const form = useForm<Schema>({
    resolver: zodResolver(schema),
  })
  const [uniqueId, setUniqueId] = useLocalStorage("identifier", uniqueNamesGenerator({ dictionaries: [adjectives, animals] }))

  function setRandomUniqueName() {
    form.clearErrors('identifier');
    form.setValue('identifier', uniqueNamesGenerator({ dictionaries: [adjectives, animals] }));
  }

  function onSubmit(data: Schema) {
    setUniqueId(data.identifier)
    props.onClose?.()
  }

  useEffect(() => {
    if (!uniqueId) return;
    form.setValue('identifier', uniqueId);
  }, [form.setValue, uniqueId])

  return <Sheet onOpenChange={opened => {
    if(opened) return
    props.onClose?.()
  }}>
    <SheetTrigger asChild>
      {props.trigger}
    </SheetTrigger>
    <SheetContent>
      <SheetHeader>
        <SheetTitle>Figma settings</SheetTitle>
        <SheetDescription>This identifier allows you to send and receive variable values between this app and the <a className='underline' href="https://www.figma.com/community/plugin/1373258770799080545/figma-hardware-bridge" target="_blank">Figma hardware bridge plugin</a>.
        Make sure you configure the same identifier in the plugin settings.</SheetDescription>
      </SheetHeader>
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="mt-6 space-y-2">
          <FormField control={form.control} name="identifier" render={({ field }) => (
            <FormItem>
              <FormLabel>Indentifier</FormLabel>
              <section className="flex items-center space-x-2">
                <FormControl>
                  <Input placeholder="xiduzo-the-labrador" {...field} />
                </FormControl>
                <Button variant="ghost" type="button" onClick={setRandomUniqueName}>
                  <Icons.Dices className="w-4 h-4" />
                </Button>
              </section>
              <FormMessage />
            </FormItem>)} />
          <Button type="submit" className="w-full">Save Figma settings</Button>
        </form>
      </Form>
    </SheetContent>
  </Sheet>
}

type Props = {
  trigger: React.ReactNode
  onClose?: () => void
}
