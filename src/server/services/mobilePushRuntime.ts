import os from 'node:os'
import path from 'node:path'
import { getMobileSessionActivity } from './mobileSessionActivityRuntime.js'
import { sessionService } from './sessionService.js'
import { MobilePushService } from './mobilePushService.js'
import { DirectMobilePushTransport } from './mobilePushTransport.js'

const services = new Map<string, MobilePushService>()
export function getMobilePushService() {
  const directory = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'cc-haha')
  let service = services.get(directory)
  if (!service) {
    service = new MobilePushService({ directory, transport: new DirectMobilePushTransport(), activities: getMobileSessionActivity, summary: id => sessionService.getSessionSummary(id) })
    services.set(directory, service)
  }
  return service
}
export async function stopMobilePushServices() { const pending = [...services.values()].map(service => service.stop()); services.clear(); await Promise.all(pending) }
