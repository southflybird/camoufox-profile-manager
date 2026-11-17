import { API_BASE_URL, getApiKey } from './api'
/** Streaming fetch preserves API-key authentication without putting secrets in URLs. */
export function subscribeProfileEvents(onChange: (id: string | null) => void, denied: () => void): () => void {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  async function connect() {
    try {
      const key = getApiKey()
      const response = await fetch(`${API_BASE_URL}/api/v1/events`, { headers: key ? { 'X-API-Key': key } : {}, credentials: 'same-origin', signal: controller.signal })
      if (response.status === 401 || response.status === 403) { denied(); return }
      if (!response.ok || !response.body) throw new Error('Event stream unavailable')
      onChange(null)
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (!controller.signal.aborted) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
        let end: number
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2)
          if (frame.startsWith('event: denied')) { denied(); controller.abort(); return }
          if (frame.startsWith('event: reset')) onChange(null)
          if (frame.startsWith('event: change')) {
            const data = frame.split('\n').find(line => line.startsWith('data: '))
            if (data) onChange(JSON.parse(data.slice(6)).profile_id ?? null)
          }
        }
      }
    } catch { /* Reconnect; periodic reads remain available. */ }
    if (!controller.signal.aborted) timer = setTimeout(() => { void connect() }, 2000)
  }
  void connect()
  return () => { controller.abort(); clearTimeout(timer) }
}
