import {
  DEFAULT_BROKER_URL,
  storedMqttConfig,
  useAppStore,
  useMqttSettingsForm,
} from "@microflow/design-bridge/react";
import type { MqttConfig } from "@microflow/mqtt";
import { Dices, Info } from "lucide-react";
import { type ReactNode, useCallback } from "react";
import { storage } from "../channel";
import { PageContent, PageHeader } from "../components/PageLayout";
import { toast } from "../components/Toast";

const INPUT =
  "w-full rounded border border-gray-300 bg-white px-2 py-1 text-[13px] outline-none focus:border-blue-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white";

function Field(props: { label: string; htmlFor: string; error?: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={props.htmlFor} className="text-[11px] font-semibold text-gray-900 dark:text-gray-100">
        {props.label}
      </label>
      <div className="mt-1 flex gap-1">{props.children}</div>
      {props.error && <p className="mt-0.5 text-[11px] text-red-500">{props.error}</p>}
      {props.hint && <p className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">{props.hint}</p>}
    </div>
  );
}

export function MqttSettings() {
  const { setMqttConfig } = useAppStore();

  const save = useCallback(
    (config: MqttConfig) => {
      setMqttConfig(config);
      try {
        storage.save(storedMqttConfig(config));
        toast("Broker settings saved");
      } catch {
        toast("Connected, but the settings could not be stored", { error: true });
      }
    },
    [setMqttConfig],
  );

  const { fields, errors, setField, randomizeId, submit } = useMqttSettingsForm(save);

  return (
    <>
      <PageHeader title="MQTT settings" />
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <PageContent>
          <Field
            label="Bridge ID"
            htmlFor="bridge-id"
            error={errors.uniqueId}
            hint="Must match the Bridge ID shown in Microflow Studio."
          >
            <input
              id="bridge-id"
              type="text"
              value={fields.uniqueId}
              onChange={(event) => setField("uniqueId", event.target.value)}
              placeholder="calm_lynx_4821"
              autoComplete="off"
              spellCheck={false}
              className={INPUT}
            />
            <button
              type="button"
              onClick={randomizeId}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded border border-gray-300 hover:bg-gray-100 dark:border-gray-600 dark:hover:bg-gray-700"
              title="Generate a random Bridge ID"
              aria-label="Generate a random Bridge ID"
            >
              <Dices size={14} />
            </button>
          </Field>

          <Field label="Broker URL" htmlFor="broker-url" error={errors.url} hint="[protocol://]host[:port][/path]">
            <input
              id="broker-url"
              type="text"
              value={fields.url}
              onChange={(event) => setField("url", event.target.value)}
              placeholder={DEFAULT_BROKER_URL}
              spellCheck={false}
              className={INPUT}
            />
          </Field>

          <Field label="Username" htmlFor="username">
            <input
              id="username"
              type="text"
              value={fields.username}
              onChange={(event) => setField("username", event.target.value)}
              placeholder="optional"
              autoComplete="off"
              className={INPUT}
            />
          </Field>

          <Field label="Password" htmlFor="password">
            <input
              id="password"
              type="password"
              value={fields.password}
              onChange={(event) => setField("password", event.target.value)}
              placeholder="optional"
              autoComplete="off"
              className={INPUT}
            />
          </Field>

          <button
            type="submit"
            className="mt-1 w-full rounded bg-blue-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-blue-700"
          >
            Save MQTT settings
          </button>

          <p className="text-[11px] text-blue-500">
            <Info size={12} className="mr-1 inline align-middle" />
            Use <code>wss://</code> for encrypted connections.
          </p>
        </PageContent>
      </form>
    </>
  );
}
