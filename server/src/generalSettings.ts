import { DefaultGeneralSettings, isValidMonth, type GeneralSettings } from "../../shared/types.js";
import { ValidationError } from "./errors.js";
import type { Actor } from "./inventory.js";
import type { SettingsStore } from "./settingsStore.js";

const KEY = "general";

/** 設定の保存に必要な入力者の確認・監査ログ（InventoryService の一部だけに依存させる） */
export interface SettingsAuditor {
  requireUser(actor: Actor): string;
  recordSettingsChange(target: string, detail: string, actor: Actor): void;
}

/**
 * 全体の設定（決算月など）。値は app_settings に JSON で保存する。
 * 保存済みの値が壊れている・項目が足りない場合は、その項目だけ既定値で補う。
 */
export class GeneralSettingsService {
  constructor(
    private readonly store: Pick<SettingsStore, "get" | "set">,
    private readonly auditor: SettingsAuditor,
  ) {}

  get(): GeneralSettings {
    const raw = this.store.get(KEY);
    const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    return {
      fiscalYearEndMonth: isValidMonth(obj.fiscalYearEndMonth) ? obj.fiscalYearEndMonth : DefaultGeneralSettings.fiscalYearEndMonth,
    };
  }

  /** 省略した項目は変えない。変わった項目だけ監査ログに残す */
  save(raw: Record<string, unknown>, actor: Actor): GeneralSettings {
    const userName = this.auditor.requireUser(actor);
    const before = this.get();
    const after: GeneralSettings = { ...before };
    if (raw.fiscalYearEndMonth !== undefined) {
      if (!isValidMonth(raw.fiscalYearEndMonth)) {
        throw new ValidationError("決算月は 1〜12 の月を選んでください。");
      }
      after.fiscalYearEndMonth = raw.fiscalYearEndMonth;
    }
    if (after.fiscalYearEndMonth !== before.fiscalYearEndMonth) {
      this.store.set(KEY, after);
      this.auditor.recordSettingsChange("年度", `決算月: ${before.fiscalYearEndMonth}月 → ${after.fiscalYearEndMonth}月`, { ...actor, userName });
    }
    return after;
  }
}
