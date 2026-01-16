import { useEffect, useCallback, useRef } from "react";
import { useCollabConnection, useCollabAwareness, type AwarenessUser } from "@/stores/collab-provider";

const COLORS = [
  "#ef4444", "#f97316", "#eab308", "#22c55e", 
  "#14b8a6", "#3b82f6", "#8b5cf6", "#ec4899",
];

function getRandomColor() {
  return COLORS[Math.floor(Math.random() * COLORS.length)];
}

type UseCollabFlowOptions = {
  flowId: string;
  userId: string;
  userName: string;
  wsUrl?: string;
};

/**
 * Hook to connect to a collaborative flow session
 */
export function useCollabFlow({ flowId, userId, userName, wsUrl }: UseCollabFlowOptions) {
  const { connect, disconnect, isConnected, isConnecting, error } = useCollabConnection();
  
  // Use refs to avoid reconnecting when functions change
  const connectRef = useRef(connect);
  const disconnectRef = useRef(disconnect);
  connectRef.current = connect;
  disconnectRef.current = disconnect;

  useEffect(() => {
    const user: AwarenessUser = {
      id: userId,
      name: userName,
      color: getRandomColor(),
    };

    // Default to current origin with ws/wss protocol
    const defaultWsUrl = typeof window !== "undefined"
      ? `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}`
      : "ws://localhost:3000";

    connectRef.current(flowId, user, wsUrl ?? defaultWsUrl);

    return () => {
      disconnectRef.current();
    };
  }, [flowId, userId, userName, wsUrl]);

  return { isConnected, isConnecting, error };
}

/**
 * Hook to track cursor position and broadcast to other users
 */
export function useCollabCursor() {
  const { updateCursor } = useCollabAwareness();

  const handleMouseMove = useCallback(
    (event: React.MouseEvent) => {
      updateCursor({ x: event.clientX, y: event.clientY });
    },
    [updateCursor]
  );

  return { onMouseMove: handleMouseMove };
}

/**
 * Hook to get other users' presence information
 */
export function useCollabPresence() {
  const { awareness, localUser } = useCollabAwareness();

  // Filter out local user
  const otherUsers = Array.from(awareness.values()).filter(
    (user) => user.id !== localUser?.id
  );

  return { otherUsers, localUser };
}
