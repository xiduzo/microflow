HUGE thanks to [avrgirl-arduino](https://github.com/noopkat/avrgirl-arduino) which is the foundation of this package.

## StandardFirmata

This package includes StandardFirmata version 2.5, which has been enhanced with software merged from [node-pixel](https://github.com/ajfisher/node-pixel/tree/master/firmware) to enable LED strip support (WS2812/NeoPixel).

## Compiling StandardFirmata for a Specific Board

To compile StandardFirmata for your specific Arduino board using the Arduino IDE:

1. **Install Arduino IDE**: Download and install the [Arduino IDE](https://www.arduino.cc/en/software) if you haven't already.

2. **Install Required Libraries**:

   - Open Arduino IDE and go to **Sketch → Include Library → Manage Libraries**
   - Search for and install:
     - **Firmata** (by Firmata Developers)
     - **Servo** (usually included by default)

3. **Open StandardFirmata.ino**:

   - Navigate to `packages/flasher/StandardFirmata/`
   - Open `StandardFirmata.ino` in the Arduino IDE

4. **Select Your Board**:

   - Go to **Tools → Board** and select your Arduino board (e.g., Arduino Uno, Arduino Nano, Arduino Mega, etc.)
   - If your board is not listed, you may need to install additional board support via **Tools → Board → Boards Manager**

5. **Select Port**:

   - Connect your Arduino board to your computer via USB
   - Go to **Tools → Port** and select the port your board is connected to

6. **Compile and Upload**:

   - Click the **Verify** button (checkmark icon) to compile the code
   - Once compilation succeeds, click the **Upload** button (arrow icon) to flash the firmware to your board
   - Wait for the upload to complete

7. **Verify Installation**:
   - The board should automatically reset after upload
   - You can verify the firmware is working by using any Firmata client library or the Microflow application

**Note**: Make sure all the supporting files (`lw_ws2812.h`, `lw_ws2812.cpp`, `ws2812.h`, `ws2812.cpp`, `light_ws2812.cpp`) are in the same directory as `StandardFirmata.ino` for the compilation to succeed.

## Extracting the Generated .hex File

After successfully compiling StandardFirmata in the Arduino IDE, you need to locate and extract the generated `.hex` file:

1. **Enable Verbose Output** (optional but helpful):

   - Go to **File → Preferences**
   - Check **"Show verbose output during: compilation"**
   - Click **OK**

2. **Compile the Sketch**:

   - Click the **Verify** button (checkmark icon) to compile
   - The compilation output will show the location of the temporary build folder

3. **Locate the .hex File**:

   - The compiled `.hex` file is stored in a temporary build folder
   - **Windows**: Usually in `%LOCALAPPDATA%\Temp\arduino\sketches\` or `%TEMP%\arduino\sketches\`
   - **macOS**: Usually in `/var/folders/.../T/arduino-sketch-XXXXXX/` or `~/Library/Arduino15/packages/.../build/`
   - **Linux**: Usually in `/tmp/arduino-sketch-XXXXXX/`
   - Look for a file named `StandardFirmata.ino.hex` in the build folder

4. **Alternative Method - Find Build Folder**:

   - After compiling, check the verbose output in the Arduino IDE console
   - Look for a line like: `"/path/to/build/folder/StandardFirmata.ino.hex"`
   - Copy the full path from the output

5. **Copy the .hex File**:
   - Copy the `.hex` file to a convenient location
   - You'll need this file when adding a new board to the project (see next section)

## Adding a New Board to the Project

To add support for a new Arduino board in this project, you need to:

1. **Create the Board Directory**:

   - Navigate to `packages/flasher/hex/`
   - Create a new folder with the board name (e.g., `my-board/`)
   - Use lowercase and hyphens for folder names (e.g., `pro-mini`, `sf-pro-micro`)

2. **Add the .hex File**:

   - Copy the compiled `.hex` file (from the previous section) into the new board folder
   - Rename it to `StandardFirmata.ino.hex` to match the naming convention used by other boards
   - Example: `packages/flasher/hex/my-board/StandardFirmata.ino.hex`

3. **Add Board Definition to constants.ts**:

   - Open `packages/flasher/src/constants.ts`
   - Add a new board object to the `BOARDS` array with the following properties:
     ```typescript
     {
       name: 'my-board',  // Must match the folder name
       baudRate: 115200,  // Serial communication baud rate (common: 57600, 115200)
       signature: Buffer.from([0x1e, 0x95, 0x0f]),  // AVR signature bytes (check datasheet)
       pageSize: 128,  // Flash page size in bytes (check datasheet)
       numPages: 256,  // Total number of flash pages (optional, for some boards)
       timeout: 400,   // Communication timeout in milliseconds
       productIds: ['0043', '7523'],  // USB product IDs (find via lsusb or system info)
       productPage: 'https://store.arduino.cc/my-board',  // Optional: product page URL
       protocol: Stk500v1,  // Protocol: Stk500v1, Stk500v2, or Avr109
     }
     ```

4. **Determine Board Properties**:

   - **Signature**: Check the AVR microcontroller datasheet (e.g., ATmega328P signature is `[0x1e, 0x95, 0x0f]`)
   - **Page Size**: Check the microcontroller datasheet (common: 64, 128, 256 bytes)
   - **Product IDs**: Use `lsusb` (Linux) or check System Information (macOS) to find USB vendor/product IDs
   - **Protocol**:
     - `Stk500v1`: Used by Uno, Nano (old bootloader), Duemilanove
     - `Stk500v2`: Used by Mega 2560
     - `Avr109`: Used by Leonardo, Micro, Yun (boards with native USB)

5. **Additional Properties** (for Stk500v2 protocol):

   ```typescript
   {
     // ... other properties ...
     delay1: 10,
     delay2: 1,
     stabDelay: 0x64,
     cmdexeDelay: 0x19,
     synchLoops: 0x20,
     byteDelay: 0x00,
     pollValue: 0x53,
     pollIndex: 0x03,
   }
   ```

6. **Test the New Board**:
   - After adding the board definition, you can test it using the flasher:
     ```typescript
     import { Flasher } from './src/Flasher';
     const flasher = new Flasher('my-board', '/dev/tty.usbmodemXXXX');
     await flasher.flash('packages/flasher/hex/my-board/StandardFirmata.ino.hex');
     ```

**Example**: See existing board definitions in `packages/flasher/src/constants.ts` for reference on how different boards are configured.
