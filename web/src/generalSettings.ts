import { useCallback, useEffect, useRef, useState } from "react";
import { DefaultGeneralSettings, type GeneralSettings } from "../../shared/types";
import { api } from "./api";

/**
 * 全体の設定（決算月など。共有PCに保存し全端末で共通）。
 * 読み込むまで・失敗したときは既定値を使う（年度の選択肢が出ないより、既定の年度で出るほうがよいため）。
 * save は画面に先に反映し、保存に失敗したら元に戻してエラーを投げる。
 */
export function useGeneralSettings(): {
  settings: GeneralSettings;
  save: (change: Partial<GeneralSettings>, userName: string) => Promise<void>;
} {
  const [settings, setSettings] = useState<GeneralSettings>(DefaultGeneralSettings);
  const current = useRef(settings);
  current.current = settings;

  useEffect(() => {
    let cancelled = false;
    api
      .generalSettings()
      .then((s) => !cancelled && setSettings(s))
      .catch(() => {
        // 既定値のまま
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const save = useCallback(async (change: Partial<GeneralSettings>, userName: string) => {
    const before = current.current;
    setSettings({ ...before, ...change });
    try {
      setSettings(await api.saveGeneralSettings(change, userName));
    } catch (e) {
      setSettings(before);
      throw e;
    }
  }, []);

  return { settings, save };
}
