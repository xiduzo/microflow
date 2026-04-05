import { useEffect, useState, useCallback } from 'react';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { isDesktop } from '@/lib/platform';
import { toast } from 'sonner';

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
    console.log('[updater] Checking for updates...');
    setState(s => ({ ...s, status: 'checking', error: null }));
    
    try {
      const update = await check();
      
      if (update) {
        console.log(`[updater] Update available: v${update.version}`);
        setState(s => ({ ...s, status: 'available', update }));
        toast.info(`Update v${update.version} available`, {
          description: 'A new version is ready to download.',
          action: {
            label: 'Update',
            onClick: () => {
              // Trigger download — the effect below will handle it
              setState(s => ({ ...s, status: 'downloading' }));
            },
          },
          duration: Infinity,
        });
        return update;
      } else {
        console.log('[updater] No updates available');
        setState(s => ({ ...s, status: 'idle', update: null }));
        return null;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to check for updates';
      console.error('[updater] Check failed:', message);
      setState(s => ({ ...s, status: 'error', error: message }));
      return null;
    }
  }, []);

  const downloadAndInstall = useCallback(async () => {
    if (!state.update) return;

    console.log('[updater] Downloading update...');
    setState(s => ({ ...s, status: 'downloading', progress: 0 }));

    const toastId = toast.loading('Downloading update...', { duration: Infinity });

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
          toast.loading(`Downloading update... ${percent}%`, { id: toastId, duration: Infinity });
        } else if (event.event === 'Finished') {
          setState(s => ({ ...s, status: 'ready', progress: 100 }));
        }
      });

      console.log('[updater] Download complete, ready to install');
      setState(s => ({ ...s, status: 'ready' }));
      toast.success('Update downloaded. Restart to apply.', {
        id: toastId,
        action: {
          label: 'Restart',
          onClick: () => void relaunch(),
        },
        duration: Infinity,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to download update';
      console.error('[updater] Download failed:', message);
      setState(s => ({ ...s, status: 'error', error: message }));
      toast.error('Update failed', { id: toastId, description: message });
    }
  }, [state.update]);

  const installAndRelaunch = useCallback(async () => {
    await relaunch();
  }, []);

  // Auto-download when user clicks "Update" from the toast
  useEffect(() => {
    if (state.status === 'downloading' && state.update && state.progress === 0) {
      downloadAndInstall();
    }
  }, [state.status, state.update, state.progress, downloadAndInstall]);

  // Check for updates on mount (only in Tauri desktop + production)
  useEffect(() => {
    const desktop = isDesktop();
    const prod = import.meta.env.PROD;
    console.log(`[updater] Init — desktop=${desktop}, prod=${prod}`);
    if (desktop && prod) {
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
