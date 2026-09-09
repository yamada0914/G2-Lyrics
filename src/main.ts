import './style.css'
import {
  CreateStartUpPageContainer,
  ImuReportPace,
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
const GESTURE_THRESHOLD = 0.34
const GESTURE_COOLDOWN_MS = 700
const CALIBRATION_SAMPLES = 12

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

let baselineX = 0
let calibrationCount = 0
let gestureArmed = true
let lastGestureAt = 0

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
      <p class="hint">Redirect URIとして次のURLをSpotifyアプリへ登録してください。</p>
      <code id="redirect-uri"></code>
      <div class="actions">
        <button id="connect" class="primary">Spotifyに接続</button>
        <button id="disconnect" class="secondary">切断</button>
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
      <h2>首ジェスチャー</h2>
      <p>左へ傾ける：歌詞を0.5秒早める</p>
      <p>右へ傾ける：歌詞を0.5秒遅らせる</p>
      <p>中央へ戻すと次の操作を受け付けます。</p>
    </section>

    <pre id="preview">G2 display preview</pre>
  </main>
`

const $ = <T extends Element>(selector: string) => document.querySelector<T>(selector)!
const clientIdInput = $<HTMLInputElement>('#client-id')
const redirectEl = $<HTMLElement>('#redirect-uri')
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
  localStorage.setItem(key, value)
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
      message = '同期歌詞を検索中…'
      await render()
      lyrics = await findLyrics({
        title: latest.title,
        artist: latest.artist,
        album: latest.album,
        durationMs: latest.durationMs,
      })
      message = lyrics
        ? lyrics.lines.length ? '同期歌詞を表示中' : '時間情報のない歌詞です'
        : 'LRCLIBに歌詞がありません'
    }
    await render()
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
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
    message = 'Spotifyへ移動します…'
    await render()
    const verifier = createVerifier()
    const state = createState()
    await Promise.all([
      writeStorage(STORAGE.clientId, clientId),
      writeStorage(STORAGE.verifier, verifier),
      writeStorage(STORAGE.oauthState, state),
    ])
    window.location.href = await authorizeUrl(clientId, redirectUri(), verifier, state)
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
  message = 'Spotifyに接続しました'
}

async function handleImu(x: number): Promise<void> {
  if (calibrationCount < CALIBRATION_SAMPLES) {
    baselineX += x
    calibrationCount += 1
    if (calibrationCount === CALIBRATION_SAMPLES) baselineX /= CALIBRATION_SAMPLES
    return
  }
  const delta = x - baselineX
  if (Math.abs(delta) < GESTURE_THRESHOLD * 0.45) {
    gestureArmed = true
    return
  }
  const now = Date.now()
  if (!gestureArmed || now - lastGestureAt < GESTURE_COOLDOWN_MS) return
  if (Math.abs(delta) >= GESTURE_THRESHOLD) {
    gestureArmed = false
    lastGestureAt = now
    await setOffset(offsetMs + (delta > 0 ? GESTURE_STEP_MS : -GESTURE_STEP_MS))
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
  const result = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer({
    containerTotalNum: 1,
    textObject: [new TextContainerProperty({
      xPosition: 0,
      yPosition: 0,
      width: 288,
      height: 144,
      containerID: 1,
      containerName: 'lyrics',
      content: 'G2 LYRICS',
      isEventCapture: 1,
    })],
  }))
  if (result !== StartUpPageCreateResult.success) throw new Error(`G2 init v3 failed code ${result}`)
  await render()
  await bridge.imuControl(true, ImuReportPace.P100)
  bridge.onEvenHubEvent((event) => {
    if (event.sysEvent?.eventType === OsEventTypeList.IMU_DATA_REPORT && event.sysEvent.imuData) {
      void handleImu(event.sysEvent.imuData.x ?? 0)
      return
    }
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
  clientId = await readStorage(STORAGE.clientId)
  clientIdInput.value = clientId
  const savedToken = await readStorage(STORAGE.token)
  const savedOffset = Number(await readStorage(STORAGE.offset))
  if (Number.isFinite(savedOffset)) offsetMs = savedOffset
  if (savedToken) {
    try { tokens = JSON.parse(savedToken) as SpotifyTokens } catch { tokens = null }
  }
  await handleOAuthCallback()
  message = tokens ? 'Spotifyの再生を確認中…' : message
  await render()
  if (tokens) await pollSpotify()
  setInterval(() => void pollSpotify(), SPOTIFY_POLL_MS)
  setInterval(() => void render(), DISPLAY_TICK_MS)
}

$('#connect').addEventListener('click', () => void connectSpotify())
$('#disconnect').addEventListener('click', async () => {
  tokens = null
  playback = null
  lyrics = null
  lastTrackId = ''
  await writeStorage(STORAGE.token, '')
  message = 'Spotifyとの接続を解除しました'
  await render()
})
$('#earlier').addEventListener('click', () => void setOffset(offsetMs - GESTURE_STEP_MS))
$('#later').addEventListener('click', () => void setOffset(offsetMs + GESTURE_STEP_MS))

void bootstrap().catch(async (error) => {
  message = error instanceof Error ? error.message : String(error)
  console.error(error)
  await render()
})
