const ACCOUNTS_URL = 'https://accounts.spotify.com'
const API_URL = 'https://api.spotify.com/v1'

export interface SpotifyTokens {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

export interface Playback {
  id: string
  title: string
  artist: string
  album: string
  durationMs: number
  progressMs: number
  isPlaying: boolean
  sampledAt: number
}

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  bytes.forEach((byte) => { binary += String.fromCharCode(byte) })
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function createVerifier(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'
  const bytes = crypto.getRandomValues(new Uint8Array(64))
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('')
}

export function createState(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(18)))
}

export async function authorizeUrl(
  clientId: string,
  redirectUri: string,
  verifier: string,
  state: string,
): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    code_challenge_method: 'S256',
    code_challenge: base64Url(new Uint8Array(digest)),
    state,
    scope: 'user-read-currently-playing user-read-playback-state',
  })
  return `${ACCOUNTS_URL}/authorize?${params}`
}

type TokenPayload = {
  access_token: string
  refresh_token?: string
  expires_in: number
}

async function tokenRequest(body: URLSearchParams): Promise<TokenPayload> {
  const response = await fetch(`${ACCOUNTS_URL}/api/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!response.ok) throw new Error(`Spotify authentication failed (${response.status})`)
  return response.json() as Promise<TokenPayload>
}

export async function exchangeCode(
  clientId: string,
  redirectUri: string,
  verifier: string,
  code: string,
): Promise<SpotifyTokens> {
  const data = await tokenRequest(new URLSearchParams({
    client_id: clientId,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  }))
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? '',
    expiresAt: Date.now() + data.expires_in * 1000,
  }
}

export async function refreshAccess(clientId: string, token: SpotifyTokens): Promise<SpotifyTokens> {
  const data = await tokenRequest(new URLSearchParams({
    client_id: clientId,
    grant_type: 'refresh_token',
    refresh_token: token.refreshToken,
  }))
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? token.refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
  }
}

export async function getPlayback(accessToken: string): Promise<Playback | null> {
  const response = await fetch(`${API_URL}/me/player/currently-playing`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (response.status === 204) return null
  if (response.status === 401) throw new Error('SPOTIFY_TOKEN_EXPIRED')
  if (response.status === 429) throw new Error('Spotify rate limit reached')
  if (!response.ok) throw new Error(`Spotify playback failed (${response.status})`)

  const data = await response.json() as {
    is_playing: boolean
    progress_ms: number | null
    item: null | {
      id: string
      name: string
      duration_ms: number
      album: { name: string }
      artists: Array<{ name: string }>
    }
  }
  if (!data.item) return null
  return {
    id: data.item.id,
    title: data.item.name,
    artist: data.item.artists.map((artist) => artist.name).join(', '),
    album: data.item.album.name,
    durationMs: data.item.duration_ms,
    progressMs: data.progress_ms ?? 0,
    isPlaying: data.is_playing,
    sampledAt: Date.now(),
  }
}
