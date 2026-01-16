import { useCollabPresence } from "@/hooks/use-collab-flow";

/**
 * Shows avatars of users currently viewing/editing the flow
 */
export function CollabPresence() {
  const { otherUsers } = useCollabPresence();

  if (otherUsers.length === 0) return null;

  return (
    <div className="flex items-center gap-1">
      {otherUsers.map((user) => (
        <div
          key={user.id}
          className="relative flex items-center justify-center w-8 h-8 rounded-full text-white text-xs font-medium"
          style={{ backgroundColor: user.color }}
          title={user.name}
        >
          {user.name.charAt(0).toUpperCase()}
          {/* Online indicator */}
          <span className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-green-500 border-2 border-white rounded-full" />
        </div>
      ))}
      {otherUsers.length > 0 && (
        <span className="text-sm text-muted-foreground ml-2">
          {otherUsers.length} {otherUsers.length === 1 ? "person" : "people"} editing
        </span>
      )}
    </div>
  );
}

/**
 * Renders cursors of other users on the canvas
 */
export function CollabCursors() {
  const { otherUsers } = useCollabPresence();

  return (
    <>
      {otherUsers.map((user) =>
        user.cursor ? (
          <div
            key={user.id}
            className="pointer-events-none fixed z-50 transition-all duration-75"
            style={{
              left: user.cursor.x,
              top: user.cursor.y,
              transform: "translate(-2px, -2px)",
            }}
          >
            {/* Cursor SVG */}
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              style={{ filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.3))" }}
            >
              <path
                d="M5.65376 12.4563L5.65376 12.4563L5.65314 12.4525C5.64132 12.3804 5.64132 12.3067 5.65314 12.2346L5.65376 12.2308L5.65376 12.2308L8.73388 3.68299C8.7933 3.51661 8.90321 3.37098 9.04914 3.26584C9.19507 3.1607 9.37014 3.10089 9.55078 3.09424C9.73142 3.08759 9.91028 3.13439 10.0633 3.22851C10.2163 3.32263 10.3363 3.45977 10.4078 3.62148L10.4078 3.62148L10.4115 3.63001L17.4115 19.63L17.4115 19.63L17.4152 19.6388C17.4867 19.8005 17.5063 19.9803 17.4713 20.1535C17.4363 20.3267 17.3484 20.4847 17.2195 20.6063C17.0906 20.7279 16.9271 20.8069 16.7517 20.8322C16.5763 20.8575 16.3976 20.8279 16.2402 20.7476L16.2402 20.7476L16.2315 20.7431L11.2315 18.0931L11.2315 18.0931L11.2228 18.0885C11.0654 18.0082 10.8867 17.9786 10.7113 18.0039C10.5359 18.0292 10.3724 18.1082 10.2435 18.2298L10.2435 18.2298L10.2363 18.2366L6.23633 21.9866L6.23633 21.9866L6.22764 21.9948C6.09873 22.1164 5.93523 22.1954 5.75983 22.2207C5.58443 22.246 5.40573 22.2164 5.24833 22.1361C5.09093 22.0558 4.96213 21.9287 4.87883 21.7717C4.79553 21.6147 4.76163 21.4357 4.78183 21.2588L4.78183 21.2588L4.78313 21.2478L5.65376 12.4563Z"
                fill={user.color}
                stroke="white"
                strokeWidth="1.5"
              />
            </svg>
            {/* User name label */}
            <div
              className="absolute left-4 top-4 px-2 py-0.5 rounded text-xs text-white whitespace-nowrap"
              style={{ backgroundColor: user.color }}
            >
              {user.name}
            </div>
          </div>
        ) : null
      )}
    </>
  );
}
