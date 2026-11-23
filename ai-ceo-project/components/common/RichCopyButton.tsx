"use client";

import { useState } from "react";

/**
 * 書式つきでコピー（HTML と 書式なしの文章の両方をクリップボードに入れる）。
 * note の編集画面に貼ると、見出し・太字・箇条書きなどが残る。HTMLのコピーができない環境では文章だけコピーする。
 */
export function RichCopyButton({ html, plain, label = "書式つきでコピー" }: { html: string; plain: string; label?: string }) {
  const [state, setState] = useState<"idle" | "rich" | "plain" | "error">("idle");
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
            await navigator.clipboard.write([
              new ClipboardItem({
                "text/html": new Blob([html], { type: "text/html" }),
                "text/plain": new Blob([plain], { type: "text/plain" }),
              }),
            ]);
            setState("rich");
          } else {
            await navigator.clipboard.writeText(plain);
            setState("plain");
          }
        } catch {
          try {
            await navigator.clipboard.writeText(plain);
            setState("plain");
          } catch {
            setState("error");
          }
        }
        setTimeout(() => setState("idle"), 2500);
      }}
      className="inline-flex items-center rounded-md bg-gold-strong px-3 py-1.5 text-sm font-medium text-ink hover:bg-gold"
    >
      {state === "rich" ? "書式つきでコピーしました" : state === "plain" ? "文章だけコピーしました" : state === "error" ? "コピーできませんでした" : label}
    </button>
  );
}
