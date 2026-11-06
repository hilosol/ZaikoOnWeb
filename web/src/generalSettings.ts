import { useCallback, useEffect, useState } from "react";
import { DefaultGeneralSettings, type GeneralSettings } from "../../shared/types";
import { api } from "./api";

/**
 * 全体の設定（決算月など）を読み込む。読み込むまで・失敗したときは既定値を使う
 * （履歴ページの年度の選択肢が出ないより、既定の年度で出るほうがよいため）。
 */
export function useGeneralSettings(): { settings: GeneralSettings; loaded: boolean; reload: () => Promise<void> } {
  const [settings, setSettings] = useState<GeneralSettings>(DefaultGeneralSettings);
  const [loaded, setLoaded] = useState(false);
  const reload = useCallback(async () => {
    try {
      setSettings(await api.generalSettings());
    } catch {
      // 既定値のまま
    } finally {
      setLoaded(true);
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { settings, loaded, reload };
}
