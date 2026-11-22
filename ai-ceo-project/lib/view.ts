import { cookies } from "next/headers";
import type { View } from "./database/repo";

export const SAMPLE_COOKIE = "cc_show_sample";

/** 画面に出すデータの種類。「サンプル表示」をONにしたときだけ sample を混ぜる */
export async function getView(): Promise<View & { showSample: boolean }> {
  const showSample = (await cookies()).get(SAMPLE_COOKIE)?.value === "1";
  return { kinds: showSample ? ["actual", "sample"] : ["actual"], showSample };
}
