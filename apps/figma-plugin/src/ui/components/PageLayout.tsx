/** @jsxImportSource preact */
import { type ComponentChildren } from "preact";
import { IconButton } from "@create-figma-plugin/ui";
import { useNavigation } from "../hooks/use-navigation";

export function PageHeader(props: {
  title: string;
  end?: ComponentChildren;
}) {
  const { canGoBack, goBack } = useNavigation();

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        padding: "8px 12px",
        height: "40px",
        borderBottom: "1px solid var(--figma-color-border)",
        background: "var(--figma-color-bg-secondary)",
        position: "sticky",
        top: 0,
        zIndex: 10,
      }}
    >
      {canGoBack && (
        <IconButton onClick={goBack}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path
              d="M10 12L6 8L10 4"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </IconButton>
      )}
      <span style={{ flex: 1, fontWeight: 600, fontSize: "13px" }}>
        {props.title}
      </span>
      {props.end}
    </div>
  );
}

export function PageContent(props: { children: ComponentChildren }) {
  return (
    <div style={{ padding: "12px", display: "flex", flexDirection: "column", gap: "8px" }}>
      {props.children}
    </div>
  );
}
