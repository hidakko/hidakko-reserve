# ひだっこCAFE 予約システム（最小デモ）

## できること
- お客さん：仮予約 → 店側承認 → 確定通知（LINE push）
- お客さん：予約確認・変更・キャンセル（来店2日前 23:59まで）
- 店側：承認待ち一覧 / 承認 / お断り（デモ用PINで保護）
- 空席状況：日付×時間枠で表示（デフォルト枠あり）

## 事前準備（最低限）
- Firebase プロジェクト作成
- Firestore を有効化
- Hosting / Functions を有効化
- LINE Developers（Messaging API チャネル）で長期チャネルアクセストークンを発行

## 設定（Functionsの環境変数）
- ADMIN_PIN: 店側専用PIN（例：1234）
- LINE_CHANNEL_ACCESS_TOKEN: 長期チャネルアクセストークン

## デプロイ
```bash
npm i -g firebase-tools
firebase login
cd hidakko-reservation
firebase init   # Hosting と Functions を選択
cd functions && npm i
cd ..
firebase deploy --only hosting,functions
```

> 注意：本番運用は必ず「店側ページの認証（Firebase Auth + 権限）」を入れてください。
