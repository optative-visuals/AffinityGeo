// Keeps the store's area preview in step with the open project: re-read when the data, the sources or the
// projection change. Mount wherever a MapCanvas shows the area.
import { useEffect } from "react";
import { toast } from "../shell/Toast.js";
import { useApp } from "../store.js";

export function useAreaPreview(): void {
  const { project, counts, refreshPreview } = useApp();
  const key = project
    ? JSON.stringify([project.id, project.dataVersion, project.area.projectionId, project.area.projectionParams ?? null, counts])
    : "";
  useEffect(() => {
    if (!key) return;
    refreshPreview().catch((e) => toast(e instanceof Error ? e.message : String(e), "error"));
  }, [key, refreshPreview]);
}
