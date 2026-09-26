/** @jsxImportSource preact */
import { Button, Textbox, VerticalSpace } from "@create-figma-plugin/ui";
import { storedMqttConfig, useAppStore, useMqttSettingsForm } from "@microflow/design-bridge/react";
import type { MqttConfig } from "@microflow/mqtt";
import { Dices, Info } from "lucide-react";
import type { ComponentChildren } from "preact";
import { useCallback } from "preact/hooks";
import { settingsStorage, showToast } from "../channel";
import { PageContent, PageHeader } from "../components/PageLayout";
import { useWindowSize } from "../hooks/use-window-size";

export function MqttSettings() {
  const { setMqttConfig } = useAppStore();
  const onSave = useCallback(
    (config: MqttConfig) => {
      setMqttConfig(config);
      settingsStorage.save(storedMqttConfig(config));
      showToast("Broker settings saved!");
    },
    [setMqttConfig],
  );
  const { fields, errors, setField, randomizeId, submit } = useMqttSettingsForm(onSave);

  useWindowSize({ width: 350, height: 440 });

  return (
    <>
      <PageHeader title="MQTT settings" />
      <PageContent>
        <Field
          label="Bridge ID"
          error={errors.uniqueId}
          hint="Must match the Bridge ID shown in Microflow Studio."
        >
          <div style={{ display: "flex", gap: 4 }}>
            <Textbox
              value={fields.uniqueId}
              onValueInput={(value) => setField("uniqueId", value)}
              placeholder="your_bridge_id"
              style={{ flex: 1 }}
            />
            <Button secondary onClick={randomizeId}>
              <Dices size={14} />
            </Button>
          </div>
        </Field>

        <Field label="Broker URL" error={errors.url} hint="[protocol://]host[:port][/path]">
          <Textbox
            value={fields.url}
            onValueInput={(value) => setField("url", value)}
            placeholder="mqtt.xiduzo.com"
          />
        </Field>

        <Field label="Username">
          <Textbox
            value={fields.username}
            onValueInput={(value) => setField("username", value)}
            placeholder="optional"
          />
        </Field>

        <Field label="Password">
          <Textbox
            value={fields.password}
            onValueInput={(value) => setField("password", value)}
            placeholder="optional"
            password
          />
        </Field>

        <VerticalSpace space="extraSmall" />

        <Button fullWidth onClick={submit}>
          Save MQTT settings
        </Button>

        <div style={{ fontSize: "11px", color: "#3b82f6" }}>
          <Info size={12} style={{ display: "inline", verticalAlign: "middle", marginRight: 4 }} />
          Use <code>wss://</code> protocol for encrypted connections.
        </div>
      </PageContent>
    </>
  );
}

function Field(props: {
  label: string;
  error?: string;
  hint?: string;
  children: ComponentChildren;
}) {
  return (
    <div>
      <label style={{ fontSize: "11px", fontWeight: 600 }}>{props.label}</label>
      <VerticalSpace space="extraSmall" />
      {props.children}
      {props.error && (
        <div style={{ color: "#ef4444", fontSize: "11px", marginTop: 2 }}>{props.error}</div>
      )}
      {props.hint && (
        <div
          style={{
            fontSize: "11px",
            color: "var(--figma-color-text-secondary)",
            marginTop: 4,
          }}
        >
          {props.hint}
        </div>
      )}
    </div>
  );
}
