import { useNavigation } from "@microflow/design-bridge/react";
import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";

export function PageHeader(props: { title: string; end?: ReactNode }) {
  const { canGoBack, goBack } = useNavigation();

  return (
    <div className="sticky top-0 z-10 flex h-10 items-center border-b border-gray-200 bg-gray-50 px-3 dark:border-gray-700 dark:bg-gray-900">
      {canGoBack && (
        <button
          type="button"
          onClick={goBack}
          className="mr-1 flex h-7 w-7 items-center justify-center rounded hover:bg-gray-200 dark:hover:bg-gray-700"
          aria-label="Go back"
        >
          <ArrowLeft size={16} />
        </button>
      )}
      <span className="flex-1 text-sm font-semibold text-gray-900 dark:text-white">
        {props.title}
      </span>
      {props.end}
    </div>
  );
}

export function PageContent(props: { children: ReactNode }) {
  return <div className="flex flex-col gap-2 overflow-y-auto p-3">{props.children}</div>;
}

export function IconButton(props: {
  onClick: () => void;
  children: ReactNode;
  title: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      title={props.title}
      aria-label={props.title}
      disabled={props.disabled}
      className="flex h-7 w-7 items-center justify-center rounded text-gray-600 hover:bg-gray-200 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent dark:text-gray-300 dark:hover:bg-gray-700"
    >
      {props.children}
    </button>
  );
}
