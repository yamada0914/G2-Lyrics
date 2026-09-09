import './style.css'
import {
  CreateStartUpPageContainer,
  OsEventTypeList,
  StartUpPageCreateResult,
  TextContainerProperty,
  TextContainerUpgrade,
  waitForEvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import { activeLine, findLyrics, type LyricsResult } from './lyrics'
import {
  authorizeUrl,
  createState,
  createVerifier,
  exchangeCode,
  getPlayback,
  refreshAccess,
  type Playback,
  type SpotifyTokens,
} from './spotify'

const STORAGE = {
  clientId: 'g2lyrics:spotify-client-id',
  token: 'g2lyrics:spotify-token',
  verifier: 'g2lyrics:pkce-verifier',
  oauthState: 'g2lyrics:oauth-state',
  offset: 'g2lyrics:offset-ms',
}
const SPOTIFY_POLL_MS = 4_000
const DISPLAY_TICK_MS = 200
const GESTURE_STEP_MS = 500

type Bridge = Awaited<ReturnType<typeof waitForEvenAppBridge>>

let bridge: Bridge | null = null
let clientId = ''
let tokens: SpotifyTokens | null = null
let playback: Playback | null = null
let lyrics: LyricsResult | null = null
let offsetMs = 0
let message = 'Spotifyを接続してください'
let lastTrackId = ''
let lastGlassesText = ''
let writeQueue: Promise<unknown> = Promise.resolve()

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <main class="phone-app">
    <header>
      <p class="eyebrow">EVEN G2 EXPERIMENT</p>
      <h1>G2 Lyrics</h1>
      <p class="lead">iPhoneのSpotifyに合わせて、同期歌詞を眼鏡へ表示します。</p>
    </header>

    <section class="card">
      <h2>1. Spotifyを接続</h2>
      <label for="client-id">Spotify Client ID</label>
      <input id="client-id" autocomplete="off" placeholder="Developer DashboardのClient ID" />

      <div id="browser-auth">
        <p class="hint">Safariでこの画面を開き、Spotifyにログインしてください。Redirect URIとして次のURLをSpotifyへ登録します。</p>
        <code id="redirect-uri"></code>
        <div class="actions">
          <button id="connect" class="primary">Spotifyに接続</button>
          <button id="disconnect" class="secondary">切断</button>
        </div>
        <div id="token-out" style="display:none">
          <p class="hint">接続キー（コピーして、G2側アプリの入力欄に貼り付けてください）</p>
          <textarea id="token-blob" readonly rows="3"></textarea>
          <button id="copy-token" class="secondary">接続キーをコピー</button>
        </div>
      </div>

      <div id="glasses-auth" style="display:none">
        <p class="hint">Safariで発行した接続キーを貼り付けて保存してください。</p>
        <textarea id="token-in" rows="3" placeholder="接続キーを貼り付け"></textarea>
        <div class="actions">
          <button id="save-token" class="primary">保存して接続</button>
          <button id="disconnect2" class="secondary">切断</button>
        </div>
      </div>
    </section>

    <section class="card now-playing">
      <h2>2. Spotifyで再生</h2>
      <p id="track" class="track">再生待ち</p>
      <p id="artist" class="artist">—</p>
      <p id="status" class="status">起動中…</p>
      <div class="offset-row">
        <button id="earlier" aria-label="歌詞を早める">−0.5秒</button>
        <strong id="offset">補正 0.0秒</strong>
        <button id="later" aria-label="歌詞を遅らせる">+0.5秒</button>
      </div>
    </section>

    <section class="card guide">
      <h2>タイミング調整</h2>
      <p>スマホの「−0.5秒／+0.5秒」ボタンで調整できます。</p>
      <p>タッチパッドの上下スワイプでも±0.5秒調整できます。</p>
      <p>シングルタップで再同期、ダブルタップで終了。</p>
    </section>

    <pre id="preview">G2 display preview</pre>
  </main>
`

const $ = <T extends Element>(selector: string) => document.querySelector<T>(selector)!
const clientIdInput = $<HTMLInputElement>('#client-id')
const redirectEl = $<HTMLElement>('#redirect-uri')
const browserAuthEl = $<HTMLElement>('#browser-auth')
const glassesAuthEl = $<HTMLElement>('#glasses-auth')
const tokenOutEl = $<HTMLElement>('#token-out')
const tokenBlobEl = $<HTMLTextAreaElement>('#token-blob')
const tokenInEl = $<HTMLTextAreaElement>('#token-in')
const statusEl = $<HTMLElement>('#status')
const trackEl = $<HTMLElement>('#track')
const artistEl = $<HTMLElement>('#artist')
const offsetEl = $<HTMLElement>('#offset')
const previewEl = $<HTMLPreElement>('#preview')

function redirectUri(): string {
  const url = new URL(window.location.href)
  url.search = ''
  url.hash = ''
  return url.toString()
}

async function readStorage(key: string): Promise<string> {
  if (bridge) {
    try { return await bridge.getLocalStorage(key) } catch { /* browser fallback */ }
  }
  return localStorage.getItem(key) ?? ''
}

async function writeStorage(key: string, value: string): Promise<void> {
  try { localStorage.setItem(key, value) } catch { /* Safari private mode may block */ }
  if (bridge) {
    try { await bridge.setLocalStorage(key, value) } catch { /* browser fallback remains */ }
  }
}

function estimatedPosition(): number {
  if (!playback) return 0
  const elapsed = playback.isPlaying ? Date.now() - playback.sampledAt : 0
  return Math.min(playback.durationMs, playback.progressMs + elapsed + offsetMs)
}

function formatTime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

function glassesText(): string {
  if (!playback) return ['G2 LYRICS', '', message, '', 'Spotifyで曲を再生'].join('\n')

  const header = `${playback.title}\n${playback.artist}`
  if (!lyrics) return `${header}\n\n${message}`
  if (!lyrics.lines.length) {
    const plain = lyrics.plain?.split('\n').filter(Boolean).slice(0, 5) ?? []
    return [header, '', '(同期歌詞なし)', ...plain].join('\n')
  }

  const position = estimatedPosition()
  const index = activeLine(lyrics.lines, position)
  const previous = index > 0 ? lyrics.lines[index - 1].text : ''
  const current = index >= 0 ? lyrics.lines[index].text : '♪'
  const next = index + 1 < lyrics.lines.length ? lyrics.lines[index + 1].text : ''
  return [
    `${playback.title} — ${playback.artist}`,
    '',
    previous,
    `▶ ${current}`,
    `  ${next}`,
    '',
    `${playback.isPlaying ? 'PLAY' : 'PAUSE'} ${formatTime(position)}  ${offsetMs >= 0 ? '+' : ''}${(offsetMs / 1000).toFixed(1)}s`,
  ].join('\n')
}

async function render(): Promise<void> {
  trackEl.textContent = playback?.title ?? '再生待ち'
  artistEl.textContent = playback?.artist ?? '—'
  statusEl.textContent = message
  offsetEl.textContent = `補正 ${offsetMs >= 0 ? '+' : ''}${(offsetMs / 1000).toFixed(1)}秒`
  const text = glassesText()
  previewEl.textContent = text
  if (!bridge || text === lastGlassesText) return
  lastGlassesText = text
  writeQueue = writeQueue.then(() => bridge!.textContainerUpgrade(new TextContainerUpgrade({
    containerID: 1,
    containerName: 'lyrics',
    content: text,
  }))).catch((error) => console.error('G2 render failed', error))
  await writeQueue
}

async function setOffset(next: number): Promise<void> {
  offsetMs = Math.max(-10_000, Math.min(10_000, next))
  message = `同期を${offsetMs >= 0 ? '遅く' : '早く'}しました`
  await writeStorage(STORAGE.offset, String(offsetMs))
  await render()
}

async function ensureFreshToken(): Promise<void> {
  if (!tokens || !clientId) return
  if (Date.now() < tokens.expiresAt - 30_000) return
  tokens = await refreshAccess(clientId, tokens)
  await writeStorage(STORAGE.token, JSON.stringify(tokens))
}

async function pollSpotify(): Promise<void> {
  if (!tokens || !clientId) return
  try {
    await ensureFreshToken()
    let latest: Playback | null
    try {
      latest = await getPlayback(tokens.accessToken)
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'SPOTIFY_TOKEN_EXPIRED') throw error
      tokens.expiresAt = 0
      await ensureFreshToken()
      latest = await getPlayback(tokens.accessToken)
    }
    if (!latest) {
      playback = null
      message = 'Spotifyで曲を再生してください'
      await render()
      return
    }
    playback = latest
    message = latest.isPlaying ? 'Spotifyと同期中' : 'Spotifyは一時停止中'
    if (latest.id !== lastTrackId) {
      lastTrackId = latest.id
      lyrics = null
      message = '同期歌詞を検索中…'
      await render()
      try {
        lyrics = await findLyrics({
          title: latest.title,
          artist: latest.artist,
          album: latest.album,
          durationMs: latest.durationMs,
        })
      } catch {
        // Transient lookup failure: retry on the next poll instead of
        // leaving this track permanently without lyrics.
        lastTrackId = ''
        message = '歌詞の取得に失敗（再試行します）'
        await render()
        return
      }
      message = lyrics
        ? lyrics.lines.length ? '同期歌詞を表示中' : '時間情報のない歌詞です'
        : 'LRCLIBに歌詞がありません'
    }
    await render()
  } catch (error) {
    // A network hiccup shouldn't wipe the last track/lyrics. estimatedPosition
    // keeps advancing, so the glasses keep scrolling while we recover.
    message = error instanceof TypeError ? '接続を確認中…' : error instanceof Error ? error.message : String(error)
    await render()
  }
}

async function connectSpotify(): Promise<void> {
  clientId = clientIdInput.value.trim()
  if (!clientId) {
    message = 'Client IDを入力してください'
    await render()
    return
  }
  try {
    message = 'Spotifyへ移動します…(v2)'
    await render()
    const verifier = createVerifier()
    const state = createState()
    await Promise.all([
      writeStorage(STORAGE.clientId, clientId),
      writeStorage(STORAGE.verifier, verifier),
      writeStorage(STORAGE.oauthState, state),
    ])
    const url = await authorizeUrl(clientId, redirectUri(), verifier, state)
    message = `移動中: ${url.slice(0, 40)}…`
    await render()
    window.location.assign(url)
  } catch (error) {
    message = `接続エラー: ${error instanceof Error ? error.message : String(error)}`
    await render()
  }
}

async function handleOAuthCallback(): Promise<void> {
  const url = new URL(window.location.href)
  const code = url.searchParams.get('code')
  if (!code) return
  const returnedState = url.searchParams.get('state') ?? ''
  const [verifier, expectedState] = await Promise.all([
    readStorage(STORAGE.verifier),
    readStorage(STORAGE.oauthState),
  ])
  if (!verifier || !expectedState || returnedState !== expectedState) {
    throw new Error('Spotify認証状態を確認できませんでした')
  }
  tokens = await exchangeCode(clientId, redirectUri(), verifier, code)
  await writeStorage(STORAGE.token, JSON.stringify(tokens))
  url.searchParams.delete('code')
  url.searchParams.delete('state')
  history.replaceState({}, '', url.toString())
  message = 'Spotifyに接続しました。下の接続キーをコピーしてください。'
  if (tokens.refreshToken) {
    tokenBlobEl.value = `${clientId}~${tokens.refreshToken}`
    tokenOutEl.style.display = 'block'
  }
}

async function saveConnectionKey(): Promise<void> {
  const blob = tokenInEl.value.trim()
  const sep = blob.indexOf('~')
  if (sep < 0) {
    message = '接続キーの形式が正しくありません'
    await render()
    return
  }
  clientId = blob.slice(0, sep).trim()
  const refreshToken = blob.slice(sep + 1).trim()
  if (!clientId || !refreshToken) {
    message = '接続キーの形式が正しくありません'
    await render()
    return
  }
  clientIdInput.value = clientId
  tokens = { accessToken: '', refreshToken, expiresAt: 0 }
  await Promise.all([
    writeStorage(STORAGE.clientId, clientId),
    writeStorage(STORAGE.token, JSON.stringify(tokens)),
  ])
  try {
    await ensureFreshToken()
    await writeStorage(STORAGE.token, JSON.stringify(tokens))
    message = 'Spotifyに接続しました'
    await render()
    await pollSpotify()
  } catch (error) {
    message = `接続キーが無効です: ${error instanceof Error ? error.message : String(error)}`
    await render()
  }
}

async function connectGlasses(): Promise<void> {
  try {
    bridge = await Promise.race([
      waitForEvenAppBridge(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('preview')), 2500)),
    ])
  } catch {
    message = 'ブラウザプレビュー（G2未接続）'
    return
  }
  // In a plain browser (e.g. Safari) waitForEvenAppBridge may still resolve a
  // bridge, but the glasses APIs return invalid. Treat any failure here as
  // "not on glasses" so the rest of bootstrap (OAuth callback) still runs.
  try {
    const result = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer({
      containerTotalNum: 1,
      textObject: [new TextContainerProperty({
        xPosition: 0,
        yPosition: 0,
        width: 576,
        height: 288,
        paddingLength: 6,
        containerID: 1,
        containerName: 'lyrics',
        content: glassesText(),
        isEventCapture: 1,
      })],
    }))
    if (result !== StartUpPageCreateResult.success) throw new Error(`G2 page error (${result})`)
  } catch (error) {
    console.warn('G2 not available, running as browser', error)
    bridge = null
    return
  }
  bridge.onEvenHubEvent((event) => {
    const type = event.textEvent?.eventType ?? event.listEvent?.eventType ?? event.sysEvent?.eventType
    if (type === OsEventTypeList.SCROLL_TOP_EVENT) void setOffset(offsetMs - GESTURE_STEP_MS)
    if (type === OsEventTypeList.SCROLL_BOTTOM_EVENT) void setOffset(offsetMs + GESTURE_STEP_MS)
    // Current iOS builds can report a tap as a sysEvent with only eventSource.
    if (type === OsEventTypeList.CLICK_EVENT || (event.sysEvent && type === undefined)) void pollSpotify()
    if (type === OsEventTypeList.DOUBLE_CLICK_EVENT) void bridge?.shutDownPageContainer(1)
  })
}

async function bootstrap(): Promise<void> {
  redirectEl.textContent = redirectUri()
  await connectGlasses()
  if (bridge) {
    browserAuthEl.style.display = 'none'
    glassesAuthEl.style.display = 'block'
  }
  clientId = await readStorage(STORAGE.clientId)
  clientIdInput.value = clientId
  const savedToken = await readStorage(STORAGE.token)
  const savedOffset = Number(await readStorage(STORAGE.offset))
  if (Number.isFinite(savedOffset)) offsetMs = savedOffset
  if (savedToken) {
    try { tokens = JSON.parse(savedToken) as SpotifyTokens } catch { tokens = null }
  }
  await handleOAuthCallback()
  // On glasses, jump straight to playback. In the browser keep the OAuth
  // message (e.g. the "copy the connection key" instruction) visible.
  if (tokens && bridge) message = 'Spotifyの再生を確認中…'
  await render()
  if (tokens) await pollSpotify()
  setInterval(() => void pollSpotify(), SPOTIFY_POLL_MS)
  setInterval(() => void render(), DISPLAY_TICK_MS)
}

async function disconnectSpotify(): Promise<void> {
  tokens = null
  playback = null
  lyrics = null
  lastTrackId = ''
  await writeStorage(STORAGE.token, '')
  message = 'Spotifyとの接続を解除しました'
  await render()
}

$('#connect').addEventListener('click', () => void connectSpotify())
$('#disconnect').addEventListener('click', () => void disconnectSpotify())
$('#disconnect2').addEventListener('click', () => void disconnectSpotify())
$('#save-token').addEventListener('click', () => void saveConnectionKey())
$('#copy-token').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(tokenBlobEl.value)
    message = '接続キーをコピーしました'
  } catch {
    tokenBlobEl.select()
    message = 'コピーできない場合は手動で選択してください'
  }
  await render()
})
$('#earlier').addEventListener('click', () => void setOffset(offsetMs - GESTURE_STEP_MS))
$('#later').addEventListener('click', () => void setOffset(offsetMs + GESTURE_STEP_MS))

void bootstrap().catch(async (error) => {
  message = error instanceof Error ? error.message : String(error)
  console.error(error)
  await render()
})
