// Node data factories with required fields

export const buttonData = (pin = 6) => ({
  instance: "Button" as const,
  pin,
  isPullup: true,
  isPulldown: false,
  holdtime: 500,
  invert: false,
  group: "hardware" as const,
  tags: ["input", "digital"] as const,
  icon: "PointerIcon" as const,
  label: "Button",
  description: "Detect when a physical button is pressed or released",
});

export const ledData = (pin = 13) => ({
  instance: "Led" as const,
  pin,
  group: "hardware" as const,
  tags: ["output", "analog", "digital"] as const,
  label: "LED",
  icon: "LightbulbIcon" as const,
  description: "Turn a light on or off, or control its brightness",
});

export const intervalData = (interval = 1000) => ({
  instance: "Interval" as const,
  interval,
  autoStart: true,
  group: "flow" as const,
  tags: ["event", "generator"] as const,
  label: "Interval",
  icon: "TimerIcon" as const,
  description: "Automatically send a signal at regular time intervals",
});

export const sensorData = (pin = "A0") => ({
  instance: "Sensor" as const,
  pin,
  type: "analog" as const,
  freq: 25,
  threshold: 1,
  group: "hardware" as const,
  tags: ["input", "analog"] as const,
  label: "Analog Sensor",
  icon: "GaugeIcon" as const,
  description: "Measure values that change smoothly",
});

export const potentiometerData = (pin = "A0") => ({
  ...sensorData(pin),
  subType: "potentiometer",
  label: "Potentiometer",
  icon: "CircleArrowOutUpLeftIcon" as const,
  description: "Read values from a knob or slider",
});

export const ldrData = (pin = "A0") => ({
  ...sensorData(pin),
  subType: "ldr",
  label: "Light Sensor (LDR)",
  icon: "SunIcon" as const,
  description: "Measure ambient light levels",
});

export const monitorData = (type: "graph" | "raw" = "graph") => ({
  instance: "Monitor" as const,
  type,
  fps: 60,
  group: "flow" as const,
  tags: ["information", "output"] as const,
  label: "Monitor",
  icon: "MonitorIcon" as const,
  description: "Watch and visualize values in real-time",
});

export const rangeMapData = (
  from = { min: 0, max: 1023 },
  to = { min: 0, max: 180 },
) => ({
  instance: "RangeMap" as const,
  from,
  to,
  group: "flow" as const,
  tags: ["transformation"] as const,
  icon: "SeparatorVerticalIcon" as const,
  label: "Map",
  description: "Convert a number from one range to another",
});

export const servoData = (pin = 9) => ({
  instance: "Servo" as const,
  pin,
  range: { min: 0, max: 180 },
  type: "standard" as const,
  group: "hardware" as const,
  tags: ["output", "analog"] as const,
  label: "Servo",
  icon: "RotateCwIcon" as const,
  description: "Control a motor that can move to specific positions",
});

export const compareNumberData = (subValidator: string, number: number) => ({
  instance: "Compare" as const,
  validator: "number" as const,
  subValidator,
  number,
  group: "flow" as const,
  tags: ["control"] as const,
  label: "Compare",
  icon: "ShieldCheckIcon" as const,
  description: "Check if a value meets certain conditions",
});

export const compareTextData = (subValidator: string, text: string) => ({
  instance: "Compare" as const,
  validator: "text" as const,
  subValidator,
  text,
  group: "flow" as const,
  tags: ["control"] as const,
  label: "Compare",
  icon: "ShieldCheckIcon" as const,
  description: "Check if text matches a condition",
});

export const gateData = (gate: "and" | "or" | "xor" | "nor" | "nand" | "xnor" = "and") => ({
  instance: "Gate" as const,
  gate,
  group: "flow" as const,
  tags: ["control"] as const,
  label: "Gate",
  icon: "GitPullRequestClosedIcon" as const,
  description: "Combine multiple signals using logic rules",
});

export const smoothData = (type: "smooth" | "movingAverage" = "smooth", value = 0.995) => ({
  instance: type === "smooth" ? ("Smooth" as const) : ("MovingAverage" as const),
  type,
  ...(type === "smooth" ? { attenuation: value } : { windowSize: value }),
  group: "flow" as const,
  tags: ["transformation"] as const,
  label: "Smooth",
  icon: "EraserIcon" as const,
  description: "Make sensor readings smoother and more stable",
});

export const triggerData = (
  behaviour: "increasing" | "decreasing" = "decreasing",
  threshold = 5,
  within = 250,
) => ({
  instance: "Trigger" as const,
  relative: false,
  behaviour,
  threshold,
  within,
  group: "flow" as const,
  tags: ["event", "control"] as const,
  label: "Trigger",
  icon: "TrendingUpIcon" as const,
  description: "Detect sudden changes in values",
});

export const calculateData = (
  fn:
    | "add"
    | "subtract"
    | "multiply"
    | "divide"
    | "modulo"
    | "max"
    | "min"
    | "pow"
    | "ceil"
    | "floor"
    | "round" = "add",
) => ({
  instance: "Calculate" as const,
  function: fn,
  group: "flow" as const,
  tags: ["transformation"] as const,
  label: "Calculate",
  icon: "CalculatorIcon" as const,
  description: "Perform math operations on numbers",
});

export const constantData = (value = 1337) => ({
  instance: "Constant" as const,
  value,
  group: "flow" as const,
  tags: ["generator"] as const,
  label: "Constant",
  icon: "HashIcon" as const,
  description: "Provide a fixed number value",
});

export const rgbData = (pins = { red: 9, green: 10, blue: 11 }) => ({
  instance: "Rgb" as const,
  pins,
  isAnode: false,
  group: "hardware" as const,
  tags: ["output", "analog"] as const,
  label: "RGB LED",
  icon: "PaletteIcon" as const,
  description: "Control a colored light by mixing red, green, and blue",
});

export const relayData = (pin = 10, type: "NO" | "NC" = "NO") => ({
  instance: "Relay" as const,
  pin,
  type,
  group: "hardware" as const,
  tags: ["output", "analog", "digital"] as const,
  label: "Relay",
  icon: "ZapIcon" as const,
  description: "Control high-power devices safely",
});

export const switchData = (pin = 2, type: "NO" | "NC" = "NC") => ({
  instance: "Switch" as const,
  pin,
  type,
  group: "hardware" as const,
  tags: ["input", "digital"] as const,
  label: "Switch",
  icon: "ToggleLeftIcon" as const,
  description: "Detect when a switch is toggled",
});

export const proximityData = (pin = "A0", controller = "GP2Y0A21YK") => ({
  instance: "Proximity" as const,
  pin,
  controller,
  freq: 25,
  group: "hardware" as const,
  tags: ["input", "analog"] as const,
  label: "Proximity",
  icon: "TargetIcon" as const,
  description: "Measure distance to objects",
});

export const oscillatorData = (waveform = "sinus", period = 2000) => ({
  instance: "Oscillator" as const,
  waveform,
  period,
  amplitude: 127,
  phase: 0,
  shift: 128,
  autoStart: true,
  group: "flow" as const,
  tags: ["generator", "event"] as const,
  label: "Oscillator",
  icon: "AudioWaveformIcon" as const,
  description: "Create repeating wave patterns",
});

export const motionData = (pin = 7) => ({
  instance: "Motion" as const,
  pin,
  controller: "HCSR501",
  group: "hardware" as const,
  tags: ["input", "digital"] as const,
  icon: "EyeIcon" as const,
  label: "Motion",
  description: "Detect when something moves nearby",
});

export const delayData = (delay = 500) => ({
  instance: "Delay" as const,
  delay,
  forgetPrevious: false,
  group: "flow" as const,
  tags: ["control", "event"] as const,
  label: "Delay",
  icon: "SnailIcon" as const,
  description: "Wait before sending a signal forward",
});

export const piezoData = (pin = 8) => ({
  instance: "Piezo" as const,
  pin,
  type: "buzz" as const,
  duration: 500,
  frequency: 440,
  group: "hardware" as const,
  tags: ["output", "analog", "digital"] as const,
  label: "Piezo",
  icon: "BellIcon" as const,
  description: "Make sounds or play tones",
});

export const counterData = () => ({
  instance: "Counter" as const,
  group: "flow" as const,
  tags: ["control", "information"] as const,
  label: "Counter",
  icon: "Tally5Icon" as const,
  description: "Keep track of a number",
});

export const mqttPublishData = (topic: string) => ({
  instance: "Mqtt" as const,
  direction: "publish" as const,
  brokerId: "",
  topic,
  qos: "1" as const,
  retain: false,
  group: "external" as const,
  tags: ["input", "output"] as const,
  label: "MQTT",
  icon: "RadioTowerIcon" as const,
  description: "Publish messages over MQTT",
});

export const mqttSubscribeData = (topic: string) => ({
  instance: "Mqtt" as const,
  direction: "subscribe" as const,
  brokerId: "",
  topic,
  qos: "1" as const,
  retain: false,
  group: "external" as const,
  tags: ["input", "output"] as const,
  label: "MQTT",
  icon: "RadioTowerIcon" as const,
  description: "Subscribe to MQTT messages",
});
