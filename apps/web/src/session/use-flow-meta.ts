import { useEffect, useState } from "react";
import type { FlowDocument, FlowMeta } from "@microflow/collab";

export function useFlowMeta(doc: FlowDocument): FlowMeta {
  const [meta, setMeta] = useState<FlowMeta>(() => doc.getMeta());
  useEffect(() => {
    setMeta(doc.getMeta());
    return doc.onMetaChange(() => setMeta(doc.getMeta()));
  }, [doc]);
  return meta;
}
