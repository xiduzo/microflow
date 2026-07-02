// Node data factories with required fields

export const buttonData = (pin = 2) => ({
  instance: "Button" as const,
  pin,
  isPullup: true,
  isPulldown: false,
  holdtime: 500,
  invert: false,
  group: "sense" as const,
  tags: ["trigger", "source"] as const,
  icon: "PointerIcon" as const,
  label: "Button",
  description: "Detect when a physical button is pressed or released",
});

export const ledData = (pin = 13) => ({
  instance: "Led" as const,
  pin,
  group: "express" as const,
  tags: ["action"] as const,
  label: "LED",
  icon: "LightbulbIcon" as const,
  description: "Turn a light on or off, or control its brightness",
});

export const intervalData = (interval = 1000) => ({
  instance: "Interval" as const,
  interval,
  autoStart: true,
  group: "generate" as const,
  tags: ["trigger", "source", "time-based"] as const,
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
  group: "sense" as const,
  tags: ["value", "source"] as const,
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
  group: "express" as const,
  tags: ["action"] as const,
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
  group: "shape" as const,
  tags: ["value"] as const,
  icon: "SeparatorVerticalIcon" as const,
  label: "Map",
  description: "Convert a number from one range to another",
});

export const servoData = (pin = 9) => ({
  instance: "Servo" as const,
  pin,
  range: { min: 0, max: 180 },
  type: "standard" as const,
  group: "express" as const,
  tags: ["action", "value"] as const,
  label: "Servo",
  icon: "RotateCwIcon" as const,
  description: "Control a motor that can move to specific positions",
});

export const compareNumberData = (subValidator: string, number: number) => ({
  instance: "Compare" as const,
  validator: "number" as const,
  subValidator,
  number,
  group: "decide" as const,
  tags: ["trigger", "logic"] as const,
  label: "Compare",
  icon: "ShieldCheckIcon" as const,
  description: "Check if a value meets certain conditions",
});

export const compareTextData = (subValidator: string, text: string) => ({
  instance: "Compare" as const,
  validator: "text" as const,
  subValidator,
  text,
  group: "decide" as const,
  tags: ["trigger", "logic"] as const,
  label: "Compare",
  icon: "ShieldCheckIcon" as const,
  description: "Check if text matches a condition",
});

export const gateData = (gate: "and" | "or" | "xor" | "nor" | "nand" | "xnor" = "and") => ({
  instance: "Gate" as const,
  gate,
  group: "decide" as const,
  tags: ["trigger", "logic", "stateful"] as const,
  label: "Gate",
  icon: "GitPullRequestClosedIcon" as const,
  description: "Combine multiple signals using logic rules",
});

export const smoothData = (type: "smooth" | "movingAverage" = "smooth", value = 0.995) => ({
  instance: type === "smooth" ? ("Smooth" as const) : ("MovingAverage" as const),
  type,
  ...(type === "smooth" ? { attenuation: value } : { windowSize: value }),
  group: "shape" as const,
  tags: ["value", "stateful"] as const,
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
  group: "decide" as const,
  tags: ["trigger", "logic", "time-based", "stateful"] as const,
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
  group: "shape" as const,
  tags: ["value"] as const,
  label: "Calculate",
  icon: "CalculatorIcon" as const,
  description: "Perform math operations on numbers",
});

export const constantData = (value = 1337) => ({
  instance: "Constant" as const,
  value,
  group: "generate" as const,
  tags: ["value", "source"] as const,
  label: "Constant",
  icon: "HashIcon" as const,
  description: "Provide a fixed number value",
});

export const rgbData = (pins = { red: 9, green: 10, blue: 11 }) => ({
  instance: "Rgb" as const,
  pins,
  isAnode: false,
  group: "express" as const,
  tags: ["action"] as const,
  label: "RGB LED",
  icon: "PaletteIcon" as const,
  description: "Control a colored light by mixing red, green, and blue",
});

export const relayData = (pin = 10, type: "NO" | "NC" = "NO") => ({
  instance: "Relay" as const,
  pin,
  type,
  group: "express" as const,
  tags: ["action"] as const,
  label: "Relay",
  icon: "ZapIcon" as const,
  description: "Control high-power devices safely",
});

export const switchData = (pin = 2, type: "NO" | "NC" = "NC") => ({
  instance: "Switch" as const,
  pin,
  type,
  group: "sense" as const,
  tags: ["trigger", "source"] as const,
  label: "Switch",
  icon: "ToggleLeftIcon" as const,
  description: "Detect when a switch is toggled",
});

export const proximityData = (pin = "A0", controller = "GP2Y0A21YK") => ({
  instance: "Proximity" as const,
  pin,
  controller,
  freq: 25,
  group: "sense" as const,
  tags: ["value", "source"] as const,
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
  group: "generate" as const,
  tags: ["value", "source", "time-based"] as const,
  label: "Oscillator",
  icon: "AudioWaveformIcon" as const,
  description: "Create repeating wave patterns",
});

export const motionData = (pin = 7) => ({
  instance: "Motion" as const,
  pin,
  controller: "HCSR501",
  group: "sense" as const,
  tags: ["trigger", "source"] as const,
  icon: "EyeIcon" as const,
  label: "Motion",
  description: "Detect when something moves nearby",
});

export const delayData = (delay = 500, forgetPrevious = false) => ({
  instance: "Delay" as const,
  delay,
  forgetPrevious,
  group: "decide" as const,
  tags: ["trigger", "time-based", "stateful"] as const,
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
  group: "express" as const,
  tags: ["action"] as const,
  label: "Piezo",
  icon: "BellIcon" as const,
  description: "Make sounds or play tones",
});

export const counterData = () => ({
  instance: "Counter" as const,
  group: "generate" as const,
  tags: ["value", "source", "stateful"] as const,
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
  group: "sense" as const,
  tags: ["action", "external"] as const,
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
  group: "sense" as const,
  tags: ["value", "source", "external"] as const,
  label: "MQTT",
  icon: "RadioTowerIcon" as const,
  description: "Subscribe to MQTT messages",
});

export const stepperData = (mode: "driver" | "four_wire" = "driver") => ({
  instance: "Stepper" as const,
  interface: mode,
  stepPin: 2,
  dirPin: 3,
  motorPin1: 4,
  motorPin2: 5,
  motorPin3: 6,
  motorPin4: 7,
  stepsPerRev: 200,
  speed: 200,
  acceleration: 100,
  deviceNum: 0,
  group: "express" as const,
  tags: ["action", "value"] as const,
  label: "Stepper",
  icon: "CogIcon" as const,
  description: "Control a stepper motor with precise positioning",
});

export const matrixData = (pins = { data: 2, clock: 3, cs: 4 }) => ({
  instance: "Matrix" as const,
  pins,
  shapes: [
    ["00000000", "00000000", "00000000", "00000000", "00000000", "00000000", "00000000", "00000000"],
    ["01100110", "10011001", "10000001", "10000001", "01000010", "00100100", "00011000", "00000000"],
    ["00111100", "01000010", "10100101", "10000001", "10100101", "10011001", "01000010", "00111100"],
  ],
  dims: "8x8",
  devices: 1,
  group: "express" as const,
  tags: ["action"] as const,
  label: "Matrix",
  icon: "GridIcon" as const,
  description: "Display patterns on an 8x8 LED matrix",
});

export const pixelData = (pin = 11, length = 8) => ({
  instance: "Pixel" as const,
  pin,
  length,
  controller: "FIRMATA" as const,
  skip_firmware_check: true,
  gamma: 2.8,
  color_order: "BRG" as const,
  presets: [
    ["#FF0000", "#FF0000", "#FF0000", "#FF0000", "#FF0000", "#FF0000", "#FF0000", "#FF0000"],
    ["#00FF00", "#00FF00", "#00FF00", "#00FF00", "#00FF00", "#00FF00", "#00FF00", "#00FF00"],
    ["#0000FF", "#0000FF", "#0000FF", "#0000FF", "#0000FF", "#0000FF", "#0000FF", "#0000FF"],
    ["#FF0000", "#FF7F00", "#FFFF00", "#00FF00", "#0000FF", "#4B0082", "#9400D3", "#FFFFFF"],
  ],
  group: "express" as const,
  tags: ["action"] as const,
  label: "Pixel Strip",
  icon: "SparklesIcon" as const,
  description: "Control a NeoPixel LED strip with color presets",
});
