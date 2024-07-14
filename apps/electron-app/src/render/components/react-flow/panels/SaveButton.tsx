import { Button, Icons } from "@fhb/ui";
import { useReactFlow } from "@xyflow/react";
import { useEffect, useState } from "react";
import { useNodesEdgesStore } from "../../../store";

export function SaveButton() {
  const [disabled, setDisabled] = useState(false);
  const { getNodes, getEdges } = useReactFlow();
  const { setNodes, setEdges } = useNodesEdgesStore();

  function handleClick() {
    setDisabled(true);
    localStorage.setItem(
      "nodes",
      JSON.stringify(
        getNodes().map((node) => {
          node.data.value = undefined;
          return node;
        }),
      ),
    );
    localStorage.setItem("edges", JSON.stringify(getEdges()));
    setDisabled(false);
  }

  useEffect(() => {
    const nodes = JSON.parse(localStorage.getItem("nodes") || "[]");
    const edges = JSON.parse(localStorage.getItem("edges") || "[]");

    setNodes(nodes);
    setEdges(edges);
  }, [setNodes, setEdges]);

  return (
    <Button onClick={handleClick} variant="ghost" disabled={disabled}>
      {disabled ? <Icons.Loader2 className="animate-spin" /> : <Icons.Save />}
    </Button>
  );
}
