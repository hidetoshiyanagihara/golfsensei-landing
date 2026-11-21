/**
 * AI CEO PROJECT の新しいSNSアカウント開設キット（2026-11-22 代表者決定：新しくアカウントを作る）。
 *
 * ここに書く数字・事実は、記録済みのもの（2026-11-21 時点）だけ。
 * 【 】の部分は柳原さん自身の言葉で埋める（AIに書かせない部分。個性と実体験を残すため）。
 * アカウント名（@〜）が空いているかは、登録画面でしか確認できないため「候補」。
 */

export type Platform = "x" | "note" | "instagram" | "youtube";

export const ACCOUNTS = [
  { id: "ai-ceo", label: "AI CEO PROJECT" },
  { id: "axion", label: "AXION SALES" },
  { id: "copipe", label: "コピペAI仕事術" },
] as const;

export const PROFILES: { platform: Platform; label: string; handles: string[]; limit: number; name: string; bio: string }[] = [
  {
    platform: "x",
    label: "X",
    handles: ["ai_ceo_project", "aiceo_project", "aiceo_yanagi"],
    limit: 160,
    name: "柳原｜AI CEO PROJECT",
    bio: "人間1人とAI社員で、いくつもの事業を回す実験をしています。売上・失敗・改善をそのまま公開。2026年11月、売上0円からスタート。",
  },
  {
    platform: "note",
    label: "note",
    handles: ["aiceoproject", "ai_ceo_project"],
    limit: 400,
    name: "柳原｜AI CEO PROJECT",
    bio:
      "ONE HUMAN. MANY AI EMPLOYEES.\n人間1人とAIで、複数の収益事業を運営する実験をしています。\n\n・AI社員（CEO・市場調査・商品開発・マーケティング・販売・顧客対応・財務）の設計と運用\n・売上・利益・失敗をそのまま公開\n・実際に使ったAI営業・業務自動化の仕組みを商品にして販売予定\n\n2026年11月21日開始。売上0円から記録しています。",
  },
  {
    platform: "instagram",
    label: "Instagram",
    handles: ["ai.ceo.project", "aiceo.project", "ai_ceo_project"],
    limit: 150,
    name: "柳原｜AI CEO PROJECT",
    bio: "人間1人×AI社員で事業をつくる実験\n売上・失敗・改善を公開\n2026.11 売上0円からスタート\n↓ 記録はnoteで",
  },
  {
    platform: "youtube",
    label: "YouTube",
    handles: ["AICEOPROJECT", "aiceoproject"],
    limit: 1000,
    name: "AI CEO PROJECT｜柳原",
    bio:
      "人間1人とAI社員で、複数の事業を運営する実験チャンネルです。\nAI社員の作り方、AIで事業を立ち上げる過程、売上・失敗・改善を、数字ごと公開します。\n\n2026年11月、売上0円からスタート。\n誇張した数字や、やっていない実績は出しません。",
  },
];

export const SETUP_CHECKLIST: { platform: Platform; steps: string[] }[] = [
  {
    platform: "x",
    steps: [
      "x.com で新しいアカウントを作る（既存の AXION SALES とは別のメールアドレスか、Xの「アカウントを追加」）",
      "ユーザー名を候補から決める（空いていなければ別の候補）",
      "名前・自己紹介を下のプロフィール文で設定。リンク欄は note を作ったあとで入れる",
      "プロフィール画像：顔写真（顔出しOKの方針）",
    ],
  },
  {
    platform: "note",
    steps: [
      "note.com で新規登録し、クリエイター名・自己紹介を設定",
      "有料記事の販売に必要な「売上の振込先口座」を登録（販売開始前でOK）",
      "最初の記事は無料で公開（下の下書き）。有料記事は商品の品質検査に合格してから",
    ],
  },
  {
    platform: "instagram",
    steps: [
      "Instagram で新しいアカウントを作る（今の2アカウントとは別）",
      "プロのアカウント（クリエイター）に切り替える（数字が見られるようになる）",
      "自己紹介のリンクに note のURLを入れる",
    ],
  },
  {
    platform: "youtube",
    steps: [
      "YouTube で新しいチャンネルを作る（ブランドアカウント。AXION SALES のチャンネルとは別）",
      "チャンネル名・説明文・ハンドルを設定",
      "最初はショート（下の台本）から。長い動画は週2〜3本の体制ができてから",
    ],
  },
];

export type LaunchDraft = { ref: string; platform: Platform; title: string; body: string; dayOffset: number };

export const LAUNCH_DRAFTS: LaunchDraft[] = [
  {
    ref: "launch-kit:x-1",
    platform: "x",
    dayOffset: 1,
    title: "X①：はじめまして（固定ポスト）",
    body:
      "はじめまして、柳原です。\n\n「人間1人とAI社員で、いくつもの事業を回せるか」を本気で試します。\n\nCEO・市場調査・商品開発・マーケ・販売・顧客対応・財務。AI社員は7人、設計まで終わりました。\n\n売上は0円から。数字も失敗も、そのまま書いていきます。\n\n【なぜやるのか、柳原さん自身の言葉で1行】",
  },
  {
    ref: "launch-kit:x-2",
    platform: "x",
    dayOffset: 2,
    title: "X②：管理画面を作った話",
    body:
      "AI社員より先に、まず「社長室」を作りました。\n\n売上・利益・予算・AI社員の稼働・事業アイデア・商品・投稿・経営会議を1画面で見る管理画面。Claude Codeで作っています。\n\nこだわったのは1つだけ。\n実際の数字と、サンプルの数字を絶対に混ぜないこと。\n\n今の売上は、ちゃんと0円と表示されます。",
  },
  {
    ref: "launch-kit:x-3",
    platform: "x",
    dayOffset: 3,
    title: "X③：AIに守らせるルール",
    body:
      "AI社員に最初に教えたのは、仕事のやり方ではなく「やってはいけないこと」でした。\n\n・架空の売上や口コミを作らない\n・根拠のない数字を事実として書かない\n・お金と契約は勝手に決めない\n\nAIは、それっぽい数字を平気で作れてしまう。だから最初に縛ります。",
  },
  {
    ref: "launch-kit:note-1",
    platform: "note",
    dayOffset: 2,
    title: "note①：人間1人とAI社員で会社をつくる。売上0円からの記録をはじめます",
    body:
      "## はじめに\n【自己紹介。今やっていること（営業代行など）を、柳原さんの言葉で】\n\n## AI CEO PROJECT とは\n「ONE HUMAN. MANY AI EMPLOYEES.」\n人間は経営判断と創造に集中し、調査・制作・分析・改善はAIが担当する。そんな会社の運営が、本当にできるのかを試すプロジェクトです。\n\n## AI社員は7人\n- AI CEO：全体の統括、毎日の経営会議\n- 市場調査AI：市場・競合・需要の調査\n- 商品開発AI：商品の制作と品質チェック\n- マーケティングAI：投稿や記事の下書き\n- 販売戦略AI：価格や販売ページ\n- 顧客対応AI：よくある質問や問い合わせの整理\n- 財務分析AI：売上・費用・利益の集計\n\n現時点では「設計と管理画面の準備」まで。AIをAPIにつないで実際に動かすのは、これからです。\n\n## 決めたルール\n- 実在しない売上・顧客・口コミを作らない\n- 情報源のない数字を事実として書かない\n- 支払い・契約・広告は、必ず人間（私）が判断する\n- 予算の上限を超えそうなら、AIは自動で止まる\n\n月の運営予算は1〜3万円。お金をかけずに、どこまでできるかも含めて実験です。\n\n## 最初の商品\n中小企業・個人事業主向けの「AI営業自動化スターターキット」を作ります。営業のリサーチ、トーク、メール、商談の議事録、提案書づくりをAIで効率化する、実際に使えるテンプレートと手順書のセットです。\n\n品質チェックに合格するまでは売りません。完成したら、このnoteで販売します。\n\n## これから書くこと\n- AI社員を作って動かす過程\n- 売上・費用・利益（0円の月も含めて）\n- うまくいかなかったこと\n\n【最後に、読んでくれた人へ一言】",
  },
  {
    ref: "launch-kit:instagram-1",
    platform: "instagram",
    dayOffset: 3,
    title: "Instagram①：カルーセル（6枚）",
    body:
      "1枚目：人間1人とAI社員で、会社はつくれるのか。\n2枚目：AI社員は7人（CEO／市場調査／商品開発／マーケ／販売／顧客対応／財務）\n3枚目：人間がやるのは「決めること」と「つくること」だけ\n4枚目：AIに最初に教えたのは「やってはいけないこと」（架空の数字を作らない、お金は勝手に決めない）\n5枚目：スタート時点の売上は0円。ここから全部公開します\n6枚目：続きはnoteで（プロフィールのリンクから）\n\nキャプション：【1枚目の補足と、柳原さんがこれを始めた理由を2〜3行】\n#AI活用 #ひとり起業 #ClaudeCode #業務自動化",
  },
  {
    ref: "launch-kit:youtube-1",
    platform: "youtube",
    dayOffset: 4,
    title: "YouTubeショート①：台本（約40秒）",
    body:
      "（顔出し・正面）\n0〜3秒：「社員7人、全員AIです。」\n3〜12秒：「人間は僕1人。AIに会社の仕事を任せたら、本当に売上が立つのか。今日から実験します。」\n12〜25秒：（管理画面の画面録画）「これが社長室。売上、利益、予算、AI社員の動き。ちなみに今の売上は…0円です。」\n25〜35秒：「AIには、架空の数字を作らない、お金は勝手に使わない、というルールを最初に入れました。」\n35〜40秒：「売上も失敗も全部出します。続きはnoteで。」\n\n※画面録画に、実データ以外（サンプル表示ON）を映さないこと",
  },
];
