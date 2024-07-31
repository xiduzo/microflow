import { Button, Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage, Icons, Input, useForm, Zod, zodResolver } from "@fhb/ui";
import { useEffect } from "react";
import { adjectives, animals, uniqueNamesGenerator } from "unique-names-generator";
import { LOCAL_STORAGE_KEYS, ShowToast } from "../../../common/types/Message";
import { PageContent, PageHeader } from "../../components/Page";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useSetWindowSize } from "../../hooks/useSetWindowSize";
import { sendMessageToFigma } from "../../utils/sendMessageToFigma";

const schema = Zod.object({
  identifier: Zod.string().min(5, "Requires minimum of 5 characters").regex(/^[a-zA-Z_]+$/, { message: 'Only letters and underscores allowed' })
});

type Schema = Zod.infer<typeof schema>;

export function Config() {
  const form = useForm<Schema>({
    resolver: zodResolver(schema),
  });

  const [uniqueId, setUniqueId] = useLocalStorage<string>(LOCAL_STORAGE_KEYS.TOPIC_UID);

  useSetWindowSize({ width: 400, height: 240 + Object.keys(form.formState.errors).length * 28 });


  function setRandomUniqueName() {
    form.clearErrors('identifier');
    form.setValue('identifier', uniqueNamesGenerator({ dictionaries: [adjectives, animals] }));
  }

  function onSubmit(data: Schema) {
    setUniqueId(data.identifier)
    sendMessageToFigma(ShowToast("Plugin settings saved!"))
  }

  useEffect(() => {
    if (!uniqueId) return;
    form.setValue('identifier', uniqueId);
  }, [form.setValue, uniqueId])

  return (
    <>
      <PageHeader title="Plugin settings" />
      <PageContent className="px-2">
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-2">
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
                <FormDescription>
                  This identifier allows you to share messages between the Figma harware bridge and other MQTT clients.
                </FormDescription>
                <FormMessage />
              </FormItem>)} />
            <Button type="submit" className="w-full">Save plugin settings</Button>
          </form>
        </Form>
      </PageContent>
    </>
  )
}
