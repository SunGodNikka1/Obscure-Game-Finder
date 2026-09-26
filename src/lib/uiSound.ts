/** Shared click / toggle feedback for the terminal UI. */
export const UI_SOUND_SRC = "/sounds/3553.m4a";

const POOL_SIZE = 8;
let pool: HTMLAudioElement[] | null = null;

function ensurePool(): HTMLAudioElement[] {
  if (pool) return pool;
  pool = Array.from({ length: POOL_SIZE }, () => {
    const audio = new Audio(UI_SOUND_SRC);
    audio.preload = "auto";
    return audio;
  });
  return pool;
}

export function primeUiSound(): void {
  if (typeof window === "undefined") return;
  ensurePool();
}

export function playUiSound(): void {
  if (typeof window === "undefined") return;
  const voices = ensurePool();
  const idle = voices.find((audio) => audio.paused || audio.ended);
  const audio = idle ?? voices[0];
  if (!audio) return;
  audio.currentTime = 0;
  void audio.play().catch(() => {
    /* autoplay policy or missing asset — ignore */
  });
}
