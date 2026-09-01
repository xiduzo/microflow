// Ask AI: a conversation beside the canvas, not a page of its own.
//
// The point of the placement is that you watch the flow change while you talk
// about it — a node appearing where you can see it is most of the feedback this
// feature owes you, so a route that hides the canvas would throw that away.

import { useEffect, useMemo, useRef, useState } from "react";
import { BotMessageSquareIcon, CheckIcon, SquareIcon, XIcon } from "lucide-react";
import { Link } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ui/spinner";
import { EmptyState } from "@/components/states/empty-state";
import { useFlowSession } from "@/session";
import { useAskAi, type AskAiMessage } from "@/lib/ai/use-ask-ai";
import { useAskAiStore, WRITE_MODES } from "@/stores/ask-ai";
import { useLlmProviderStore } from "@/stores/llm-provider";
import { providerModel } from "@/lib/ai/models";
import { hostLimitation } from "@/components/flow/nodes/_base/browser-support";
import { ProviderBadge } from "@/components/flow/nodes/_base/desktop-only-badge";
import { cn } from "@/lib/utils";

export function AskAiPanel() {
  const { doc, readOnly } = useFlowSession();
  const { setOpen, writeMode, setWriteMode, providerId, setProviderId } = useAskAiStore();
  // CLI providers cannot drive the flow tools this panel exists for, so they
  // cannot be *chosen* here — but they are still listed, disabled and badged,
  // rather than hidden: a provider that silently vanishes from one surface
  // reads as a bug, where a greyed row with a tooltip explains itself.
  // `useAskAi` does the same exclusion when resolving the active one.
  const providers = useLlmProviderStore((s) => s.providers);
  // A flow you cannot edit is a flow the assistant cannot edit either — the
  // document would reject the write anyway, so the tools should not be offered.
  const effectiveMode = readOnly ? "read-only" : writeMode;

  const { messages, busy, pending, provider, send, stop, reset, acceptPending, rejectPending } =
    useAskAi(doc, effectiveMode, providerId);

  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, pending]);

  const submit = () => {
    const prompt = draft.trim();
    if (prompt.length === 0 || busy) return;
    setDraft("");
    void send(prompt);
  };

  return (
    <aside className="bg-sidebar flex h-full min-w-0 flex-col border-l">
      <header className="flex items-center gap-2 border-b px-3 py-2">
        <BotMessageSquareIcon className="size-4 shrink-0" />
        <span className="flex-1 truncate text-xs font-medium">Ask AI</span>
        {messages.length > 0 && (
          <Button variant="ghost" size="xs" onClick={reset}>
            Clear
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Close Ask AI"
          onClick={() => setOpen(false)}
        >
          <XIcon />
        </Button>
      </header>

      <div className="flex flex-col gap-2 border-b px-3 py-2">
        <div className="flex gap-1" role="group" aria-label="How changes are applied">
          {WRITE_MODES.map((mode) => (
            <Button
              key={mode.value}
              variant={effectiveMode === mode.value ? "secondary" : "ghost"}
              size="xs"
              className="flex-1"
              // A read-only flow forces the mode; letting the picker pretend
              // otherwise would promise an edit that silently never happens.
              disabled={readOnly}
              title={mode.hint}
              onClick={() => setWriteMode(mode.value)}
            >
              {mode.label}
            </Button>
          ))}
        </div>
        <p className="text-muted-foreground text-[11px] leading-tight">
          {readOnly
            ? "This flow is read-only, so the assistant can only look and explain."
            : WRITE_MODES.find((m) => m.value === effectiveMode)?.hint}
        </p>
        {/* Which saved LLM configuration answers. The model comes with it —
            set once under Configuration → LLM, not restated per surface. */}
        <Select value={provider?.id ?? ""} onValueChange={(value) => setProviderId(value ?? "")}>
          <SelectTrigger size="sm" className="h-7 w-full text-xs">
            <SelectValue placeholder="No LLM configuration">
              {(value: string | null) => {
                const selected = providers.find((p) => p.id === value);
                return selected
                  ? `${selected.name} · ${providerModel(selected)}`
                  : "No LLM configuration";
              }}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {providers.map((p) => (
              <SelectItem
                key={p.id}
                value={p.id}
                className="text-xs"
                disabled={
                  hostLimitation({ kind: "provider", provider: p, surface: "ask-ai" }) !== undefined
                }
              >
                {p.name}
                <span className="text-muted-foreground ml-1">{providerModel(p)}</span>
                <ProviderBadge provider={p} surface="ask-ai" />
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3">
        {messages.length === 0 ? (
          <EmptyState
            icon={BotMessageSquareIcon}
            title={provider ? "Ask about this flow" : "No provider configured"}
            description={
              provider ? (
                "Try: “add a button on pin 2 that toggles an LED on pin 13”, or “why isn’t my LED lighting up?”"
              ) : (
                <>
                  Add one under{" "}
                  <Link to="/configuration/llm" className="underline">
                    Configuration → LLM
                  </Link>
                  . Ollama on this machine works, and so does any OpenAI-compatible endpoint.
                </>
              )
            }
          />
        ) : (
          <div className="flex flex-col gap-3">
            {messages.map((message) => (
              <Message key={message.id} message={message} busy={busy} />
            ))}
            {pending.length > 0 && (
              <PendingChanges
                summaries={pending.map((change) => change.summary)}
                onAccept={acceptPending}
                onReject={rejectPending}
              />
            )}
            <div ref={endRef} />
          </div>
        )}
      </div>

      <div className="flex flex-col gap-2 border-t px-3 py-2">
        <Textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends, Shift+Enter breaks the line — a chat box, not a form
            // field. The canvas's own hotkeys must not fire from in here.
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
            event.stopPropagation();
          }}
          placeholder="Ask about this flow…"
          className="min-h-16 resize-none"
          disabled={!provider}
        />
        <div className="flex justify-end gap-2">
          {busy ? (
            <Button variant="outline" size="sm" onClick={stop}>
              <SquareIcon /> Stop
            </Button>
          ) : (
            <Button size="sm" onClick={submit} disabled={!provider || draft.trim().length === 0}>
              Send
            </Button>
          )}
        </div>
      </div>
    </aside>
  );
}

function Message({ message, busy }: { message: AskAiMessage; busy: boolean }) {
  const isUser = message.role === "user";
  const thinking = !isUser && busy && message.content.length === 0;

  return (
    <div className={cn("flex flex-col gap-1", isUser && "items-end")}>
      <div
        className={cn(
          "max-w-[92%] rounded-md px-2.5 py-1.5 text-xs whitespace-pre-wrap",
          isUser && "bg-primary text-primary-foreground",
          !isUser && !message.error && "bg-muted",
          message.error && "bg-destructive/10 text-destructive",
        )}
      >
        {thinking ? <Spinner className="size-3" /> : message.content}
      </div>
      {message.tools && message.tools.length > 0 && (
        // What it actually did, in the order it did it — the difference between
        // trusting the answer and taking its word for it.
        <p className="text-muted-foreground font-mono text-[10px]">
          {message.tools.join(" → ")}
        </p>
      )}
    </div>
  );
}

function PendingChanges({
  summaries,
  onAccept,
  onReject,
}: {
  summaries: string[];
  onAccept: () => void;
  onReject: () => void;
}) {
  return (
    <div className="border-primary/40 bg-primary/5 flex flex-col gap-2 rounded-md border p-2.5">
      <p className="text-xs font-medium">
        {summaries.length} change{summaries.length === 1 ? "" : "s"} to apply
      </p>
      <ul className="text-muted-foreground flex flex-col gap-0.5 text-[11px]">
        {summaries.map((summary, index) => (
          <li key={`${summary}-${index}`}>· {summary}</li>
        ))}
      </ul>
      <div className="flex gap-2">
        <Button size="xs" onClick={onAccept}>
          <CheckIcon /> Apply
        </Button>
        <Button size="xs" variant="ghost" onClick={onReject}>
          Discard
        </Button>
      </div>
    </div>
  );
}
