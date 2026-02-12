import { useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

interface UpdateBannerProps {
  update: Update;
  onDismiss: () => void;
}

export function UpdateBanner({ update, onDismiss }: UpdateBannerProps) {
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);

  const handleInstall = async () => {
    setInstalling(true);
    setProgress("Downloading...");
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started" && event.data.contentLength) {
          setProgress(`Downloading (${Math.round(event.data.contentLength / 1024)} KB)...`);
        } else if (event.event === "Finished") {
          setProgress("Restarting...");
        }
      });
      await relaunch();
    } catch (e) {
      console.error("Update install failed:", e);
      setInstalling(false);
      setProgress(null);
    }
  };

  return (
    <div className="flex items-center justify-between px-4 py-2 bg-blue-600 text-white text-xs">
      <span>
        {installing
          ? progress
          : `v${update.version} is available`}
      </span>
      {!installing && (
        <div className="flex items-center gap-2">
          <button
            onClick={handleInstall}
            className="px-2 py-0.5 rounded bg-white text-blue-600 font-medium hover:bg-blue-50 transition-colors"
          >
            Update
          </button>
          <button
            onClick={onDismiss}
            className="text-blue-200 hover:text-white transition-colors"
          >
            Later
          </button>
        </div>
      )}
    </div>
  );
}

/** Check for an available update. Returns the Update object if one exists, null otherwise. */
export async function checkForUpdate(): Promise<Update | null> {
  try {
    const update = await check();
    return update ?? null;
  } catch (e) {
    console.error("Update check failed:", e);
    return null;
  }
}
