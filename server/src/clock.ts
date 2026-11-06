export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** サーバーのローカル時刻を "YYYY-MM-DD HH:mm:ss" で返す（文字列のまま並べ替えられる形式）。 */
export function formatLocal(date: Date): string {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}
