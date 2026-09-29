import { useEffect } from "react";
import { create } from "zustand";

type Toast = { id: number; message: string; error: boolean };

const useToasts = create<{ current: Toast | null }>(() => ({ current: null }));

let nextId = 0;

/** Penpot has no notification API, so the UI shows its own. */
export function toast(message: string, options?: { error?: boolean }) {
  useToasts.setState({ current: { id: nextId++, message, error: options?.error ?? false } });
}

export function Toaster() {
  const current = useToasts((state) => state.current);

  useEffect(() => {
    if (!current) return;
    const timer = setTimeout(() => useToasts.setState({ current: null }), 2000);
    return () => clearTimeout(timer);
  }, [current]);

  if (!current) return null;

  return (
    <div
      key={current.id}
      role={current.error ? "alert" : "status"}
      className={`fixed inset-x-3 bottom-3 z-20 rounded px-3 py-2 text-[12px] shadow-lg ${
        current.error
          ? "bg-red-600 text-white"
          : "bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900"
      }`}
    >
      {current.message}
    </div>
  );
}
