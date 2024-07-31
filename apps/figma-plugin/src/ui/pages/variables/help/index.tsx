import { Icons } from "@fhb/ui";
import { PageContent, PageHeader } from "../../../components/Page";
import { useSetWindowSize } from "../../../hooks/useSetWindowSize";

export function VariablesHelp() {
  useSetWindowSize({ width: 450, height: 450 });


  return <>
    <PageHeader title="Variables help" />
    <PageContent>
      <div>This plugin uses <a href="https://mqtt.org/" target="_blank" className="underline">MQTT</a> to expose all variables in the <code className="p-0.5 bg-yellow-500 rounded-md text-neutral-100">FHB</code> variable collection.</div>
      <div className="flex items-center">Variables updates can be <Icons.RadioTower className="w-3 h-3 mx-2" aria-hidden /> send or <Icons.Antenna className="w-3 h-3 mx-2" aria-hidden /> received</div>
      <section className="pt-3">
        <div className="flex items-center space-x-3">
          <Icons.RadioTower className="w-5 h-5" aria-hidden />
          <div className="font-bold">Sending updates</div>
        </div>
        <div className="mt-1.5">
          You can use any MQTT client to send updates to a variable. See the <a href="https://www.figma.com/plugin-docs/api/VariableResolvedDataType" className="underline">Figma documentation</a> for more information on the data format for each variable type.
        </div>
        <div className="mt-1 text-orange-500">
          Make sure your client is connected to the same MQTT broker as configured in the plugin.
        </div>
      </section>
      <section className="pt-3">
        <div className="flex items-center space-x-3">
          <Icons.Antenna className="w-5 h-5" aria-hidden />
          <div className="font-bold">Receiving Updates</div>
        </div>
        <div className="mt-1.5">
          Whenever there is a change in the <code className="p-0.5 bg-yellow-500 rounded-md text-neutral-100">FHB</code> collection, this plugin will publish an update on the received topic.
        </div>
      </section>
    </PageContent>
  </>
}
