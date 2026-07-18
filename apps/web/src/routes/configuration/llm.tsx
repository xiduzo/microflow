import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { useForm } from "@tanstack/react-form";
import { toast } from "sonner";
import {
  PlusIcon, TrashIcon, StarIcon, PencilIcon,
  CircleIcon, CheckCircleIcon, XCircleIcon, Loader2Icon, BotIcon,
} from "lucide-react";

import { useLlmProviderStore, useProviderStatus, type LlmProviderConfig } from "@/stores/llm-provider";
import { track } from "@/lib/analytics";
import { invokeCommand } from "@/lib/ipc";
import { isDesktop } from "@/lib/platform";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { InputGroup, InputGroupInput } from "@/components/ui/input-group";
import { EmptyState } from "@/components/states/empty-state";
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";

// Coarse provider family from the base URL — keeps analytics low-cardinality
// (never the URL itself, which can identify a user's private endpoint).
function providerFamily(baseUrl: string): string {
  const url = baseUrl.toLowerCase();
  if (url.includes("localhost:11434") || url.includes("ollama")) return "ollama";
  if (url.includes("openrouter.ai")) return "openrouter";
  if (url.includes("api.openai.com")) return "openai";
  return "other";
}

export const Route = createFileRoute("/configuration/llm")({
  component: LlmConfigPage,
  beforeLoad: async () => {
    if (!isDesktop()) {
      toast.warning("LLM configuration is only available on desktop");
      return redirect({ to: "/" });
    }
  },
});

function LlmConfigPage() {
  const providers = useLlmProviderStore((s) => s.providers);

  return (
    <div className="h-full overflow-auto">
      <div className="container max-w-4xl mx-auto py-8 px-4 space-y-6">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold">LLM Configuration</h1>
            <p className="text-muted-foreground text-sm">
              Configure LLM providers — Ollama, OpenRouter, or any OpenAI-compatible endpoint
            </p>
          </div>
          <AddProviderDialog />
        </header>

        {providers.length === 0 ? (
          <EmptyState
            title="No providers configured"
            description="Add an LLM provider to use AI nodes in your flows"
            icon={BotIcon}
          >
            <AddProviderDialog />
          </EmptyState>
        ) : (
          <div className="space-y-2">
            {providers.map((p) => <ProviderCard key={p.id} provider={p} />)}
          </div>
        )}

        <Separator />

        <div className="text-sm text-muted-foreground space-y-1">
          <p className="font-medium">Quick start:</p>
          <p>• <strong>Ollama (local):</strong> Base URL <code>http://localhost:11434</code>, no API key needed</p>
          <p>• <strong>OpenRouter:</strong> Base URL <code>https://openrouter.ai/api/v1</code>, add your API key</p>
          <p>• <strong>OpenAI:</strong> Base URL <code>https://api.openai.com/v1</code>, add your API key</p>
        </div>
      </div>
    </div>
  );
}

function ProviderCard({ provider }: { provider: LlmProviderConfig }) {
  const { deleteProvider, setDefaultProvider, setStatus } = useLlmProviderStore();
  const status = useProviderStatus(provider.id);
  const [editOpen, setEditOpen] = useState(false);

  const handleTest = async () => {
    setStatus(provider.id, "testing");
    const result = await invokeCommand({
      type: "llm_test_provider",
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
    });
    track("llm_provider_tested", {
      family: providerFamily(provider.baseUrl),
      ok: result.success,
    });
    if (result.success) {
      setStatus(provider.id, "ok");
      toast.success(`${provider.name} is reachable`);
    } else {
      setStatus(provider.id, "error");
      toast.error(`${provider.name} test failed`, { description: (result as { error: string }).error });
    }
  };

  return (
    <Item variant="outline">
      <ItemMedia>
        {status === "testing" ? (
          <Loader2Icon className="animate-spin size-5" />
        ) : status === "ok" ? (
          <CheckCircleIcon className="size-5 text-green-500" />
        ) : status === "error" ? (
          <XCircleIcon className="size-5 text-red-500" />
        ) : (
          <CircleIcon className="size-5 text-muted-foreground" />
        )}
      </ItemMedia>
      <ItemContent>
        <ItemTitle>
          {provider.name}
          {provider.isDefault && <span className="ml-2 text-xs text-muted-foreground">(default)</span>}
        </ItemTitle>
        <ItemDescription>{provider.baseUrl}</ItemDescription>
      </ItemContent>
      <ItemActions>
        <Button variant="ghost" size="sm" onClick={handleTest}>
          <CheckCircleIcon className="size-4" /> Test
        </Button>
        {!provider.isDefault && (
          <Button variant="ghost" size="icon" onClick={() => setDefaultProvider(provider.id)}>
            <StarIcon />
          </Button>
        )}
        {provider.isDefault && (
          <Button variant="ghost" size="icon" disabled>
            <StarIcon className="text-yellow-900 fill-yellow-500" />
          </Button>
        )}
        <Dialog open={editOpen} onOpenChange={setEditOpen}>
          <DialogTrigger render={<Button variant="ghost" size="sm"><PencilIcon /></Button>} />
          <EditProviderDialogContent provider={provider} onClose={() => setEditOpen(false)} />
        </Dialog>
        <Button variant="ghost" size="icon" onClick={() => { deleteProvider(provider.id); toast.success("Provider deleted"); }}>
          <TrashIcon />
        </Button>
      </ItemActions>
    </Item>
  );
}

function ProviderForm({ defaults, onSubmit, onCancel, submitLabel }: {
  defaults: { name: string; baseUrl: string; apiKey: string };
  onSubmit: (v: typeof defaults) => void;
  onCancel: () => void;
  submitLabel: string;
}) {
  const form = useForm({ defaultValues: defaults, onSubmit: ({ value }) => onSubmit(value) });
  return (
    <form onSubmit={(e) => { e.preventDefault(); form.handleSubmit(); }}>
      <FieldGroup>
        <form.Field name="name">{(f) => (
          <Field><FieldLabel>Name</FieldLabel>
            <InputGroup><InputGroupInput placeholder="My Provider" value={f.state.value} onChange={(e) => f.handleChange(e.target.value)} /></InputGroup>
          </Field>
        )}</form.Field>
        <form.Field name="baseUrl">{(f) => (
          <Field><FieldLabel>Base URL</FieldLabel>
            <InputGroup><InputGroupInput placeholder="http://localhost:11434" value={f.state.value} onChange={(e) => f.handleChange(e.target.value)} /></InputGroup>
          </Field>
        )}</form.Field>
        <form.Field name="apiKey">{(f) => (
          <Field><FieldLabel>API Key (optional)</FieldLabel>
            <InputGroup><InputGroupInput type="password" placeholder="sk-…" value={f.state.value} onChange={(e) => f.handleChange(e.target.value)} /></InputGroup>
          </Field>
        )}</form.Field>
      </FieldGroup>
      <DialogFooter className="mt-4">
        <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
        <Button type="submit">{submitLabel}</Button>
      </DialogFooter>
    </form>
  );
}

function AddProviderDialog() {
  const [open, setOpen] = useState(false);
  const addProvider = useLlmProviderStore((s) => s.addProvider);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button><PlusIcon className="h-4 w-4 mr-2" />Add Provider</Button>} />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add LLM Provider</DialogTitle>
          <DialogDescription>Configure a new LLM endpoint</DialogDescription>
        </DialogHeader>
        <ProviderForm
          defaults={{ name: "", baseUrl: "", apiKey: "" }}
          onSubmit={(v) => {
            addProvider({ ...v, isDefault: false });
            track("llm_provider_added", {
              family: providerFamily(v.baseUrl),
              keyed: Boolean(v.apiKey),
            });
            toast.success("Provider added");
            setOpen(false);
          }}
          onCancel={() => setOpen(false)}
          submitLabel="Add Provider"
        />
      </DialogContent>
    </Dialog>
  );
}

function EditProviderDialogContent({ provider, onClose }: { provider: LlmProviderConfig; onClose: () => void }) {
  const updateProvider = useLlmProviderStore((s) => s.updateProvider);
  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Edit Provider</DialogTitle>
        <DialogDescription>Update provider configuration</DialogDescription>
      </DialogHeader>
      <ProviderForm
        defaults={{ name: provider.name, baseUrl: provider.baseUrl, apiKey: provider.apiKey }}
        onSubmit={(v) => { updateProvider(provider.id, v); toast.success("Provider updated"); onClose(); }}
        onCancel={onClose}
        submitLabel="Save"
      />
    </DialogContent>
  );
}
