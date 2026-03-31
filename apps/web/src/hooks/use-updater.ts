import { useEffect, useState, useCallback } from 'react';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { isDesktop } from '@/lib/platform';

type UpdateStatus = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error';

interface UpdaterState {
  status: UpdateStatus;
  update: Update | null;
  progress: number;
  error: string | null;
}

export function useUpdater() {
  const [state, setState] = useState<UpdaterState>({
    status: 'idle',
    update: null,
    progress: 0,
    error: null,
  });

  const checkForUpdates = useCallback(async () => {
    setState(s => ({ ...s, status: 'checking', error: null }));
    
    try {
      const update = await check();
      
      if (update) {
        setState(s => ({ ...s, status: 'available', update }));
        return update;
      } else {
        setState(s => ({ ...s, status: 'idle', update: null }));
        return null;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to check for updates';
      setState(s => ({ ...s, status: 'error', error: message }));
      return null;
    }
  }, []);

  const downloadAndInstall = useCallback(async () => {
    if (!state.update) return;

    setState(s => ({ ...s, status: 'downloading', progress: 0 }));

    try {
      let contentLength = 0;
      let downloaded = 0;

      await state.update.downloadAndInstall((event) => {
        if (event.event === 'Started') {
          contentLength = event.data.contentLength ?? 0;
          setState(s => ({ ...s, progress: 0 }));
        } else if (event.event === 'Progress') {
          downloaded += event.data.chunkLength;
          const percent = contentLength > 0 ? Math.round((downloaded / contentLength) * 100) : 0;
          setState(s => ({ ...s, progress: percent }));
        } else if (event.event === 'Finished') {
          setState(s => ({ ...s, status: 'ready', progress: 100 }));
        }
      });

      setState(s => ({ ...s, status: 'ready' }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to download update';
      setState(s => ({ ...s, status: 'error', error: message }));
    }
  }, [state.update]);

  const installAndRelaunch = useCallback(async () => {
    await relaunch();
  }, []);

  // Check for updates on mount (only in Tauri desktop + production)
  useEffect(() => {
    if (isDesktop() && import.meta.env.PROD) {
      checkForUpdates();
    }
  }, [checkForUpdates]);

  return {
    ...state,
    checkForUpdates,
    downloadAndInstall,
    installAndRelaunch,
  };
}
