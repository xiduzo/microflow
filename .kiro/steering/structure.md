# Project Structure

## Monorepo Organization

The project follows a Yarn workspaces monorepo structure with clear separation between applications and shared packages.

```
microflow/
├── apps/                    # Main applications
│   ├── electron-app/        # Microflow Studio (Electron desktop app)
│   ├── figma-plugin/        # Microflow Hardware Bridge (Figma plugin)
│   └── nextjs-app/          # Documentation website
├── packages/                # Shared packages
│   ├── components/          # Hardware abstraction components
│   ├── flasher/             # Firmware flashing utilities
│   ├── mqtt-provider/       # MQTT communication layer
│   ├── socket/              # WebSocket communication
│   ├── ui/                  # Shared UI component library
│   ├── utils/               # Common utilities
│   └── test/                # Testing utilities
└── patches/                 # Package patches for dependencies
```

## Application Structure

### Microflow Studio (`apps/electron-app/`)
```
electron-app/
├── src/                     # Source code
├── assets/                  # Static assets
├── hex/                     # Firmware hex files
├── workers/                 # Web workers
├── vite.*.config.mjs        # Vite configuration files
├── forge.config.js          # Electron Forge configuration
└── tailwind.config.js       # TailwindCSS configuration
```

### Figma Plugin (`apps/figma-plugin/`)
```
figma-plugin/
├── src/                     # Plugin source code
├── scripts/                 # Build scripts
├── figma.manifest.ts        # Figma plugin manifest
├── vite.config.plugin.ts    # Plugin build config
└── vite.config.ui.ts        # UI build config
```

### Documentation Site (`apps/nextjs-app/`)
```
nextjs-app/
├── app/                     # Next.js app directory
├── components/              # Site-specific components
├── markdoc/                 # Markdoc configuration
├── public/                  # Static assets
└── next.config.mjs          # Next.js configuration
```

## Shared Packages Structure

### UI Package (`packages/ui/`)
- **Purpose**: Shared component library based on Radix UI and shadcn/ui
- **Exports**: Reusable React components with consistent styling
- **Dependencies**: Radix UI primitives, class-variance-authority, TailwindCSS

### Components Package (`packages/components/`)
- **Purpose**: Hardware abstraction layer and flow-based components
- **Dependencies**: Johnny-Five, LangChain for AI integration
- **Exports**: Hardware component abstractions

### Flasher Package (`packages/flasher/`)
- **Purpose**: Microcontroller firmware flashing utilities
- **Dependencies**: SerialPort, AVR programmers (chip.avr.avr109, stk500)
- **Exports**: Firmware flashing functions

### MQTT Provider (`packages/mqtt-provider/`)
- **Purpose**: MQTT communication abstraction
- **Dependencies**: MQTT.js
- **Exports**: MQTT client utilities and providers

## Naming Conventions

### Workspace Names
- Applications: `microflow-studio`, `microflow-hardware-bridge`, `nextjs-app`
- Packages: `@microflow/[package-name]` (scoped packages)

### File Structure Patterns
- **TypeScript**: Strict mode enabled, `.ts`/`.tsx` extensions
- **Configuration**: Root-level config files (tsconfig.json, tailwind.config.js)
- **Build Output**: `dist/` directories for compiled packages
- **Assets**: `assets/` or `public/` directories for static files

## Import Patterns

### Workspace Dependencies
```typescript
// Use workspace protocol in package.json
"@microflow/ui": "workspaces:*"

// Import from workspace packages
import { Button } from "@microflow/ui"
```

### Path Aliases
```typescript
// TypeScript path mapping for UI package
"paths": {
  "@ui/*": ["../../packages/ui/*"]
}
```

## Build Artifacts

### Development
- **Hot Reload**: Vite dev server for fast development
- **Concurrent Processes**: Multiple apps/packages can run simultaneously
- **Watch Mode**: TypeScript compilation in watch mode for packages

### Production
- **Electron**: Packaged as native desktop applications (.dmg, .exe, .deb, .rpm)
- **Figma Plugin**: Bundled as single-file plugin for Figma marketplace
- **Documentation**: Static site deployed to Vercel

## Configuration Files

### Root Level
- `package.json`: Workspace configuration and scripts
- `.yarnrc.yml`: Yarn configuration
- `yarn.lock`: Dependency lock file

### Per Application/Package
- `package.json`: Individual package configuration
- `tsconfig.json`: TypeScript configuration
- `tailwind.config.js`: TailwindCSS configuration (where applicable)
- Vite/build tool specific configs