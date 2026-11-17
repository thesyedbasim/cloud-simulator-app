/** Turns raw simulation numbers into a plain-language explanation of what broke and why. Pure. */
import type { Architecture, ArchComponent } from '../store/types'
import { appCapacityPerInstance, dbCapacity, POISON_RETRY_COST } from './capacity'
import type { NodeResult, StepResult } from './engine'

export interface Insight {
  /** Stable while the same problem persists, so a dismissed card stays dismissed. */
  key: string
  nodeId: string
  title: string
  reasons: string[]
  hint: string
}

const n0 = (x: number) => Math.round(x).toLocaleString('en-US')

function why(c: ArchComponent, n: NodeResult): { title: string; reasons: string[]; hint: string; kind: string } {
  const name = c.name
  const cfg = c.config
  const dropPct = n.offered > 0 ? Math.round((n.dropped / n.offered) * 100) : 0

  if (n.injected === 'bad') {
    return {
      kind: 'bad',
      title: `${name} is running a bad release`,
      reasons: [
        `A faulty release makes about 30% of the requests ${name} handles fail, even though it has the capacity (it is at ${Math.round(n.util * 100)}% utilization).`,
        `${dropPct}% of requests to it fail. Clients retry them, which adds load on top of the bug.`,
      ],
      hint: 'Roll back (restore it from the inspector). A canary release would have exposed only a small share of traffic to the bug.',
    }
  }

  if (c.kind === 'appServers' && (n.breaker === 'open' || n.breaker === 'half')) {
    return {
      kind: 'breaker',
      title: `${name} is shedding load (circuit breaker ${n.breaker === 'open' ? 'open' : 'testing'})`,
      reasons: [
        n.breaker === 'open'
          ? `The calls ${name} makes downstream kept failing, so its circuit breaker opened: requests now fail fast here and nothing is sent downstream until the breaker tries again.`
          : `${name}'s circuit breaker is testing the downstream with a small share of traffic. If those calls succeed it closes; if not it opens again.`,
        `${dropPct}% of requests are failing fast at this tier. That is the price of keeping workers free and giving the downstream service room to recover.`,
      ],
      hint: 'Fix what is failing downstream. Once calls succeed again the breaker closes by itself.',
    }
  }

  if (n.failover?.phase === 'failing') {
    const reps = Math.round(cfg.replicas ?? 0)
    const reasons = [
      `The primary of ${name} is down and a replica is being promoted, ready in about ${Math.ceil(n.failover.remainingSec)} s. Until then writes fail and ${reps} replica${reps === 1 ? '' : 's'} serve reads only, so ${dropPct}% of requests are dropped.`,
    ]
    if (n.failover.lostWrites >= 1) reasons.push(`About ${n0(n.failover.lostWrites)} acknowledged writes had not reached a replica yet when the primary died. They are lost for good.`)
    return { kind: 'failover', title: `${name} is failing over`, reasons, hint: 'A shorter failover time, or a design that retries writes after the switch, shortens the outage. Lower replication lag loses fewer writes.' }
  }

  if (n.down) {
    const lone = n.injected === 'lostInstance'
    return {
      kind: 'down',
      title: `${name} is down`,
      reasons: [
        lone ? `${name} has a single instance and it failed.` : `${name} has been taken offline.`,
        `All ${n0(n.offered)} requests per second sent to it fail, and nothing behind it receives traffic.`,
      ],
      hint: 'This is an injected fault. Restore it from the inspector, or add more instances so one failure is survivable.',
    }
  }

  const reasons: string[] = []
  let hint = 'Scale up, scale out, or reduce the load reaching this component.'
  let kind = 'overload'

  if (n.injected === 'slow') {
    kind = 'slow'
    reasons.push(`${name} is running slowly: about 4× normal latency and a quarter of its usual capacity.`)
  } else if (n.injected === 'zoneLoss') {
    kind = 'degraded'
    const inst = n.scaling?.active ?? cfg.instances ?? 2
    reasons.push(`A failure zone is down: ${Math.ceil(inst / 2)} of ${inst} instances of ${name} are gone, so it has lost ${Math.round((Math.ceil(inst / 2) / inst) * 100)}% of its capacity.`)
  } else if (n.injected === 'lostInstance') {
    kind = 'degraded'
    const inst = n.scaling?.active ?? cfg.instances ?? 2
    reasons.push(`One of ${inst} instances of ${name} has failed, so it has lost ${Math.round(100 / inst)}% of its capacity.`)
  }
  reasons.push(`It is receiving ${n0(n.offered)} rps but can only handle about ${n0(n.capacity)} rps, so ${dropPct}% of requests are dropped.`)

  switch (c.kind) {
    case 'appServers': {
      const per = appCapacityPerInstance(cfg)
      reasons.push(`Each instance (${cfg.vcpu} vCPU, ${cfg.ramGb} GB) serves about ${n0(per.rps)} rps, limited by ${per.limiter === 'CPU' ? 'CPU' : 'memory'}.`)
      hint = per.limiter === 'RAM' ? 'Memory is the limit: adding vCPUs alone will not help. Add RAM or more instances.' : 'Add vCPUs (scale up) or more instances (scale out).'
      if (n.hold) {
        reasons.unshift(`Workers here wait on slower downstream services, so each one is held about ${n.hold.toFixed(1)}× longer than normal and the tier handles ${Math.round((1 - 1 / n.hold) * 100)}% fewer requests. The real problem is downstream: this tier is only the first to feel it.`)
        hint = n.callTimeouts ? 'Call timeouts are already failing the slowest calls. Fix the slow dependency, or add a circuit breaker.' : 'Fix the slow dependency, or set a call timeout so workers give up instead of waiting forever.'
      }
      const sc = n.scaling
      if (sc) {
        if (sc.pending > 0) {
          // lead with this: it is the most useful thing to know, and the card shows only the first reason until expanded
          reasons.unshift(`Autoscaling is adding ${sc.pending} instance${sc.pending > 1 ? 's' : ''}, ready in about ${Math.ceil(sc.nextReadyIn ?? sc.warmupSec)} s. Until then it runs with ${sc.active}. That delay is the gap between a spike and new capacity.`)
          hint = 'It recovers once the new instances finish starting. A shorter start-up time, a higher minimum, or a lower scale-out threshold shortens the gap.'
        } else if (sc.active >= sc.max) {
          reasons.push(`Autoscaling is already at its maximum of ${sc.max} instances, so it cannot add more.`)
          hint = 'Raise the maximum number of instances, or use bigger instances.'
        } else {
          reasons.push(`Autoscaling has not added capacity yet (${sc.active} of up to ${sc.max} instances).`)
        }
      }
      break
    }
    case 'database': {
      const d = dbCapacity(cfg)
      if (n.shards && n.shards.hot > n.shards.even * 1.3) {
        const pct = (x: number) => Math.round(x * 100)
        reasons.unshift(`The data is split over ${n.shards.count} shards, but the busiest takes ${pct(n.shards.hot)}% of the traffic instead of an even ${pct(n.shards.even)}%. That shard saturates first, so the database as a whole handles only about ${n0(n.capacity)} rps instead of ${n0(n.capacity * (n.shards.hot / n.shards.even))}: adding shards does not help a hot key.`)
        hint = 'Spread the hot key (add a random suffix, cache it, or split it), or pick a shard key that spreads load evenly.'
        break
      }
      if (n.conns && !n.conns.pooled && n.conns.demand > n.conns.max) {
        reasons.push(`Function instances are holding about ${n0(n.conns.demand)} connections, but the database allows only ${n0(n.conns.max)}, so requests without a connection are refused.`)
        hint = 'Turn on the connection pooler so many function instances share a few connections, or raise the connection pool.'
      } else if (n.poolSize > 0 && n.poolUsed >= n.poolSize * 0.9) {
        reasons.push(`The connection pool is exhausted: ${n.poolUsed.toFixed(0)} of ${n.poolSize} connections are in use because each query now takes about ${n0(n.latency)} ms.`)
        hint = 'Queries are holding connections too long. Reduce the load on the database (a cache helps), or scale it up.'
      } else {
        reasons.push(`The database serves about ${n0(d.rps)} rps, limited by ${d.limiter === 'CPU' ? 'CPU' : 'memory'}.`)
        hint = 'Put a cache in front of it, or give it more vCPUs and memory.'
      }
      break
    }
    case 'queue':
      if (n.broker) {
        const b = n.broker
        const pct = (x: number) => Math.round(x * 100)
        if (b.hot > 1 / b.partitions * 1.3) {
          reasons.unshift(`One partition takes ${pct(b.hot)}% of the messages (an even spread would be ${pct(1 / b.partitions)}%), and a partition is read by a single consumer, so adding consumers does not help: that partition's backlog keeps growing while the others sit idle.`)
          hint = 'Choose a partition key that spreads messages evenly, or split the hot key.'
        } else if (b.idle > 0) {
          reasons.unshift(`${b.consumers} consumers share ${b.partitions} partitions, so ${b.idle} sit idle: a partition is read by only one consumer in the group.`)
          hint = 'Add partitions before adding consumers, or raise the rate each consumer can process.'
        } else if (b.poison > 0 && b.dlqDepth === 0) {
          reasons.unshift(`${pct(b.poison)}% of messages are poison: each one is retried about ${POISON_RETRY_COST} times, holding up its partition, and the drain rate drops to ${n0(n.capacity)}/s.`)
          hint = 'Turn on a dead-letter queue so a poison message is parked after one failure instead of blocking the partition.'
        }
      }
      reasons.push(`The queue is ${n0(n.queueDepth)} deep (max ${n0(cfg.maxDepth ?? 0)}) because arrivals outpace the ${n0(cfg.capacity ?? 0)} msg/s drain rate.`)
      hint = 'Raise the drain rate or the maximum depth.'
      break
    default:
      break
  }
  if (n.injected) hint += ' You injected this fault; restore it from the inspector.'
  const title = kind === 'slow' ? `${name} is slow` : kind === 'degraded' ? `${name} lost capacity` : `${name} is the bottleneck`
  return { title, reasons, hint, kind }
}

/** Finds the component hurting the system most and explains why, or null when all is well. */
export function analyze(arch: Architecture, res: StepResult): Insight | null {
  let worst: { c: ArchComponent; n: NodeResult } | null = null
  for (const c of arch.components) {
    const n = res.nodes[c.id]
    if (!n || c.kind === 'client' || n.health !== 'failed') continue
    if (!worst || n.dropped > worst.n.dropped) worst = { c, n }
  }
  if (!worst) return null
  const w = why(worst.c, worst.n)
  const reasons = [...w.reasons]
  const retry = res.totals.retryFactor
  for (const cc of arch.components) {
    const cn = res.nodes[cc.id]
    if ((cc.kind !== 'cache' && cc.kind !== 'cdn') || !cn || cn.warmth === undefined || cn.warmth >= 0.9) continue
    reasons.push(`${cc.name} is only ${Math.round(cn.warmth * 100)}% warm after a flush, so most reads fall through to what is behind it.${cn.stampede && cn.stampede > 1.2 ? ` Without request coalescing, many requests for the same missing item each load it separately (about ${cn.stampede.toFixed(1)}× the misses).` : ''}`)
  }
  if (res.totals.timeouts > 0.05) reasons.push(`${Math.round(res.totals.timeouts * 100)}% of requests run past the client timeout and count as failures.`)
  if (retry > 0.15) reasons.push(`Clients are retrying failed requests, adding about ${Math.round(retry * 100)}% more load. This retry storm keeps the problem going.`)
  return { key: `${worst.c.id}:${w.kind}`, nodeId: worst.c.id, title: w.title, reasons, hint: w.hint }
}
