# 打順・守備交代プランナー v10

少年野球向けのスマホ優先オーダー作成アプリの試作版です。
現時点では単体HTML（`index.html`）で動作します。

## 2026-11-06：PC画面・コーチ向け共有・端末間の共有

- 幅1,000px以上では、編集画面とコーチ向け共有プレビューを左右に表示します。スマホは従来の操作画面を維持します。
- 共有画像・共有文・保存メモは、同じ打順の下に先発と途中出場の選手を並べます。実際の回数と「何回まで／何回から」を示し、回ごとの選手交代と守備変更も掲載します。9人制の途中出場選手に10番以降の打順を付けません。
- 全員打ちでは、打順を維持した守備交代として表示します。欠席選手は共有内容に含めません。
- 設定にJSONバックアップ保存・読込を追加しました。ログインなしでも端末間でデータを移せます。読込前の内容は端末内に最大3件保管し、「切替前のデータを保存」から書き出して復元できます。
- `cloud-sync.mjs` は、同じGoogleアカウントのスマホ・PCで、選手・編集中のオーダー・保存記録を同期する追加モジュールです。既存の端末保存を維持し、通信できない間も端末に編集を保存します。
- 初回に両端末の内容が異なる場合と同時編集が衝突した場合は、自動で上書きせず、設定内で使う内容を選びます。切替前のデータを端末にバックアップし、Firestoreトランザクションのリビジョン比較で上書き競合を検出します。

### クラウド共有の初回設定（管理者）

**コードの公開だけではクラウド共有は有効になりません。** 2026-11-06の確認時、対象プロジェクトのAuthentication公開設定は `CONFIGURATION_NOT_FOUND` でした。管理者が以下を設定した後に本番の2端末確認を行ってください。

1. Firebaseプロジェクト `lineup-app-b4f4e` のAuthenticationを開始し、Googleログインを有効にします。サポートメールには管理者自身のアドレスを選びます。
2. 承認済みドメインに `lineup-app-b4f4e.web.app` と `lineup-app-b4f4e.firebaseapp.com` があることを確認します。
3. Cloud Firestoreの既定データベースを作成します。既存データベースがあればそれを利用し、既存のルールを読んでから必要なマッチを統合してください。テストモードの公開ルールは使用しません。新規作成時のリージョンは管理者が選択します。
4. `firestore.rules` を適用します。読み書きは `/lineupUsers/{本人のUID}/workspace/current` だけに限定します。Firebaseコンソールのルール画面からの反映、または管理者として `firebase deploy --only firestore:rules,firestore:indexes --project lineup-app-b4f4e` で反映できます。`payload` のインデックスを除外する設定は `firestore.indexes.json` にあります。
5. 正式URLをスマホとPCで開き、設定の「Googleでログイン」で同じアカウントを使用します。初回は既存データがある端末からログインし、もう一方で共有先の内容を選びます。
6. 選手名とオーダーの編集が両端末へ反映されること、通信を切った編集が再接続後に同期すること、別アカウントから内容を読めないことを確認します。

既存のGitHub Actionsは引き続きHostingのみを公開します。クラウド設定が未完了でも、選手登録・端末保存・共有画像・バックアップ機能は動作します。同期できた場合だけ「共有済み」と表示し、設定不足・通信エラーは端末に保存した状態で通知します。

### 開発時の検証

ビルドやライブラリのインストールなしで、`node --test tests/lineup.test.mjs` により打順・守備交代、共有文、端末保存、同期の競合処理を確認できます。GitHub Actionsも公開前にこのテストを実行します。

Firestoreルールの結合テストは `tests/firestore.rules.test.mjs` です。`firebase-tools`、`@firebase/rules-unit-testing`、`firebase` を用意し、Firestore Emulatorに対して実行します。本番には接続しません。検証済み組み合わせはfirebase-tools 14.16.0、rules-unit-testing 4.0.1、Firebase SDK 11.10.0、Java 17です。`FIRESTORE_EMULATOR_HOST` がない場合は実行を拒否します。依存を別フォルダーに用意する場合は `LINEUP_RULES_TEST_PACKAGE` にその `package.json` の絶対パスを指定できます。

## 起動方法

ブラウザで `index.html` を開いてください。
ローカルサーバーで確認する場合は、プロジェクトフォルダで以下を実行します。

```bash
python -m http.server 8000
```

その後、ブラウザで `http://localhost:8000` を開きます。

## iPhoneで確認する方法（GitHub Pages）

GitHub Pagesで公開すると、iPhoneのSafariからURLで操作確認できます。

確認用URL：

- https://komari0608-ux.github.io/lineup-app/

1. GitHubにこのフォルダをアップロードする
2. GitHubの Settings → Pages を開く
3. Source を Deploy from a branch にする
4. Branch を main / root にする
5. 発行されたURLをiPhoneのSafariで開く
6. ホーム画面に追加して使える

### iPhoneでホーム画面アイコンが更新されない場合

iPhoneのホーム画面アイコンはSafari側にキャッシュが残ることがあります。

1. 既存のホーム画面アイコンを削除する
2. Safariで最新版URLを開く
3. 必要ならURL末尾に `?v=icon2` を付けて開く
4. もう一度「ホーム画面に追加」する

このフォルダは `index.html` がリポジトリ直下にあるため、GitHub Pagesの `/root` 公開でそのまま起動できます。

## Firebase Hostingで正式公開する方法

Firebase Hostingで正式運用用URLとして公開できます。

正式公開URL：

- https://lineup-app-b4f4e.web.app
- https://lineup-app-b4f4e.firebaseapp.com

1. Firebase CLI をインストールする
2. `firebase login` を実行する
3. `firebase use lineup-app-b4f4e` を実行する
4. `firebase deploy --only hosting` を実行する
5. 発行された Firebase Hosting URL をiPhoneのSafariで開く
6. 必要ならホーム画面に追加する

公開対象はリポジトリ直下の `index.html` と `assets/` です。
Firebase設定では `public` を `.` にしているため、GitHub Pagesの `/root` 公開構成も維持できます。

### GitHub Actions自動デプロイ

`main` ブランチにpushすると、GitHub ActionsからFirebase Hostingの本番URLへ自動デプロイされます。

- Workflow：`.github/workflows/firebase-hosting-merge.yml`
- 反映先：https://lineup-app-b4f4e.web.app
- 確認場所：GitHubリポジトリの Actions タブ

この自動デプロイはGitHub Actions OIDCとGoogle Cloud Workload Identity Federationを使います。
FirebaseサービスアカウントキーやFirebaseトークンはリポジトリに保存しません。

### 公開環境と保存方式の役割

- GitHub Pages：開発確認用
- Firebase Hosting：正式運用用
- GitHub Actions：main push時にFirebase Hostingへ自動デプロイ
- localStorage：現時点の端末内保存
- Firestore：今後のクラウド保存候補

## iPhoneでローカル確認する方法（Windows）

PCとiPhoneを同じWi-Fiに接続してから確認します。

1. PCとiPhoneを同じWi-Fiに接続する
2. PCで `start-local-server.bat` を実行する
3. 表示されたPCのIPアドレスを確認する
4. iPhoneのSafariで `http://PCのIPアドレス:8080` を開く

例：`http://192.168.1.10:8080`

終了するときは、起動しているコマンド画面で `Ctrl+C` を押してください。

## 現在の到達点 v10

- オーダー画面内で操作を完結
- 試合情報・表示設定は設定モーダルで編集
- 別画面遷移なし
- タップメニューなし
- 守備変更専用カードなし
- 初期モードでは選手名2タップで打順変更可能
- 想定イニング数までの回を選択すると守備変更モード
- 回選択中は打順変更不可
- 回選択中は守備チップ2タップで守備入替可能
- 回選択中はベンチ選手との交代可能
- 打順番号は固定したまま選手交代
- 守備履歴は横並び表示
- 選手登録はニックネーム・本名・背番号に対応
- 登録選手は localStorage で保持
- 保存・共有機能あり

## 重要なUI方針

このアプリは少年野球の現場でスマホ操作することを最優先にしています。
そのため、試合中にリアルタイムで触る操作では以下を禁止します。

- ポップアップ
- 別画面遷移
- タップ後に出る大きなメニュー
- 全選手×9回の大きな表
- スクロール量が大きくなるUI

試合情報、表示名、打順方式など試合前に整える項目は、設定モーダルで扱って構いません。
ただし、初期・1回・2回などの回チップ、打順変更、守備変更、選手交代は設定モーダルへ入れません。

## 守るべき操作ルール

### 初期モード

- 初期オーダー作成用
- 選手名を2回タップして打順入替
- 守備変更・選手交代ではなく、スタメンの形を作るモード

### 回選択モード

- 想定イニング数までの回チップをタップして選択
- その回からの守備変更・選手交代を編集
- 選手名2タップで打順変更してはいけない
- 守備チップ2タップで守備位置を入れ替える
- ベンチ選手との交代は可能
- 打順番号は固定

## 共有テキスト

共有テキストには以下を含めます。

- 試合日
- 対戦相手
- 場所
- 開始時間
- スターティングメンバー
- 守備変更
- 選手交代

9人制について、「打順引き継ぎ」という文言は使わないでください。
野球のルールとして自然に表現します。
