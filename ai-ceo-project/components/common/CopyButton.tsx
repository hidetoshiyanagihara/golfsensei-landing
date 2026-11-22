"use client";

import { useState } from "react";

/** 本文をコピーするボタン（note など、手で貼り付ける投稿先のため） */
export function CopyButton({ text, label = "本文をコピー" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 2000);
        } catch {
          setDone(false);
        }
      }}
      className="inline-flex items-center rounded-md border border-navy-700 px-3 py-1.5 text-sm text-fg hover:border-gold-dim"
    >
      {done ? "コピーしました" : label}
    </button>
  );
}
