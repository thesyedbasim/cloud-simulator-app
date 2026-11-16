import type { Architecture } from '../store/types'
import { linkShortener } from './linkShortener'

/** Chat app: a queue decouples the gateway from slow writes. Weak point: the queue drains slower than a spike arrives. */
const chatApp: Architecture = {
  name: 'Chat App',
  components: [
    { id: 'client', kind: 'client', name: 'Clients', position: { col: 0, row: 2 }, config: { rps: 400 }, assumed: ['rps'] },
    { id: 'lb', kind: 'loadBalancer', name: 'Load Balancer', position: { col: 3, row: 2 }, config: { targets: 2 } },
    { id: 'gateway', kind: 'appServers', name: 'Chat Gateway', position: { col: 6, row: 2 }, config: { instances: 2, vcpu: 4, ramGb: 8 }, assumed: ['vcpu', 'ramGb'] },
    { id: 'queue', kind: 'queue', name: 'Message Queue', position: { col: 9, row: 2 }, config: { capacity: 450, maxDepth: 2000 }, assumed: ['capacity', 'maxDepth'] },
    { id: 'workers', kind: 'appServers', name: 'Message Workers', position: { col: 9, row: 6 }, config: { instances: 1, vcpu: 6, ramGb: 12 }, assumed: ['vcpu', 'ramGb'] },
    { id: 'db', kind: 'database', name: 'Message Store', position: { col: 13, row: 6 }, config: { vcpu: 8, ramGb: 32, poolSize: 40 }, assumed: ['vcpu', 'ramGb', 'poolSize'] },
  ],
  connections: [
    { id: 'c1', from: 'client', to: 'lb' },
    { id: 'c2', from: 'lb', to: 'gateway' },
    { id: 'c3', from: 'gateway', to: 'queue' },
    { id: 'c4', from: 'queue', to: 'workers' },
    { id: 'c5', from: 'workers', to: 'db' },
  ],
}

/** Video streaming: a CDN cache absorbs most plays. Weak point: a slow origin when the cache misses. */
const videoStreaming: Architecture = {
  name: 'Video Streaming',
  components: [
    { id: 'client', kind: 'client', name: 'Viewers', position: { col: 0, row: 3 }, config: { rps: 700 }, assumed: ['rps'] },
    { id: 'lb', kind: 'loadBalancer', name: 'Load Balancer', position: { col: 3, row: 3 }, config: { targets: 2 } },
    { id: 'cdn', kind: 'cache', name: 'CDN Cache', position: { col: 6, row: 3 }, config: { hitRate: 0.85 }, assumed: ['hitRate'] },
    { id: 'origin', kind: 'appServers', name: 'Origin Servers', position: { col: 9, row: 3 }, config: { instances: 2, vcpu: 2, ramGb: 4 }, assumed: ['vcpu', 'ramGb'] },
    { id: 'store', kind: 'database', name: 'Media Store', position: { col: 12, row: 6 }, config: { vcpu: 2, ramGb: 8, poolSize: 20 }, assumed: ['vcpu', 'ramGb', 'poolSize'] },
  ],
  connections: [
    { id: 'c1', from: 'client', to: 'lb' },
    { id: 'c2', from: 'lb', to: 'cdn' },
    { id: 'c3', from: 'cdn', to: 'origin' },
    { id: 'c4', from: 'origin', to: 'store' },
  ],
}

/** E-commerce: a busy web tier in front of an order database. Weak point: low cache hit rate pushes reads onto the database. */
const ecommerce: Architecture = {
  name: 'E-commerce Store',
  components: [
    { id: 'client', kind: 'client', name: 'Shoppers', position: { col: 0, row: 3 }, config: { rps: 500 }, assumed: ['rps'] },
    { id: 'lb', kind: 'loadBalancer', name: 'Load Balancer', position: { col: 3, row: 3 }, config: { targets: 3 } },
    { id: 'web', kind: 'appServers', name: 'Web Servers', position: { col: 6, row: 3 }, config: { instances: 3, vcpu: 4, ramGb: 8 }, assumed: ['vcpu', 'ramGb'] },
    { id: 'cache', kind: 'cache', name: 'Product Cache', position: { col: 9, row: 3 }, config: { hitRate: 0.6 }, assumed: ['hitRate'] },
    { id: 'db', kind: 'database', name: 'Order Database', position: { col: 12, row: 6 }, config: { vcpu: 4, ramGb: 16, poolSize: 20 }, assumed: ['vcpu', 'ramGb', 'poolSize'] },
  ],
  connections: [
    { id: 'c1', from: 'client', to: 'lb' },
    { id: 'c2', from: 'lb', to: 'web' },
    { id: 'c3', from: 'web', to: 'cache' },
    { id: 'c4', from: 'cache', to: 'db' },
  ],
}

export interface Preset { id: string; name: string; blurb: string; weak: string; arch: Architecture }

export const PRESETS: Preset[] = [
  { id: 'link', name: 'Link Shortener', blurb: 'Read-heavy lookups behind a cache.', weak: 'The app tier saturates in a spike.', arch: linkShortener },
  { id: 'chat', name: 'Chat App', blurb: 'A queue decouples messages from storage.', weak: 'The queue drains slower than a spike arrives.', arch: chatApp },
  { id: 'video', name: 'Video Streaming', blurb: 'A CDN cache absorbs most plays.', weak: 'A small origin struggles when the cache misses.', arch: videoStreaming },
  { id: 'shop', name: 'E-commerce Store', blurb: 'A busy web tier over an order database.', weak: 'A low cache hit rate pushes reads onto the database.', arch: ecommerce },
]

export const BLANK: Architecture = { name: 'Untitled design', components: [], connections: [] }
