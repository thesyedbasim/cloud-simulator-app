import type { Architecture } from '../store/types'

export const linkShortener: Architecture = {
  name: 'Link Shortener',
  components: [
    { id: 'client', kind: 'client', name: 'Clients', position: { col: 0, row: 3 }, config: { rps: 600 }, assumed: ['rps'] },
    { id: 'lb', kind: 'loadBalancer', name: 'Load Balancer', position: { col: 3, row: 3 }, config: { targets: 2 } },
    { id: 'app', kind: 'appServers', name: 'App Servers', position: { col: 6, row: 3 }, config: { instances: 2, vcpu: 4, ramGb: 8 }, assumed: ['vcpu', 'ramGb'] },
    { id: 'cache', kind: 'cache', name: 'Cache', position: { col: 9, row: 3 }, config: { hitRate: 0.8 }, assumed: ['hitRate'] },
    { id: 'db', kind: 'database', name: 'Database', position: { col: 9, row: 7 }, config: { vcpu: 4, ramGb: 16, poolSize: 20 }, assumed: ['vcpu', 'ramGb', 'poolSize'] },
  ],
  connections: [
    { id: 'c1', from: 'client', to: 'lb' },
    { id: 'c2', from: 'lb', to: 'app' },
    { id: 'c3', from: 'app', to: 'cache' },
    { id: 'c4', from: 'cache', to: 'db' },
  ],
}
