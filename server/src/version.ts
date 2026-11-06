/** ビルド日時のバージョン。tsx での開発時・テスト時は埋め込まれないため "開発版" */
export const APP_VERSION: string = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "開発版";
