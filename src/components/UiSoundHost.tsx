"use client";

import { useEffect } from "react";
import { playUiSound, primeUiSound } from "@/lib/uiSound";

function silenced(from: EventTarget | null): boolean {
  return from instanceof Element && Boolean(from.closest("[data-ui-sound='off']"));
}

/** Innermost control that should emit the shared UI click sound. */
export function uiSoundClickTarget(from: EventTarget | null): Element | null {
  if (!(from instanceof Element) || silenced(from)) return null;

  const button = from.closest("button");
  if (button && !button.disabled) return button;

  const actionLink = from.closest("a.btn");
  if (actionLink) return actionLink;

  if (from.closest("button, a.btn")) return null;

  const row = from.closest('[role="button"]');
  if (row) return row;

  return null;
}

function uiSoundChangeTarget(from: EventTarget | null): Element | null {
  if (!(from instanceof Element) || silenced(from)) return null;
  if (from.matches("select")) return from;
  if (from.matches('input[type="range"]')) return from;
  return null;
}

export function UiSoundHost() {
  useEffect(() => {
    primeUiSound();

    const onClick = (event: MouseEvent) => {
      if (event.button !== 0) return;
      if (uiSoundClickTarget(event.target)) playUiSound();
    };

    const onChange = (event: Event) => {
      if (uiSoundChangeTarget(event.target)) playUiSound();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      if (event.defaultPrevented) return;
      const target = event.target;
      if (!(target instanceof Element) || silenced(target)) return;
      if (target.closest("button, a.btn, select, input")) return;
      const row = target.closest('[role="button"]');
      if (row) playUiSound();
    };

    document.addEventListener("click", onClick, true);
    document.addEventListener("change", onChange, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("change", onChange, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, []);

  return null;
}
