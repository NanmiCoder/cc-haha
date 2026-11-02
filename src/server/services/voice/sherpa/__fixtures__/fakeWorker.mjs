// Stand-in for the local speech worker: real process and HTTP lifetimes, no sherpa.
// The requested language selects a behavior; marker files next to the VAD path
// (the models directory) steer startup and record what happened.
import { createServer } from 'node:http'
import { appendFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

const config = JSON.parse(process.env.CC_HAHA_VOICE_WORKER_CONFIG)
const token = process.env.CC_HAHA_VOICE_WORKER_TOKEN
delete process.env.CC_HAHA_VOICE_WORKER_CONFIG
delete process.env.CC_HAHA_VOICE_WORKER_TOKEN
const dir = dirname(config.vad)
const log = (name, line) => appendFileSync(join(dir, name), `${line}\n`)

log('starts.log', String(process.pid))
if (existsSync(join(dir, 'fail-start'))) {
  process.stderr.write('fake worker: model failed to load\n')
  process.exit(3)
}
const startDelay = existsSync(join(dir, 'slow-start')) ? 200 : 0

const server = createServer((request, response) => {
  if (request.headers.authorization !== `Bearer ${token}`) {
    response.writeHead(401).end('{}')
    return
  }
  const language = new URL(request.url, 'http://localhost').searchParams.get('language')
  log('requests.log', `${process.pid} ${language}`)
  request.resume()
  request.on('end', () => {
    if (language === 'hold') return
    if (language === 'crash') process.exit(1)
    const json = (status, body) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
    if (language === 'invalid-input') return json(400, { error: 'invalid input', code: 'invalid-input' })
    if (language === 'error') return json(500, { error: 'provider failed' })
    if (language === 'garbage') return response.writeHead(200).end('not json')
    const respond = () => json(200, { text: `echo:${language}`, audioSeconds: 1, inferenceSeconds: 0.01 })
    if (language === 'slow') setTimeout(respond, 150)
    else respond()
  })
})
setTimeout(() => {
  server.listen(0, '127.0.0.1', () => process.stdout.write(`${JSON.stringify({ port: server.address().port })}\n`))
}, startDelay)
process.stdin.resume()
process.stdin.on('end', () => process.exit(0))
