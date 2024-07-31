import { Button, cva, Icons } from "@fhb/ui";
import { useState } from "react";
import { Link } from "react-router-dom";
import { LOCAL_STORAGE_KEYS, MESSAGE_TYPE } from "../../../common/types/Message";
import { PageContent, PageHeader } from "../../components/Page";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useMessageListener } from "../../hooks/useMessageListener";
import { useSetWindowSize } from "../../hooks/useSetWindowSize";

export function Variables() {
  const [uniqueId] = useLocalStorage<string>(LOCAL_STORAGE_KEYS.TOPIC_UID)

  const [variables, setVariables] = useState<Variable[] | undefined>([]);
  const [copiedValue, copy] = useCopyToClipboard();

  useSetWindowSize({ width: 450, height: variables?.length ? 550 : 300 });

  useMessageListener<Variable[] | undefined>(
    MESSAGE_TYPE.GET_LOCAL_VARIABLES,
    setVariables
  );

  return <>
    <PageHeader title="Variables" end={<Button variant="ghost" size="icon" title="How to use" asChild>
      <Link to="/variables/help">
        <Icons.BadgeHelp className="w-4 h-4" opacity="80%" />
      </Link>
    </Button>} />
    <PageContent className="divide-y divide-neutral-700 space-y-0">
      {!variables?.length && <section className="flex flex-col items-center space-y-7 w-full h-full">
        <Icons.BookDashed className="w-16 h-16" opacity="40%" />
        <div className="text-xl">No variables found</div>
        <div className="text-neutral-400 text-center">All variables created in the <code className="p-0.5 bg-yellow-500 rounded-md text-neutral-100">FHB</code> collection will be linked automatically with this plugin.</div>
      </section>}
      {variables?.map(variable => {
        return <section key={variable.id} className="flex justify-between py-1 group">
          <div className="flex space-x-2 items-center">
            <VariableIcon type={variable.resolvedType} />
            <span>{variable.name}</span>
          </div>
          <div className="flex space-x-2 items-center opacity-10 group-hover:opacity-100 transition-all duration-300">
            <Button
              variant="ghost"
              size="icon"
              title="Copy send topic"
              className="hover:cursor-copy"
              onClick={() => { copy(`fhb/v1/${uniqueId}/YOUR_APP_NAME/variable/${variable.id}/set`) }}>
              <Icons.RadioTower className={copyButtonIcon({ hasCopiedValue: copiedValue === `fhb/v1/${uniqueId}/YOUR_APP_NAME/variable/${variable.id}/set` })} opacity="80%" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              title="Copy receive topic"
              className="hover:cursor-copy"
              onClick={() => { copy(`fhb/v1/${uniqueId}/plugin/variable/${variable.id}`) }}>
              <Icons.Antenna className={copyButtonIcon({ hasCopiedValue: copiedValue === `fhb/v1/${uniqueId}/plugin/variable/${variable.id}` })} opacity="80%" />
            </Button>
          </div>
        </section>
      })}
    </PageContent>
  </>
}

function VariableIcon(props: { type: Variable['resolvedType'] }) {
  switch (props.type) {
    case 'BOOLEAN':
      return <Icons.Hash className="w-3 h-3 opacity-40" />
    case 'STRING':
      return <Icons.Type className="w-3 h-3 opacity-40" />
    case 'COLOR':
      return <Icons.Palette className="w-3 h-3 opacity-40" />
    case 'FLOAT':
      return <Icons.DiscAlbum className="w-3 h-3 opacity-40" />
    default:
      return null
  }
}

const copyButtonIcon = cva('w-4 h-4', {
  variants: {
    hasCopiedValue: {
      true: 'text-green-500',
      false: ''
    }
  },
  defaultVariants: {
    hasCopiedValue: false
  }
})
