export type I2cPreset = {
  label: string;
  address: number;
  register: number;
  readLength: number;
  output: "raw" | "unsigned_int" | "signed_int";
  description: string;
};

export const I2C_PRESETS: Record<string, I2cPreset> = {
  custom: {
    label: "Custom",
    address: 0x48,
    register: 0x00,
    readLength: 2,
    output: "unsigned_int",
    description: "Manual I2C configuration",
  },
  ads1115: {
    label: "ADS1115",
    address: 0x48,
    register: 0x00,
    readLength: 2,
    output: "signed_int",
    description: "16-bit ADC",
  },
  bh1750: {
    label: "BH1750",
    address: 0x23,
    register: 0x10,
    readLength: 2,
    output: "unsigned_int",
    description: "Light sensor (lux)",
  },
  bme280_temp: {
    label: "BME280 (temp)",
    address: 0x76,
    register: 0xfa,
    readLength: 3,
    output: "unsigned_int",
    description: "Temperature sensor",
  },
  bme280_humidity: {
    label: "BME280 (humidity)",
    address: 0x76,
    register: 0xfd,
    readLength: 2,
    output: "unsigned_int",
    description: "Humidity sensor",
  },
  mpu6050: {
    label: "MPU6050",
    address: 0x68,
    register: 0x3b,
    readLength: 6,
    output: "raw",
    description: "Accelerometer/Gyro XYZ",
  },
  vl53l0x: {
    label: "VL53L0X",
    address: 0x29,
    register: 0x14,
    readLength: 2,
    output: "unsigned_int",
    description: "Distance sensor (mm)",
  },
} as const;

export const I2C_DEVICE_OPTIONS = Object.fromEntries(
  Object.entries(I2C_PRESETS).map(([key, preset]) => [key, preset.label]),
);

export const I2C_OUTPUT_OPTIONS = {
  raw: "Raw bytes",
  unsigned_int: "Unsigned int",
  signed_int: "Signed int",
} as const;
