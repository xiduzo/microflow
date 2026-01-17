import { useCallback, useEffect, useState, useRef } from "react";
import { FlowDocument, type FlowNode, type FlowEdge, type FlowMeta } from "@microflow/collab";
import { applyNodeChanges, applyEdgeChanges, type NodeChange, type EdgeChange } from "@xyflow/react";

// ============================================================================
// useFlowState - Main hook for ReactFlow integration
// ============================================================================

export function useFlowState(flowDoc: FlowDocument | null) {
  const [nodes, setNodes] = useState<FlowNode[]>([]);
  const [edges, setEdges] = useState<FlowEdge[]>([]);
  
  // Track if we're currently syncing from Yjs to avoid loops
  const isSyncingFromYjs = useRef(false);
  // Track if we need to sync to Yjs
  const pendingYjsSync = useRef<{ nodes?: FlowNode[]; edges?: FlowEdge[] } | null>(null);

  // Sync local state to Yjs (debounced for drag operations)
  const syncToYjs = useCallback(() => {
    if (!flowDoc || !pendingYjsSync.current) return;
    
    const { nodes: newNodes, edges: newEdges } = pendingYjsSync.current;
    pendingYjsSync.current = null;

    flowDoc.doc.transact(() => {
      if (newNodes) {
        // Update changed nodes
        const currentNodeIds = new Set(flowDoc.nodes.keys());
        const newNodeIds = new Set(newNodes.map(n => n.id));
        
        // Remove deleted nodes
        currentNodeIds.forEach(id => {
          if (!newNodeIds.has(id)) {
            flowDoc.nodes.delete(id);
          }
        });
        
        // Update/add nodes
        newNodes.forEach(node => {
          const existing = flowDoc.nodes.get(node.id);
          // Only update if changed (compare position and dimensions)
          if (!existing || 
              existing.position.x !== node.position.x || 
              existing.position.y !== node.position.y ||
              existing.width !== node.width ||
              existing.height !== node.height) {
            flowDoc.nodes.set(node.id, {
              ...node,
              selected: undefined, // Don't persist selection
              dragging: undefined,
            });
          }
        });
      }
      
      if (newEdges) {
        const currentEdgeIds = new Set(flowDoc.edges.keys());
        const newEdgeIds = new Set(newEdges.map(e => e.id));
        
        // Remove deleted edges
        currentEdgeIds.forEach(id => {
          if (!newEdgeIds.has(id)) {
            flowDoc.edges.delete(id);
          }
        });
        
        // Update/add edges
        newEdges.forEach(edge => {
          if (!flowDoc.edges.has(edge.id)) {
            flowDoc.edges.set(edge.id, {
              ...edge,
              selected: undefined,
            });
          }
        });
      }
    }, "local");
  }, [flowDoc]);

  // Initialize and subscribe to Yjs changes
  useEffect(() => {
    if (!flowDoc) {
      setNodes([]);
      setEdges([]);
      return;
    }

    // Load initial data
    setNodes(flowDoc.getNodes());
    setEdges(flowDoc.getEdges());

    // Subscribe to Yjs changes (from remote or undo/redo)
    const handleNodesChange = () => {
      if (pendingYjsSync.current) return; // Skip if we have pending local changes
      isSyncingFromYjs.current = true;
      setNodes(flowDoc.getNodes());
      isSyncingFromYjs.current = false;
    };

    const handleEdgesChange = () => {
      if (pendingYjsSync.current) return;
      isSyncingFromYjs.current = true;
      setEdges(flowDoc.getEdges());
      isSyncingFromYjs.current = false;
    };

    const unsubNodes = flowDoc.onNodesChange(handleNodesChange);
    const unsubEdges = flowDoc.onEdgesChange(handleEdgesChange);

    return () => {
      unsubNodes();
      unsubEdges();
    };
  }, [flowDoc]);

  // Handle ReactFlow node changes
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes(currentNodes => {
      const newNodes = applyNodeChanges(changes, currentNodes) as FlowNode[];
      
      // Check if this is a structural change (not just selection/dragging)
      const hasStructuralChange = changes.some(c => 
        c.type === 'add' || 
        c.type === 'remove' || 
        (c.type === 'position' && !c.dragging) ||
        c.type === 'dimensions'
      );
      
      if (hasStructuralChange && flowDoc) {
        pendingYjsSync.current = { ...pendingYjsSync.current, nodes: newNodes };
        // Use requestAnimationFrame to batch updates
        requestAnimationFrame(syncToYjs);
      }
      
      return newNodes;
    });
  }, [flowDoc, syncToYjs]);

  // Handle ReactFlow edge changes
  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setEdges(currentEdges => {
      const newEdges = applyEdgeChanges(changes, currentEdges) as FlowEdge[];
      
      const hasStructuralChange = changes.some(c => 
        c.type === 'add' || 
        c.type === 'remove'
      );
      
      if (hasStructuralChange && flowDoc) {
        pendingYjsSync.current = { ...pendingYjsSync.current, edges: newEdges };
        requestAnimationFrame(syncToYjs);
      }
      
      return newEdges;
    });
  }, [flowDoc, syncToYjs]);

  return {
    nodes,
    edges,
    onNodesChange,
    onEdgesChange,
  };
}

// ============================================================================
// useFlowNodes - Subscribe to nodes changes (read-only)
// ============================================================================

export function useFlowNodes(flowDoc: FlowDocument | null): FlowNode[] {
  const [nodes, setNodes] = useState<FlowNode[]>([]);

  useEffect(() => {
    if (!flowDoc) {
      setNodes([]);
      return;
    }

    // Initial value
    setNodes(flowDoc.getNodes());

    // Subscribe to changes
    const unsubscribe = flowDoc.onNodesChange(() => {
      setNodes(flowDoc.getNodes());
    });

    return unsubscribe;
  }, [flowDoc]);

  return nodes;
}

// ============================================================================
// useFlowEdges - Subscribe to edges changes (read-only)
// ============================================================================

export function useFlowEdges(flowDoc: FlowDocument | null): FlowEdge[] {
  const [edges, setEdges] = useState<FlowEdge[]>([]);

  useEffect(() => {
    if (!flowDoc) {
      setEdges([]);
      return;
    }

    // Initial value
    setEdges(flowDoc.getEdges());

    // Subscribe to changes
    const unsubscribe = flowDoc.onEdgesChange(() => {
      setEdges(flowDoc.getEdges());
    });

    return unsubscribe;
  }, [flowDoc]);

  return edges;
}

// ============================================================================
// useFlowMeta - Subscribe to meta changes
// ============================================================================

export function useFlowMeta(flowDoc: FlowDocument | null): FlowMeta | null {
  const [meta, setMeta] = useState<FlowMeta | null>(null);

  useEffect(() => {
    if (!flowDoc) {
      setMeta(null);
      return;
    }

    // Initial value
    setMeta(flowDoc.getMeta());

    // Subscribe to changes
    const unsubscribe = flowDoc.onMetaChange(() => {
      setMeta(flowDoc.getMeta());
    });

    return unsubscribe;
  }, [flowDoc]);

  return meta;
}

// ============================================================================
// useFlowHistory - Undo/Redo with Yjs UndoManager
// ============================================================================

export function useFlowHistory(flowDoc: FlowDocument | null) {
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  useEffect(() => {
    if (!flowDoc) {
      setCanUndo(false);
      setCanRedo(false);
      return;
    }

    const updateState = () => {
      setCanUndo(flowDoc.canUndo());
      setCanRedo(flowDoc.canRedo());
    };

    // Initial state
    updateState();

    // Listen to undo manager events
    const undoManager = flowDoc.undoManager;
    undoManager.on("stack-item-added", updateState);
    undoManager.on("stack-item-popped", updateState);

    return () => {
      undoManager.off("stack-item-added", updateState);
      undoManager.off("stack-item-popped", updateState);
    };
  }, [flowDoc]);

  const undo = useCallback(() => {
    flowDoc?.undo();
  }, [flowDoc]);

  const redo = useCallback(() => {
    flowDoc?.redo();
  }, [flowDoc]);

  return { canUndo, canRedo, undo, redo };
}

// ============================================================================
// useFlowData - Combined nodes and edges (for ReactFlow)
// ============================================================================

export function useFlowData(flowDoc: FlowDocument | null) {
  const nodes = useFlowNodes(flowDoc);
  const edges = useFlowEdges(flowDoc);
  return { nodes, edges };
}
