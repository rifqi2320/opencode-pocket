export function memoryStorage() {
  const map = new Map()
  return {
    map,
    async get(k) { return map.has(k) ? structuredClone(map.get(k)) : undefined },
    async set(k, v) { map.set(k, structuredClone(v)) },
    async remove(k) { map.delete(k) },
    async scan({ prefix, after, limit = 100 }) {
      const keys = [...map.keys()].filter((k) => k.startsWith(prefix) && (after === undefined || k > after)).sort()
      const page = keys.slice(0, limit)
      return { entries: page.map((key) => ({ key, value: structuredClone(map.get(key)) })), next: keys.length > limit ? page.at(-1) : undefined }
    },
  }
}

export function fakeSender(respond = () => ({ ok: true, name: 'projects/x/messages/1' })) {
  const sent = []
  return { sent, async send(message) { sent.push(message); return respond(message, sent.length) } }
}
