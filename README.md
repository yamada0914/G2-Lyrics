# G2 Lyrics

iPhoneで再生中のSpotifyトラックに合わせて、同期歌詞をEven G2へ表示する個人用プロトタイプです。

## 機能

- Spotify Web APIから再生中の曲、再生位置、一時停止状態を取得
- LRCLIBから時刻付き歌詞を取得
- G2に前・現在・次の歌詞を表示
- Spotifyの再生位置を4秒ごとに再同期し、表示は200msごとに更新
- 首を左右へ傾けて歌詞タイミングを500msずつ補正
- タッチパッドの上下スワイプでも500msずつ補正
- シングルタップでSpotify状態を即時更新、ダブルタップで終了

## 必要なもの

- Even G2とEven App
- Spotify Premiumアカウント
- Spotify Developer Dashboardで作成したアプリのClient ID
- Node.js 20以上

## Spotify設定

1. [Spotify Developer Dashboard](https://developer.spotify.com/dashboard)でアプリを作成します。
2. G2 LyricsをHTTPSで開き、画面に表示されたRedirect URIをコピーします。公開版では `https://yamada0914.github.io/G2-Lyrics/` です。
3. SpotifyアプリのSettingsで、そのURLをRedirect URIとして完全一致で登録します。
4. G2 LyricsへClient IDを入力し、「Spotifyに接続」を押します。

SpotifyのDevelopment Modeでは、アプリ所有者にPremiumが必要です。利用者を追加する場合はSpotify DashboardのUsers Managementへ登録します。

### Redirect URIについて

Spotifyは、ループバックアドレスを除く通常のHTTP Redirect URIを受け付けません。MacのLAN IPを使った `http://192.168.x.x:5173` は、iPhone実機でのSpotify認証には使えません。GitHub Pages、Cloudflare PagesなどへHTTPS配信して、そのURLをEven Hubで開いてください。

## 開発

```bash
npm install
npm run dev
npm run build
```

ブラウザのみの確認では、Spotify Dashboardに `http://127.0.0.1:5173/` を登録できます。ポートが変わった場合は画面に表示されるURLへ合わせてください。

## 首ジェスチャー

起動直後の12サンプルを中立姿勢として記録します。左右へ傾けた後は、一度中央へ戻すまで次の操作を受け付けません。

- 左へ傾ける: 表示を500ms早める
- 右へ傾ける: 表示を500ms遅らせる

実機では装着角度に個人差があるため、`src/main.ts` の `GESTURE_THRESHOLD` を調整してください。

## データと制限

- 曲情報と再生位置はSpotify Web APIから取得します。
- 歌詞はコミュニティ運営のLRCLIBから取得します。曲によって同期歌詞が存在しない場合があります。
- Spotifyアクセストークンは端末内ストレージに保存されます。
- SpotifyのRefresh Tokenは6か月で再認証が必要になる場合があります。
- 一般公開する前にSpotify Developer Policyと歌詞提供元の利用条件を確認してください。

本実装は公開API仕様を基に独立して作成しています。他のG2歌詞アプリのソースコードは再利用していません。
