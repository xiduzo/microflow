/** @jsxImportSource preact */
import { useState, useEffect, useCallback } from "preact/hooks";
import { Button, Textbox, VerticalSpace } from "@create-figma-plugin/ui";
import { mqttUrlSchema } from "@microflow/mqtt";
import { Dices, Info } from "lucide-react";
import { PageContent, PageHeader } from "../components/PageLayout";
import { useWindowSize } from "../hooks/use-window-size";
import { useAppStore, APP_STATE_KEY } from "../stores/app";
import { messages, sendToPlugin } from "../../common/messages";

export function MqttSettings() {
  const { mqttConfig, setMqttConfig } = useAppStore();

  const [url, setUrl] = useState(mqttConfig?.url ?? "test.mosquitto.org");
  const [username, setUsername] = useState(mqttConfig?.username ?? "");
  const [password, setPassword] = useState(mqttConfig?.password ?? "");
  const [uniqueId, setUniqueId] = useState(mqttConfig?.uniqueId ?? "");
  const [errors, setErrors] = useState<Record<string, string>>({});

  useWindowSize({ width: 350, height: 420 });

  useEffect(() => {
    if (!mqttConfig) return;
    setUrl(mqttConfig.url || "test.mosquitto.org");
    setUsername(mqttConfig.username ?? "");
    setPassword(mqttConfig.password ?? "");
    setUniqueId(mqttConfig.uniqueId ?? "");
  }, [mqttConfig]);

  const validate = useCallback(() => {
    const errs: Record<string, string> = {};
    const urlResult = mqttUrlSchema.safeParse(url);
    if (!urlResult.success) {
      errs.url = urlResult.error.issues[0]?.message ?? "Invalid URL";
    }
    if (!uniqueId || uniqueId.length < 5) {
      errs.uniqueId = "Minimum 5 characters";
    } else if (!/^[a-zA-Z_]+$/.test(uniqueId)) {
      errs.uniqueId = "Only letters and underscores";
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  }, [url, uniqueId]);

  function handleSubmit() {
    if (!validate()) return;
    const config = {
      url,
      username: username || undefined,
      password: password || undefined,
      uniqueId,
    };
    setMqttConfig(config);
    sendToPlugin(
      messages.setLocalState(APP_STATE_KEY, { state: { mqttConfig: config } }),
    );
    sendToPlugin(messages.showToast("Broker settings saved!"));
  }

  function generateRandomName() {
    const adjectives = ["swift", "bright", "calm", "bold", "keen", "warm", "cool", "wild"];
    const animals = ["fox", "owl", "bear", "wolf", "hawk", "deer", "lynx", "seal"];
    const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
    const animal = animals[Math.floor(Math.random() * animals.length)];
    setUniqueId(`${adj}_${animal}`);
    setErrors((e) => {
      const next = { ...e };
      delete next.uniqueId;
      return next;
    });
  }

  return (
    <>
      <PageHeader title="MQTT settings" />
      <PageContent>
        <div>
          <label style={{ fontSize: "11px", fontWeight: 600 }}>Identifier</label>
          <VerticalSpace space="extraSmall" />
          <div style={{ display: "flex", gap: 4 }}>
            <Textbox
              value={uniqueId}
              onInput={(e: any) => setUniqueId(e.currentTarget.value)}
              placeholder="your_unique_id"
              style={{ flex: 1 }}
            />
            <Button secondary onClick={generateRandomName}>
              <Dices size={14} />
            </Button>
          </div>
          {errors.uniqueId && (
            <div style={{ color: "#ef4444", fontSize: "11px", marginTop: 2 }}>
              {errors.uniqueId}
            </div>
          )}
          <div
            style={{
              fontSize: "11px",
              color: "var(--figma-color-text-secondary)",
              marginTop: 4,
            }}
          >
            Links this plugin with other MQTT clients like Microflow studio.
          </div>
        </div>

        <div>
          <label style={{ fontSize: "11px", fontWeight: 600 }}>Broker URL</label>
          <VerticalSpace space="extraSmall" />
          <Textbox
            value={url}
            onInput={(e: any) => setUrl(e.currentTarget.value)}
            placeholder="mqtt.xiduzo.com"
          />
          {errors.url && (
            <div style={{ color: "#ef4444", fontSize: "11px", marginTop: 2 }}>
              {errors.url}
            </div>
          )}
          <div
            style={{
              fontSize: "11px",
              color: "var(--figma-color-text-secondary)",
              marginTop: 4,
            }}
          >
            [protocol://]host[:port][/path]
          </div>
        </div>

        <div>
          <label style={{ fontSize: "11px", fontWeight: 600 }}>Username</label>
          <VerticalSpace space="extraSmall" />
          <Textbox
            value={username}
            onInput={(e: any) => setUsername(e.currentTarget.value)}
            placeholder="optional"
          />
        </div>

        <div>
          <label style={{ fontSize: "11px", fontWeight: 600 }}>Password</label>
          <VerticalSpace space="extraSmall" />
          <Textbox
            value={password}
            onInput={(e: any) => setPassword(e.currentTarget.value)}
            placeholder="optional"
            password
          />
        </div>

        <VerticalSpace space="extraSmall" />

        <Button fullWidth onClick={handleSubmit}>
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
