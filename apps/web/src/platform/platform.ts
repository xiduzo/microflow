/**
 * Platform detection utility for determining if the app is running in Tauri desktop or web browser
 */

// Cache the result to avoid repeated checks
let cachedIsDesktop: boolean | null = null;

/**
 * Checks if the application is running in a Tauri desktop environment
 * This function attempts multiple detection methods and caches the result.
 *
 * @returns true if running in Tauri desktop, false if running in web browser
 */
export function isDesktop(): boolean {
  // Return cached result if available
  if (cachedIsDesktop !== null) {
    return cachedIsDesktop;
  }

  try {
    // Check if we're in a browser environment first
    if (typeof window === "undefined") {
      cachedIsDesktop = false;
      return false;
    }

    const w = window as any;

    // Method 1: Check for __TAURI_INTERNALS__ (Tauri v2 - most reliable)
    // This is injected by Tauri into the window object
    if (w.__TAURI_INTERNALS__ !== undefined && w.__TAURI_INTERNALS__ !== null) {
      cachedIsDesktop = true;
      return true;
    }

    // Method 2: Check for __TAURI__ (Tauri v1 compatibility)
    if (w.__TAURI__ !== undefined && w.__TAURI__ !== null) {
      cachedIsDesktop = true;
      return true;
    }

    // Method 3: Check for ipc object (Tauri IPC bridge)
    if (w.ipc !== undefined && w.ipc !== null) {
      cachedIsDesktop = true;
      return true;
    }

    // Method 4: Check protocol - Tauri uses tauri:// in production builds
    if (window.location.protocol === "tauri:") {
      cachedIsDesktop = true;
      return true;
    }

    // Method 5: Check for __TAURI_INVOKE__ function
    if (typeof w.__TAURI_INVOKE__ === "function") {
      cachedIsDesktop = true;
      return true;
    }

    // If none of the above, we're in a web browser
    cachedIsDesktop = false;
    return false;
  } catch (error) {
    // If any error occurs, assume we're in a web browser
    console.debug("Platform detection error:", error);
    cachedIsDesktop = false;
    return false;
  }
}

/**
 * Reset the cached platform detection result.
 * Useful for testing or if the environment changes.
 */
export function resetPlatformCache(): void {
  cachedIsDesktop = null;
}
