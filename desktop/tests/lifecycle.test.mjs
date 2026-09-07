import { expect, test } from 'vitest'

import * as lifecycle from '../src/main/runtime-manager'

const { stopProcessesInOrder } = lifecycle

test('starts gateway, proxy, index restoration, and voice in order', async () => {
  expect(typeof lifecycle.startProcessesInOrder).toBe('function')
  const order = []

  await lifecycle.startProcessesInOrder({
    gateway: async () => order.push('gateway'),
    subscribeGatewayEvents: () => order.push('subscribe-gateway'),
    proxy: async () => order.push('proxy'),
    restoreIndexes: async () => order.push('restore-indexes'),
    voice: async () => order.push('voice'),
  })

  expect(order).toEqual(['gateway', 'subscribe-gateway', 'proxy', 'restore-indexes', 'voice'])
})

test('starts voice when initial knowledge restoration fails', async () => {
  const order = []

  await lifecycle.startProcessesInOrder({
    gateway: async () => order.push('gateway'),
    proxy: async () => order.push('proxy'),
    restoreIndexes: async () => { order.push('restore-indexes'); throw new Error('restore failed') },
    voice: async () => order.push('voice'),
  })

  expect(order).toEqual(['gateway', 'proxy', 'restore-indexes', 'voice'])
})

test('stops voice, proxy, QMD, and gateway sequentially', async () => {
  const order = []
  await stopProcessesInOrder({
    voice: async () => order.push('voice'),
    proxy: async () => order.push('proxy'),
    qmd: async () => order.push('qmd'),
    gateway: async () => order.push('gateway'),
  })

  expect(order).toEqual(['voice', 'proxy', 'qmd', 'gateway'])
})

test('continues shutdown after one process stop fails', async () => {
  const order = []
  await stopProcessesInOrder({
    voice: async () => { order.push('voice'); throw new Error('voice failed') },
    proxy: async () => order.push('proxy'),
    qmd: async () => order.push('qmd'),
    gateway: async () => order.push('gateway'),
  })

  expect(order).toEqual(['voice', 'proxy', 'qmd', 'gateway'])
})
