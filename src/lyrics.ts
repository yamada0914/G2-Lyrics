export interface LyricLine {
  atMs: number
  text: string
}

export interface LyricsResult {
  lines: LyricLine[]
  plain: string | null
}

export function parseLrc(source: string): LyricLine[] {
  const result: LyricLine[] = []
  for (const row of source.split(/\r?\n/)) {
    const matches = [...row.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g)]
    if (!matches.length) continue
    const last = matches[matches.length - 1]
    const text = row.slice((last.index ?? 0) + last[0].length).trim()
    for (const match of matches) {
      const fraction = match[3] ?? '0'
      const fractionMs = Number(fraction.padEnd(3, '0').slice(0, 3))
      result.push({
        atMs: Number(match[1]) * 60_000 + Number(match[2]) * 1000 + fractionMs,
        text,
      })
    }
  }
  return result.sort((a, b) => a.atMs - b.atMs)
}

export function activeLine(lines: readonly LyricLine[], positionMs: number): number {
  let low = 0
  let high = lines.length - 1
  let found = -1
  while (low <= high) {
    const middle = (low + high) >> 1
    if (lines[middle].atMs <= positionMs) {
      found = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return found
}

export async function findLyrics(input: {
  title: string
  artist: string
  album: string
  durationMs: number
}): Promise<LyricsResult | null> {
  const query = new URLSearchParams({
    track_name: input.title,
    artist_name: input.artist,
    album_name: input.album,
    duration: String(Math.round(input.durationMs / 1000)),
  })
  const response = await fetch(`https://lrclib.net/api/get?${query}`, {
    headers: { Accept: 'application/json' },
  })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`Lyrics lookup failed (${response.status})`)
  const data = await response.json() as {
    syncedLyrics?: string | null
    plainLyrics?: string | null
  }
  return {
    lines: data.syncedLyrics ? parseLrc(data.syncedLyrics) : [],
    plain: data.plainLyrics ?? null,
  }
}
