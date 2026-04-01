import { useState, useEffect, useCallback } from "react";
import { mqttUrlSchema } from "@microflow/mqtt";
import { Dices, Info } from "lucide-react";
import { PageContent, PageHeader } from "../components/PageLayout";
import { useAppStore, APP_STATE_KEY } from "../stores/app";
import { messages, sendToPlugin } from "../../common/messages";

export function MqttSettings() {
  const { mqttConfig, setMqttConfig } = useAppStore();

  const [url, setUrl] = useState(mqttConfig?.url ?? "test.mosquitto.org");
  const [username, setUsername] = useState(mqttConfig?.username ?? "");
  const [password, setPassword] = useState(mqttConfig?.password ?? "");
  const [uniqueId, setUniqueId] = useState(mqttConfig?.uniqueId ?? "");
  const [errors, setErrors] = useState<Record<string, string>>({});

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
          <label className="text-[11px] font-semibold text-gray-900 dark:text-gray-100">
            Identifier
          </label>
          <div className="mt-1 flex gap-1">
            <input
              type="text"
              value={uniqueId}
              onChange={(e) => setUniqueId(e.target.value)}
              placeholder="your_unique_id"
              className="flex-1 rounded border border-gray-300 bg-white px-2 py-1 text-[13px] outline-none focus:border-blue-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
            />
            <button
              type="button"
              onClick={generateRandomName}
              className="flex h-8 w-8 items-center justify-center rounded border border-gray-300 hover:bg-gray-100 dark:border-gray-600 dark:hover:bg-gray-700"
              title="Generate random name"
            >
              <Dices size={14} />
            </button>
          </div>
          {errors.uniqueId && (
            <p className="mt-0.5 text-[11px] text-red-500">{errors.uniqueId}</p>
          )}
          <p className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">
            Links this plugin with other MQTT clients like Microflow studio.
          </p>
        </div>

        <div>
          <label className="text-[11px] font-semibold text-gray-900 dark:text-gray-100">
            Broker URL
          </label>
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="mqtt.xiduzo.com"
            className="mt-1 w-full rounded border border-gray-300 bg-white px-2 py-1 text-[13px] outline-none focus:border-blue-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
          />
          {errors.url && (
            <p className="mt-0.5 text-[11px] text-red-500">{errors.url}</p>
          )}
          <p className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">
            [protocol://]host[:port][/path]
          </p>
        </div>

        <div>
          <label className="text-[11px] font-semibold text-gray-900 dark:text-gray-100">
            Username
          </label>
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="optional"
            className="mt-1 w-full rounded border border-gray-300 bg-white px-2 py-1 text-[13px] outline-none focus:border-blue-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
          />
        </div>

        <div>
          <label className="text-[11px] font-semibold text-gray-900 dark:text-gray-100">
            Password
          </label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="optional"
            className="mt-1 w-full rounded border border-gray-300 bg-white px-2 py-1 text-[13px] outline-none focus:border-blue-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
          />
        </div>

        <button
          type="button"
          onClick={handleSubmit}
          className="mt-1 w-full rounded bg-blue-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-blue-700"
        >
          Save MQTT settings
        </button>

        <p className="text-[11px] text-blue-500">
          <Info size={12} className="mr-1 inline align-middle" />
          Use <code>wss://</code> protocol for encrypted connections.
        </p>
      </PageContent>
    </>
  );
}
